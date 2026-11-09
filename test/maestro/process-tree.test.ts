import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAcceptCommand } from "../../maestro/adapters/pi/accept-runner.ts";
import { killProcessTree } from "../../maestro/adapters/pi/process-tree.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// SAFETY: process.kill throws Node system errors, which carry `code`.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function until(
	condition: () => boolean,
	message: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(message);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function readPid(file: string): number {
	try {
		return Number.parseInt(readFileSync(file, "utf8"), 10) || 0;
	} catch {
		return 0;
	}
}

/** Source of a node process that starts a node grandchild and records its pid. */
const SPAWNS_GRANDCHILD = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync("grandchild.pid", String(grandchild.pid));
writeFileSync("parent.pid", String(process.pid));
setInterval(() => {}, 1000);
`;

/**
 * Teardown that does not depend on the code under test: end each recorded
 * process on its own, so a failed assertion cannot leave a node process
 * running (and keep the test worker alive).
 */
function reap(dir: string, ...extra: number[]): void {
	const pids = [
		...extra,
		readPid(join(dir, "parent.pid")),
		readPid(join(dir, "grandchild.pid")),
	];
	for (const pid of pids) {
		if (pid <= 0 || !alive(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

test("killProcessTree ends a detached process and the process it started", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "process-tree-"));
	const child = spawn(process.execPath, ["-e", SPAWNS_GRANDCHILD], {
		cwd: dir,
		detached: true,
		windowsHide: true,
		stdio: "ignore",
	});
	// The test must not wait on the process it is about to kill.
	child.unref();
	t.after(() => {
		reap(dir, child.pid ?? 0);
		rmSync(dir, { recursive: true, force: true });
	});
	const pid = child.pid;
	assert.ok(pid, "the parent started");
	await until(() => readPid(join(dir, "grandchild.pid")) > 0, "no grandchild");
	const grandchild = readPid(join(dir, "grandchild.pid"));
	assert.equal(alive(pid) && alive(grandchild), true);

	assert.equal(killProcessTree(pid, "SIGKILL"), true);

	await until(() => !alive(pid), "the parent survived");
	await until(() => !alive(grandchild), "the grandchild survived");
});

test("killProcessTree reports a process that is already gone", () => {
	// 2 ** 31 - 1 is above every platform's pid_max (Linux caps at 2 ** 22), so
	// no live process or group can own it and the call can hit nothing real.
	assert.equal(killProcessTree(2 ** 31 - 1, "SIGKILL"), false);
});

test("a timed-out accept check leaves nothing it started running", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "accept-tree-"));
	// If the runner fails to end the tree, still end what it left behind.
	t.after(() => {
		reap(dir);
		rmSync(dir, { recursive: true, force: true });
	});
	// `node` comes from PATH (the runner's `sh -c` line); the grandchild's pid
	// goes to a file in the check's cwd, so no Windows path passes through `sh`.
	const script = SPAWNS_GRANDCHILD.replace(/\n/g, " ").replaceAll('"', "'");
	const started = Date.now();
	const result = await runAcceptCommand({
		run: `node -e "${script}"`,
		cwd: dir,
		timeoutMs: 2_500,
		killGraceMs: 100,
	});

	assert.equal(result.kind, "timeout");
	assert.ok(Date.now() - started < 8_000, "the timeout was not enforced");
	const grandchild = readPid(join(dir, "grandchild.pid"));
	assert.ok(grandchild > 0, "the check never started its grandchild");
	await until(() => !alive(grandchild), "the grandchild survived the timeout");
});
