import {
	getAgentDir,
	getShellConfig,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ScriptShellResolver } from "../../core/script-launch.ts";

/**
 * Which settings the launch reads `shellPath` from: the launching session's
 * directory and its project-trust decision, so an untrusted project cannot
 * choose the executable and the host reads what the parent's bash tool reads.
 */
export interface PiScriptShellContext {
	cwd: string;
	projectTrusted: boolean;
}

export interface PiScriptShellDeps {
	/** Pi's `shellPath` setting, as the bash tool reads it for this session. */
	readShellPath: (context: PiScriptShellContext) => string | undefined;
	/** Pi's bash-tool shell resolution; throws when no bash is found. */
	resolveShell: (shellPath?: string) => { shell: string };
}

export const piScriptShellDeps: PiScriptShellDeps = {
	// `projectTrusted` is ignored by Pi releases without trust gating, which
	// also ignore it for the parent's own settings.
	readShellPath: ({ cwd, projectTrusted }) =>
		SettingsManager.create(cwd, getAgentDir(), {
			projectTrusted,
		}).getShellPath(),
	resolveShell: getShellConfig,
};

/**
 * Resolve the bash that runs launch scripts the way Pi resolves it for its own
 * bash tool: the `shellPath` setting (project settings only when the session
 * trusts the project), then Git Bash, then bash on PATH. Pi's own error
 * (missing custom path, no bash installed) propagates unchanged.
 */
export function createPiScriptShellResolver(
	context: PiScriptShellContext,
	deps: PiScriptShellDeps = piScriptShellDeps,
): ScriptShellResolver {
	return () => deps.resolveShell(deps.readShellPath(context)).shell;
}
