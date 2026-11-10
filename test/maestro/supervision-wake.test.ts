import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";

const never = () => new AbortController().signal;

test("parked wake wait observes a sidecar written after the registration reconcile", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wake-parked-"));
	const supervisor = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: [{ paneId: "child", workspaceId: "workspace" }],
		}),
		async () => ({
			kind: "present",
			agentStatus: "idle",
			observedAt: Date.now(),
		}),
	);
	try {
		const sessionFile = join(dir, "child.jsonl");
		const registration = supervisor.register(sessionFile, "child");
		assert.equal(supervisor.diagnostics().mode, "wake+batch");
		assert.equal(supervisor.diagnostics().watcherCount, 1);
		// Registration queues one reconcile. Consuming it leaves the next wait
		// parked on the directory watch, with no timer of its own.
		assert.equal(await registration.wait(never()), "reconcile");
		const aborted = new AbortController();
		const early = registration.wait(aborted.signal);
		aborted.abort();
		await assert.rejects(early, /Aborted while waiting for subagent to finish/);
		const parked = registration.wait(never());
		const temporary = `${sessionFile}.exit.tmp`;
		writeFileSync(temporary, "{}");
		renameSync(temporary, `${sessionFile}.exit`);
		assert.equal(await parked, "wake");
		registration.unregister();
		assert.equal(supervisor.diagnostics().watcherCount, 0);
	} finally {
		supervisor.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

interface FakeWatcher {
	directory: string;
	referenced: boolean;
	closed: boolean;
	emit(filename: string): void;
}

// Records the actual ref/unref state of every watch the registry creates.
function fakeWatches() {
	const watchers: FakeWatcher[] = [];
	const watch = (
		directory: string,
		listener: (event: string, filename: string | null) => void,
	) => {
		const watcher = {
			directory,
			referenced: true,
			closed: false,
			emit: (filename: string) => listener("rename", filename),
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
		watchers.push(watcher);
		return watcher;
	};
	// SAFETY: the fake implements the fs.watch surface FileWakeRegistry uses.
	const registry = new FileWakeRegistry(watch as any);
	return { registry, watchers };
}

function coordinator(registry: FileWakeRegistry) {
	return new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		async () => ({
			kind: "present",
			agentStatus: "idle",
			observedAt: Date.now(),
		}),
		false,
		registry,
	);
}

describe("wake retain accounting before close", () => {
	test("a settled and an aborted wait each release the watch reference", async () => {
		const { registry, watchers } = fakeWatches();
		const supervisor = coordinator(registry);
		try {
			const registration = supervisor.register("/a/child.jsonl", "child");
			assert.equal(await registration.wait(never()), "reconcile");
			assert.equal(watchers.length, 1);
			assert.equal(watchers[0].referenced, false, "idle watch is unref'd");

			const woken = registration.wait(never());
			assert.equal(registry.retainedWaits, 1);
			assert.equal(watchers[0].referenced, true, "parked wait refs it");
			watchers[0].emit("child.jsonl.exit");
			assert.equal(await woken, "wake");
			assert.equal(registry.retainedWaits, 0);
			assert.equal(watchers[0].referenced, false, "settled wait unrefs it");

			const controller = new AbortController();
			const aborted = registration.wait(controller.signal);
			assert.equal(registry.retainedWaits, 1);
			assert.equal(watchers[0].referenced, true);
			controller.abort();
			await assert.rejects(aborted, /Aborted while waiting/);
			assert.equal(registry.retainedWaits, 0);
			assert.equal(watchers[0].referenced, false, "aborted wait unrefs it");
			registration.unregister();
		} finally {
			supervisor.close();
		}
	});

	test("a watch created while a wait is parked is referenced, then released", async () => {
		const { registry, watchers } = fakeWatches();
		const supervisor = coordinator(registry);
		try {
			const first = supervisor.register("/a/one.jsonl", "one");
			assert.equal(await first.wait(never()), "reconcile");
			const parked = first.wait(never());
			const second = supervisor.register("/b/two.jsonl", "two");
			assert.equal(watchers.length, 2);
			assert.equal(watchers[1].directory, "/b");
			assert.equal(watchers[1].referenced, true, "new watch joins the retain");
			watchers[0].emit("one.jsonl.exit");
			assert.equal(await parked, "wake");
			assert.equal(registry.retainedWaits, 0);
			assert.deepEqual(
				watchers.map((watcher) => watcher.referenced),
				[false, false],
			);
			first.unregister();
			second.unregister();
		} finally {
			supervisor.close();
		}
	});

	test("a wait parked at unregister settles and returns its retain", async () => {
		const { registry, watchers } = fakeWatches();
		const supervisor = coordinator(registry);
		try {
			const registration = supervisor.register("/a/child.jsonl", "child");
			assert.equal(await registration.wait(never()), "reconcile");
			const parked = registration.wait(never());
			assert.equal(registry.retainedWaits, 1);
			registration.unregister();
			await assert.rejects(parked, /registration was unregistered/);
			assert.equal(registry.retainedWaits, 0);
			await assert.rejects(
				registration.wait(never()),
				/registration was unregistered/,
			);
			assert.equal(
				registry.retainedWaits,
				0,
				"a dead registration never parks",
			);
			const idle = supervisor.register("/a/idle.jsonl", "idle");
			assert.equal(registry.retainedWaits, 0);
			const current = watchers.at(-1)!;
			assert.equal(current.closed, false);
			assert.equal(current.referenced, false, "idle child's watch is unref'd");
			idle.unregister();
		} finally {
			supervisor.close();
		}
	});

	test("a second concurrent wait is rejected and cannot strand the first", async () => {
		const { registry, watchers } = fakeWatches();
		const supervisor = coordinator(registry);
		try {
			const registration = supervisor.register("/a/child.jsonl", "child");
			assert.equal(await registration.wait(never()), "reconcile");
			const controller = new AbortController();
			const first = registration.wait(controller.signal);
			await assert.rejects(
				registration.wait(never()),
				/already has a parked wait/,
			);
			assert.equal(registry.retainedWaits, 1, "the rejected wait took none");
			controller.abort();
			await assert.rejects(first, /Aborted while waiting/);
			assert.equal(registry.retainedWaits, 0);
			const next = registration.wait(never());
			watchers[0].emit("child.jsonl.exit");
			assert.equal(await next, "wake");
			assert.equal(registry.retainedWaits, 0);
			assert.equal(watchers[0].referenced, false);
			registration.unregister();
		} finally {
			supervisor.close();
		}
	});

	test("a settled wait removes its abort listener from a long-lived signal", async () => {
		const { registry, watchers } = fakeWatches();
		const supervisor = coordinator(registry);
		const signal = new AbortController().signal;
		const listeners = () => getEventListeners(signal, "abort").length;
		try {
			const registration = supervisor.register("/a/child.jsonl", "child");
			assert.equal(await registration.wait(signal), "reconcile");
			const woken = registration.wait(signal);
			assert.equal(listeners(), 1);
			watchers[0].emit("child.jsonl.exit");
			assert.equal(await woken, "wake");
			assert.equal(listeners(), 0, "a woken wait detaches");

			const parked = registration.wait(signal);
			await assert.rejects(
				registration.wait(signal),
				/already has a parked wait/,
			);
			assert.equal(listeners(), 1, "a rejected wait attaches nothing");
			registration.unregister();
			await assert.rejects(parked, /registration was unregistered/);
			assert.equal(listeners(), 0, "an unregistered wait detaches");
		} finally {
			supervisor.close();
		}
	});

	test("each release counts once and only the last one unrefs", () => {
		const { registry, watchers } = fakeWatches();
		const registration = registry.register(
			"/a/child.jsonl",
			() => {},
			() => assert.fail("watcher unexpectedly fell back"),
		);
		try {
			const one = registry.retain();
			const two = registry.retain();
			assert.equal(registry.retainedWaits, 2);
			one();
			one();
			assert.equal(registry.retainedWaits, 1, "a repeated release is ignored");
			assert.equal(watchers[0].referenced, true);
			two();
			assert.equal(registry.retainedWaits, 0);
			assert.equal(watchers[0].referenced, false);
			registration.unregister();
		} finally {
			registry.close();
		}
	});

	test("close resets the count and a later retain is a no-op", () => {
		const { registry, watchers } = fakeWatches();
		registry.register(
			"/a/child.jsonl",
			() => {},
			() => assert.fail("watcher unexpectedly fell back"),
		);
		const outstanding = registry.retain();
		assert.equal(registry.retainedWaits, 1);
		registry.close();
		assert.equal(registry.retainedWaits, 0);
		assert.equal(watchers[0].closed, true);
		const late = registry.retain();
		assert.equal(
			registry.retainedWaits,
			0,
			"a closed registry retains nothing",
		);
		late();
		outstanding();
		assert.equal(registry.retainedWaits, 0);
	});
});
