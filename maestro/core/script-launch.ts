import { shellQuote } from "./shell.ts";

/**
 * Resolves the absolute path of the bash that runs a launch script. Returns
 * `undefined` when the host has no usable bash. It is only called on Windows.
 */
export type ScriptShellResolver = () => string | undefined;

/** True for the WSL launcher (`<drive>:\Windows\System32|Sysnative\bash.exe`). */
export function isWslBashLauncher(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(
		normalized,
	);
}

/** Quote a value as a PowerShell single-quoted literal. */
export function powerShellQuote(value: string): string {
	return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * The line typed into a pane to run a launch script.
 *
 * Off Windows the pane's own `bash` runs it. On Windows a bare `bash` can
 * resolve to the WSL launcher, which runs the script inside WSL, so the script
 * runs through an absolute bash path and the call uses PowerShell's `&`
 * operator, the shell a Windows Herdr pane runs. An unresolvable or WSL bash
 * fails before anything is typed instead of falling back to a bare `bash`.
 */
export function buildScriptLaunchCommand(options: {
	scriptPath: string;
	platform: NodeJS.Platform;
	resolveShell?: ScriptShellResolver | undefined;
}): string {
	const { scriptPath, platform, resolveShell } = options;
	if (platform !== "win32") return `bash ${shellQuote(scriptPath)}`;

	const bashPath = resolveShell?.();
	if (!bashPath) {
		throw new Error(
			"No bash found to run the subagent launch script on Windows. Install Git for Windows or set shellPath in Pi's settings.json to its bash.exe.",
		);
	}
	if (isWslBashLauncher(bashPath)) {
		throw new Error(
			`Refusing to run the subagent launch script through the WSL bash launcher (${bashPath}). Install Git for Windows or set shellPath in Pi's settings.json to its bash.exe.`,
		);
	}
	return `& ${powerShellQuote(bashPath)} ${powerShellQuote(scriptPath)}`;
}
