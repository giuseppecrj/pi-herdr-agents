import assert from "node:assert/strict";
import type {
	CleanupGitState,
	WorktreeCleanupOperations,
} from "../pi-extension/subagents/worktree-cleanup.ts";

export function cleanupFixture() {
	const calls: string[] = [];
	const state: CleanupGitState = {
		branch: "task",
		headSha: "local-only-commit",
		registered: true,
		locked: false,
		dirtyFiles: 0,
		untrackedFiles: 0,
		ignoredFiles: 0,
		conflicts: 0,
		submodules: false,
	};
	let present = true;
	const operations: WorktreeCleanupOperations = {
		scan: () => (present ? ["/managed/repo/task"] : []),
		managedRoot: () => "/managed",
		realpath: (path) => path,
		resolveSource: () => "/repo",
		inspectGit: () => ({ ...state }),
		listHerdr: () => [],
		readManifests: () => [],
		holders: async () => ({ blockers: [], warnings: [] }),
		exists: () => present,
		preserve: () => {
			calls.push("preserve");
			state.dirtyFiles = 0;
			state.untrackedFiles = 0;
			state.headSha = "wip-sha";
			return "wip-sha";
		},
		removeWorkspace: (id) => {
			calls.push(`herdr:${id}`);
			present = false;
		},
		closeOpenedPrimaryWorkspace: () => undefined,
		removeCheckout: (source, path) => {
			calls.push(`git:${source}:${path}`);
			present = false;
		},
		prune: (source) => {
			assert.equal(present, false);
			calls.push(`prune:${source}`);
		},
		writeManifest: (_file, value) => {
			calls.push(`manifest:${value.state}`);
			assert.equal(Number.isFinite(value.workspaceRemovedAt), true);
		},
	};
	return {
		operations,
		calls,
		state,
		input: { cwd: "/repo", operations, target: "task" },
	};
}
