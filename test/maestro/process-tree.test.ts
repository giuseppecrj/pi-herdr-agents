import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createAcceptRunner,
	runAcceptCommand,
} from "../../maestro/adapters/pi/accept-runner.ts";
import {
	terminateAcceptChecks,
	trackAcceptCheck,
} from "../../maestro/adapters/pi/accept-groups.ts";
import {
	killProcessTree,
	signalProcessTree,
	type ProcessTreeOptions,
} from "../../maestro/adapters/pi/process-tree.ts";

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

/** A `taskkill` stand-in that records its calls and succeeds. */
function recordingTaskkill(result = true) {
	const calls: { command: string; args: string[] }[] = [];
	const options: ProcessTreeOptions = {
		platform: "win32",
		env: { SystemRoot: String.raw`C:\Windows` },
		run: (command, args) => {
			calls.push({ command, args });
			return result;
		},
		runAsync: async (command, args) => {
			calls.push({ command, args });
			return result;
		},
	};
	return { calls, options };
}

test("on Windows killProcessTree runs taskkill /T /F from System32", () => {
	const { calls, options } = recordingTaskkill();
	assert.equal(killProcessTree(4242, "SIGKILL", options), true);
	assert.deepEqual(calls, [
		{
			command: String.raw`C:\Windows\System32\taskkill.exe`,
			args: ["/PID", "4242", "/T", "/F"],
		},
	]);
});

test("on Windows killProcessTree reports a taskkill that finds nothing", () => {
	const { options } = recordingTaskkill(false);
	assert.equal(killProcessTree(4242, "SIGKILL", options), false);
});

test("on Windows killProcessTree never calls taskkill once the shell has exited", () => {
	// The pid may already belong to an unrelated process; taskkill /T would end
	// that process's tree.
	const { calls, options } = recordingTaskkill();
	assert.equal(
		killProcessTree(4242, "SIGKILL", { ...options, alive: () => false }),
		false,
	);
	assert.deepEqual(calls, []);
});

test("signalProcessTree on Windows runs taskkill off the main thread while the shell lives", async () => {
	const { calls, options } = recordingTaskkill();
	let missed = 0;
	signalProcessTree(4242, "SIGTERM", () => missed++, {
		...options,
		alive: () => true,
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.args, ["/PID", "4242", "/T", "/F"]);
	assert.equal(missed, 0);
});

test("signalProcessTree falls back when taskkill fails, and skips taskkill after exit", async () => {
	const failing = recordingTaskkill(false);
	let missed = 0;
	signalProcessTree(4242, "SIGTERM", () => missed++, failing.options);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(missed, 1);

	const exited = recordingTaskkill();
	signalProcessTree(4242, "SIGKILL", () => missed++, {
		...exited.options,
		alive: () => false,
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(exited.calls, []);
});

test("signalProcessTree on POSIX signals the group at once and falls back for a missing one", () => {
	let missed = 0;
	signalProcessTree(2 ** 31 - 1, "SIGKILL", () => missed++, {
		platform: "linux",
	});
	assert.equal(missed, 1);
});

test("a finished accept check never gets a taskkill, even though its pid may be reused", async () => {
	const { calls, options } = recordingTaskkill();
	const run = createAcceptRunner(options);
	const dir = mkdtempSync(join(tmpdir(), "accept-win32-"));
	try {
		const result = await run({
			run: "exit 0",
			cwd: dir,
			timeoutMs: 10_000,
		});
		assert.equal(result.kind, "exit");
		assert.deepEqual(calls, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the shutdown sweep skips taskkill for a check whose shell has exited", async () => {
	const owner = { label: "test" };
	const exited = recordingTaskkill();
	const running = recordingTaskkill();
	const track = (options: ProcessTreeOptions, pgid: number) =>
		trackAcceptCheck({
			pgid,
			owner,
			terminate: () => {},
			finished: new Promise<void>(() => {}),
			processTree: options,
		});
	const untrackExited = track({ ...exited.options, alive: () => false }, 111);
	const untrackRunning = track({ ...running.options, alive: () => true }, 222);
	try {
		await terminateAcceptChecks(owner, 10);
	} finally {
		untrackExited();
		untrackRunning();
	}
	assert.deepEqual(exited.calls, []);
	assert.deepEqual(
		running.calls.map((call) => call.args[1]),
		["222"],
	);
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
