import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

for (const fails of [false, true])
	test(`Linux CI driver reads private state, isolates env and propagates suite ${fails ? "failure" : "success"}`, {
		skip: process.platform !== "linux" ? "Linux-only driver" : false,
	}, () => {
		const dir = mkdtempSync(join(tmpdir(), "piha-ci-driver-"));
		try {
			const session = join(dir, "parent.jsonl");
			const child = join(dir, "child.jsonl");
			writeFileSync(child, "fixture\n");
			writeFileSync(
				session,
				[
					{
						type: "custom_message",
						customType: "subagent_result",
						details: { name: "Echo-ci", sessionFile: child },
						content:
							'<subagent_report from="Echo-ci" kind="result">CHILD_RESULT_ci</subagent_report>',
					},
					{
						type: "message",
						message: { role: "assistant", content: "PARENT_CONTINUED_ci" },
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			writeFileSync(
				join(dir, "state.json"),
				JSON.stringify({
					env: { HOME: dir, PATH: process.env.PATH },
					socket: join(dir, "unused.sock"),
					workspace: "w1",
					parentPane: "w1:p1",
					parentSession: session,
				}),
			);
			const labDir = join(dir, ".pi/skills/verify-pi-herdr-agents/scripts");
			mkdirSync(labDir, { recursive: true });
			// Stub only the external lab CLI: no Herdr or Pi process is started.
			writeFileSync(
				join(labDir, "lab.ts"),
				`
if (process.argv[2] === "state") console.log(JSON.stringify({ runDir: ${JSON.stringify(dir)} }));
else if (process.argv[2] === "panes") console.log(JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1" }] } }));
else console.log("fixture", process.argv[2]);
`,
			);
			mkdirSync(join(dir, "test/integration"), { recursive: true });
			writeFileSync(
				join(dir, "test/integration/probe.test.ts"),
				`
import assert from "node:assert/strict";
assert.equal(process.env.HOME, ${JSON.stringify(dir)});
assert.equal(process.env.HERDR_ENV, "1");
assert.equal(process.env.HERDR_SOCKET_PATH, ${JSON.stringify(join(dir, "unused.sock"))});
assert.equal(process.env.HERDR_WORKSPACE_ID, "w1");
assert.equal(process.env.HERDR_PANE_ID, "w1:p1");
assert.equal(process.env.HERDR_TAB_ID, "w1:t1");
assert.equal(process.env.PI_TEST_LIVE, "0");
assert.equal(process.env.HC_SOCKET, undefined);
assert.equal(process.env.HC_TERMINAL_ID, undefined);
assert.equal(process.env.PIHA_FOREIGN_CONTEXT, undefined);
${fails ? 'assert.fail("suite failure fixture");' : ""}
`,
			);
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					resolve("scripts/run-linux-integration.ts"),
				],
				{
					cwd: dir,
					encoding: "utf8",
					timeout: 20_000,
					env: {
						...process.env,
						HERDR_BIN: "/bin/false",
						HERDR_CORE_BIN: "/bin/false",
						PI_BIN: process.execPath,
						VERIFY_EVIDENCE_ROOT: dir,
						PI_TEST_LIVE: "0",
						HC_SOCKET: "/not-our-core.sock",
						HC_TERMINAL_ID: "t999",
						PIHA_FOREIGN_CONTEXT: "do not forward",
					},
				},
			);
			assert.equal(result.error, undefined);
			assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
			assert.match(result.stdout, /fixture evidence/);
			if (fails) assert.match(result.stdout, /suite failure fixture/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
