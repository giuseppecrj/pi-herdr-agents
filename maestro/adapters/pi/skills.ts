import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	CONFIG_DIR_NAME,
	hasTrustRequiringProjectResources,
	parseFrontmatter,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	isString,
	type JsonObject,
} from "../../core/config/type-guards.ts";

/**
 * Delivering a role's declared skills with a child's first task.
 *
 * A standalone child cannot receive skills through `/skill:name` arguments:
 * Pi binds `@file` to the first prompt and expands one slash command per
 * message, so the skills land in later turns or not at all. The host instead
 * reads each declared skill's body and writes it into the task artifact.
 *
 * Discovery here only reads files. It never builds a resource loader, imports
 * an extension, runs a package manager or spawns a process, so resolving skills
 * for a child's cwd cannot run that project's code inside the parent. It
 * mirrors the files Pi's own resource loader collects (SDK 1.1.0
 * `package-manager.js` `resolve()`, `collectSkillEntries()` and
 * `addAutoDiscoveredResources()`) and names each skill as Pi's `loadSkills`
 * does, searching in this precedence order:
 *
 * 1. project `skills` entries from `<cwd>/.pi/settings.json`
 * 2. `<cwd>/.pi/skills` and `.agents/skills` in cwd and each ancestor up to
 *    the Git root
 * 3. user `skills` entries from `<agentDir>/settings.json`
 * 4. `<agentDir>/skills` and `~/.agents/skills`
 * 5. skills of configured packages (project, then user) whose install
 *    directory already exists; a package that is not installed is skipped
 *
 * Project sources (1, 2 and project packages) count only when Pi would trust
 * the project without asking, as the child would.
 *
 * Settings `skills` overrides (`!`, `+`, `-`), package manifest overrides and
 * package filters (`skills` allowlists, `autoload: false`) narrow what is
 * delivered as they narrow what Pi loads. Where the host cannot evaluate a
 * filter exactly it delivers less, never more: a glob that would include a
 * skill includes nothing, a glob that would exclude one excludes everything it
 * could match, and an `autoload: false` package contributes nothing. Ignore
 * files (`.gitignore`, `.ignore`, `.fdignore`) inside skill directories are
 * not consulted.
 *
 * A file over {@link SKILL_FILE_MAX_BYTES} is never read whole: discovery
 * stats every candidate first and reads only the head of an oversize file,
 * enough to learn its name, so a large unrelated skill costs a bounded read.
 */

/** Largest SKILL.md file delivered with a task. */
export const SKILL_FILE_MAX_BYTES = 64 * 1024;
/** Largest combined size of all skill blocks delivered with one task. */
export const SKILLS_TOTAL_MAX_BYTES = 256 * 1024;
/** The head of an oversize skill file read to learn its name. */
const SKILL_HEADER_MAX_BYTES = 8 * 1024;

/** One declared skill resolved to the instruction body delivered with a task. */
export interface ResolvedSkill {
	name: string;
	filePath: string;
	baseDir: string;
	content: string;
}

export interface SkillResolution {
	skills: ResolvedSkill[];
	/** Declared names that resolved to no discovered skill. */
	missing: string[];
	/** Host diagnostics for the parent, each naming the skill it concerns. */
	diagnostics: string[];
}

export interface SkillResolveOptions {
	/** The child's working directory. */
	cwd: string;
	/** The child's effective Pi agent directory. */
	agentDir: string;
	/** Home directory for `~/.agents/skills`; defaults to `$HOME`. */
	homeDir?: string;
}

/** Resolve declared skill names to their instruction bodies. */
export type SkillResolver = (
	names: readonly string[],
	options: SkillResolveOptions,
) => SkillResolution | Promise<SkillResolution>;

/** A declared skill cannot be delivered within the size limits. */
export class SkillDeliveryError extends Error {
	override name = "SkillDeliveryError";
}

/** Split a comma-separated `skills` declaration, keeping first occurrences. */
export function parseDeclaredSkills(value: string | undefined): string[] {
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return [...new Set(names)];
}

/**
 * Resolve declared skills by exact name among the skills discovered on disk.
 * A name never becomes a path; path-like names resolve to nothing.
 */
export function resolveDeclaredSkills(
	names: readonly string[],
	options: SkillResolveOptions,
): SkillResolution {
	const declared = [...new Set(names.map((name) => name.trim()))].filter(
		Boolean,
	);
	if (declared.length === 0)
		return { skills: [], missing: [], diagnostics: [] };

	const search = collectSkillSearch(options);
	const discovered = discoverSkills(search.files);
	const skills: ResolvedSkill[] = [];
	const missing: string[] = [];
	const diagnostics: string[] = [];
	for (const name of declared) {
		const skill = isSkillName(name) ? discovered.get(name) : undefined;
		if (!skill) {
			missing.push(name);
			continue;
		}
		if (skill.raw === undefined) {
			throw new SkillDeliveryError(
				`Skill "${name}" (${skill.filePath}) is ${formatKiB(skill.bytes)}, over the ` +
					`${formatKiB(SKILL_FILE_MAX_BYTES)} per-skill limit for delivery with a ` +
					`subagent's first task. Shorten it (move detail into files the skill ` +
					`references) or remove "${name}" from the role's skills.`,
			);
		}
		skills.push({
			name,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			content: stripFrontmatter(skill.raw).trim(),
		});
	}

	const total = Buffer.byteLength(formatSkillBlocks(skills));
	if (total > SKILLS_TOTAL_MAX_BYTES) {
		throw new SkillDeliveryError(
			`Declared skills ${skills.map((skill) => `"${skill.name}"`).join(", ")} ` +
				`total ${formatKiB(total)}, over the ${formatKiB(SKILLS_TOTAL_MAX_BYTES)} ` +
				`total limit for delivery with a subagent's first task. Declare fewer ` +
				`skills for this role or shorten them.`,
		);
	}

	if (missing.length > 0) {
		const quoted = missing.map((name) => `"${name}"`).join(", ");
		diagnostics.push(
			`Declared skill${missing.length === 1 ? "" : "s"} ${quoted} ` +
				`${missing.length === 1 ? "was" : "were"} not found on disk and ` +
				`${missing.length === 1 ? "was" : "were"} not delivered` +
				(search.notes.length > 0 ? ` (${search.notes.join("; ")})` : ""),
		);
	}
	return { skills, missing, diagnostics };
}

/** Format resolved skills as the `<skill>` blocks Pi injects for `/skill:name`. */
export function formatSkillBlocks(skills: readonly ResolvedSkill[]): string {
	return skills
		.map(
			(skill) =>
				`<skill name="${skill.name}" location="${skill.filePath}">\n` +
				`References are relative to ${skill.baseDir}.\n\n` +
				`${skill.content}\n</skill>`,
		)
		.join("\n\n");
}

/** A note for the child naming declared skills the host could not find. */
export function formatMissingSkillsNote(missing: readonly string[]): string {
	return missing.length > 0
		? `Declared skills not found: ${missing.join(", ")}. They were not loaded.`
		: "";
}

interface SkillSearch {
	/** Enabled skill files in precedence order. */
	files: string[];
	/** Sources that were not searched, for missing-skill diagnostics. */
	notes: string[];
}

/** A skill file named on disk; its body is read only within the size cap. */
interface DiscoveredSkill {
	name: string;
	filePath: string;
	baseDir: string;
	/** Size on disk. */
	bytes: number;
	/** The whole file, absent when it is over {@link SKILL_FILE_MAX_BYTES}. */
	raw?: string;
}

type PackageScope = "project" | "user";

/** One `packages` settings entry, parsed at the settings-file boundary. */
interface PackageEntry {
	source: string;
	/** An object entry: Pi applies its `skills` and `autoload` as a filter. */
	filtered: boolean;
	/** The object entry's `skills` patterns; `[]` disables the package's skills. */
	skills?: string[];
	/** False for an object entry with `autoload: false`. */
	autoload: boolean;
}

/** The settings fields skill discovery reads. */
interface SettingsView {
	skills: string[];
	packages: PackageEntry[];
	defaultProjectTrust?: string;
}

/** Where a configured package's skills live, or why they were not searched. */
interface PackageLocation {
	root?: string;
	note?: string;
}

type SkillCollectionMode = "pi" | "agents";

function collectSkillSearch(options: SkillResolveOptions): SkillSearch {
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir);
	const home = resolve(options.homeDir ?? (process.env.HOME || homedir()));
	const projectBase = join(cwd, CONFIG_DIR_NAME);
	const global = readSettings(join(agentDir, "settings.json"));
	const trusted = isProjectTrusted(cwd, agentDir, global);
	const project = trusted
		? readSettings(join(projectBase, "settings.json"))
		: { skills: [], packages: [] };
	const homeAgentsSkills = join(home, ".agents", "skills");
	const search: SkillSearch = { files: [], notes: [] };

	if (trusted) {
		search.files.push(...settingsSkillFiles(project.skills, projectBase, home));
		search.files.push(
			...autoSkillFiles(
				join(projectBase, "skills"),
				"pi",
				project.skills,
				projectBase,
			),
		);
		for (const dir of ancestorAgentsSkillDirs(cwd)) {
			if (dir === homeAgentsSkills) continue;
			search.files.push(
				...autoSkillFiles(dir, "agents", project.skills, dirname(dir)),
			);
		}
	} else {
		search.notes.push(
			`project ${cwd} is not trusted by Pi, so its skills and packages were not searched`,
		);
	}
	search.files.push(...settingsSkillFiles(global.skills, agentDir, home));
	search.files.push(
		...autoSkillFiles(join(agentDir, "skills"), "pi", global.skills, agentDir),
		...autoSkillFiles(
			homeAgentsSkills,
			"agents",
			global.skills,
			dirname(homeAgentsSkills),
		),
	);

	const context = { projectBase, agentDir, home };
	for (const { entry, scope } of dedupePackages(
		project.packages,
		global.packages,
		context,
	)) {
		const located = locatePackage(entry.source, scope, {
			installBase: scope === "project" ? projectBase : agentDir,
			home,
		});
		if (located.root)
			search.files.push(...packageSkillFiles(located.root, entry));
		else if (located.note) search.notes.push(located.note);
	}
	return search;
}

/**
 * Name each file as Pi's `loadSkills` would; the first skill with a name
 * wins, and a file reached twice (through a symlink) counts once.
 */
function discoverSkills(
	files: readonly string[],
): Map<string, DiscoveredSkill> {
	const byName = new Map<string, DiscoveredSkill>();
	const seenFiles = new Set<string>();
	for (const file of files) {
		const canonical = canonicalPath(file);
		if (seenFiles.has(canonical)) continue;
		const skill = readSkillFile(file);
		if (!skill) continue;
		seenFiles.add(canonical);
		if (!byName.has(skill.name)) byName.set(skill.name, skill);
	}
	return byName;
}

/**
 * Name one skill file without reading more than the size cap: stat first,
 * then read the whole file only when it fits, else just its head. Mirrors
 * `loadSkillFromFile`: the frontmatter `name` or the parent directory's name,
 * and a non-empty `description` is required.
 */
function readSkillFile(file: string): DiscoveredSkill | undefined {
	let bytes: number;
	try {
		const stats = statSync(file);
		if (!stats.isFile()) return undefined;
		bytes = stats.size;
	} catch {
		return undefined;
	}
	const oversize = bytes > SKILL_FILE_MAX_BYTES;
	let head: Buffer;
	try {
		head = readHead(
			file,
			oversize ? SKILL_HEADER_MAX_BYTES : SKILL_FILE_MAX_BYTES + 1,
		);
	} catch {
		return undefined;
	}
	// A file that grew past the cap since the stat is oversize too.
	const whole = !oversize && head.length <= SKILL_FILE_MAX_BYTES;
	const text = head.toString("utf8");
	let frontmatter: JsonObject;
	try {
		const parsed: unknown = parseFrontmatter(text).frontmatter;
		frontmatter = isRecord(parsed) ? parsed : {};
	} catch {
		return undefined;
	}
	const isSkillFile = basename(file) === "SKILL.md";
	const baseDir = dirname(file);
	const name =
		isString(frontmatter.name) && frontmatter.name
			? frontmatter.name
			: basename(baseDir);
	const described =
		isString(frontmatter.description) && frontmatter.description.trim() !== "";
	// An oversize SKILL.md whose frontmatter runs past the head still claims
	// its name, so declaring it refuses rather than delivering another skill.
	if (!described && (whole || !isSkillFile)) return undefined;
	const skill: DiscoveredSkill = {
		name,
		filePath: file,
		baseDir,
		bytes: Math.max(bytes, head.length),
	};
	if (whole) skill.raw = text;
	return skill;
}

/** Read at most `limit` bytes from the start of a file. */
function readHead(file: string, limit: number): Buffer {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(limit);
		let length = 0;
		while (length < limit) {
			const read = readSync(fd, buffer, length, limit - length, null);
			if (read === 0) break;
			length += read;
		}
		return buffer.subarray(0, length);
	} finally {
		closeSync(fd);
	}
}

/** Declared names are names, never paths. */
function isSkillName(name: string): boolean {
	return (
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes("\0") &&
		!name.includes("..") &&
		!isAbsolute(name)
	);
}

/** Mirror Pi's startup trust decision without prompting or locking. */
function isProjectTrusted(
	cwd: string,
	agentDir: string,
	global: SettingsView,
): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	const decision = nearestTrustDecision(join(agentDir, "trust.json"), cwd);
	if (decision !== undefined) return decision;
	return global.defaultProjectTrust === "always";
}

function nearestTrustDecision(
	trustFile: string,
	cwd: string,
): boolean | undefined {
	const data = readJsonObject(trustFile);
	if (!data) return undefined;
	let dir = canonicalPath(cwd);
	while (true) {
		const value = data[dir];
		if (value === true || value === false) return value;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function ancestorAgentsSkillDirs(cwd: string): string[] {
	const gitRoot = findGitRoot(cwd);
	const dirs: string[] = [];
	let dir = cwd;
	while (true) {
		dirs.push(join(dir, ".agents", "skills"));
		if (gitRoot && dir === gitRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function findGitRoot(start: string): string | undefined {
	let dir = start;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Skill files under an auto-discovered directory, as Pi's
 * `collectSkillEntries()` lists them: a directory holding a `SKILL.md` is one
 * skill; otherwise top-level `.md` files count in `pi` mode and nested ones in
 * `agents` mode, and subdirectories are searched, skipping dot entries and
 * `node_modules`.
 */
function collectSkillEntries(
	dir: string,
	mode: SkillCollectionMode,
	root = dir,
): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const skillFile = entries.find((entry) => entry.name === "SKILL.md");
	if (skillFile && entryKind(join(dir, skillFile.name), skillFile) === "file")
		return [join(dir, skillFile.name)];
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		const kind = entryKind(path, entry);
		if (
			kind === "file" &&
			entry.name.endsWith(".md") &&
			(mode === "pi" ? dir === root : dir !== root)
		) {
			files.push(path);
		} else if (kind === "directory") {
			files.push(...collectSkillEntries(path, mode, root));
		}
	}
	return files;
}

function entryKind(
	path: string,
	entry: Dirent,
): "file" | "directory" | "other" {
	if (entry.isSymbolicLink()) {
		try {
			const stats = statSync(path);
			return stats.isFile()
				? "file"
				: stats.isDirectory()
					? "directory"
					: "other";
		} catch {
			return "other";
		}
	}
	return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
}

/** Markdown files at, or collected under, each path (Pi's `collectFilesFromPaths`). */
function collectFilesFromPaths(paths: readonly string[]): string[] {
	const files: string[] = [];
	for (const path of paths) {
		try {
			const stats = statSync(path);
			if (stats.isFile()) {
				if (path.endsWith(".md")) files.push(path);
			} else if (stats.isDirectory()) {
				files.push(...collectSkillEntries(path, "pi"));
			}
		} catch {
			// Missing or unreadable: Pi skips it too.
		}
	}
	return files;
}

/** An auto-discovered directory's files that settings overrides leave enabled. */
function autoSkillFiles(
	dir: string,
	mode: SkillCollectionMode,
	settingsSkills: readonly string[],
	baseDir: string,
): string[] {
	return collectSkillEntries(dir, mode).filter((file) =>
		isEnabledByOverrides(file, settingsSkills, baseDir),
	);
}

/** Settings `skills` entries: plain paths, narrowed by the entry patterns. */
function settingsSkillFiles(
	entries: readonly string[],
	base: string,
	home: string,
): string[] {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (isPattern(trimmed)) patterns.push(trimmed);
		else plain.push(resolve(base, expandHome(trimmed, home)));
	}
	return enabledFiles(collectFilesFromPaths(plain), patterns, base);
}

/**
 * Pi drops a user package entry when the project configures the same package
 * (the project's filter wins), except under a project `autoload: false` delta,
 * which Pi applies over the user entry. The host does not apply deltas: a
 * delta with patterns drops the user entry too, so its skills are never
 * delivered against the delta's exclusions. `autoload: false` entries
 * themselves contribute nothing.
 */
function dedupePackages(
	projectPackages: readonly PackageEntry[],
	userPackages: readonly PackageEntry[],
	context: { projectBase: string; agentDir: string; home: string },
): { entry: PackageEntry; scope: PackageScope }[] {
	const projectByIdentity = new Map<string, PackageEntry>();
	for (const entry of projectPackages)
		projectByIdentity.set(
			packageIdentity(entry.source, context.projectBase, context.home),
			entry,
		);
	const seenUser = new Set<string>();
	const result: { entry: PackageEntry; scope: PackageScope }[] = [];
	// A later project entry for the same package replaces an earlier one.
	for (const entry of projectByIdentity.values())
		if (entry.autoload) result.push({ entry, scope: "project" });
	for (const entry of userPackages) {
		const identity = packageIdentity(
			entry.source,
			context.agentDir,
			context.home,
		);
		if (seenUser.has(identity)) continue;
		seenUser.add(identity);
		if (!entry.autoload) continue;
		const projectEntry = projectByIdentity.get(identity);
		if (
			projectEntry &&
			(projectEntry.autoload || (projectEntry.skills?.length ?? 0) > 0)
		)
			continue;
		result.push({ entry, scope: "user" });
	}
	return result;
}

/** The identity Pi dedupes packages by: npm name, git host/path, local path. */
function packageIdentity(source: string, base: string, home: string): string {
	if (source.startsWith("npm:")) {
		const name = npmPackageName(source);
		return name ? `npm:${name}` : source;
	}
	const git = parseGitSource(source);
	if (git) return `git:${git.host}/${git.path}`;
	if (/^(git|github|https?|ssh|builtin):/.test(source)) return source;
	return `local:${resolve(base, expandHome(source, home))}`;
}

/**
 * Find an already-installed package directory by Pi's install layout. Nothing
 * is installed, updated or executed; legacy global npm roots, which need an
 * `npm root -g` process to locate, are not searched.
 */
function locatePackage(
	source: string,
	scope: PackageScope,
	context: { installBase: string; home: string },
): PackageLocation {
	const location: PackageLocation = {};
	const path = packageInstallPath(source, context);
	if (!path) {
		location.note = `package ${source} (${scope}) could not be located`;
		return location;
	}
	try {
		// A package that is a single file contributes no skills.
		if (statSync(path).isDirectory()) location.root = path;
	} catch {
		location.note = `package ${source} (${scope}) is not installed at ${path}, so its skills were not searched`;
	}
	return location;
}

function npmPackageName(source: string): string | undefined {
	return source
		.slice("npm:".length)
		.trim()
		.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1];
}

function packageInstallPath(
	source: string,
	context: { installBase: string; home: string },
): string | undefined {
	if (source.startsWith("npm:")) {
		const name = npmPackageName(source);
		if (!name) return undefined;
		return containedPath(
			join(context.installBase, "npm", "node_modules"),
			name.split("/"),
		);
	}
	const git = parseGitSource(source);
	if (git) {
		return containedPath(join(context.installBase, "git"), [
			git.host,
			...git.path.split("/"),
		]);
	}
	if (/^(git|github|https?|ssh|builtin):/.test(source)) return undefined;
	return resolve(context.installBase, expandHome(source, context.home));
}

/** The host and repository path Pi uses for a git package's install dir. */
function parseGitSource(
	source: string,
): { host: string; path: string } | undefined {
	const prefixed = source.startsWith("git:");
	const url = prefixed ? source.slice("git:".length).trim() : source;
	const hasProtocol = /^(https?|ssh|git):\/\//i.test(url);
	if (!prefixed && !hasProtocol) return undefined;
	let host: string;
	let path: string;
	const scp = url.match(/^git@([^:]+):(.+)$/);
	if (scp) {
		host = scp[1];
		path = scp[2];
	} else if (hasProtocol) {
		try {
			const parsed = new URL(url);
			host = parsed.hostname;
			path = parsed.pathname;
		} catch {
			return undefined;
		}
	} else {
		const slash = url.indexOf("/");
		if (slash < 0) return undefined;
		host = url.slice(0, slash);
		path = url.slice(slash + 1);
	}
	path = path.replace(/^\/+/, "");
	const ref = path.indexOf("@");
	if (ref >= 0) path = path.slice(0, ref);
	path = path.replace(/\.git$/, "");
	const parts = path.split("/");
	if (!host || parts.length < 2) return undefined;
	return { host, path };
}

/**
 * The skill files a package contributes, as Pi's `collectPackageResources()`
 * selects them: a plain entry uses the `pi.skills` manifest (with its
 * overrides) or, without a manifest, `skills/`; an object entry's `skills`
 * patterns then narrow the package's files, and `skills: []` disables them.
 */
function packageSkillFiles(root: string, entry: PackageEntry): string[] {
	const manifest = readPiManifestSkills(root);
	if (!entry.filtered) {
		if (manifest.present) return manifestSkillFiles(root, manifest.skills);
		return collectSkillEntries(join(root, "skills"), "pi");
	}
	if (entry.skills === undefined) {
		if (manifest.skills) return manifestSkillFiles(root, manifest.skills);
		return collectSkillEntries(join(root, "skills"), "pi");
	}
	if (entry.skills.length === 0) return [];
	const all =
		manifest.skills && manifest.skills.length > 0
			? manifestSkillFiles(root, manifest.skills)
			: collectSkillEntries(join(root, "skills"), "pi");
	return enabledFiles(all, entry.skills, root);
}

/** A package's `pi` manifest, and its `skills` entries when they are valid. */
interface PiManifestSkills {
	present: boolean;
	skills?: string[];
}

/** Read a package's manifest skills as Pi's `readPiManifest()` does. */
function readPiManifestSkills(root: string): PiManifestSkills {
	const manifest = readJsonObject(join(root, "package.json"))?.pi;
	if (!isRecord(manifest)) return { present: false };
	const entries = manifest.skills;
	return Array.isArray(entries) && entries.every(isString)
		? { present: true, skills: entries }
		: { present: true };
}

/** Manifest paths inside the package, narrowed by the manifest's overrides. */
function manifestSkillFiles(
	root: string,
	entries: readonly string[] | undefined,
): string[] {
	if (!entries) return [];
	const paths: string[] = [];
	const overrides: string[] = [];
	for (const entry of entries) {
		if (isOverridePattern(entry)) overrides.push(entry);
		// A manifest glob would need Pi's matcher to expand; it adds nothing.
		else if (!/[*?]/.test(entry)) {
			const path = containedPath(root, [entry]);
			if (path) paths.push(path);
		}
	}
	return enabledFiles(collectFilesFromPaths(paths), overrides, root);
}

/** Join under a root, refusing any result outside it. */
function containedPath(
	root: string,
	parts: readonly string[],
): string | undefined {
	if (parts.some((part) => part.includes("\0") || part.includes("\\"))) {
		return undefined;
	}
	const path = resolve(root, ...parts);
	const rel = relative(root, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? path : undefined;
}

/** A settings or manifest entry that filters rather than names a path. */
function isPattern(entry: string): boolean {
	return isOverridePattern(entry) || entry.includes("*") || entry.includes("?");
}

function isOverridePattern(entry: string): boolean {
	return (
		entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")
	);
}

/** The files Pi's `applyPatterns()` leaves enabled, in their original order. */
function enabledFiles(
	files: readonly string[],
	patterns: readonly string[],
	baseDir: string,
): string[] {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];
	for (const pattern of patterns) {
		if (pattern.startsWith("+")) forceIncludes.push(pattern.slice(1));
		else if (pattern.startsWith("-")) forceExcludes.push(pattern.slice(1));
		else if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
		else includes.push(pattern);
	}
	return files.filter((file) => {
		let enabled =
			(includes.length === 0 ||
				matchesAnyPattern(file, includes, baseDir) === true) &&
			matchesAnyPattern(file, excludes, baseDir) === false;
		if (matchesAnyExactPattern(file, forceIncludes, baseDir)) enabled = true;
		if (matchesAnyExactPattern(file, forceExcludes, baseDir)) enabled = false;
		return enabled;
	});
}

/** Pi's `isEnabledByOverrides()` for an auto-discovered file. */
function isEnabledByOverrides(
	file: string,
	settingsSkills: readonly string[],
	baseDir: string,
): boolean {
	return (
		enabledFiles([file], settingsSkills.filter(isOverridePattern), baseDir)
			.length === 1
	);
}

/**
 * Pi matches patterns with minimatch against a file's relative path, name and
 * absolute path, and a `SKILL.md`'s directory too. A pattern without glob
 * syntax matches by string equality, as in minimatch; the host cannot
 * evaluate a glob, so it answers undefined (unknown) unless a literal pattern
 * already matched.
 */
function matchesAnyPattern(
	file: string,
	patterns: readonly string[],
	baseDir: string,
): boolean | undefined {
	const candidates = patternCandidates(file, baseDir, true);
	let unknown = false;
	for (const pattern of patterns) {
		const normalized = toPosixPath(pattern);
		if (/[*?[\]{}\\]|[!+@]\(/.test(normalized)) unknown = true;
		else if (candidates.includes(normalized)) return true;
	}
	return unknown ? undefined : false;
}

/** Pi's `matchesAnyExactPattern()`: relative or absolute path equality. */
function matchesAnyExactPattern(
	file: string,
	patterns: readonly string[],
	baseDir: string,
): boolean {
	const candidates = patternCandidates(file, baseDir, false);
	return patterns.some((pattern) =>
		candidates.includes(toPosixPath(pattern.replace(/^\.[/\\]/, ""))),
	);
}

function patternCandidates(
	file: string,
	baseDir: string,
	byName: boolean,
): string[] {
	const candidates = [toPosixPath(relative(baseDir, file)), toPosixPath(file)];
	if (byName) candidates.push(basename(file));
	if (basename(file) === "SKILL.md") {
		const dir = dirname(file);
		candidates.push(toPosixPath(relative(baseDir, dir)), toPosixPath(dir));
		if (byName) candidates.push(basename(dir));
	}
	return candidates;
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function readSettings(file: string): SettingsView {
	const data = readJsonObject(file);
	const settings: SettingsView = { skills: [], packages: [] };
	if (Array.isArray(data?.skills))
		settings.skills = data.skills.filter(isString);
	if (Array.isArray(data?.packages)) {
		for (const entry of data.packages) {
			if (isString(entry)) {
				settings.packages.push({
					source: entry.trim(),
					filtered: false,
					autoload: true,
				});
			} else if (isRecord(entry) && isString(entry.source)) {
				const parsed: PackageEntry = {
					source: entry.source.trim(),
					filtered: true,
					autoload: entry.autoload !== false,
				};
				if (Array.isArray(entry.skills))
					parsed.skills = entry.skills.filter(isString);
				settings.packages.push(parsed);
			}
		}
	}
	if (isString(data?.defaultProjectTrust)) {
		settings.defaultProjectTrust = data.defaultProjectTrust;
	}
	return settings;
}

function readJsonObject(file: string): JsonObject | undefined {
	try {
		const parsed = JSON.parse(
			readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
		);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function formatKiB(bytes: number): string {
	const kib = bytes / 1024;
	return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
}
