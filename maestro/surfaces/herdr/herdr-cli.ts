import { execFile, execSync, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { isString } from "../../core/config/type-guards.ts";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
	if (commandAvailability.has(command)) {
		return commandAvailability.get(command)!;
	}

	let available = false;
	if (process.platform === "win32") {
		try {
			execFileSync("where.exe", [command], { stdio: "ignore" });
			available = true;
		} catch {
			try {
				execSync(`command -v ${command}`, { stdio: "ignore" });
				available = true;
			} catch {
				available = false;
			}
		}
	} else {
		try {
			execSync(`command -v ${command}`, { stdio: "ignore" });
			available = true;
		} catch {
			available = false;
		}
	}

	commandAvailability.set(command, available);
	return available;
}

export function isHerdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1" && hasCommand("herdr");
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

export function herdrExec(args: string[], timeout?: number): string {
	if (herdrExecForTest) {
		const result = herdrExecForTest(args, timeout, "sync");
		if (!isString(result)) {
			throw new Error("Synchronous Herdr test exec returned a Promise");
		}
		return result;
	}
	return execFileSync("herdr", args, {
		stdio: "pipe",
		encoding: "utf8",
		timeout,
		killSignal: "SIGKILL",
	});
}

export async function herdrExecAsync(
	args: string[],
	timeout?: number,
): Promise<string> {
	if (herdrExecForTest) return await herdrExecForTest(args, timeout, "async");
	const { stdout } = await execFileAsync("herdr", args, {
		encoding: "utf8",
		timeout,
		killSignal: "SIGKILL",
	});
	return stdout;
}

/** Install a test exec (or restore the previous one) and return the one it replaced. */
export function swapHerdrExecForTest(
	next: HerdrExecForTest | undefined,
): HerdrExecForTest | undefined {
	const previous = herdrExecForTest;
	herdrExecForTest = next;
	return previous;
}
