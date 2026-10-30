import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	hasTrustRequiringProjectResources,
	loadSkills,
	stripFrontmatter,
	type Skill,
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
 * mirrors the directories Pi's own resource loader searches (SDK 1.1.0
 * `package-manager.js` `resolve()` and `addAutoDiscoveredResources()`), in
 * Pi's precedence order, and parses each skill with the SDK's `loadSkills`:
 *
 * 1. project `skills` entries from `<cwd>/.pi/settings.json` (plain paths)
 * 2. `<cwd>/.pi/skills` and `.agents/skills` in cwd and each ancestor up to
 *    the Git root
 * 3. user `skills` entries from `<agentDir>/settings.json` (plain paths)
 * 4. `<agentDir>/skills` and `~/.agents/skills`
 * 5. skills of configured packages (project, then user) whose install
 *    directory already exists; a package that is not installed is skipped
 *
 * Project sources (1, 2 and project packages) count only when Pi would trust
 * the project without asking, as the child would.
 */

/** Largest SKILL.md file delivered with a task. */
export const SKILL_FILE_MAX_BYTES = 64 * 1024;
/** Largest combined size of all skill blocks delivered with one task. */
export const SKILLS_TOTAL_MAX_BYTES = 256 * 1024;

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
	const discovered = discoverSkills(search, options);
	const skills: ResolvedSkill[] = [];
	const missing: string[] = [];
	const diagnostics: string[] = [];
	for (const name of declared) {
		const skill = isSkillName(name) ? discovered.get(name) : undefined;
		if (!skill) {
			missing.push(name);
			continue;
		}
		const size = statSync(skill.filePath).size;
		const raw =
			size <= SKILL_FILE_MAX_BYTES ? readFileSync(skill.filePath, "utf8") : "";
		const bytes = Math.max(size, Buffer.byteLength(raw));
		if (bytes > SKILL_FILE_MAX_BYTES) {
			throw new SkillDeliveryError(
				`Skill "${name}" (${skill.filePath}) is ${formatKiB(bytes)}, over the ` +
					`${formatKiB(SKILL_FILE_MAX_BYTES)} per-skill limit for delivery with a ` +
					`subagent's first task. Shorten it (move detail into files the skill ` +
					`references) or remove "${name}" from the role's skills.`,
			);
		}
		skills.push({
			name,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			content: stripFrontmatter(raw).trim(),
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
	/** Skill files and directories in precedence order. */
	paths: string[];
	/** `.agents/skills` roots, whose top-level `.md` files Pi does not load. */
	agentsRoots: Set<string>;
	/** Sources that were not searched, for missing-skill diagnostics. */
	notes: string[];
}

type PackageScope = "project" | "user";

/** One `packages` settings entry, parsed at the settings-file boundary. */
interface PackageEntry {
	source: string;
	/** An object entry with `skills: []` disables the package's skills. */
	skillsDisabled: boolean;
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
	const search: SkillSearch = { paths: [], agentsRoots: new Set(), notes: [] };

	if (trusted) {
		search.paths.push(...settingsSkillPaths(project.skills, projectBase, home));
		search.paths.push(join(projectBase, "skills"));
		for (const dir of ancestorAgentsSkillDirs(cwd)) {
			if (dir === homeAgentsSkills) continue;
			search.paths.push(dir);
			search.agentsRoots.add(dir);
		}
	} else {
		search.notes.push(
			`project ${cwd} is not trusted by Pi, so its skills and packages were not searched`,
		);
	}
	search.paths.push(...settingsSkillPaths(global.skills, agentDir, home));
	search.paths.push(join(agentDir, "skills"), homeAgentsSkills);
	search.agentsRoots.add(homeAgentsSkills);

	const packages = [
		...project.packages.map((entry) => ({ entry, scope: "project" as const })),
		...global.packages.map((entry) => ({ entry, scope: "user" as const })),
	];
	for (const { entry, scope } of packages) {
		if (entry.skillsDisabled) continue;
		const located = locatePackage(entry.source, scope, {
			installBase: scope === "project" ? projectBase : agentDir,
			home,
		});
		if (located.root) search.paths.push(...packageSkillPaths(located.root));
		else if (located.note) search.notes.push(located.note);
	}
	return search;
}

/** Discover skills on disk; the first skill with a name wins, as in Pi. */
function discoverSkills(
	search: SkillSearch,
	options: SkillResolveOptions,
): Map<string, Skill> {
	const byName = new Map<string, Skill>();
	const seenFiles = new Set<string>();
	for (const path of search.paths) {
		if (!existsSync(path)) continue;
		const { skills } = loadSkills({
			cwd: options.cwd,
			agentDir: options.agentDir,
			skillPaths: [path],
			includeDefaults: false,
		});
		for (const skill of skills) {
			if (
				search.agentsRoots.has(path) &&
				dirname(skill.filePath) === path &&
				!skill.filePath.endsWith("/SKILL.md")
			) {
				continue;
			}
			const canonical = canonicalPath(skill.filePath);
			if (seenFiles.has(canonical) || byName.has(skill.name)) continue;
			seenFiles.add(canonical);
			byName.set(skill.name, skill);
		}
	}
	return byName;
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

/** Plain `skills` settings entries; include/exclude patterns are not paths. */
function settingsSkillPaths(
	entries: readonly string[],
	base: string,
	home: string,
): string[] {
	return entries
		.map((entry) => entry.trim())
		.filter((entry) => entry && !/^[!+-]/.test(entry) && !hasGlob(entry))
		.map((entry) => resolve(base, expandHome(entry, home)));
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

function packageInstallPath(
	source: string,
	context: { installBase: string; home: string },
): string | undefined {
	if (source.startsWith("npm:")) {
		const name = source
			.slice("npm:".length)
			.trim()
			.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1];
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

/** Skill paths a package contributes: its `pi.skills` manifest or `skills/`. */
function packageSkillPaths(root: string): string[] {
	const manifest = readJsonObject(join(root, "package.json"))?.pi;
	if (!isRecord(manifest)) return [join(root, "skills")];
	const entries = manifest.skills;
	if (!Array.isArray(entries)) return [];
	const paths: string[] = [];
	for (const entry of entries) {
		if (!isString(entry) || /^[!+-]/.test(entry) || hasGlob(entry)) continue;
		const path = containedPath(root, [entry]);
		if (path) paths.push(path);
	}
	return paths;
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

function readSettings(file: string): SettingsView {
	const data = readJsonObject(file);
	const settings: SettingsView = { skills: [], packages: [] };
	if (Array.isArray(data?.skills))
		settings.skills = data.skills.filter(isString);
	if (Array.isArray(data?.packages)) {
		for (const entry of data.packages) {
			if (isString(entry)) {
				settings.packages.push({ source: entry.trim(), skillsDisabled: false });
			} else if (isRecord(entry) && isString(entry.source)) {
				settings.packages.push({
					source: entry.source.trim(),
					skillsDisabled:
						Array.isArray(entry.skills) && entry.skills.length === 0,
				});
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

function hasGlob(value: string): boolean {
	return /[*?[\]{}]/.test(value);
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
