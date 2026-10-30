import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	formatSkillBlocks,
	parseDeclaredSkills,
	resolveDeclaredSkills,
	SKILL_FILE_MAX_BYTES,
	SKILLS_TOTAL_MAX_BYTES,
} from "../../maestro/adapters/pi/skills.ts";

declare global {
	// Set by the probe extension if anything ever imports it.
	var __piSkillsProbeRan: boolean | undefined;
}

interface Layout {
	root: string;
	project: string;
	agentDir: string;
	homeDir: string;
}

function withLayout(run: (layout: Layout) => Promise<void> | void) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-skills-")));
	const layout: Layout = {
		root,
		project: join(root, "project"),
		agentDir: join(root, "agent"),
		homeDir: join(root, "home"),
	};
	mkdirSync(layout.project, { recursive: true });
	mkdirSync(layout.agentDir, { recursive: true });
	mkdirSync(layout.homeDir, { recursive: true });
	return Promise.resolve(run(layout)).finally(() =>
		rmSync(root, { recursive: true, force: true }),
	);
}

function writeSkill(dir: string, name: string, body: string): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	const file = join(skillDir, "SKILL.md");
	writeFileSync(
		file,
		`---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
	);
	return file;
}

function trustProject(layout: Layout) {
	writeFileSync(
		join(layout.agentDir, "trust.json"),
		JSON.stringify({ [layout.project]: true }),
	);
}

function options(layout: Layout) {
	return {
		cwd: layout.project,
		agentDir: layout.agentDir,
		homeDir: layout.homeDir,
	};
}

test("parseDeclaredSkills trims, drops empties and dedupes in order", () => {
	assert.deepEqual(parseDeclaredSkills(" alpha, beta,,alpha , beta,gamma"), [
		"alpha",
		"beta",
		"gamma",
	]);
	assert.deepEqual(parseDeclaredSkills(undefined), []);
});

test("resolves declared skills from Pi's project, user and .agents skill directories", () =>
	withLayout(async (layout) => {
		trustProject(layout);
		const projectFile = writeSkill(
			join(layout.project, ".pi", "skills"),
			"alpha",
			"# Alpha\nProject alpha.",
		);
		writeSkill(
			join(layout.agentDir, "skills"),
			"alpha",
			"# Alpha\nUser alpha loses the name collision.",
		);
		const userFile = writeSkill(
			join(layout.agentDir, "skills"),
			"beta",
			"# Beta\nUser beta.",
		);
		const agentsFile = writeSkill(
			join(layout.project, ".agents", "skills"),
			"gamma",
			"# Gamma\nProject .agents gamma.",
		);
		const homeFile = writeSkill(
			join(layout.homeDir, ".agents", "skills"),
			"delta",
			"# Delta\nHome .agents delta.",
		);

		const resolution = await resolveDeclaredSkills(
			["alpha", "beta", "gamma", "delta", "missing"],
			options(layout),
		);

		assert.deepEqual(
			resolution.skills.map((skill) => [skill.name, skill.filePath]),
			[
				["alpha", projectFile],
				["beta", userFile],
				["gamma", agentsFile],
				["delta", homeFile],
			],
		);
		assert.deepEqual(resolution.missing, ["missing"]);
		assert.match(resolution.diagnostics.join("\n"), /"missing"/);
		const alpha = resolution.skills[0];
		assert.equal(alpha.content, "# Alpha\nProject alpha.");
		assert.doesNotMatch(alpha.content, /description:/);

		const blocks = formatSkillBlocks(resolution.skills);
		assert.ok(
			blocks.startsWith(
				`<skill name="alpha" location="${projectFile}">\nReferences are relative to ${join(layout.project, ".pi", "skills", "alpha")}.\n\n# Alpha`,
			),
		);
		assert.match(blocks, /Home \.agents delta\./);
	}));

test("REGRESSION: resolving skills never runs project extensions or installs packages", () =>
	withLayout(async (layout) => {
		trustProject(layout);
		const marker = join(layout.root, "probe-ran");
		const extensions = join(layout.project, ".pi", "extensions");
		mkdirSync(extensions, { recursive: true });
		const probe = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nglobalThis.__piSkillsProbeRan = true;\nexport default function () {}\n`;
		writeFileSync(join(extensions, "probe.js"), probe);
		writeFileSync(join(extensions, "probe.ts"), probe);
		writeFileSync(
			join(layout.project, ".pi", "settings.json"),
			JSON.stringify({
				packages: ["npm:project-pkg-not-installed", "./local-pkg"],
				extensions: ["./extensions/probe.js"],
			}),
		);
		writeFileSync(
			join(layout.agentDir, "settings.json"),
			JSON.stringify({
				packages: [
					"npm:user-pkg-installed",
					"npm:@scope/user-pkg-missing@1.2.3",
					"git:git@github.com:owner/repo@v1",
				],
			}),
		);
		writeSkill(
			join(
				layout.agentDir,
				"npm",
				"node_modules",
				"user-pkg-installed",
				"skills",
			),
			"npm-skill",
			"From an installed npm package.",
		);
		writeSkill(
			join(layout.agentDir, "git", "github.com", "owner", "repo", "skills"),
			"git-skill",
			"From an installed git package.",
		);
		const localPkg = join(layout.project, ".pi", "local-pkg");
		mkdirSync(localPkg, { recursive: true });
		writeFileSync(
			join(localPkg, "package.json"),
			JSON.stringify({ pi: { skills: ["./custom-skills"] } }),
		);
		writeSkill(
			join(localPkg, "custom-skills"),
			"local-skill",
			"From a local package manifest.",
		);

		const spawned: string[] = [];
		const methods = [
			"spawn",
			"spawnSync",
			"exec",
			"execSync",
			"execFile",
			"execFileSync",
			"fork",
		] as const;
		const originals = Object.fromEntries(
			methods.map((method) => [method, childProcess[method]]),
		);
		for (const method of methods) {
			Object.assign(childProcess, {
				[method]: (...args: unknown[]) => {
					spawned.push(`${method} ${String(args[0])}`);
					throw new Error(`unexpected child process: ${method}`);
				},
			});
		}
		syncBuiltinESMExports();
		let resolution;
		try {
			resolution = await resolveDeclaredSkills(
				["npm-skill", "git-skill", "local-skill", "pkg-only-skill"],
				options(layout),
			);
		} finally {
			Object.assign(childProcess, originals);
			syncBuiltinESMExports();
		}

		assert.deepEqual(spawned, [], "no npm, git or other child process");
		assert.equal(existsSync(marker), false, "project extension was imported");
		assert.equal(globalThis.__piSkillsProbeRan, undefined);
		assert.equal(existsSync(join(layout.project, ".pi", "npm")), false);
		assert.equal(existsSync(join(layout.project, "node_modules")), false);
		assert.equal(
			existsSync(
				join(
					layout.agentDir,
					"npm",
					"node_modules",
					"@scope",
					"user-pkg-missing",
				),
			),
			false,
		);
		assert.deepEqual(
			resolution.skills.map((skill) => skill.name),
			["npm-skill", "git-skill", "local-skill"],
		);
		assert.deepEqual(resolution.missing, ["pkg-only-skill"]);
		const diagnostics = resolution.diagnostics.join("\n");
		assert.match(diagnostics, /"pkg-only-skill"/);
		assert.match(diagnostics, /npm:project-pkg-not-installed/);
		assert.match(diagnostics, /npm:@scope\/user-pkg-missing@1\.2\.3/);
	}));

test("an untrusted project's skills are not delivered", () =>
	withLayout(async (layout) => {
		writeSkill(
			join(layout.project, ".pi", "skills"),
			"alpha",
			"Untrusted project alpha.",
		);
		const userFile = writeSkill(
			join(layout.agentDir, "skills"),
			"alpha",
			"Trusted user alpha.",
		);
		writeSkill(
			join(layout.project, ".pi", "skills"),
			"project-only",
			"Untrusted.",
		);

		const resolution = await resolveDeclaredSkills(
			["alpha", "project-only"],
			options(layout),
		);

		assert.deepEqual(
			resolution.skills.map((skill) => skill.filePath),
			[userFile],
		);
		assert.deepEqual(resolution.missing, ["project-only"]);
		assert.match(resolution.diagnostics.join("\n"), /not trusted/);

		writeFileSync(
			join(layout.agentDir, "settings.json"),
			JSON.stringify({ defaultProjectTrust: "always" }),
		);
		const trusted = await resolveDeclaredSkills(
			["alpha", "project-only"],
			options(layout),
		);
		assert.deepEqual(
			trusted.skills.map((skill) => skill.content),
			["Untrusted project alpha.", "Untrusted."],
		);
	}));

test("duplicate declarations are delivered once", () =>
	withLayout(async (layout) => {
		writeSkill(join(layout.agentDir, "skills"), "alpha", "Alpha body.");
		const resolution = await resolveDeclaredSkills(
			["alpha", " alpha ", "alpha"],
			options(layout),
		);
		assert.equal(resolution.skills.length, 1);
		const blocks = formatSkillBlocks(resolution.skills);
		assert.equal(blocks.match(/Alpha body\./g)?.length, 1);
	}));

test("an oversize skill and an oversize aggregate refuse with an actionable message", () =>
	withLayout(async (layout) => {
		const skills = join(layout.agentDir, "skills");
		writeSkill(skills, "huge", "x".repeat(SKILL_FILE_MAX_BYTES + 1));
		await assert.rejects(
			async () => resolveDeclaredSkills(["huge"], options(layout)),
			(error: Error) => {
				assert.match(error.message, /"huge"/);
				assert.match(error.message, /64 KiB per-skill limit/);
				assert.match(error.message, /Shorten/);
				return true;
			},
		);

		const each = Math.floor(SKILL_FILE_MAX_BYTES * 0.9);
		const count = Math.ceil(SKILLS_TOTAL_MAX_BYTES / each) + 1;
		const names = Array.from({ length: count }, (_, i) => `part-${i}`);
		for (const name of names) writeSkill(skills, name, "y".repeat(each));
		await assert.rejects(
			async () => resolveDeclaredSkills(names, options(layout)),
			(error: Error) => {
				assert.match(error.message, /256 KiB total limit/);
				assert.match(error.message, /part-0/);
				return true;
			},
		);
	}));

test("a name containing ../ or an absolute path resolves to nothing", () =>
	withLayout(async (layout) => {
		const skills = join(layout.agentDir, "skills");
		writeSkill(skills, "inner", "Inner.");
		const outside = writeSkill(layout.agentDir, "outside", "Outside.");
		// A skill whose frontmatter claims a path-like name is never selected.
		const evilDir = join(skills, "evil");
		mkdirSync(evilDir, { recursive: true });
		writeFileSync(
			join(evilDir, "SKILL.md"),
			"---\nname: ../outside\ndescription: evil\n---\nEvil.\n",
		);

		const resolution = await resolveDeclaredSkills(
			[
				"../outside",
				"inner/../../outside",
				outside,
				join(layout.agentDir, "outside"),
			],
			options(layout),
		);

		assert.deepEqual(resolution.skills, []);
		assert.equal(resolution.missing.length, 4);
	}));

/** Count the bytes read from `file` through node:fs while `run` executes. */
async function bytesReadFrom(
	file: string,
	run: () => Promise<void> | void,
): Promise<number> {
	const original = {
		readFileSync: fs.readFileSync,
		openSync: fs.openSync,
		readSync: fs.readSync,
	};
	const watched = new Set<number>();
	let bytes = 0;
	Object.assign(fs, {
		readFileSync(path: fs.PathOrFileDescriptor, ...rest: unknown[]) {
			// SAFETY: forwards the caller's own arguments unchanged.
			const value = (original.readFileSync as any).call(fs, path, ...rest);
			if (String(path) === file) bytes += Buffer.byteLength(value);
			return value;
		},
		openSync(path: fs.PathLike, ...rest: unknown[]) {
			// SAFETY: forwards the caller's own arguments unchanged.
			const fd = (original.openSync as any).call(fs, path, ...rest);
			if (String(path) === file) watched.add(fd);
			return fd;
		},
		readSync(fd: number, ...rest: unknown[]) {
			// SAFETY: forwards the caller's own arguments unchanged.
			const read = (original.readSync as any).call(fs, fd, ...rest);
			if (watched.has(fd)) bytes += read;
			return read;
		},
	});
	syncBuiltinESMExports();
	try {
		await run();
	} finally {
		Object.assign(fs, original);
		syncBuiltinESMExports();
	}
	return bytes;
}

test("REGRESSION: an oversize skill file is never read whole, declared or not", () =>
	withLayout(async (layout) => {
		const skills = join(layout.agentDir, "skills");
		const big = writeSkill(skills, "big", "x".repeat(1024 * 1024));
		writeSkill(skills, "small", "Small body.");

		let resolution:
			| Awaited<ReturnType<typeof resolveDeclaredSkills>>
			| undefined;
		const unrelated = await bytesReadFrom(big, async () => {
			resolution = await resolveDeclaredSkills(["small"], options(layout));
		});
		assert.deepEqual(
			resolution?.skills.map((skill) => skill.content),
			["Small body."],
		);
		assert.ok(
			unrelated < SKILL_FILE_MAX_BYTES,
			`read ${unrelated} bytes of an unrelated oversize skill`,
		);

		const declared = await bytesReadFrom(big, () =>
			assert.rejects(
				async () => resolveDeclaredSkills(["big"], options(layout)),
				/Skill "big" .* is 1024\.0 KiB, over the 64 KiB per-skill limit/,
			),
		);
		assert.ok(
			declared < SKILL_FILE_MAX_BYTES,
			`read ${declared} bytes of a declared oversize skill before refusing it`,
		);
	}));

/** A local package whose manifest lists `./skills` holding two skills. */
function writePackage(layout: Layout, manifestSkills: string[] = ["./skills"]) {
	const pack = join(layout.root, "pack");
	const allowed = writeSkill(join(pack, "skills"), "allowed", "Allowed.");
	writeSkill(join(pack, "skills"), "excluded", "EXCLUDED CONTENT");
	writeFileSync(
		join(pack, "package.json"),
		JSON.stringify({ pi: { skills: manifestSkills } }),
	);
	return { pack, allowed };
}

interface UserSettings {
	skills?: string[];
	packages?: (string | PackageSettingsEntry)[];
}

interface PackageSettingsEntry {
	source: string;
	skills?: string[];
	autoload?: boolean;
}

function writeUserSettings(layout: Layout, settings: UserSettings) {
	writeFileSync(
		join(layout.agentDir, "settings.json"),
		JSON.stringify(settings),
	);
}

test("REGRESSION: a package's skill allowlist excludes the skills it does not list", () =>
	withLayout(async (layout) => {
		const { pack, allowed } = writePackage(layout);
		for (const filter of [
			"skills/allowed/SKILL.md",
			"skills/allowed",
			"allowed",
		]) {
			writeUserSettings(layout, {
				packages: [{ source: pack, skills: [filter] }],
			});
			const resolution = await resolveDeclaredSkills(
				["allowed", "excluded"],
				options(layout),
			);
			assert.deepEqual(
				resolution.skills.map((skill) => skill.filePath),
				[allowed],
				filter,
			);
			assert.deepEqual(resolution.missing, ["excluded"], filter);
		}

		// A glob the host cannot evaluate without Pi's matcher fails closed.
		writeUserSettings(layout, {
			packages: [{ source: pack, skills: ["skills/allow*"] }],
		});
		const glob = await resolveDeclaredSkills(
			["allowed", "excluded"],
			options(layout),
		);
		assert.deepEqual(glob.missing, ["allowed", "excluded"]);
	}));

test("REGRESSION: an autoload-disabled package contributes no skills", () =>
	withLayout(async (layout) => {
		const { pack } = writePackage(layout);
		for (const entry of [
			{ source: pack, autoload: false },
			{ source: pack, autoload: false, skills: ["allowed"] },
		]) {
			writeUserSettings(layout, { packages: [entry] });
			const resolution = await resolveDeclaredSkills(
				["allowed", "excluded"],
				options(layout),
			);
			assert.deepEqual(resolution.skills, [], JSON.stringify(entry));
			assert.deepEqual(resolution.missing, ["allowed", "excluded"]);
		}
	}));

test("a project package filter replaces the user's entry for the same package", () =>
	withLayout(async (layout) => {
		trustProject(layout);
		const { pack, allowed } = writePackage(layout);
		writeUserSettings(layout, { packages: [pack] });
		mkdirSync(join(layout.project, ".pi"), { recursive: true });
		writeFileSync(
			join(layout.project, ".pi", "settings.json"),
			JSON.stringify({ packages: [{ source: pack, skills: ["allowed"] }] }),
		);
		const resolution = await resolveDeclaredSkills(
			["allowed", "excluded"],
			options(layout),
		);
		assert.deepEqual(
			resolution.skills.map((skill) => skill.filePath),
			[allowed],
		);
		assert.deepEqual(resolution.missing, ["excluded"]);
	}));

test("manifest and settings exclusions keep a skill from being delivered", () =>
	withLayout(async (layout) => {
		const { pack, allowed } = writePackage(layout, [
			"./skills",
			"!skills/excluded",
		]);
		writeUserSettings(layout, { packages: [pack] });
		const manifest = await resolveDeclaredSkills(
			["allowed", "excluded"],
			options(layout),
		);
		assert.deepEqual(
			manifest.skills.map((skill) => skill.filePath),
			[allowed],
		);

		const skills = join(layout.agentDir, "skills");
		const kept = writeSkill(skills, "kept", "Kept.");
		writeSkill(skills, "dropped", "Dropped.");
		writeUserSettings(layout, { skills: ["!dropped"] });
		const settings = await resolveDeclaredSkills(
			["kept", "dropped"],
			options(layout),
		);
		assert.deepEqual(
			settings.skills.map((skill) => skill.filePath),
			[kept],
		);
		assert.deepEqual(settings.missing, ["dropped"]);
	}));

test("an empty declaration resolves nothing without reading settings", async () => {
	assert.deepEqual(
		await resolveDeclaredSkills([], {
			cwd: "/nonexistent",
			agentDir: "/nonexistent",
		}),
		{ skills: [], missing: [], diagnostics: [] },
	);
});
