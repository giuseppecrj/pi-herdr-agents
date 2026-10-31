import assert from "node:assert/strict";
import { test } from "node:test";
import {
	__herdrTest__,
	createHerdrGroupedSurface,
	createHerdrWorktree,
	sendHerdrCommand,
	closeHerdrSurface,
} from "../../maestro/surfaces/herdr/herdr.ts";
import { AcquisitionUncertainError } from "../../maestro/core/surface-provider.ts";
import { Deadline } from "../../maestro/core/deadline.ts";

import type { JsonObject } from "../../maestro/core/config/type-guards.ts";

const json = (result: JsonObject) => JSON.stringify({ result });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function driver() {
	const panes: { pane_id: string; tab_id: string; workspace_id: string }[] = [];
	let tabs = 0,
		splits = 0;
	let splitFailure = false,
		tabFailure = false;
	let gate: Promise<void> | undefined;
	const entered = deferred();
	const exec = async (
		args: string[],
		timeout?: number,
		mode?: string,
	): Promise<string> => {
		assert.equal(mode, "async");
		assert.ok(timeout && timeout > 0 && Number.isFinite(timeout));
		const op = args.slice(0, 2).join(" ");
		if (op === "pane current")
			return json({
				pane: { pane_id: "parent", tab_id: "parent-tab", workspace_id: "w" },
			});
		if (op === "workspace list")
			return json({
				type: "workspace_list",
				workspaces: [
					{ workspace_id: "w", worktree: { checkout_path: "/repo" } },
				],
			});
		if (op === "pane list") return json({ type: "pane_list", panes });
		if (op === "tab create") {
			entered.resolve();
			await gate;
			const pane = {
				pane_id: `p${panes.length}`,
				tab_id: `t${++tabs}`,
				workspace_id: "w",
			};
			panes.push(pane);
			if (tabFailure) {
				tabFailure = false;
				throw new Error("tab response lost");
			}
			return json({ root_pane: pane, tab: { tab_id: pane.tab_id } });
		}
		if (op === "pane split") {
			splits++;
			const anchor = panes.find((pane) => pane.pane_id === args[2]);
			assert.ok(anchor);
			const pane = { ...anchor, pane_id: `p${panes.length}` };
			panes.push(pane);
			if (splitFailure) throw new Error("split response lost");
			return json({ pane });
		}
		return json({ ok: true });
	};
	return {
		panes,
		exec,
		entered,
		setGate: (value: Promise<void>) => {
			gate = value;
		},
		failSplit: () => {
			splitFailure = true;
		},
		failTab: () => {
			tabFailure = true;
		},
		counts: () => ({ tabs, splits }),
	};
}

test("deferred concurrent placement and a reloaded module share one inspect/create/record queue", async () => {
	const d = driver(),
		release = deferred();
	d.setGate(release.promise);
	await __herdrTest__.withMockHerdrExec(d.exec, async () => {
		const first = createHerdrGroupedSurface("one", "/repo", 2, "right");
		await d.entered.promise;
		const url = new URL(
			"../../maestro/surfaces/herdr/herdr.ts?placement-reload",
			import.meta.url,
		);
		const reloaded = await import(url.href);
		const next = reloaded.createHerdrGroupedSurface("two", "/repo", 2, "right");
		const third = createHerdrGroupedSurface("three", "/repo", 2, "right");
		release.resolve();
		await Promise.all([first, next, third]);
		assert.deepEqual(d.counts(), { tabs: 2, splits: 1 });
		for (const tab of new Set(d.panes.map((pane) => pane.tab_id)))
			assert.ok(d.panes.filter((pane) => pane.tab_id === tab).length <= 2);
	});
});

test("an uncertain split quarantines its tab across reload, without poisoning later placement", async () => {
	const d = driver();
	await __herdrTest__.withMockHerdrExec(d.exec, async () => {
		await createHerdrGroupedSurface("one", "/repo", 4, "right");
		d.failSplit();
		await assert.rejects(
			createHerdrGroupedSurface("two", "/repo", 4, "right"),
			AcquisitionUncertainError,
		);
		const module = await import(
			new URL(
				"../../maestro/surfaces/herdr/herdr.ts?quarantine-reload",
				import.meta.url,
			).href
		);
		await module.createHerdrGroupedSurface("three", "/repo", 4, "right");
		assert.deepEqual(d.counts(), { tabs: 2, splits: 1 });
	});
});

test("unknown new tabs are never adopted by label or closed, even if they appear in a later snapshot", async () => {
	const d = driver();
	d.failTab();
	await __herdrTest__.withMockHerdrExec(d.exec, async () => {
		await assert.rejects(
			createHerdrGroupedSurface("one", "/repo", 4, "right"),
			AcquisitionUncertainError,
		);
		await createHerdrGroupedSurface("two", "/repo", 4, "right");
		assert.deepEqual(d.counts(), { tabs: 2, splits: 0 });
		assert.equal(d.panes.length, 2);
	});
});

test("user panes count toward capacity", async () => {
	const d = driver();
	await __herdrTest__.withMockHerdrExec(d.exec, async () => {
		await createHerdrGroupedSurface("one", "/repo", 2, "right");
		d.panes.push({ pane_id: "user", tab_id: "t1", workspace_id: "w" });
		await createHerdrGroupedSurface("two", "/repo", 2, "right");
		assert.deepEqual(d.counts(), { tabs: 2, splits: 0 });
	});
});

for (const reason of ["cancel", "expire"] as const)
	test(`queued ${reason} settles promptly and its job never dispatches later`, async () => {
		const gate = deferred(),
			entered = deferred();
		let dispatched = 0;
		const first = __herdrTest__.withPlacement(
			Deadline.after(1000),
			undefined,
			async () => {
				entered.resolve();
				await gate.promise;
			},
		);
		await entered.promise;
		const controller = new AbortController();
		const second = __herdrTest__.withPlacement(
			Deadline.after(reason === "expire" ? 15 : 1000),
			controller.signal,
			async () => {
				dispatched++;
			},
		);
		if (reason === "cancel") controller.abort();
		try {
			await assert.rejects(second);
			assert.equal(dispatched, 0);
		} finally {
			gate.resolve();
			await first;
		}
		await __herdrTest__.withPlacement(
			Deadline.after(1000),
			undefined,
			async () => {},
		);
		assert.equal(dispatched, 0);
	});

test("worktree execution errors enter bounded reconciliation but never authorize late dispatch", async () => {
	const calls: string[] = [];
	await __herdrTest__.withMockHerdrExec(
		(args, timeout) => {
			const op = args.slice(0, 2).join(" ");
			calls.push(op);
			if (op === "worktree create")
				throw new Error("client timed out after creating");
			if (op === "worktree list") {
				assert.ok(timeout && timeout <= 3000);
				return json({
					type: "worktree_list",
					worktrees: [
						{
							branch: "branch",
							path: "/retained",
							open_workspace_id: "w",
							is_linked_worktree: true,
						},
					],
				});
			}
			if (op === "pane list")
				return json({
					type: "pane_list",
					panes: [{ pane_id: "root", workspace_id: "w" }],
				});
			throw new Error(`unexpected ${op}`);
		},
		async () => {
			await assert.rejects(
				createHerdrWorktree("wt", "/repo", "branch", "base"),
				(error) =>
					error instanceof AcquisitionUncertainError &&
					error.uncertainty.kind === "worktree-create" &&
					error.uncertainty.recovered?.path === "/retained",
			);
			await closeHerdrSurface("root");
		},
	);
	assert.deepEqual(calls, [
		"worktree list",
		"worktree create",
		"worktree list",
		"pane list",
	]);
});

test("retained worktree roots count toward capacity and never close automatically", async () => {
	const d = driver();
	d.panes.push({ pane_id: "root", tab_id: "root-tab", workspace_id: "w" });
	await __herdrTest__.withMockHerdrExec(
		(args, timeout, mode) => {
			if (args[0] === "worktree" && args[1] === "list")
				return json({ type: "worktree_list", worktrees: [] });
			if (args[0] === "worktree" && args[1] === "create")
				return json({
					type: "worktree_created",
					worktree: { path: "/repo", branch: "b" },
					workspace: { workspace_id: "w" },
					root_pane: { pane_id: "root" },
					tab: { tab_id: "root-tab" },
				});
			assert.notEqual(args.slice(0, 2).join(" "), "pane close");
			return d.exec(args, timeout, mode);
		},
		async () => {
			await createHerdrWorktree("writer", "/source", "b", "base");
			await createHerdrGroupedSurface("review", "/repo", 2, "right");
			await createHerdrGroupedSurface("overflow", "/repo", 2, "right");
			await closeHerdrSurface("root");
			assert.deepEqual(d.counts(), { tabs: 1, splits: 1 });
		},
	);
});

test("cancelling a real queued grouped launch never sends its mutation", async () => {
	const d = driver(),
		gate = deferred();
	d.setGate(gate.promise);
	await __herdrTest__.withMockHerdrExec(d.exec, async () => {
		const first = createHerdrGroupedSurface("one", "/repo", 4, "right");
		await d.entered.promise;
		const controller = new AbortController();
		const queued = createHerdrGroupedSurface("two", "/repo", 4, "right", {
			signal: controller.signal,
		});
		controller.abort();
		try {
			await assert.rejects(queued);
		} finally {
			gate.resolve();
			await first;
		}
		assert.deepEqual(d.counts(), { tabs: 1, splits: 0 });
	});
});

test("partial worktree receipts preserve observed identities when reconciliation is unavailable", async () => {
	let lists = 0;
	await __herdrTest__.withMockHerdrExec(
		(args) => {
			if (args[0] === "worktree" && args[1] === "create")
				return json({
					worktree: { path: "/observed", branch: "b" },
					root_pane: { pane_id: "root" },
				});
			lists++;
			throw new Error("listing unavailable");
		},
		async () => {
			await assert.rejects(
				createHerdrWorktree("writer", "/repo", "b", "base"),
				(error) =>
					error instanceof AcquisitionUncertainError &&
					error.uncertainty.kind === "worktree-create" &&
					error.uncertainty.recovered?.path === "/observed" &&
					error.uncertainty.recovered.paneId === "root",
			);
			await closeHerdrSurface("root");
		},
	);
	assert.equal(lists, 2);
});

test("command dispatch failures and malformed responses are uncertain mutations", async () => {
	for (const output of ["invalid", json({})]) {
		await __herdrTest__.withMockHerdrExec(
			() => output,
			async () => {
				await assert.rejects(
					sendHerdrCommand("owned", "pi"),
					AcquisitionUncertainError,
				);
			},
		);
	}
	await __herdrTest__.withMockHerdrExec(
		() => {
			throw new Error("transport lost");
		},
		async () => {
			await assert.rejects(
				sendHerdrCommand("owned", "pi"),
				(error) =>
					error instanceof AcquisitionUncertainError &&
					error.uncertainty.kind === "command-dispatch" &&
					error.uncertainty.surfaceId === "owned",
			);
		},
	);
});
