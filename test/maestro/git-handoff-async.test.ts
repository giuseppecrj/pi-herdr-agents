import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("migrated launch/query and Git preflight/handoff production paths contain no synchronous subprocess calls", () => {
	const source = (path: string) =>
		readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
	for (const path of [
		"maestro/surfaces/herdr/herdr-pane.ts",
		"maestro/surfaces/herdr/herdr-surface-provider.ts",
		"maestro/adapters/pi/pi-harness-adapter.ts",
		"maestro/adapters/pi/launch.ts",
		"maestro/adapters/pi/launch-resume.ts",
	])
		assert.doesNotMatch(
			source(path),
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
	const git = source("maestro/runtime/worktree-operations.ts").split(
		"const CLEANUP_TIMEOUT_MS",
	)[0];
	assert.doesNotMatch(git, /\b(?:execFileSync|spawnSync|execSync)\s*\(/);
});
