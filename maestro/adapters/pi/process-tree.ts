import { execFile, spawnSync } from "node:child_process";
import { win32 } from "node:path";

/** `taskkill` is a quick local call; this bounds it if the system is wedged. */
const TASKKILL_TIMEOUT_MS = 5_000;

/** Runs one command and reports whether it exited 0. */
export type CommandRunner = (command: string, args: string[]) => boolean;
export type AsyncCommandRunner = (
	command: string,
	args: string[],
) => Promise<boolean>;

/**
 * Seams for the Windows branch, so Linux tests can drive it. Production code
 * passes nothing except `alive`.
 */
export interface ProcessTreeOptions {
	platform?: NodeJS.Platform;
	/** Where `SystemRoot` is read from; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Blocking `taskkill`, for the `exit` hook and the final sweep. */
	run?: CommandRunner;
	/** Non-blocking `taskkill`, for everything on Pi's main thread. */
	runAsync?: AsyncCommandRunner;
	/**
	 * Whether the shell that leads the tree is still running. Once it has
	 * exited its pid is free to be reused by an unrelated process, and
	 * `taskkill /T` cannot find a dead root's descendants anyway, so on Windows
	 * a false answer means no tree kill is attempted. POSIX ignores it: a process
	 * group outlives its leader and `kill(-pid)` only reaches that group.
	 */
	alive?: () => boolean;
}

const runSync: CommandRunner = (command, args) =>
	spawnSync(command, args, {
		stdio: "ignore",
		windowsHide: true,
		timeout: TASKKILL_TIMEOUT_MS,
	}).status === 0;

const runAsync: AsyncCommandRunner = (command, args) =>
	new Promise((resolve) => {
		execFile(
			command,
			args,
			{ windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
			(error) => resolve(error === null),
		);
	});

/** `taskkill` from System32, so a `PATH` entry cannot stand in for it. */
function taskkillCommand(env: NodeJS.ProcessEnv): string {
	const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
	return win32.join(root, "System32", "taskkill.exe");
}

function taskkillArguments(pid: number): string[] {
	return ["/PID", String(pid), "/T", "/F"];
}

/**
 * Signal a process and everything it started. POSIX children are spawned
 * `detached`, so each leads its own process group and `kill(-pid)` reaches the
 * whole tree. Windows has no process groups or signals: `taskkill /T /F`
 * force-ends the process and its descendants instead, so every signal (even
 * SIGTERM) is final there and a grace period before SIGKILL buys nothing.
 *
 * This form blocks (up to the `taskkill` timeout on Windows), so it is for the
 * `exit` hook and the final shutdown sweep. Everything else uses
 * `signalProcessTree`.
 *
 * Returns whether the signal was delivered. False is not an error: the
 * process may already be gone, and Windows cannot find the descendants of a
 * parent that has already exited.
 */
export function killProcessTree(
	pid: number,
	signal: NodeJS.Signals,
	options: ProcessTreeOptions = {},
): boolean {
	if ((options.platform ?? process.platform) === "win32") {
		if (options.alive && !options.alive()) return false;
		return (options.run ?? runSync)(
			taskkillCommand(options.env ?? process.env),
			taskkillArguments(pid),
		);
	}
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Like `killProcessTree`, but never blocks: on Windows `taskkill` runs
 * asynchronously. `onMiss` runs when nothing was signalled (the group is gone,
 * `taskkill` found nothing or failed, or the shell had already exited), so the
 * caller can fall back to signalling the shell alone.
 */
export function signalProcessTree(
	pid: number,
	signal: NodeJS.Signals,
	onMiss: () => void,
	options: ProcessTreeOptions = {},
): void {
	if ((options.platform ?? process.platform) !== "win32") {
		if (!killProcessTree(pid, signal, options)) onMiss();
		return;
	}
	if (options.alive && !options.alive()) return onMiss();
	(options.runAsync ?? runAsync)(
		taskkillCommand(options.env ?? process.env),
		taskkillArguments(pid),
	).then((delivered) => {
		if (!delivered) onMiss();
	}, onMiss);
}
