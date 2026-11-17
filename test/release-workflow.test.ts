import "./clean-host-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function extractStepRun(workflow: string, stepName: string): string {
	const lines = workflow.split("\n");
	const step = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
	assert.notEqual(step, -1, `missing workflow step: ${stepName}`);
	const run = lines.findIndex(
		(line, index) => index > step && line.trim() === "run: |",
	);
	assert.notEqual(run, -1, `missing run block: ${stepName}`);
	const end = lines.findIndex(
		(line, index) =>
			index > run && line.trim().length > 0 && !line.startsWith("          "),
	);
	return lines
		.slice(run + 1, end === -1 ? undefined : end)
		.map((line) => line.replace(/^ {10}/, ""))
		.join("\n");
}

function workflowJobs(workflow: string): Map<string, string> {
	const lines = workflow.split("\n");
	const start = lines.indexOf("jobs:");
	assert.notEqual(start, -1, "missing jobs");
	const jobs = new Map<string, string>();
	let id: string | undefined;
	let body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\S/.test(line)) break;
		const header = line.match(/^ {2}([A-Za-z0-9_-]+):$/);
		if (header) {
			if (id) jobs.set(id, body.join("\n"));
			assert.ok(!jobs.has(header[1]), `duplicate job: ${header[1]}`);
			id = header[1];
			body = [];
			continue;
		}
		assert.ok(id || line.trim() === "", `job content before job id: ${line}`);
		body.push(line);
	}
	if (id) jobs.set(id, body.join("\n"));
	return jobs;
}

function workflowJob(workflow: string, id: string): string {
	const job = workflowJobs(workflow).get(id);
	assert.ok(job, `missing workflow job: ${id}`);
	return job;
}

function readOutputs(path: string): Record<string, string> {
	return existsSync(path)
		? Object.fromEntries(
				readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const [key, value] = line.split("=", 2);
						return [key, value];
					}),
			)
		: {};
}

interface ScriptRunResult {
	error?: unknown;
	outputs: Record<string, string>;
}

function runDetect(
	script: string,
	options: {
		eventName: "push" | "workflow_dispatch";
		ref?: string;
		previousVersion?: string;
		currentVersion?: string;
		beforeSha?: string;
	},
): ScriptRunResult {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-release-"));
	const output = join(dir, "github-output");
	let beforeSha = options.beforeSha ?? "0".repeat(40);
	let error: unknown;

	try {
		execFileSync("git", ["init", "--quiet"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "Release Test"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "release-test@example.com"], {
			cwd: dir,
		});
		execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

		if (options.previousVersion) {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					name: "pi-herdr-agents",
					version: options.previousVersion,
				}),
			);
			execFileSync("git", ["add", "package.json"], { cwd: dir });
			execFileSync("git", ["commit", "--quiet", "-m", "previous"], {
				cwd: dir,
			});
			beforeSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: dir,
				encoding: "utf8",
			}).trim();
		}

		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: "pi-herdr-agents",
				version: options.currentVersion ?? "0.0.2",
			}),
		);

		try {
			execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
				cwd: dir,
				env: {
					...process.env,
					BEFORE_SHA: beforeSha,
					GITHUB_EVENT_NAME: options.eventName,
					GITHUB_OUTPUT: output,
					GITHUB_REF: options.ref ?? "refs/heads/main",
				},
				stdio: "pipe",
			});
		} catch (caught) {
			error = caught;
		}

		return { error, outputs: readOutputs(output) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function runRegistryVerification(
	script: string,
	scenario:
		| "not-found"
		| "ambiguous-404"
		| "extra-404"
		| "redirect"
		| "registry-error"
		| "malformed-json"
		| "wrong-package"
		| "unpublished"
		| "wrong-version"
		| "exact-commit"
		| "foreign-commit",
): ScriptRunResult {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-registry-check-"));
	const output = join(dir, "github-output");
	const fetchStub = join(dir, "fetch-stub.mjs");
	let error: unknown;

	try {
		writeFileSync(
			fetchStub,
			`const scenario = process.env.REGISTRY_SCENARIO;
const name = process.env.PACKAGE_NAME;
const version = process.env.VERSION;
const sha = process.env.GITHUB_SHA;

globalThis.fetch = async (_url, options) => {
  if (scenario === "redirect") {
    if (options?.redirect !== "error") {
      return new Response(JSON.stringify({ name, versions: {} }), { status: 200 });
    }
    throw new TypeError("redirect rejected");
  }

  let status = 200;
  let body;
  switch (scenario) {
    case "not-found":
      status = 404;
      body = JSON.stringify({ error: "Not found" });
      break;
    case "ambiguous-404":
      status = 404;
      body = JSON.stringify({ error: "E503" });
      break;
    case "extra-404":
      status = 404;
      body = JSON.stringify({ error: "Not found", detail: "ambiguous" });
      break;
    case "registry-error":
      status = 503;
      body = JSON.stringify({ error: "Unavailable" });
      break;
    case "malformed-json":
      body = "{}\\n{}";
      break;
    case "wrong-package":
      body = JSON.stringify({ name: "other-package", versions: {} });
      break;
    case "unpublished":
      body = JSON.stringify({ name, versions: {} });
      break;
    case "wrong-version":
      body = JSON.stringify({ name, versions: { [version]: { version: version + "\\n" } } });
      break;
    case "exact-commit":
      body = JSON.stringify({ name, versions: { [version]: { version, gitHead: sha } } });
      break;
    case "foreign-commit":
      body = JSON.stringify({ name, versions: { [version]: { version, gitHead: "b".repeat(40) } } });
      break;
    default:
      throw new Error("Unknown registry scenario");
  }
  return new Response(body, { status, headers: { "content-type": "application/json" } });
};
`,
		);

		try {
			execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
				cwd: dir,
				env: {
					...process.env,
					GITHUB_OUTPUT: output,
					GITHUB_SHA: "a".repeat(40),
					NODE_OPTIONS: `--import=${pathToFileURL(fetchStub).href}`,
					PACKAGE_NAME: "pi-herdr-agents",
					REGISTRY_SCENARIO: scenario,
					REGISTRY_URL: "https://registry.test/",
					VERSION: "0.0.2",
				},
				stdio: "pipe",
			});
		} catch (caught) {
			error = caught;
		}

		return { error, outputs: readOutputs(output) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("CI checks pushes and pull requests without release authority", async () => {
	const workflow = await readFile(".github/workflows/check.yml", "utf8");

	assert.match(workflow, /^name: CI$/m);
	assert.match(workflow, /^  push:\n    branches:\n      - main$/m);
	assert.match(workflow, /^  pull_request:\n    branches:\n      - main$/m);
	assert.match(workflow, /^  workflow_dispatch:$/m);
	assert.doesNotMatch(workflow, /pull_request_target|paths(?:-ignore)?:/);
	assert.match(workflow, /^permissions:\n  contents: read$/m);
	assert.doesNotMatch(workflow, /:\s*write\b|secrets\.|id-token:/);
	assert.match(
		workflow,
		/group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
	);
	assert.match(workflow, /cancel-in-progress: true/);
	assert.match(workflow, /timeout-minutes: 15/);
	assert.match(workflow, /persist-credentials: false/);
	assert.match(workflow, /package-manager-cache: false/);
	assert.doesNotMatch(
		workflow,
		/npm publish|gh release|git push|test:integration/,
	);
});

test("CI runs the local gates with the release workflow's pinned tools", async () => {
	const workflow = workflowJob(
		await readFile(".github/workflows/check.yml", "utf8"),
		"checks",
	);
	const release = await readFile(".github/workflows/publish.yml", "utf8");
	const actions = [...workflow.matchAll(/uses: (\S+)/g)].map(
		(match) => match[1],
	);

	assert.deepEqual(actions, [
		"actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
		"actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
	]);
	for (const action of actions) assert.ok(release.includes(`uses: ${action}`));
	assert.equal(
		workflow.match(/node-version: (\S+)/)?.[1],
		release.match(/node-version: (\S+)/)?.[1],
	);
	assert.deepEqual(
		[...workflow.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]),
		[
			"npm ci --ignore-scripts",
			"npm run format:check",
			"npm run docs:tools:check",
			"npm run lint",
			"npm run typecheck",
			"npm test",
			"npm pack --dry-run",
			"git diff --check",
		],
	);
});

test("CI runs only unit tests on Windows without blocking", async () => {
	const workflow = await readFile(".github/workflows/check.yml", "utf8");
	const checks = workflowJob(workflow, "checks");
	const windows = workflowJob(workflow, "windows-unit");

	assert.ok(windows, "missing Windows unit job");
	assert.match(windows, /name: Unit tests \(Windows, non-blocking\)/);
	assert.match(windows, /^    runs-on: windows-latest$/m);
	assert.match(windows, /^    continue-on-error: true$/m);
	assert.match(windows, /^    timeout-minutes: 20$/m);
	assert.match(windows, /persist-credentials: false/);
	assert.match(windows, /package-manager-cache: false/);
	assert.deepEqual(
		[...windows.matchAll(/uses: (\S+)/g)].map((match) => match[1]),
		[...checks.matchAll(/uses: (\S+)/g)].map((match) => match[1]),
	);
	assert.equal(
		windows.match(/node-version: (\S+)/)?.[1],
		checks.match(/node-version: (\S+)/)?.[1],
	);
	assert.deepEqual(
		[...windows.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]),
		["npm ci --ignore-scripts", "npm test"],
	);
});

test("CI keeps Checks and reports check only when Checks succeeded", async () => {
	const workflow = await readFile(".github/workflows/check.yml", "utf8");
	const jobs = workflowJobs(workflow);

	assert.deepEqual(
		[...jobs.keys()],
		["checks", "check", "compatibility", "windows-unit"],
	);
	const checks = workflowJob(workflow, "checks");
	assert.match(checks, /^ {4}name: Checks$/m);
	assert.doesNotMatch(checks, /^ {4}needs:|^\s+if:|continue-on-error/m);

	const check = workflowJob(workflow, "check");
	assert.match(check, /^ {4}name: check$/m);
	assert.match(check, /^ {4}needs: checks$/m);
	assert.match(check, /^ {4}if: always\(\)$/m);
	assert.match(
		check,
		/^ {10}CHECKS_RESULT: \$\{\{ needs\.checks\.result \}\}$/m,
	);
	assert.deepEqual(
		[...check.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((match) => match[1]),
		['test "$CHECKS_RESULT" = success'],
	);
	assert.doesNotMatch(check, /uses:|npm |continue-on-error/);

	const compatibility = workflowJob(workflow, "compatibility");
	assert.match(compatibility, /^ {4}needs: check$/m);
	assert.doesNotMatch(compatibility, /^ {4}if:/m);
	assert.doesNotMatch(compatibility, /uses:|npm |continue-on-error/);
	assert.deepEqual(
		[...compatibility.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map(
			(match) => match[1],
		),
		["printf '%s\\n' 'Ordinary PR compatibility; not factory certification.'"],
	);

	const folded = compatibility.match(/^ {4}name: >-\n((?: {6}.+\n)+)/m);
	assert.ok(folded, "compatibility name must be a folded expression");
	const expression = folded[1]
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ");
	assert.equal(
		expression,
		"${{ (startsWith(github.head_ref, 'factory/pr/') || " +
			"startsWith(github.head_ref, 'factory/run/') || " +
			"github.event.pull_request.user.login == 'exe-dev-github-integration[bot]') && " +
			"'factory-compatibility' || 'factory-gates' }}",
	);
	// Evaluate the workflow's own expression: its operators (||, &&, ==,
	// startsWith) have the same meaning for these string operands in JavaScript.
	const evaluate = new Function(
		"startsWith",
		"github",
		`return ${expression.slice(4, -3).replaceAll(" == ", " === ")};`,
	);
	const nameFor = (headRef: string, login: string): string =>
		String(
			evaluate((value: string, prefix: string) => value.startsWith(prefix), {
				head_ref: headRef,
				event: { pull_request: { user: { login } } },
			}),
		);
	assert.equal(nameFor("factory/pr/12", "someone"), "factory-compatibility");
	assert.equal(nameFor("factory/run/12", "someone"), "factory-compatibility");
	assert.equal(
		nameFor("feature", "exe-dev-github-integration[bot]"),
		"factory-compatibility",
	);
	assert.equal(nameFor("feature", "someone"), "factory-gates");
	assert.equal(nameFor("factory/onboarding", "someone"), "factory-gates");
});

test("trusted gate dispatch is main-only and pins the product revision", async () => {
	const workflow = await readFile(".github/workflows/ci.yml", "utf8");
	const policy = JSON.parse(
		await readFile(".github/factory/gates/gates.json", "utf8"),
	);

	assert.match(workflow, /^name: candidate gates$/m);
	assert.match(
		workflow,
		/^run-name: gates \$\{\{ inputs\.candidate_sha \}\} \$\{\{ inputs\.nonce \}\}$/m,
	);
	assert.match(workflow, /^on:\n {2}workflow_dispatch:\n {4}inputs:$/m);
	assert.doesNotMatch(
		workflow,
		/^ {2}(?:push|pull_request|pull_request_target|schedule|workflow_run):/m,
	);
	assert.match(workflow, /^permissions:\n {2}contents: read$/m);
	assert.doesNotMatch(workflow, /secrets\.|id-token:/);
	for (const input of ["candidate_sha", "nonce"]) {
		assert.match(
			workflow,
			new RegExp(
				`^ {6}${input}:\\n {8}description: .+\\n {8}required: true\\n {8}type: string$`,
				"m",
			),
		);
	}
	assert.match(workflow, /^ {8}default: '\[\]'$/m);
	assert.match(
		workflow,
		/^ {8}default: 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945$/m,
	);
	for (const input of ["heldout_dir", "heldout_digest"]) {
		assert.match(workflow, new RegExp(`^ {6}${input}:$`, "m"));
	}

	const product = workflow.match(
		/^ {2}FACTORY_PRODUCT_REVISION: ([0-9a-f]{40})$/m,
	)?.[1];
	assert.ok(product, "product revision must be a full lowercase SHA");
	assert.equal(policy.toolingRevision, product);
	assert.equal(policy.version, 2);

	assert.deepEqual([...workflowJobs(workflow).keys()], ["gates", "report"]);
	const gates = workflowJob(workflow, "gates");
	assert.match(
		gates,
		/^ {4}if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}$/m,
	);
	assert.doesNotMatch(gates, /^ {4}permissions:/m);
	assert.match(
		gates,
		/\[\[ "\$FACTORY_PRODUCT_REVISION" =~ \^\[0-9a-f\]\{40\}\$ \]\]/,
	);
	for (const action of gates.matchAll(/uses: (\S+)/g)) {
		assert.match(action[1], /^actions\/[a-z-]+@[0-9a-f]{40}$/);
	}
	assert.match(
		gates,
		/with:\n {10}repository: nublai\/pi-herdr-factorio\n {10}ref: \$\{\{ env\.FACTORY_PRODUCT_REVISION \}\}\n {10}path: product\n {10}persist-credentials: false/,
	);
	assert.match(
		gates,
		/with:\n {10}ref: \$\{\{ github\.sha \}\}\n {10}path: target\n {10}fetch-depth: 0\n {10}persist-credentials: false/,
	);
	assert.match(
		gates,
		/test "\$\(git -C product rev-parse HEAD\)" = "\$FACTORY_PRODUCT_REVISION"/,
	);
	assert.match(
		gates,
		/test "\$\(git -C target rev-parse HEAD\)" = "\$GATE_SHA"/,
	);
	assert.match(
		gates,
		/readFileSync\('target\/\.github\/factory\/gates\/gates\.json', 'utf8'\)\);\n\s+assert\.equal\(policy\.toolingRevision, process\.env\.FACTORY_PRODUCT_REVISION\);/,
	);
	assert.match(gates, /\[\[ "\$CANDIDATE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
	assert.match(gates, /git -C target fetch --no-tags origin "\$CANDIDATE_SHA"/);
	assert.match(gates, /npm --prefix product ci --ignore-scripts/);
	assert.match(gates, /docker pull node@sha256:[0-9a-f]{64}\n/);

	for (const [name, value] of [
		["CANDIDATE_SHA", "inputs.candidate_sha"],
		["GATE_SHA", "github.sha"],
		["NONCE", "inputs.nonce"],
		["REPLACEMENTS", "inputs.replacements"],
		["REPLACEMENTS_DIGEST", "inputs.replacements_digest"],
		["HELDOUT_DIR", "inputs.heldout_dir"],
		["HELDOUT_DIGEST", "inputs.heldout_digest"],
	]) {
		assert.ok(
			gates.includes(`${name}: \${{ ${value} }}`),
			`gates must pass ${name} from ${value}`,
		);
	}
	const run = extractStepRun(gates, "Run trusted gates");
	assert.equal(
		run.replace(/\\\n\s*/g, "").trim(),
		"node --experimental-strip-types product/host/cli/index.ts gates " +
			'--repository "$PWD/target" --gate-sha "$GATE_SHA" --candidate-sha "$CANDIDATE_SHA" ' +
			'--nonce "$NONCE" --output "$RUNNER_TEMP/gate-results" ' +
			'--replacements "$REPLACEMENTS" --replacements-digest "$REPLACEMENTS_DIGEST" ' +
			'--heldout-dir "$HELDOUT_DIR" --heldout-digest "$HELDOUT_DIGEST"',
	);
	assert.match(
		gates,
		/- name: Upload trusted receipt\n {8}if: \$\{\{ always\(\) && !cancelled\(\) \}\}\n {8}uses: actions\/upload-artifact@[0-9a-f]{40}\n {8}with:\n {10}name: gate-receipt\n {10}path: \$\{\{ runner\.temp \}\}\/gate-results\/\n {10}if-no-files-found: error/,
	);
});

test("trusted reporter reads only the receipt and binds the exact head", async () => {
	const workflow = await readFile(".github/workflows/ci.yml", "utf8");
	const report = workflowJob(workflow, "report");

	assert.match(
		report,
		/^ {4}if: \$\{\{ always\(\) && !cancelled\(\) && github\.ref == 'refs\/heads\/main' \}\}$/m,
	);
	assert.match(report, /^ {4}needs: gates$/m);
	assert.match(
		report,
		/^ {4}permissions:\n {6}actions: read\n {6}checks: write\n {4}steps:$/m,
	);
	assert.deepEqual(
		[...report.matchAll(/uses: (\S+)/g)].map((match) => match[1].split("@")[0]),
		["actions/download-artifact", "actions/upload-artifact"],
	);
	for (const action of report.matchAll(/uses: (\S+)/g)) {
		assert.match(action[1], /@[0-9a-f]{40}$/);
	}
	assert.doesNotMatch(
		report,
		/actions\/checkout|npm |npx |strip-types|product\/|target\/|child_process|import\(|secrets\./,
	);
	assert.match(
		report,
		/download-artifact@[0-9a-f]{40}\n {8}continue-on-error: true\n {8}with:\n {10}name: gate-receipt\n/,
	);
	assert.match(report, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m);
	assert.match(
		report,
		/^ {10}TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}$/m,
	);
	assert.match(
		report,
		/^ {10}REPORT_INPUT: \$\{\{ runner\.temp \}\}\/factory-report-input\/receipt\.json$/m,
	);
	assert.deepEqual(
		[...report.matchAll(/readFileSync\(([^,)]+)/g)].map((match) => match[1]),
		["e.REPORT_INPUT"],
	);

	for (const binding of [
		"assert.equal(e.GITHUB_REF, 'refs/heads/main');",
		"assert.equal(e.GITHUB_EVENT_NAME, 'workflow_dispatch');",
		"assert.equal(e.GITHUB_ACTOR, 'exe-dev-github-integration[bot]');",
		"assert.equal(e.TRIGGERING_ACTOR, e.GITHUB_ACTOR);",
		"assert.equal(e.GITHUB_RUN_ATTEMPT, '1');",
		"assert.equal(e.GATE_RESULT, 'success');",
		"assert.equal(r.status, 'passed');",
		"assert.equal(r.modelCalls, 0);",
		"assert.equal(r.candidateSha, e.CANDIDATE_SHA);",
		"assert.equal(r.gateSha, e.GATE_SHA);",
		"assert.equal(r.nonce, e.NONCE);",
		"assert.equal(r.heldoutDigest, e.HELDOUT_DIGEST);",
		"assert.ok(expected.every(name => r.requiredChecks.includes(name)));",
		"assert.equal(r.checks.length, r.requiredChecks.length);",
		"assert.equal(matching.length, 1);",
		"assert.equal(matching[0].exitCode, 0);",
		"} catch { passed = false; }",
		"body: JSON.stringify({name: 'factory-gates', head_sha: e.CANDIDATE_SHA,",
		"conclusion: passed ? 'success' : 'failure',",
		"assert.equal(check.app?.id, 15368);",
		"assert.equal(check.head_sha, e.CANDIDATE_SHA);",
		"assert.equal(check.external_id, externalId);",
	]) {
		assert.ok(report.includes(binding), `reporter must keep: ${binding}`);
	}
	assert.ok(
		report.includes(
			"const expected = ['install', 'baseline_tests', 'typecheck', 'lint', 'format',\n" +
				"            'main_tests', 'candidate_tests', 'heldout'];",
		),
		"reporter must require every trusted gate",
	);
	assert.ok(
		report.indexOf("let passed = false;") < report.indexOf("passed = true;"),
	);
	assert.match(
		report,
		/- name: Upload reporter-owned identity\n {8}uses: actions\/upload-artifact@[0-9a-f]{40}\n {8}with:\n {10}name: factory-report\n {10}path: \$\{\{ runner\.temp \}\}\/factory-report\/receipt\.json\n {10}if-no-files-found: error/,
	);
});

test("Linux integration pins its tools and always cleans up without publication authority", async () => {
	const workflow = await readFile(
		".github/workflows/linux-integration.yml",
		"utf8",
	);
	assert.match(workflow, /^  push:\n    branches:\n      - main$/m);
	assert.match(workflow, /^  workflow_dispatch:$/m);
	assert.match(workflow, /^permissions:\n  contents: read$/m);
	assert.doesNotMatch(
		workflow,
		/pull_request_target|:\s*write\b|secrets\.|id-token:|continue-on-error|npm publish|gh release/,
	);
	assert.match(workflow, /runs-on: ubuntu-24\.04/);
	assert.match(workflow, /timeout-minutes: 45/);
	assert.match(workflow, /persist-credentials: false/);
	assert.match(workflow, /v0\.9\.5\/herdr-linux-x86_64/);
	assert.match(workflow, /core\/0\.1\.20\/herdr-core-linux-x86_64\.tar\.gz/);
	assert.match(
		workflow,
		/ac6b86890c451a37584620aaa438b71bc0d0bd430a2e7c1d7e095f052c414e74 {2}\$RUNNER_TEMP\/core\.tar\.gz/,
	);
	assert.equal(workflow.match(/sha256sum --check/g)?.length, 2);
	assert.match(workflow, /PI_TEST_LIVE=0/);
	assert.match(workflow, /scripts\/run-linux-integration\.ts/);
	assert.match(
		workflow,
		/name: Shut down the owned legacy lab\n        if: always\(\)/,
	);
	assert.match(workflow, /scripts\/lab\.ts down/);
	assert.match(
		workflow,
		/name: Upload deterministic test evidence\n        if: always\(\)/,
	);
	assert.match(
		workflow,
		/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
	);
	assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@v\d/);
	assert.match(workflow, /retention-days: 7/);
});

test("Linux integration driver rejects missing prerequisites instead of skipping", () => {
	assert.throws(
		() =>
			execFileSync(
				process.execPath,
				["--experimental-strip-types", "scripts/run-linux-integration.ts"],
				{
					env: { ...process.env, HERDR_BIN: "", PI_TEST_LIVE: "0" },
					stdio: "pipe",
					timeout: 10_000,
				},
			),
		/Linux \/proc is required|HERDR_BIN must be set/,
	);
});

test("release workflow uses package.json identity and trusted publishing", async () => {
	const workflow = await readFile(".github/workflows/publish.yml", "utf8");
	const pkg = JSON.parse(await readFile("package.json", "utf8"));

	assert.equal(pkg.name, "pi-herdr-agents");
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
	assert.match(pkg.scripts.test, /--experimental-strip-types/);
	assert.match(pkg.scripts["test:integration"], /--experimental-strip-types/);
	assert.match(workflow, /branches:\n\s+- main/);
	assert.match(workflow, /paths:\n\s+- package\.json/);
	assert.match(workflow, /concurrency:\n\s+group: pi-herdr-agents-release/);
	assert.match(workflow, /id-token:\s*write/);
	assert.match(workflow, /contents:\s*write/);
	assert.match(workflow, /node-version:\s*26\.12\.1/);
	assert.doesNotMatch(workflow, /npm install -g/);
	assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@v\d/);
	assert.match(
		workflow,
		/actions\/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09/,
	);
	assert.match(
		workflow,
		/actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/,
	);
	assert.match(workflow, /package-manager-cache:\s*false/);
	assert.doesNotMatch(workflow, /cache:\s*npm/);
	assert.equal(
		workflow.match(/persist-credentials: false/g)?.length,
		2,
		"each checkout must avoid persisting credentials",
	);
	assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
	assert.match(workflow, /gh auth setup-git/);
	assert.match(workflow, /REGISTRY_URL: https:\/\/registry\.npmjs\.org\//);
	assert.match(workflow, /await fetch\(url/);
	assert.match(workflow, /redirect: "error"/);
	assert.match(workflow, /npm run lint/);
	assert.match(workflow, /npm run typecheck/);
	assert.match(workflow, /npm test/);
	assert.match(workflow, /npm publish --access public --provenance/);
	assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
	assert.match(workflow, /gh release create "\$TAG"/);
	assert.match(workflow, /--generate-notes/);

	const publish = workflow.indexOf("- name: Publish package to npm");
	const tag = workflow.indexOf("- name: Create and push tag");
	const release = workflow.indexOf("- name: Create GitHub release");
	assert.ok(
		publish !== -1 && publish < tag,
		"npm publish must precede tagging",
	);
	assert.ok(tag < release, "tagging must precede the GitHub Release");
	assert.doesNotMatch(workflow, /pi-herdr-subagents/);
});

test("release detection executes the guarded push and dispatch branches", async () => {
	const workflow = await readFile(".github/workflows/publish.yml", "utf8");
	const detect = extractStepRun(workflow, "Detect package version bump");

	const initial = runDetect(detect, { eventName: "push" });
	assert.equal(initial.error, undefined);
	assert.equal(initial.outputs.release, "false");

	const unchanged = runDetect(detect, {
		eventName: "push",
		previousVersion: "0.0.2",
		currentVersion: "0.0.2",
	});
	assert.equal(unchanged.error, undefined);
	assert.equal(unchanged.outputs.release, "false");

	const bumped = runDetect(detect, {
		eventName: "push",
		previousVersion: "0.0.2",
		currentVersion: "0.0.3",
	});
	assert.equal(bumped.error, undefined);
	assert.equal(bumped.outputs.release, "true");

	const majorBump = runDetect(detect, {
		eventName: "push",
		previousVersion: "0.9.9",
		currentVersion: "1.0.0",
	});
	assert.equal(majorBump.error, undefined);
	assert.equal(majorBump.outputs.release, "true");

	const downgrade = runDetect(detect, {
		eventName: "push",
		previousVersion: "0.0.2",
		currentVersion: "0.0.1",
	});
	assert.ok(downgrade.error, "version downgrade must fail closed");

	const invalid = runDetect(detect, {
		eventName: "workflow_dispatch",
		currentVersion: "0.2",
	});
	assert.ok(invalid.error, "invalid package version must fail closed");

	const unreachable = runDetect(detect, {
		eventName: "push",
		beforeSha: "f".repeat(40),
	});
	assert.equal(unreachable.error, undefined);
	assert.equal(unreachable.outputs.release, "false");

	const mainDispatch = runDetect(detect, { eventName: "workflow_dispatch" });
	assert.equal(mainDispatch.error, undefined);
	assert.equal(mainDispatch.outputs.release, "true");

	const branchDispatch = runDetect(detect, {
		eventName: "workflow_dispatch",
		ref: "refs/heads/release-test",
	});
	assert.ok(branchDispatch.error, "non-main dispatch must fail closed");
});

test("npm registry responses are structured and fail closed", async () => {
	const workflow = await readFile(".github/workflows/publish.yml", "utf8");
	const verify = extractStepRun(
		workflow,
		"Verify package version is unpublished",
	);

	const missing = runRegistryVerification(verify, "not-found");
	assert.equal(missing.error, undefined);
	assert.deepEqual(missing.outputs, {
		package_exists: "false",
		published: "false",
	});

	for (const scenario of [
		"ambiguous-404",
		"extra-404",
		"redirect",
		"registry-error",
		"malformed-json",
		"wrong-package",
		"wrong-version",
		"foreign-commit",
	] as const) {
		const result = runRegistryVerification(verify, scenario);
		assert.ok(result.error, `${scenario} must fail closed`);
		assert.deepEqual(result.outputs, {});
	}

	const unpublished = runRegistryVerification(verify, "unpublished");
	assert.equal(unpublished.error, undefined);
	assert.deepEqual(unpublished.outputs, {
		package_exists: "true",
		published: "false",
	});

	const exactCommit = runRegistryVerification(verify, "exact-commit");
	assert.equal(exactCommit.error, undefined);
	assert.deepEqual(exactCommit.outputs, {
		package_exists: "true",
		published: "true",
	});
});

test("release workflow enforces bootstrap-only token and trusted publishing", async () => {
	const workflow = await readFile(".github/workflows/publish.yml", "utf8");
	const guide = await readFile("RELEASING.md", "utf8");

	assert.match(
		workflow,
		/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*!=\s*''\s*&&\s*secrets\.NPM_TOKEN\s*\|\|\s*''\s*\}\}/,
	);
	assert.match(workflow, /PACKAGE_EXISTS/);
	assert.match(workflow, /NPM_TOKEN is bootstrap-only/);
	assert.match(workflow, /OIDC trusted publishing \(no NPM_TOKEN\)/);
	assert.match(workflow, /unset NODE_AUTH_TOKEN/);
	assert.match(workflow, /package does not exist/);

	assert.match(guide, /workflow fails if `NPM_TOKEN` is still configured/);
	assert.match(guide, /other refs are rejected/);
	assert.match(guide, /releases use npm trusted publishing \(OIDC\)/);
});

test("release workflow retries only exact-commit npm publishes", async () => {
	const workflow = await readFile(".github/workflows/publish.yml", "utf8");
	const guide = await readFile("RELEASING.md", "utf8");

	assert.match(workflow, /published\.gitHead === GITHUB_SHA/);
	assert.match(workflow, /already published from this commit/);
	assert.match(workflow, /Refusing to tag or create a GitHub Release/);
	assert.match(guide, /exact-commit retry|exact same commit/);
});
