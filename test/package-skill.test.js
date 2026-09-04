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
const adversarialReview = readFileSync(
	join(root, "skills", "orchestrate", "adversarial-review.md"),
	"utf8",
);
const reviewer = readFileSync(join(root, "agents", "reviewer.md"), "utf8");
const adversarialExample = readFileSync(
	join(root, "skills", "orchestrate", "adversarial-review-example.js"),
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
			"skills/orchestrate/adversarial-review.md",
			"skills/orchestrate/adversarial-review-example.js",
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
			"identity-stripped projection of every result",
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

	it("keeps generic reviewer findings evidence-backed and task-specific", () => {
		for (const phrase of [
			"P0",
			"P1",
			"P2",
			"P3",
			"Provenance",
			"Reproduced",
			"Trace-backed",
			"Unverified",
			"Preconditions",
			"Expected behavior",
			"actual behavior",
			"INCOMPLETE",
			"task-specific output schema",
			"untrusted review data",
		]) {
			assert.ok(
				reviewer.includes(phrase),
				`missing reviewer contract: ${phrase}`,
			);
		}
		assert.doesNotMatch(reviewer, /confidence\s+0-100/i);
		assert.match(
			reviewer,
			/Numeric confidence and vote\s+counts are\s+not evidence/i,
		);
	});

	it("keeps adversarial review inside the approved runner contract", () => {
		assert.match(
			skill,
			/\[the adversarial review procedure\]\(adversarial-review\.md\)/,
		);
		for (const phrase of [
			"Routine",
			"2 distinct eligible exact model IDs",
			"High",
			"3 distinct eligible IDs with distinct lenses",
			"candidate-dependent",
			"different from the report author",
			"P0–P3",
			"reproduced",
			"trace-backed",
			"unverified",
			"INCOMPLETE",
			"untrusted review data",
			"every original `AgentResult`",
			"identity-stripped projection",
			"16,000-character",
			"catalog source",
			"omitted, with reasons",
		]) {
			assert.ok(
				adversarialReview.includes(phrase),
				`missing adversarial contract: ${phrase}`,
			);
		}
		assert.match(adversarialReview, /at most five[\s\S]*at most seven/);
		assert.match(adversarialReview, /agent\(prompt, \{ kind: "review", node:/);
		assert.match(adversarialReview, /fresh\s+standalone session/i);
		assert.match(
			adversarialReview,
			/name \| agent kind \| role \| model \| worktree/,
		);
		assert.match(adversarialReview, /unified diff/i);
		assert.match(adversarialReview, /deleted or base-only/i);
		assert.match(adversarialReview, /child `INCOMPLETE`[\s\S]*`ok: true`/i);
		assert.match(
			adversarialReview,
			/author-family exclusion[\s\S]*origin is\s+unknown/i,
		);
		assert.match(adversarialExample, /function validateReviewReport/);
		assert.match(adversarialExample, /function parseReviewResult/);
		assert.doesNotMatch(adversarialReview, /subagent\s*\(\s*\{/);
		assert.doesNotMatch(adversarialReview, /confidence\s*[><=]/i);
	});
});
