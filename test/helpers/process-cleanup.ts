import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseProcessStat } from "../../maestro/adapters/pi/process-identity.ts";

/**
 * Whether a Linux PID has exited, even if nothing has reaped it yet. A killed
 * orphan stays a zombie when PID 1 does not reap (for example Node as PID 1 in
 * a container without --init), and `kill(pid, 0)` still succeeds for it. Like
 * `judgeProcessIdentity`, treat zombie (Z) and dead (X) states as exited.
 */
export function linuxProcessExited(
	pid: number,
	readStat: (pid: number) => string = (target) =>
		readFileSync(`/proc/${target}/stat`, "utf8"),
): boolean {
	let text: string;
	try {
		text = readStat(pid);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return true;
		throw error;
	}
	const { state } = parseProcessStat(text);
	return state === "Z" || state === "X";
}

// Only pass PIDs captured from this test's own spawn or fixture PID file.
// Positive-PID signals also work on Windows; never signal a process group here.
export async function cleanupTestProcess(pid: number | undefined) {
	if (pid === undefined) return; // spawn failed before creating a process
	assert.ok(
		Number.isSafeInteger(pid) && pid > 0,
		`invalid fixture PID: ${pid}`,
	);
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH")
			return;
		throw error;
	}
	// Signalling is not proof of exit. Fail teardown if a recorded PID survives.
	const deadline = performance.now() + 5_000;
	do {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH")
				return;
			throw error;
		}
		if (process.platform === "linux" && linuxProcessExited(pid)) return;
		await delay(10);
	} while (performance.now() < deadline);
	assert.fail(`fixture process ${pid} survived teardown`);
}
