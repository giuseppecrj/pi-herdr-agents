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
					NODE_OPTIONS: `--import=${fetchStub}`,
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
	assert.match(workflow, /node-version:\s*26\.3\.0/);
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
	assert.match(guide, /Later version bumps use trusted publishing only/);
});

test("release workflow retries only exact-commit npm publishes", async () => {
	const workflow = await readFile(".github/workflows/publish.yml", "utf8");
	const guide = await readFile("RELEASING.md", "utf8");

	assert.match(workflow, /published\.gitHead === GITHUB_SHA/);
	assert.match(workflow, /already published from this commit/);
	assert.match(workflow, /Refusing to tag or create a GitHub Release/);
	assert.match(guide, /exact-commit retry|exact same commit/);
});
