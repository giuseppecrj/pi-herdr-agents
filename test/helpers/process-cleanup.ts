import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

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
		await delay(10);
	} while (performance.now() < deadline);
	assert.fail(`fixture process ${pid} survived teardown`);
}
