import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import {
	mergeWorktreeManifest,
	worktreeResultState,
} from "../../maestro/core/worktree.ts";
import {
	listContainedWorktrees,
	removeContainedWorktree,
} from "../../maestro/core/worktree-cleanup.ts";
import {
	createWorktreeCleanupOperations,
	readWorktreeManifest,
	writeWorktreeManifest,
} from "../../maestro/runtime/worktree-operations.ts";
import { cleanupFixture } from "../worktree-cleanup-fixture.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("continues writing the stable manifest owner value", () => {
	const dir = mkdtempSync(join(tmpdir(), "task16-manifest-"));
	try {
		const file = join(dir, "run.json");
		const existing = mergeWorktreeManifest(
			{},
			{ id: "run", baseSha: "base", future: { retained: true } },
			10,
		);
		writeWorktreeManifest(file, existing);
		writeWorktreeManifest(file, { state: "removed", owner: "not-an-owner" });
		const value = readWorktreeManifest(file)!;
		assert.equal(value.owner, "pi-herdr-subagents");
		assert.equal(value.version, 1);
		assert.equal(value.kind, "worktree-run");
		assert.equal(value.baseSha, "base");
		assert.deepEqual(value.future, { retained: true });
		assert.ok(readFileSync(file, "utf8").endsWith("\n"));
		assert.deepEqual(
			[
				worktreeResultState(0, false),
				worktreeResultState(1, false),
				worktreeResultState(0, true),
			],
			["ready_for_review", "failed", "needs_help"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cleanup uses the injected provider with 30-second deadlines and unavailable errors", async () => {
	const dir = mkdtempSync(join(tmpdir(), "task16-provider-"));
	const provider = new FakeSurfaceProvider();
	const calls: string[] = [];
	provider.listWorktreeSurfaces = async (options) => {
		assert.deepEqual(options, { cwd: "/repo", timeoutMs: 30_000 });
		calls.push("list-worktrees");
		return [];
	};
	provider.listSurfaces = (options) => {
		assert.equal(options?.timeoutMs, 30_000);
		calls.push("list-surfaces");
		return [{ id: "pane", workspaceId: "workspace" }];
	};
	provider.getProcessInfo = (_id, options) => {
		assert.equal(options?.timeoutMs, 30_000);
		calls.push("process");
		return {
			shellPid: 123,
			foregroundProcessGroupId: 124,
			pids: [],
			foregroundProcesses: [],
		};
	};
	provider.removeWorktreeSurface = (_id, options) => {
		assert.equal(options?.timeoutMs, 30_000);
		calls.push("remove");
	};
	const ops = createWorktreeCleanupOperations(provider, {
		manifestDir: dir,
		liveHolders: () => [],
	});
	try {
		await ops.listWorktrees("/repo");
		const entry = (await listContainedWorktrees(cleanupFixture().input))[0];
		entry.path = dir;
		entry.workspaceId = "workspace";
		assert.match(
			(await ops.holders(entry)).blockers.join(),
			/foreground process in pane pane/,
		);
		await ops.removeWorkspace("workspace");
		assert.deepEqual(calls, [
			"list-worktrees",
			"list-surfaces",
			"process",
			"remove",
		]);
		provider.listSurfaces = () => {
			throw new Error("snapshot unavailable");
		};
		await assert.rejects(ops.holders(entry), /snapshot unavailable/);
		provider.listWorktreeSurfaces = async () => {
			throw new Error("worktree list unavailable");
		};
		await assert.rejects(
			async () => ops.listWorktrees("/repo"),
			/worktree list unavailable/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const workspace of [false, true]) {
	for (const rejected of [false, true]) {
		test(`awaits async ${workspace ? "provider" : "checkout"} removal before absence/manifest/prune (reject: ${rejected})`, async () => {
			const f = cleanupFixture();
			const entered = deferred(),
				release = deferred();
			const remove = f.operations.removeCheckout;
			let completed = false,
				settled = false;
			const perform = async () => {
				entered.resolve();
				await release.promise;
				if (rejected) throw new Error("async removal rejected");
				remove("/repo", "/managed/repo/task");
				completed = true;
			};
			if (workspace) {
				const provider = new FakeSurfaceProvider();
				provider.removeWorktreeSurface = perform;
				const ops = createWorktreeCleanupOperations(provider, {
					manifestDir: "/unused",
					liveHolders: () => [],
				});
				f.operations.listWorktrees = async () => [
					{
						path: "/managed/repo/task",
						branch: "task",
						workspaceId: "workspace",
						isLinkedWorktree: true,
					},
				];
				f.operations.removeWorkspace = ops.removeWorkspace;
			} else f.operations.removeCheckout = perform;
			f.operations.readManifests = () => [
				{
					file: "run.json",
					value: { path: "/managed/repo/task", branch: "task" },
				},
			];
			const result = removeContainedWorktree(f.input);
			result.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await entered.promise;
				await turn();
				assert.equal(
					settled,
					false,
					"removal settled before async removal completed",
				);
				assert.deepEqual(f.calls, []);
			} finally {
				release.resolve();
			}
			const outcome = await result;
			assert.equal(outcome.status, rejected ? "failed" : "removed");
			assert.equal(completed, !rejected);
			if (rejected) {
				assert.match(outcome.message, /async removal rejected/);
				assert.deepEqual(f.calls, []);
			} else
				assert.deepEqual(f.calls, [
					"git:/repo:/managed/repo/task",
					...(!workspace ? ["prune:/repo"] : []),
					"manifest:removed",
				]);
		});
	}
}
