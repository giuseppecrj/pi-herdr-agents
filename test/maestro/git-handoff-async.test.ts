import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("migrated launch/query and Git preflight/handoff production paths contain no synchronous subprocess calls", () => {
	const source = (path: string) =>
		readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
	// H3: the Pi launch and Git handoff paths live in @nubl/maestro; scan the
	// installed emitted modules the host actually loads.
	const installed = (specifier: string) =>
		readFileSync(new URL(import.meta.resolve(specifier)), "utf8");
	for (const [path, text] of [
		...[
			"maestro/surfaces/herdr/herdr-pane.ts",
			"maestro/surfaces/herdr/herdr-surface-provider.ts",
		].map((path) => [path, source(path)]),
		...[
			"@nubl/maestro/adapters/pi/pi-harness-adapter",
			"@nubl/maestro/adapters/pi/launch",
			"@nubl/maestro/adapters/pi/launch-resume",
		].map((specifier) => [specifier, installed(specifier)]),
	])
		assert.doesNotMatch(
			text,
			/\b(?:execSync|execFileSync|spawnSync|herdrExec)\s*\(/,
			path,
		);
	const cli = source("maestro/surfaces/herdr/herdr-cli.ts").replace(
		/export function herdrExec\([\s\S]*?\n}\n/,
		"",
	);
	assert.doesNotMatch(cli, /\b(?:execFileSync|spawnSync|execSync)\s*\(/);
	const herdr = source("maestro/surfaces/herdr/herdr.ts");
	const withoutDiagnostic = herdr.replace(
		/export function readHerdrScreen\([\s\S]*?\n}\n/,
		"",
	);
	assert.doesNotMatch(withoutDiagnostic, /\bherdrExec\s*\(/);
	const git = installed("@nubl/maestro/runtime/worktree-operations").split(
		"const CLEANUP_TIMEOUT_MS",
	);
	assert.equal(git.length, 2, "worktree-operations cleanup marker");
	assert.ok(git[0].includes("export async function"), "handoff code scanned");
	assert.doesNotMatch(git[0], /\b(?:execFileSync|spawnSync|execSync)\s*\(/);
});
