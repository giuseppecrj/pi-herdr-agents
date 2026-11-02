import {
	getAgentDir,
	getShellConfig,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ScriptShellResolver } from "../../core/script-launch.ts";

export interface PiScriptShellDeps {
	/** Pi's `shellPath` setting, as the bash tool reads it. */
	readShellPath: () => string | undefined;
	/** Pi's bash-tool shell resolution; throws when no bash is found. */
	resolveShell: (shellPath?: string) => { shell: string };
}

const defaultDeps: PiScriptShellDeps = {
	readShellPath: () =>
		SettingsManager.create(process.cwd(), getAgentDir()).getShellPath(),
	resolveShell: getShellConfig,
};

/**
 * Resolve the bash that runs launch scripts the way Pi resolves it for its own
 * bash tool: the `shellPath` setting, then Git Bash, then bash on PATH. A child
 * therefore runs the same bash as the parent's tool calls. Pi's own error
 * (missing custom path, no bash installed) propagates unchanged.
 */
export function createPiScriptShellResolver(
	deps: PiScriptShellDeps = defaultDeps,
): ScriptShellResolver {
	return () => deps.resolveShell(deps.readShellPath()).shell;
}
