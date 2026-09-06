import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const biomeConfig = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
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
const planSkill = readFileSync(
	join(root, "pi-extension", "subagents", "plan-skill.md"),
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
	it("checks the shipped review helper", () => {
		assert.ok(
			biomeConfig.files?.includes.includes(
				"skills/orchestrate/adversarial-review-example.js",
			),
			"missing shipped helper from Biome coverage",
		);
		for (const script of ["format", "format:check", "lint"]) {
			assert.match(
				manifest.scripts?.[script] ?? "",
				/skills\/orchestrate\/adversarial-review-example\.js/,
				`missing shipped helper from ${script}`,
			);
		}
	});

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
		assert.equal(
			packageFiles.has("pi-extension/subagents/workflow-worker.js"),
			false,
		);
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

	it("keeps the public subagent review contract in the bundled skill", () => {
		for (const phrase of [
			"local paths, URLs, tickets",
			"deleted and base-only",
			"at least two fresh discovery reviewers",
			"exact authenticated `provider/model-id`",
			"author families",
			"tools:",
			"`read,bash` is **not** read-only",
			"untrusted review data",
			"Do not poll",
			"parent synthesizes",
		]) {
			assert.ok(skill.includes(phrase), `missing skill contract: ${phrase}`);
		}
		assert.match(skill, /subagent\s*\(\s*\)/);
		assert.doesNotMatch(skill, /herdr_workflow|APPROVE <|\bWorker\b|\bvm\b/);
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

	it("keeps adversarial review in the public-child topology", () => {
		assert.match(
			skill,
			/\[the adversarial review procedure\]\(adversarial-review\.md\)/,
		);
		for (const phrase of [
			"Routine",
			"2 fresh reviewers",
			"High",
			"3 fresh reviewers with distinct lenses",
			"cross-family verifier",
			"P0–P3",
			"reproduced",
			"trace-backed",
			"unverified",
			"INCOMPLETE",
			"untrusted review data",
			"public `subagent()`",
			"parent synthesis",
		]) {
			assert.ok(
				adversarialReview.includes(phrase),
				`missing adversarial contract: ${phrase}`,
			);
		}
		assert.match(adversarialReview, /fresh\s+standalone/i);
		assert.match(
			adversarialReview,
			/name \| agent kind \| role \| model \| worktree/,
		);
		assert.match(adversarialReview, /deleted or base-only/i);
		assert.match(adversarialReview, /child\s+`INCOMPLETE`/i);
		assert.match(
			adversarialReview,
			/author-family exclusion[\s\S]*origin is unknown/i,
		);
		assert.match(adversarialExample, /function validateReviewReport/);
		assert.match(adversarialExample, /function parseReviewResult/);
		assert.match(adversarialExample, /function validatePublicReviewResults/);
		assert.doesNotMatch(
			adversarialReview,
			/herdr_workflow|APPROVE <|runner-owned/,
		);
		assert.doesNotMatch(adversarialReview, /confidence\s*[><=]/i);
	});

	it("pins the Phase 7 reviewer evidence before launch", () => {
		for (const phrase of [
			"canonical repository root",
			"exact comparison base and head SHAs",
			"Dirty-state inventory and fingerprint",
			"Complete diff and deleted/base-only evidence",
			'cwd: "<canonical repository root>"',
			"untrusted review data",
		]) {
			assert.ok(planSkill.includes(phrase), `missing review input: ${phrase}`);
		}
	});
});
