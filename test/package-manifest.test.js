import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const biomeConfig = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const guides = [
	"docs/tools.md",
	"docs/configuration.md",
	"docs/roles.md",
	"docs/troubleshooting.md",
	"docs/development.md",
];
const readDoc = (path) => readFileSync(join(root, path), "utf8");
const toolsDoc = readDoc("docs/tools.md");
const configurationDoc = readDoc("docs/configuration.md");
const rolesDoc = readDoc("docs/roles.md");
const context = readFileSync(join(root, "CONTEXT.md"), "utf8");
const normalized = (value) => value.replace(/\s+/g, " ").trim();
const sectionBetween = (value, start, end) => {
	const startIndex = value.indexOf(start);
	const endIndex = value.indexOf(end, startIndex + start.length);
	assert.notEqual(startIndex, -1, `missing section start: ${start}`);
	assert.notEqual(endIndex, -1, `missing section end: ${end}`);
	return normalized(value.slice(startIndex, endIndex));
};
const ordinaryReviewClauses = [
	"For ordinary review, prefer a different authenticated model family.",
	"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
	"Disclose that this review is context-isolated, not cross-family independent.",
	"Cross-family verification must not use this fallback.",
];
// Host-owned operational skills are the only shipped skills; workflow skills
// such as orchestrate and plan belong to role packs.
const hostSkills = ["pi-herdr-agents"];
const hostSkillFiles = new Set(hostSkills.map((n) => `skills/${n}/SKILL.md`));
const packageFiles = new Set(
	JSON.parse(
		execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: root,
			encoding: "utf8",
		}),
	)[0].files.map(({ path }) => path),
);

describe("production package manifest", () => {
	it("declares the public npm identity and publish metadata", () => {
		assert.equal(manifest.name, "pi-herdr-agents");
		assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
		assert.equal(manifest.license, "MIT");
		assert.equal(manifest.publishConfig?.access, "public");
		assert.equal(
			manifest.repository?.url,
			"git+https://github.com/giuseppecrj/pi-herdr-agents.git",
		);
		assert.equal(
			manifest.bugs?.url,
			"https://github.com/giuseppecrj/pi-herdr-agents/issues",
		);
		assert.equal(
			manifest.homepage,
			"https://github.com/giuseppecrj/pi-herdr-agents#readme",
		);
		assert.equal(manifest.author?.name, "Giuseppe Rodriguez");
		assert.equal(manifest.author?.url, "https://github.com/giuseppecrj");
		assert.ok(manifest.keywords?.includes("pi-package"));
	});
});

describe("pack-neutral package contents", () => {
	it("ships only the extension, with no bundled roles or workflow resources", () => {
		assert.deepEqual(manifest.pi?.extensions, [
			"./pi-extension/subagents/index.ts",
		]);
		// An explicit `pi` manifest disables conventional `skills/` discovery, so
		// the host-owned operational skill must be declared to load at all.
		assert.deepEqual(manifest.pi?.skills, ["./skills"]);
		assert.equal(Object.hasOwn(manifest.pi ?? {}, "prompts"), false);
		for (const script of ["format", "format:check", "lint", "test"]) {
			assert.doesNotMatch(
				manifest.scripts?.[script] ?? "",
				/skills\/|test\/evals|plan-skill/,
				`${script} must not target moved resources`,
			);
		}
		assert.equal(
			biomeConfig.files?.includes.some((path) => path.startsWith("skills/")),
			false,
		);
		for (const path of [
			"README.md",
			"AGENTS.md",
			"CHANGELOG.md",
			"CONTEXT.md",
			"RELEASING.md",
			"config.json.example",
			"pi-extension/subagents/index.ts",
			"examples/role-pack/extension.ts",
			"examples/role-pack/roles/example-reviewer.md",
			"docs/worktree-subagents.md",
			...guides,
		]) {
			assert.equal(
				packageFiles.has(path),
				true,
				`missing package file: ${path}`,
			);
		}
		for (const path of packageFiles) {
			assert.doesNotMatch(
				path,
				/^agents\//,
				`moved role resource is still packaged: ${path}`,
			);
			if (path.startsWith("skills/"))
				assert.ok(
					hostSkillFiles.has(path),
					`unexpected packaged skill resource: ${path}`,
				);
			assert.doesNotMatch(path, /(^|\/)(?:claude\.ts|plugin)(?:\/|$)/);
			assert.doesNotMatch(path, /^tools\//);
			assert.doesNotMatch(
				path,
				/(^|\/)(?:\.pi|test|prototypes?|sessions|\.reviews|openspec)(?:\/|$)|(^|\/)(?:run\.jsonl|config\.json)$/,
			);
		}
		for (const path of [
			"pi-extension/subagents/plan-skill.md",
			"pi-extension/subagents/workflow-worker.js",
			"docs/review-evaluation.md",
			"oxlint.config.ts",
		])
			assert.equal(packageFiles.has(path), false, `unexpected ${path}`);
	});

	it("ships the self-contained sidebar plugin but not its active plan", () => {
		assert.deepEqual(
			[...packageFiles].filter((path) => path.startsWith("plugins/")).sort(),
			[
				"plugins/sidebar/README.md",
				"plugins/sidebar/herdr-plugin.toml",
				"plugins/sidebar/sidebar.mjs",
			],
		);
		assert.equal(packageFiles.has("docs/sidebar-plan.md"), false);
		// A Herdr subdirectory install receives only plugins/sidebar/, and
		// linking runs no build, so every command must work from those files.
		const pluginManifest = readFileSync(
			join(root, "plugins/sidebar/herdr-plugin.toml"),
			"utf8",
		);
		for (const [, argv] of pluginManifest.matchAll(/^command = (.+)$/gm)) {
			const [program, file, ...rest] = JSON.parse(argv);
			assert.equal(program, "node");
			assert.ok(existsSync(join(root, "plugins/sidebar", file)), file);
			for (const arg of rest) assert.match(arg, /^[a-z]+$/);
		}
		assert.doesNotMatch(pluginManifest, /\[\[(build|startup)\]\]/);
	});

	it("does not ship the logs pi-lens writes under .pi-lens-probe-home", () => {
		// A copy of the package manifest and ignore rules, so the repository
		// tree is never touched.
		const dir = mkdtempSync(join(tmpdir(), "piha-pack-ignore-"));
		try {
			for (const file of ["package.json", ".npmignore"])
				copyFileSync(join(root, file), join(dir, file));
			mkdirSync(join(dir, ".pi-lens-probe-home"));
			writeFileSync(join(dir, ".pi-lens-probe-home", "probe.log"), "log\n");
			writeFileSync(join(dir, "kept.txt"), "kept\n");
			const files = JSON.parse(
				execFileSync(
					"npm",
					["pack", "--dry-run", "--json", "--ignore-scripts"],
					{
						cwd: dir,
						encoding: "utf8",
					},
				),
			)[0].files.map(({ path }) => path);
			assert.ok(files.includes("kept.txt"), `fixture not packed: ${files}`);
			assert.deepEqual(
				files.filter((path) => path.startsWith(".pi-lens-probe-home/")),
				[],
			);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("leaves no empty bundled-resource directories in the source tree", () => {
		assert.equal(existsSync(join(root, "agents")), false, "agents/ remains");
	});

	it("ships only valid host-owned operational skills", () => {
		for (const name of hostSkills) {
			const path = `skills/${name}/SKILL.md`;
			assert.equal(packageFiles.has(path), true, `missing ${path}`);
			const body = readFileSync(join(root, path), "utf8");
			const front = body.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
			assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
			assert.ok(name.length <= 64);
			assert.ok(front.includes(`name: ${name}`), `${path} name mismatch`);
			const description = front.match(/^description: (.+)$/m)?.[1] ?? "";
			assert.ok(
				description.length > 0 && description.length <= 1024,
				`${path} needs a description of at most 1024 characters`,
			);
		}
		for (const path of packageFiles)
			if (path.startsWith("skills/"))
				assert.doesNotMatch(path, /orchestrate|plan/);
	});

	it("locks fork override semantics in the tools and roles references", () => {
		assert.ok(
			normalized(toolsDoc).includes(
				"`true` forces fork, `false` forces standalone. Omit to inherit",
			),
			"tools fork parameter must document true/false/omit semantics",
		);
		assert.ok(
			normalized(rolesDoc).includes(
				"`fork: true` on the tool call forces `fork` mode; `fork: false` forces `standalone` mode. Omitting `fork` inherits the agent's frontmatter `session-mode`.",
			),
			"roles session-mode section must document explicit false override",
		);
	});

	it("defines independent and ordinary review separately in README, guides, and CONTEXT", () => {
		const independentClause =
			"Cross-family independent review requires a reviewer from a different model family than the author.";
		for (const [label, content] of [
			["README", readme],
			["docs/configuration.md", configurationDoc],
			["docs/roles.md", rolesDoc],
			["CONTEXT", context],
		]) {
			const compact = normalized(content);
			assert.ok(
				compact.includes(independentClause),
				`${label} must define independent review as a requirement`,
			);
			for (const clause of ordinaryReviewClauses)
				assert.ok(compact.includes(clause), `${label} must include: ${clause}`);
		}
		for (const [label, content] of [
			["README", readme],
			["docs/configuration.md", configurationDoc],
			["docs/roles.md", rolesDoc],
		]) {
			assert.doesNotMatch(
				content,
				/Independent reviewers should use/i,
				`${label} must not weaken independent review to a suggestion`,
			);
			assert.doesNotMatch(
				content,
				/For review when the authoring family is known, choose an exact shortlist ID[^.]*task:review`; this is guidance/i,
				`${label} must replace the unconditional task:review paragraph`,
			);
		}
	});

	it("keeps all three reference review passages aligned with the taxonomy", () => {
		const passages = [
			sectionBetween(
				rolesDoc,
				"Roles use model defaults",
				"Discovery loads definitions",
			),
			sectionBetween(
				configurationDoc,
				"`models.tasks` candidates are ordered exact authenticated IDs.",
				"Run `/subagents-init",
			),
			sectionBetween(
				configurationDoc,
				"Shortlists do not enforce reviewer independence.",
				"Set `persistent.maxAgents`",
			),
		];
		for (const [index, passage] of passages.entries())
			for (const clause of ordinaryReviewClauses)
				assert.ok(
					passage.includes(clause),
					`reference passage ${index + 1} must include: ${clause}`,
				);
	});
});
