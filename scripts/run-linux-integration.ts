/** Linux CI: reuse the private verification lab, then run every integration fixture. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateDir } from "../.pi/skills/verify-pi-herdr-agents/scripts/path-guards.ts";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord, isString } from "../maestro/core/config/type-guards.ts";
import { coreResults, coreSession } from "../test/integration/core-parent.ts";

assert.equal(
	process.platform,
	"linux",
	"Linux /proc is required, not a skipped gate",
);
for (const key of [
	"HERDR_BIN",
	"HERDR_CORE_BIN",
	"PI_BIN",
	"VERIFY_EVIDENCE_ROOT",
])
	assert.ok(process.env[key], `${key} must be set`);
assert.equal(process.env.PI_TEST_LIVE, "0", "CI must use the local provider");

const labScript = ".pi/skills/verify-pi-herdr-agents/scripts/lab.ts";
function lab(...args: string[]): string {
	return execFileSync(
		process.execPath,
		["--experimental-strip-types", labScript, ...args],
		{
			encoding: "utf8",
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
		},
	);
}

console.log(lab("doctor"));
console.log(lab("up"));
const summary = JSON.parse(lab("state"));
assert.ok(isRecord(summary) && isString(summary.runDir));
assertPrivateDir(summary.runDir);
// The public state command intentionally omits the environment.
const state = JSON.parse(
	readFileSync(join(summary.runDir, "state.json"), "utf8"),
);
assert.ok(isRecord(state));
assert.ok(isRecord(state.env));
assert.ok(isString(state.socket));
assert.ok(isString(state.workspace));
assert.ok(isString(state.parentPane));
assert.ok(isString(state.parentSession));
const env: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(state.env)) {
	assert.ok(isString(value), `Invalid lab environment: ${key}`);
	env[key] = value;
}

console.log(lab("prompt", "launch", "ci"));
const deadline = performance.now() + 180_000;
let parentTab: string | undefined;
for (;;) {
	const entries = coreSession(state.parentSession);
	const results = coreResults(entries);
	if (results.length > 0) {
		assert.equal(results.length, 1, "one automatic delivery");
		const result = results[0];
		assert.ok(isRecord(result.details));
		assert.equal(result.details.name, "Echo-ci");
		assert.equal(result.details.error, undefined);
		assert.match(
			String(result.content),
			/<subagent_report from="Echo-ci" kind="result">/,
		);
		assert.match(String(result.content), /CHILD_RESULT_ci/);
		assert.ok(isString(result.details.sessionFile));
		assert.ok(existsSync(result.details.sessionFile));
		const continued = entries
			.slice(entries.indexOf(result) + 1)
			.some(
				(entry) =>
					isRecord(entry.message) &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("PARENT_CONTINUED_ci"),
			);
		const listing = JSON.parse(lab("panes"));
		assert.ok(isRecord(listing) && isRecord(listing.result));
		assert.ok(Array.isArray(listing.result.panes));
		const [parent] = listing.result.panes;
		if (
			continued &&
			listing.result.panes.length === 1 &&
			isRecord(parent) &&
			parent.pane_id === state.parentPane
		) {
			assert.ok(isString(parent.tab_id));
			parentTab = parent.tab_id;
			break;
		}
	}
	assert.ok(
		performance.now() < deadline,
		"real-parent delegation did not complete and release its pane",
	);
	await delay(250);
}
console.log(lab("evidence", "ci"));

const files = readdirSync("test/integration")
	.filter((file) => file.endsWith(".test.ts"))
	.sort()
	.map((file) => `test/integration/${file}`);
assert.ok(files.length > 0, "integration tests must be discovered");
const result = spawnSync(
	process.execPath,
	[
		"--experimental-strip-types",
		"--test",
		"--test-reporter=tap",
		"--test-concurrency=1",
		...files,
	],
	{
		stdio: "inherit",
		timeout: 35 * 60_000,
		env: {
			...env,
			HERDR_BIN: process.env.HERDR_BIN,
			HERDR_CORE_BIN: process.env.HERDR_CORE_BIN,
			PI_BIN: process.env.PI_BIN,
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: state.socket,
			HERDR_WORKSPACE_ID: state.workspace,
			HERDR_PANE_ID: state.parentPane,
			HERDR_TAB_ID: parentTab,
			PI_TEST_LIVE: "0",
		},
	},
);
if (result.error) throw result.error;
assert.equal(
	result.status,
	0,
	`integration suite failed (${result.signal ?? result.status})`,
);
