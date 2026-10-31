import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import {
	POLLING_INTERVAL_MS,
	RECONCILE_INTERVAL_MS,
	SupervisionCoordinator,
} from "../../maestro/core/supervision.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { createDefaultRunSession } from "../../maestro/runtime/pi-run-session.ts";
import type { DefaultRunSessionOptions } from "../../maestro/runtime/pi-run-session-types.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";

function options(
	supervision: SupervisionCoordinator,
	forcePolling = false,
): DefaultRunSessionOptions {
	const surfaceProvider = new FakeSurfaceProvider();
	return {
		configDir: "/unused",
		configExamplePath: "/unused/config.json.example",
		forcePolling,
		roles: [],
		infrastructure: {
			surfaceProvider,
			launchOperations: launchOperationsFromSurface(surfaceProvider, {
				mode: "tab",
				direction: "right",
				maxPerTab: 4,
			}),
			supervision,
		},
		getLaunchSnapshot: () => {
			throw new Error("No launches in this fixture");
		},
		hooks: { onSettled() {} },
		persistent: {
			send: () => ({ error: "unused" }),
			stop: () => ({ error: "unused" }),
			drain() {},
		},
	};
}

test("reload changes forcePolling in both directions with zero children", async () => {
	const coordinator = new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		async () => ({ kind: "missing", observedAt: 0 }),
	);
	let session = createDefaultRunSession(options(coordinator));
	try {
		await session.shutdown("reload");
		session = createDefaultRunSession(options(coordinator, true), session);
		assert.deepEqual(session.diagnostics(), {
			mode: "polling(forced)",
			watcherCount: 0,
		});
		await session.shutdown("reload");
		session = createDefaultRunSession(options(coordinator), session);
		assert.deepEqual(session.diagnostics(), {
			mode: "wake+batch",
			watcherCount: 0,
		});
	} finally {
		await session.shutdown("quit");
	}
});

function watches() {
	const created: { referenced: boolean; closed: boolean; emit(): void }[] = [];
	const watchDirectory = (
		_directory: string,
		listener: (event: string, filename: string) => void,
	) => {
		const watcher = {
			referenced: true,
			closed: false,
			emit: () => listener("rename", "child.jsonl.exit"),
			ref() {
				watcher.referenced = true;
				return watcher;
			},
			unref() {
				watcher.referenced = false;
				return watcher;
			},
			close() {
				watcher.closed = true;
			},
			on() {
				return watcher;
			},
		};
		created.push(watcher);
		return watcher;
	};
	// SAFETY: the fake implements the fs.watch surface consumed by the registry.
	const registry = new FileWakeRegistry(watchDirectory as any);
	return { registry, created };
}

test("reload migrates live registrations and waits, retaining the owner across the gap", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const { registry, created } = watches();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let lists = 0;
	let inspections = 0;
	const coordinator = new SupervisionCoordinator(
		async () => {
			lists++;
			return {
				complete: true,
				panes: [{ paneId: "child", workspaceId: "workspace" }],
			};
		},
		async () => {
			inspections++;
			return { kind: "missing", observedAt: 0 };
		},
		false,
		registry,
		{
			setTimeout(callback, ms) {
				const timer = setTimeout(callback, ms);
				timers.add(timer);
				return timer;
			},
			clearTimeout(timer) {
				timers.delete(timer);
				clearTimeout(timer);
			},
		},
	);
	let session = createDefaultRunSession(options(coordinator));
	const controller = new AbortController();
	const signal = controller.signal;
	const child = coordinator.register("/sessions/child.jsonl", "child");
	const sibling = coordinator.register("/sessions/sibling.jsonl", "sibling");
	try {
		await child.wait(signal);
		await sibling.wait(signal);
		const gapWait = child.wait(signal);
		assert.equal(registry.retainedWaits, 1);
		await session.shutdown("reload");
		assert.equal(
			registry.retainedWaits,
			1,
			"shutdown must not release a live wait",
		);
		created[0].emit();
		assert.equal(
			await gapWait,
			"wake",
			"supervision runs during the reload gap",
		);
		const refreshed = child.wait(signal);
		t.mock.timers.tick(RECONCILE_INTERVAL_MS);
		assert.equal(await refreshed, "reconcile");
		await sibling.wait(signal);
		assert.equal((await child.inspectPane()).kind, "present");
		const parked = child.wait(signal);
		const siblingParked = sibling.wait(signal);
		assert.equal(registry.retainedWaits, 2);
		session = createDefaultRunSession(options(coordinator, true), session);
		assert.equal(await parked, "reconcile");
		assert.equal(await siblingParked, "reconcile");
		assert.deepEqual(session.diagnostics(), {
			mode: "polling(forced)",
			watcherCount: 0,
		});
		assert.equal(registry.retainedWaits, 0);
		assert.equal(created[0].closed, true);
		assert.equal(getEventListeners(signal, "abort").length, 0);
		assert.equal(
			(await child.inspectPane()).kind,
			"missing",
			"cached batch evidence was cleared",
		);
		assert.equal(inspections, 1);

		const polling = child.wait(signal);
		assert.equal(timers.size, 1);
		assert.equal(registry.retainedWaits, 0);
		t.mock.timers.tick(POLLING_INTERVAL_MS);
		assert.equal(await polling, "reconcile");
		assert.equal(timers.size, 0);
		const pollingAcrossGap = child.wait(signal);
		await session.shutdown("reload");
		assert.equal(timers.size, 1, "poll timer survives the gap");
		session = createDefaultRunSession(options(coordinator), session);
		assert.equal(await pollingAcrossGap, "reconcile");
		assert.equal(timers.size, 0, "mode change releases the old poll timer");
		assert.deepEqual(session.diagnostics(), {
			mode: "wake+batch",
			watcherCount: 1,
		});
		assert.equal(created.length, 2, "siblings share one replacement watch");
		assert.equal(created[1].referenced, false);
		await sibling.wait(signal);
		const resumed = child.wait(signal);
		assert.equal(registry.retainedWaits, 1);
		assert.equal(created[1].referenced, true);
		await session.shutdown("reload");
		session = createDefaultRunSession(options(coordinator), session);
		assert.equal(created.length, 2, "same-mode adoption is a no-op");
		assert.equal(registry.retainedWaits, 1);
		created[1].emit();
		assert.equal(await resumed, "wake");
		assert.equal(registry.retainedWaits, 0);

		const reconciled = child.wait(signal);
		t.mock.timers.tick(RECONCILE_INTERVAL_MS - POLLING_INTERVAL_MS);
		assert.equal(await reconciled, "reconcile");
		assert.equal(lists, 3, "only the original shared reconcile timer runs");
		const aborted = child.wait(signal);
		controller.abort();
		await assert.rejects(aborted, /Aborted while waiting/);
		assert.equal(registry.retainedWaits, 0);
		child.unregister();
		sibling.unregister();
		assert.equal(registry.watcherCount, 0);
		t.mock.timers.tick(RECONCILE_INTERVAL_MS);
		assert.equal(lists, 3, "last unregister releases shared reconciliation");
		assert.equal(getEventListeners(signal, "abort").length, 0);
	} finally {
		controller.abort();
		child.unregister();
		sibling.unregister();
		await session.shutdown("quit");
	}
});

for (const complete of [false, true]) {
	test(`in-flight batch (complete=${complete}) cannot undo an adopted forced mode`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		const { registry } = watches();
		let finishBatch!: (snapshot: { complete: boolean; panes: [] }) => void;
		const batch = new Promise<{ complete: boolean; panes: [] }>((resolve) => {
			finishBatch = resolve;
		});
		const coordinator = new SupervisionCoordinator(
			() => batch,
			async () => ({ kind: "missing", observedAt: 0 }),
			false,
			registry,
		);
		let session = createDefaultRunSession(options(coordinator));
		const signal = new AbortController().signal;
		const child = coordinator.register("/sessions/child.jsonl", "child");
		try {
			const pending = child.wait(signal);
			await session.shutdown("reload");
			session = createDefaultRunSession(options(coordinator, true), session);
			assert.equal(await pending, "reconcile");
			const polling = child.wait(signal);
			finishBatch({ complete, panes: [] });
			await batch;
			t.mock.timers.tick(POLLING_INTERVAL_MS);
			assert.equal(await polling, "reconcile");
			assert.equal(
				await child.wait(signal),
				"reconcile",
				"batch probe was queued behind the poll",
			);
			assert.deepEqual(session.diagnostics(), {
				mode: "polling(forced)",
				watcherCount: 0,
			});
			assert.equal(registry.retainedWaits, 0);
			const nextPoll = child.wait(signal);
			t.mock.timers.tick(POLLING_INTERVAL_MS);
			assert.equal(await nextPoll, "reconcile", "the new mode still polls");
		} finally {
			child.unregister();
			await session.shutdown("quit");
		}
	});
}

test("switching off forced polling falls back honestly when watches cannot open", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const registry = new FileWakeRegistry(() => {
		throw new Error("watch unavailable");
	});
	const coordinator = new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		async () => ({ kind: "missing", observedAt: 0 }),
		true,
		registry,
	);
	let session = createDefaultRunSession(options(coordinator, true));
	const signal = new AbortController().signal;
	const child = coordinator.register("/sessions/child.jsonl", "child");
	try {
		await child.wait(signal);
		const polling = child.wait(signal);
		await session.shutdown("reload");
		session = createDefaultRunSession(options(coordinator), session);
		assert.equal(await polling, "reconcile");
		assert.deepEqual(session.diagnostics(), {
			mode: "polling(fallback)",
			watcherCount: 0,
		});
		// A failed watch queues a reconcile as well as the transport change.
		await child.wait(signal);
		const fallback = child.wait(signal);
		t.mock.timers.tick(POLLING_INTERVAL_MS);
		assert.equal(await fallback, "reconcile");
		const pending = child.wait(signal);
		await assert.rejects(child.wait(signal), /already has a parked wait/);
		child.unregister();
		await assert.rejects(pending, /registration was unregistered/);
		assert.equal(registry.retainedWaits, 0);
		assert.equal(getEventListeners(signal, "abort").length, 0);
	} finally {
		child.unregister();
		await session.shutdown("quit");
	}
});

for (const forced of [false, true]) {
	test(`pre-upgrade owner allows unchanged mode but rejects a change from ${forced}`, async () => {
		const { registry, created } = watches();
		const coordinator = new SupervisionCoordinator(
			async () => ({ complete: true, panes: [] }),
			async () => ({ kind: "missing", observedAt: 0 }),
			forced,
			registry,
		);
		let session = createDefaultRunSession(options(coordinator, forced));
		// Simulate the prototype retained from the version before this method existed.
		Object.defineProperty(coordinator, "setForcePolling", { value: undefined });
		const signal = new AbortController().signal;
		const child = coordinator.register("/sessions/child.jsonl", "child");
		try {
			await child.wait(signal);
			await session.shutdown("reload");
			session = createDefaultRunSession(options(coordinator, forced), session);
			assert.throws(
				() => createDefaultRunSession(options(coordinator, !forced), session),
				/pre-upgrade coordinator.*restart Pi/,
			);
			assert.equal(
				session.diagnostics().mode,
				forced ? "polling(forced)" : "wake+batch",
			);
			if (!forced) {
				const pending = child.wait(signal);
				created[0].emit();
				assert.equal(
					await pending,
					"wake",
					"failed adoption leaves the owner intact",
				);
			}
		} finally {
			child.unregister();
			await session.shutdown("quit");
		}
	});
}
