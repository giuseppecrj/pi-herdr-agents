import type { TestContext } from "node:test";

// On Windows the host refuses managed worktrees and Herdr Core before any
// effect; test/maestro/windows-support-scope.test.ts asserts those refusals.
// Tests of only that behavior skip there with these reasons.

/** A `skip` option for a test of managed-worktree behavior only. */
export const worktreesUnsupportedOnWindows =
	process.platform === "win32"
		? "managed worktrees are unsupported on Windows; see windows-support-scope.test.ts"
		: false;

/** A `skip` option for a test of Herdr Core behavior only. */
export const coreUnsupportedOnWindows =
	process.platform === "win32"
		? "Herdr Core is unsupported on Windows; see windows-support-scope.test.ts"
		: false;

/** Skip `t` on Windows, where managed worktrees are refused; true if skipped. */
export function skipWorktreesOnWindows(t: TestContext): boolean {
	if (!worktreesUnsupportedOnWindows) return false;
	t.skip(worktreesUnsupportedOnWindows);
	return true;
}

/** Skip `t` on Windows, where Herdr Core is refused; true if skipped. */
export function skipCoreOnWindows(t: TestContext): boolean {
	if (!coreUnsupportedOnWindows) return false;
	t.skip(coreUnsupportedOnWindows);
	return true;
}
