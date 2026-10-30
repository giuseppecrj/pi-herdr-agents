import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import {
	ACCEPT_CAPTURE_CHARS,
	ACCEPT_KILL_GRACE_MS,
	normalizeAcceptSpec,
	type AcceptCommandResult,
	type AcceptSpec,
} from "../../core/accept.ts";

export interface AcceptCommandOptions {
	run: string;
	cwd: string;
	timeoutMs: number;
	/** Aborting stops the check like a timeout and reports `aborted`. */
	signal?: AbortSignal;
	/** SIGTERM to the process group, then SIGKILL after this grace. */
	killGraceMs?: number;
	env?: NodeJS.ProcessEnv;
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

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		// Detached: the shell leads its own process group.
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			/* already gone */
		}
	}
}

/**
 * `sh -c <run>` in `cwd`, asynchronously, with a timeout. Keeps the last 64 KiB
 * of combined output. A timeout or abort sends SIGTERM to the process group
 * and SIGKILL after the grace; whatever is left of the group is killed once
 * the shell exits. After the shell exits, the check waits briefly for
 * inherited pipes to close; a timeout or abort then ends it at once.
 */
export const runAcceptCommand: AcceptRunner = (options) =>
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
		const stop = (reason: "timeout" | "aborted") => {
			if (stopped || done) return;
			stopped = reason;
			// The shell is gone; its group may still hold the pipes: kill it now.
			if (exit) return finish(fromExit());
			signalGroup(child, "SIGTERM");
			timers.push(
				setTimeout(
					() => signalGroup(child, "SIGKILL"),
					options.killGraceMs ?? ACCEPT_KILL_GRACE_MS,
				),
			);
		};
		const onAbort = () => stop("aborted");
		const finish = (result: AcceptCommandResult) => {
			if (done) return;
			done = true;
			for (const timer of timers) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			// A bounded check leaves nothing running behind it.
			signalGroup(child, "SIGKILL");
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
