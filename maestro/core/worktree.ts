import type { JsonObject } from "./config/type-guards.ts";

export interface WorktreeLaunch {
	path: string;
	workspaceId: string;
	paneId: string;
	branch: string;
	baseRef: string;
	baseSha: string;
	manifestFile: string;
	sessionFile?: string;
	sourceSessionFile?: string;
	handoffMessage?: string;
	/** Non-fatal provisioning problems reported with the launch. */
	diagnostics?: string[];
}

export interface FailedWorktreeManifest extends JsonObject {
	state: "failed";
	id: string;
	name: string;
	sourceCwd: string;
	branch: string;
	baseRef: string;
	baseSha: string;
	createdAt: number;
	path?: string;
	workspaceId?: string;
	error?: string;
}

export interface WorktreeHandoff extends WorktreeLaunch {
	headSha: string | null;
	commitsAhead: number | null;
	clean: boolean | null;
	conflicted: boolean | null;
	changedFiles: string[] | null;
	untrackedFiles: string[] | null;
	gitError?: string;
}

export type WorktreeResultState =
	| "running"
	| "ready_for_review"
	| "failed"
	| "needs_help"
	| "cancelled"
	| "removed";

export function isWorktreeManifest(value: JsonObject): boolean {
	return (
		value.version === 1 &&
		value.kind === "worktree-run" &&
		value.owner === "pi-herdr-subagents"
	);
}

export function mergeWorktreeManifest(
	existing: JsonObject,
	value: JsonObject,
	updatedAt: number,
): JsonObject {
	return {
		...existing,
		...value,
		version: 1,
		kind: "worktree-run",
		owner: "pi-herdr-subagents",
		updatedAt,
	};
}

export function worktreeResultState(
	exitCode: number,
	needsHelp: boolean,
): WorktreeResultState {
	return needsHelp
		? "needs_help"
		: exitCode === 0
			? "ready_for_review"
			: "failed";
}

/** Launch and completion consume effects supplied by the runtime composition. */
export interface WorktreeOperations {
	resolveGitCommit(cwd: string, ref: string): Promise<string>;
	resolveWorktreeProvisionCwd(sourceCwd: string): Promise<string>;
	writeWorktreeManifest(path: string, value: JsonObject): void;
	captureWorktreeHandoff(worktree: WorktreeLaunch): Promise<WorktreeHandoff>;
	persistWorktreeResult(
		worktree: WorktreeLaunch,
		state: WorktreeResultState,
		handoff?: WorktreeHandoff,
	): void;
}
