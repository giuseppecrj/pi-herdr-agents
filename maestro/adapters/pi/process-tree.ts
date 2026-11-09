import { spawnSync } from "node:child_process";

/** `taskkill` is a quick local call; this bounds it if the system is wedged. */
const TASKKILL_TIMEOUT_MS = 5_000;

/**
 * Signal a process and everything it started. POSIX children are spawned
 * `detached`, so each leads its own process group and `kill(-pid)` reaches the
 * whole tree. Windows has no process groups or signals: `taskkill /T /F`
 * force-ends the process and its descendants instead, so every signal (even
 * SIGTERM) is final there and a grace period before SIGKILL buys nothing.
 *
 * Returns whether the signal was delivered. False is not an error: the
 * process may already be gone, and Windows cannot find the descendants of a
 * parent that has already exited.
 */
export function killProcessTree(
	pid: number,
	signal: NodeJS.Signals,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform === "win32") {
		const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: TASKKILL_TIMEOUT_MS,
		});
		return result.status === 0;
	}
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}
