import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import {
	ACCEPT_CAPTURE_CHARS,
	ACCEPT_KILL_GRACE_MS,
	normalizeAcceptSpec,
	type AcceptCommandResult,
	type AcceptSpec,
} from "../../core/accept.ts";
import { trackAcceptCheck, type AcceptCheckOwner } from "./accept-groups.ts";
import { signalProcessTree, type ProcessTreeOptions } from "./process-tree.ts";

export interface AcceptCommandOptions {
	run: string;
	cwd: string;
	timeoutMs: number;
	/** Aborting stops the check like a timeout and reports `aborted`. */
	signal?: AbortSignal;
	/** SIGTERM to the process group (POSIX), then SIGKILL after this grace. */
	killGraceMs?: number;
	env?: NodeJS.ProcessEnv;
	/** Stops this check at its shutdown (`accept-groups.ts`). */
	owner?: AcceptCheckOwner;
}

/** Runs one accept check; injectable so tests need no real commands. */
export type AcceptRunner = (
	options: AcceptCommandOptions,
) => Promise<AcceptCommandResult>;

/** Wait this long for inherited pipes to close after the shell exits. */
const PIPE_CLOSE_GRACE_MS = 1_000;

/**
 * The check's environment: the caller's, without `PI_SUBAGENT_*`, so a nested
 * Pi inside the check never acts as this child.
 */
export function acceptCheckEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(([key]) => !key.startsWith("PI_SUBAGENT_")),
	);
}

/** Whether the check's shell is still running; its pid is only ours until then. */
function shellRunning(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

function signalGroup(
	child: ChildProcess,
	signal: NodeJS.Signals,
	tree: ProcessTreeOptions,
): void {
	if (child.pid === undefined) return;
	// Detached: the shell leads its own process group (POSIX), or its tree is
	// ended by `taskkill /T` (Windows, only while the shell lives: after it
	// exits the pid may belong to someone else). Fall back to the shell alone.
	signalProcessTree(
		child.pid,
		signal,
		() => {
			try {
				child.kill(signal);
			} catch {
				/* already gone */
			}
		},
		{ ...tree, alive: () => shellRunning(child) },
	);
}

/**
 * `sh -c <run>` in `cwd`, asynchronously, with a timeout. Keeps the last 64 KiB
 * of combined output. A timeout or abort sends SIGTERM to the process group
 * and SIGKILL after the grace; whatever is left of the group is killed once
 * the shell exits. Windows has no groups or signals, so `taskkill /T /F` ends
 * the tree while the shell still runs (never after it exits: the pid may then
 * belong to an unrelated process) and any stop there is immediate. After the shell exits, the check waits briefly for
 * inherited pipes to close; a timeout or abort then ends it at once. The
 * group is tracked under `owner` until it is killed (`accept-groups.ts`).
 */
export function createAcceptRunner(
	processTree: ProcessTreeOptions = {},
): AcceptRunner {
	return (options) => runCheck(options, processTree);
}

export const runAcceptCommand: AcceptRunner = createAcceptRunner();

const runCheck = (
	options: AcceptCommandOptions,
	tree: ProcessTreeOptions,
): Promise<AcceptCommandResult> =>
	new Promise((resolve) => {
		try {
			if (!statSync(options.cwd).isDirectory())
				return resolve({ kind: "cwd-missing", output: "" });
		} catch {
			return resolve({ kind: "cwd-missing", output: "" });
		}
		if (options.signal?.aborted)
			return resolve({ kind: "aborted", output: "" });
		let output = "";
		const append = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-ACCEPT_CAPTURE_CHARS);
		};
		let child: ChildProcess;
		try {
			child = spawn("sh", ["-c", options.run], {
				cwd: options.cwd,
				env: options.env ?? acceptCheckEnv(),
				detached: true,
				// Detached on Windows opens a console window unless it is hidden.
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			return resolve({
				kind: "spawn-error",
				error: error instanceof Error ? error.message : String(error),
				output: "",
			});
		}
		let stopped: "timeout" | "aborted" | undefined;
		let exit:
			| { code: number | null; signal: NodeJS.Signals | null }
			| undefined;
		let done = false;
		const timers: NodeJS.Timeout[] = [];
		// A later stop (an owner's shutdown) only brings the SIGKILL forward.
		const stop = (
			reason: "timeout" | "aborted",
			graceMs = options.killGraceMs ?? ACCEPT_KILL_GRACE_MS,
		) => {
			if (done) return;
			const first = !stopped;
			stopped ??= reason;
			// The shell is gone; its group may still hold the pipes: kill it now.
			if (exit) return finish(fromExit());
			if (first) signalGroup(child, "SIGTERM", tree);
			timers.push(
				setTimeout(() => signalGroup(child, "SIGKILL", tree), graceMs),
			);
		};
		let settle = () => {};
		const untrack =
			child.pid === undefined
				? () => {}
				: trackAcceptCheck({
						pgid: child.pid,
						processTree: { ...tree, alive: () => shellRunning(child) },
						owner: options.owner,
						terminate: (graceMs) => stop("aborted", graceMs),
						finished: new Promise<void>((resolve) => {
							settle = resolve;
						}),
					});
		const onAbort = () => stop("aborted");
		const finish = (result: AcceptCommandResult) => {
			if (done) return;
			done = true;
			for (const timer of timers) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			// A bounded check leaves nothing running behind it.
			signalGroup(child, "SIGKILL", tree);
			untrack();
			settle();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(result);
		};
		const fromExit = (): AcceptCommandResult => {
			if (stopped) return { kind: stopped, output };
			if (exit?.code !== null && exit?.code !== undefined)
				return { kind: "exit", exitCode: exit.code, output };
			return { kind: "signal", signal: exit?.signal ?? "unknown", output };
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) =>
			finish({ kind: "spawn-error", error: error.message, output }),
		);
		child.on("exit", (code, signal) => {
			exit = { code, signal };
			// A stopped check does not wait for its pipes.
			if (stopped) return finish(fromExit());
			timers.push(setTimeout(() => finish(fromExit()), PIPE_CLOSE_GRACE_MS));
		});
		child.on("close", () => {
			if (exit) finish(fromExit());
		});
		timers.push(setTimeout(() => stop("timeout"), options.timeoutMs));
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});

/** The child's spec file; unreadable or invalid means no child loop. */
export function readAcceptSpecFile(
	file: string | undefined,
): AcceptSpec | undefined {
	if (!file) return undefined;
	try {
		const { version, ...request } = JSON.parse(readFileSync(file, "utf8"));
		return version === 1 ? normalizeAcceptSpec(request) : undefined;
	} catch {
		return undefined;
	}
}
