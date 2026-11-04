import { shellQuote } from "./shell.ts";

/**
 * Resolves the absolute path of the bash that runs a launch script. Returns
 * `undefined` when the host has no usable bash. It is only called on Windows,
 * and only once the pane's shell is known.
 */
export type ScriptShellResolver = () => string | undefined;

/** The shells a Windows Herdr pane can run that this host knows how to address. */
export type PaneShell = "powershell" | "cmd" | "posix";

/** True for the WSL launcher (`<drive>:\Windows\System32|Sysnative\bash.exe`). */
export function isWslBashLauncher(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(
		normalized,
	);
}

/**
 * Quote a value as a PowerShell single-quoted literal. PowerShell treats the
 * typographic single quotes as quote characters too, so each one is doubled.
 */
export function powerShellQuote(value: string): string {
	return "'" + value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&") + "'";
}

/**
 * Classify a Windows pane shell from the `name` (or `argv0`) Herdr reports for
 * the pane's shell process: `powershell.exe`, `pwsh.exe`, `cmd.exe`,
 * `bash.exe` (Git Bash) or `sh.exe`. Anything else is unknown.
 */
export function classifyPaneShell(
	name: string | undefined,
): PaneShell | undefined {
	if (!name) return undefined;
	const base = name
		.split(/[\\/]/)
		.pop()!
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (base === "powershell" || base === "pwsh") return "powershell";
	if (base === "cmd") return "cmd";
	if (base === "bash" || base === "sh") return "posix";
	return undefined;
}

const SET_SHELL_PATH =
	"Set shellPath in Pi's settings.json to the bash.exe of a Git for Windows, Scoop or MSYS2 install (for example %LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe).";

/** cmd.exe expands %VAR% inside quotes, `!VAR!` under delayed expansion, and ends a quote at `"`. */
const CMD_UNSAFE = /["%!]/;

/** The bash to type, or `undefined` to keep the bare line (bash/sh panes only). */
function resolveUsableBash(
	resolveShell: ScriptShellResolver | undefined,
	lenient: boolean,
): string | undefined {
	let bashPath: string | undefined;
	try {
		bashPath = resolveShell?.();
	} catch (error) {
		if (lenient) return undefined;
		throw error;
	}
	if (!bashPath) {
		if (lenient) return undefined;
		throw new Error(
			`No bash found to run the subagent launch script on Windows. Install Git for Windows or set shellPath in Pi's settings.json to its bash.exe.`,
		);
	}
	if (isWslBashLauncher(bashPath)) {
		if (lenient) return undefined;
		throw new Error(
			`No usable Git Bash found: the bash on PATH is the WSL launcher (${bashPath}), which would run the subagent launch script inside WSL. ${SET_SHELL_PATH}`,
		);
	}
	return bashPath;
}

/**
 * The line typed into a pane to run a launch script.
 *
 * Off Windows the pane's own `bash` runs it. On Windows the pane's shell is
 * configurable (`terminal.default_shell`), and a bare `bash` can resolve to the
 * WSL launcher, which runs the script inside WSL. So when the pane shell is
 * known the script runs through an absolute bash path, spelled for that shell:
 *
 * - PowerShell: `& '<bash>' '<script>'`
 * - cmd: `"<bash>" "<script>"`
 * - Git Bash / sh: `'<bash>' '<script>'`
 *
 * An unknown shell, or no process info, keeps the bare `bash '<script>'` line
 * as before, and the resolver is not called. A Git Bash / sh pane also keeps it
 * when no usable bash resolves (none, an error, or the WSL launcher), since its
 * own `bash` is the right one. In a PowerShell or cmd pane the bare line would
 * hit WSL or nothing, so a missing bash, the WSL launcher, or a path cmd would
 * expand fails before anything is typed.
 */
export function buildScriptLaunchCommand(options: {
	scriptPath: string;
	platform: NodeJS.Platform;
	paneShell?: PaneShell | undefined;
	resolveShell?: ScriptShellResolver | undefined;
}): string {
	const { scriptPath, platform, paneShell, resolveShell } = options;
	const bare = `bash ${shellQuote(scriptPath)}`;
	if (platform !== "win32" || !paneShell) return bare;

	// Git Bash's own bare `bash` is the pane's bash, not the WSL launcher, so a
	// host that cannot name a usable bash leaves a bash/sh pane on the old line.
	const bashPath = resolveUsableBash(resolveShell, paneShell === "posix");
	if (bashPath === undefined) return bare;
	switch (paneShell) {
		case "powershell":
			return `& ${powerShellQuote(bashPath)} ${powerShellQuote(scriptPath)}`;
		case "posix":
			return `${shellQuote(bashPath)} ${shellQuote(scriptPath)}`;
		case "cmd":
			if (CMD_UNSAFE.test(bashPath) || CMD_UNSAFE.test(scriptPath)) {
				throw new Error(
					`Cannot run the subagent launch script from a cmd.exe pane: a path contains ", % or !, which cmd.exe would expand (bash: ${bashPath}; script: ${scriptPath}). Use a PowerShell or Git Bash pane (terminal.default_shell in Herdr's config), or a bash.exe path without those characters.`,
				);
			}
			return `"${bashPath}" "${scriptPath}"`;
	}
}
