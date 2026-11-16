import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { captureSurfacePiProcessIdentity } from "@nubl/maestro/adapters/pi/launch-operations";
import {
	judgeProcessIdentity,
	linuxProcessProbe,
	parseProcessStat,
	terminateProcessIdentity,
} from "@nubl/maestro/adapters/pi/process-identity";

const linux = process.platform === "linux";

function withDir(run: (dir: string, t: TestContext) => Promise<void> | void) {
	return async (t: TestContext) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-identity-test-"));
		try {
			await run(dir, t);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

// Capture timers are unref'd so a background attempt cannot hold the process
// open. These tests await that attempt directly, so they keep the loop alive
// the way a parent session does. Capture deadlines stay the ones under test.
// The anchor must never outlive the test: a capture that misses its deadline
// has to fail the file, not hang it.

// Runs one capture in a fresh process that holds nothing else open. The
// process exits on its own only if every timer the capture leaves pending is
// unref'd.

// A real process records its identity through the child-extension hook, then
// rewrites its title exactly as Pi's CLI setup does.
const IDENTITY_CHILD = `
const [extension, file, id, sessionFile] = process.argv.slice(1);
const { recordProcessIdentity } = await import(extension);
recordProcessIdentity(id, sessionFile, file);
process.title = "pi";
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;
async function spawnRecorded(file: string, id: string, sessionFile: string) {
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			"--input-type=module",
			"-e",
			IDENTITY_CHILD,
			"--",
			new URL(
				"../../maestro/adapters/pi/child/subagent-done.ts",
				import.meta.url,
			).href,
			file,
			id,
			sessionFile,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	let output = "";
	for await (const chunk of child.stdout) {
		output += String(chunk);
		if (output.includes("ready\n")) return child;
	}
	throw new Error("identity child exited before it was ready");
}
const paneOf = (shellPid: number | undefined) => ({
	getProcessInfo: () => ({ shellPid, pids: [], foregroundProcesses: [] }),
});

describe("process identity", () => {
	it(
		"captures a real child's identity across its title rewrite, SIGSTOP, and exit",
		withDir(async (dir) => {
			if (!linux) return;
			const sessionFile = join(dir, "s.jsonl");
			const file = `${sessionFile}.process.json`;
			const child = await spawnRecorded(file, "real", sessionFile);
			try {
				const pid = child.pid!;
				// The title rewrite removed every launch argument from cmdline.
				assert.doesNotMatch(
					readFileSync(`/proc/${pid}/cmdline`, "utf8"),
					/real|s\.jsonl/,
				);
				// The test process is the child's parent: the pane shell stand-in.
				const captured = await captureSurfacePiProcessIdentity(
					paneOf(process.pid),
					"pane",
					{ file, id: "real", sessionFile },
					{ timeoutMs: 5_000, intervalMs: 20 },
				);
				assert.equal(captured.pid, pid);
				assert.equal(
					captured.startTime,
					parseProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8")).startTime,
				);
				assert.equal(
					captured.pidNamespace,
					linuxProcessProbe.host().pidNamespace,
				);
				assert.deepEqual(judgeProcessIdentity(captured), { kind: "alive" });
				process.kill(pid, "SIGSTOP");
				assert.deepEqual(judgeProcessIdentity(captured), { kind: "alive" });
				process.kill(pid, "SIGCONT");
				const exited = once(child, "exit");
				assert.deepEqual(terminateProcessIdentity(captured), { kind: "alive" });
				await exited;
				assert.deepEqual(judgeProcessIdentity(captured), { kind: "exited" });
			} finally {
				child.kill("SIGKILL");
			}
		}),
	);

	it(
		"refuses a real record outside the pane shell, for another run, or without a Herdr shell",
		withDir(async (dir) => {
			if (!linux) return;
			const sessionFile = join(dir, "s.jsonl");
			const file = `${sessionFile}.process.json`;
			const child = await spawnRecorded(file, "real", sessionFile);
			const sibling = spawn(process.execPath, [
				"-e",
				"setInterval(()=>{},1e3)",
			]);
			try {
				const capture = (shellPid: number | undefined, id = "real") =>
					captureSurfacePiProcessIdentity(
						paneOf(shellPid),
						"pane",
						{ file, id, sessionFile },
						{ timeoutMs: 100, intervalMs: 20 },
					);
				await assert.rejects(
					capture(sibling.pid),
					new RegExp(
						`not the Herdr pane shell ${sibling.pid} or its descendant`,
					),
				);
				await assert.rejects(capture(process.pid, "other"), /another run/);
				await assert.rejects(capture(undefined), /reports no shell/);
				assert.equal((await capture(process.pid)).pid, child.pid);
			} finally {
				child.kill("SIGKILL");
				sibling.kill("SIGKILL");
			}
		}),
	);
});
