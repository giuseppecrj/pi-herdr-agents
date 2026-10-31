import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isString } from "../../core/config/type-guards.ts";
import { Deadline } from "../../core/deadline.ts";
import { gitEnvironment } from "../../core/git-environment.ts";

export const HERDR_RPC_TIMEOUT_MS = 10_000;
export const HERDR_PLACEMENT_TIMEOUT_MS = 30_000;
export const HERDR_WORKTREE_TIMEOUT_MS = 120_000;
export const HERDR_RECONCILE_TIMEOUT_MS = 6_000;
export const HERDR_COSMETIC_TIMEOUT_MS = 1_000;
export const HERDR_OUTPUT_BYTES = 1024 * 1024;

export function isHerdrAvailable(): boolean {
	if (process.env.HERDR_ENV !== "1") return false;
	return (process.env.PATH ?? "").split(delimiter).some((directory) => {
		try {
			const path = join(directory, "herdr");
			accessSync(path, constants.X_OK);
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}

export function parseHerdrJson(value: string) {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export type HerdrExecForTest = (
	args: string[],
	timeout?: number,
	mode?: "sync" | "async",
) => string | Promise<string>;
let herdrExecForTest: HerdrExecForTest | undefined;

/** Only synchronous screen diagnostics in integration harnesses use this. */
export function herdrExec(
	args: string[],
	timeout = HERDR_RPC_TIMEOUT_MS,
): string {
	Deadline.after(timeout);
	if (herdrExecForTest) {
		const result = herdrExecForTest(args, timeout, "sync");
		if (!isString(result))
			throw new Error("Synchronous Herdr test exec returned a Promise");
		return result;
	}
	return execFileSync("herdr", args, {
		stdio: "pipe",
		encoding: "utf8",
		timeout,
		maxBuffer: HERDR_OUTPUT_BYTES,
		killSignal: "SIGKILL",
	});
}

export class HerdrClientError extends Error {
	readonly kind: "not-spawned" | "timeout" | "overflow" | "exit";
	readonly stdout: string;
	readonly stderr: string;
	constructor(
		kind: HerdrClientError["kind"],
		message: string,
		stdout: string,
		stderr: string,
	) {
		super(message);
		this.name = "HerdrClientError";
		this.kind = kind;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

export async function herdrExecAsync(
	args: string[],
	timeout = HERDR_RPC_TIMEOUT_MS,
): Promise<string> {
	const deadline = Deadline.after(timeout);
	if (herdrExecForTest) {
		const output = await herdrExecForTest(args, timeout, "async");
		if (deadline.expired())
			throw new HerdrClientError(
				"timeout",
				"Herdr client answered after its deadline",
				output,
				"",
			);
		return output;
	}
	const remaining = deadline.remainingMs();
	return new Promise((resolve, reject) => {
		const child = spawn("herdr", args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: args[0] === "worktree" ? gitEnvironment() : process.env,
		});
		let spawned = false,
			settled = false;
		const output: Buffer[] = [],
			errors: Buffer[] = [];
		let outputBytes = 0,
			errorBytes = 0;
		const stop = () => {
			try {
				if (process.platform !== "win32" && child.pid)
					process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				/* already exited */
			}
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
		};
		const fail = (kind: HerdrClientError["kind"], message: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stop();
			reject(
				new HerdrClientError(
					kind,
					message,
					Buffer.concat(output).toString("utf8"),
					Buffer.concat(errors).toString("utf8"),
				),
			);
		};
		const timer = setTimeout(
			() =>
				fail(
					"timeout",
					`Herdr client timed out after ${timeout}ms; server cancellation is not established`,
				),
			remaining,
		);
		child.on("spawn", () => {
			spawned = true;
		});
		child.on("error", (error) =>
			fail(spawned ? "exit" : "not-spawned", error.message),
		);
		child.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > HERDR_OUTPUT_BYTES)
				fail("overflow", "Herdr stdout exceeded its output limit");
			else output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errorBytes += chunk.length;
			if (errorBytes > HERDR_OUTPUT_BYTES)
				fail("overflow", "Herdr stderr exceeded its output limit");
			else errors.push(chunk);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			if (deadline.expired())
				return fail("timeout", "Herdr client answered after its deadline");
			if (code !== 0)
				return fail(
					"exit",
					`Herdr client exited ${code ?? signal}: ${Buffer.concat(errors).toString("utf8")}`,
				);
			settled = true;
			clearTimeout(timer);
			resolve(Buffer.concat(output).toString("utf8"));
		});
	});
}

/** Install a test exec (or restore the previous one) and return the one it replaced. */
export function swapHerdrExecForTest(
	next: HerdrExecForTest | undefined,
): HerdrExecForTest | undefined {
	const previous = herdrExecForTest;
	herdrExecForTest = next;
	return previous;
}
