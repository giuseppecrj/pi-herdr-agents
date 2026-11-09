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
setInterval(() => {}, 1000);
`;

test("killProcessTree ends a detached process and the process it started", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "process-tree-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const child = spawn(process.execPath, ["-e", SPAWNS_GRANDCHILD], {
		cwd: dir,
		detached: true,
		windowsHide: true,
		stdio: "ignore",
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
	// Beyond the pid range of any platform this runs on.
	assert.equal(killProcessTree(2 ** 22 - 3, "SIGKILL"), false);
});

test("a timed-out accept check leaves nothing it started running", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "accept-tree-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
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
