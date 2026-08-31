import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const skill = readFileSync(
	join(root, "skills", "orchestrate", "SKILL.md"),
	"utf8",
);
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

describe("bundled orchestration skill", () => {
	it("is exposed with the extension in the installed package", () => {
		assert.deepEqual(manifest.pi?.skills, ["./skills"]);
		assert.deepEqual(manifest.pi?.extensions, [
			"./pi-extension/subagents/index.ts",
		]);
		assert.match(skill, /^---\nname: orchestrate\ndescription: .+\n---/);
		for (const path of [
			"README.md",
			"AGENTS.md",
			"CONTEXT.md",
			"RELEASING.md",
			"skills/orchestrate/SKILL.md",
			"agents/adversarial-reviewer.md",
			"agents/planner.md",
			"agents/poteto.md",
			"agents/reviewer.md",
			"agents/scout.md",
			"agents/visual-tester.md",
			"agents/worker.md",
			"pi-extension/subagents/plan-skill.md",
			"pi-extension/subagents/workflow-worker.js",
		]) {
			assert.equal(
				packageFiles.has(path),
				true,
				`missing package file: ${path}`,
			);
		}
		for (const path of packageFiles) {
			assert.doesNotMatch(path, /(^|\/)(?:claude\.ts|plugin)(?:\/|$)/);
		}
		assert.equal(packageFiles.has("agents/claude-reviewer.md"), false);
		assert.equal(packageFiles.has("oxlint.config.ts"), false);
		for (const path of packageFiles) {
			assert.doesNotMatch(path, /^tools\//);
		}
		for (const path of packageFiles) {
			assert.doesNotMatch(
				path,
				/(^|\/)(?:\.pi|test|prototypes?|sessions|\.reviews)(?:\/|$)|(^|\/)(?:run\.jsonl|config\.json)$/,
			);
		}
	});

	it("keeps the approved review contract in the bundled skill", () => {
		for (const phrase of [
			"local paths, URLs, tickets",
			"Materialize the",
			"Parent-only preflight",
			".pi/plans/<run>/workflow.js",
			"Promise.all",
			"retryable === true",
			"final reviewer success/failure envelope",
			"herdr_workflow",
			"unmodified",
			"APPROVE <8 lowercase hex characters>",
			"Do not poll",
			"security boundary",
		]) {
			assert.ok(skill.includes(phrase), `missing skill contract: ${phrase}`);
		}
		assert.doesNotMatch(skill, /subagent\s*\(\s*\{/);
	});
});
