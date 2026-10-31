import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLifecycle, markDelivery } from "../../maestro/core/lifecycle.ts";
import { createPiPersistentIO } from "../../maestro/runtime/pi-persistent-io.ts";
import { createWorktreeOperations } from "../../maestro/runtime/worktree-operations.ts";
import type {
	PiRunRecord,
	PiPersistentEvent,
	PiPersistentIO,
} from "../../maestro/runtime/index.ts";
import {
	appendPersistentTaskEvent,
	getPersistentDeliveryLedgerFile,
} from "../../maestro/adapters/pi/session.ts";
import { createPersistentControls } from "../../pi-extension/subagents/persistent.ts";
import { createDelivery } from "../../pi-extension/subagents/delivery.ts";
import {
	bindLiveApi,
	readGlobalSlot,
	releaseHeldDeliveries,
	RUNTIME_KEY,
	type RunningSubagent,
	type SubagentRuntime,
} from "../../pi-extension/subagents/state.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";

function specialist(t: TestContext, busy = false) {
	const dir = mkdtempSync(join(tmpdir(), "audit-persistent-"));
	const running: PiRunRecord & RunningSubagent = {
		id: "specialist",
		name: "specialist",
		task: "work",
		surface: "pane",
		startTime: 0,
		sessionFile: join(dir, "session.jsonl"),
		launchScriptFile: "unused",
		activityFile: "unused",
		interactive: false,
		runtimePlan: undefined,
		lifecycle: createLifecycle(0),
		persistent: true,
		logicalId: "specialist",
		generationId: "generation",
		policyHash: "a".repeat(64),
		taskId: busy ? "task" : undefined,
		issuedTaskIds: ["task"],
		tasksCompleted: 0,
	};
	const runtime: SubagentRuntime = {
		runningSubagents: new Map([[running.id, running]]),
	};
	const io = createPiPersistentIO({
		worktreeOperations: createWorktreeOperations(),
	});
	const makeControls = () =>
		createPersistentControls({
			runtime,
			persistentConfig: { maxAgents: 1 },
			resolveInterruptTarget: () => ({ running }),
		});
	const controls = makeControls();
	const makeDelivery = () =>
		createDelivery({
			runtime,
			updateWidget() {},
			startPersistentStopTimeout: controls.startPersistentStopTimeout,
		});
	const parent = createMockExtensionApi();
	bindLiveApi(runtime, parent.api);
	t.after(() => {
		if (running.stopTimeout) clearTimeout(running.stopTimeout);
		runtime.liveApi = undefined;
		runtime.reloadGap = false;
		releaseHeldDeliveries(runtime, undefined);
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		dir,
		running,
		runtime,
		io,
		controls,
		makeControls,
		makeDelivery,
		parent,
	};
}

for (const busy of [false, true]) {
	test(`stop publication failure is retryable and blocks sends (busy=${busy})`, (t) => {
		const f = specialist(t, busy);
		let calls = 0;
		const broken = {
			...f.io,
			requestStop() {
				calls++;
				throw new Error("publication failed");
			},
		};
		assert.throws(
			() =>
				f.controls.handleSubagentStop(
					{ id: f.running.id },
					f.parent.api,
					10,
					broken,
				),
			/publication failed/,
		);
		assert.equal(f.running.stopState, "failed");
		assert.equal(f.running.stopTimeout, undefined);
		assert.match(f.running.stopFailure!, /publication failed/);
		assert.equal(
			f.controls.handleSubagentSend({ id: f.running.id, message: "next" }, f.io)
				.details.outcome,
			"rejected-busy",
		);
		assert.equal(calls, 1);
		const retry = f
			.makeControls()
			.handleSubagentStop({ id: f.running.id }, f.parent.api, 10, f.io);
		assert.equal(
			retry.details.status,
			busy ? "stop_pending" : "stop_requested",
		);
		assert.equal(f.running.stopFailure, undefined);
		assert.equal(Boolean(f.running.stopTimeout), !busy);
	});
}

test("stop ledger failure publishes no inbox, and a later retry succeeds", (t) => {
	const f = specialist(t, true);
	const ledgerPath = getPersistentDeliveryLedgerFile(f.running.sessionFile);
	mkdirSync(ledgerPath);
	assert.throws(() =>
		f.controls.handleSubagentStop({ id: f.running.id }, f.parent.api, 10, f.io),
	);
	assert.equal(f.running.stopState, "failed");
	assert.equal(f.running.inboxSequence, undefined);
	assert.equal(
		readdirSync(f.dir).some((name) => name.includes("task-inbox")),
		false,
	);
	rmSync(ledgerPath, { recursive: true });
	assert.equal(
		f.controls.handleSubagentStop({ id: f.running.id }, f.parent.api, 10, f.io)
			.details.status,
		"stop_pending",
	);
	assert.equal(
		f.io.readLedger(f.running).filter((row) => row.outcome === "stop-pending")
			.length,
		1,
	);
});

test("stop inbox failure retains evidence without duplicating it on retry after reload", (t) => {
	const f = specialist(t, true);
	const blocked = `${f.running.sessionFile}.task-inbox.000000000001.json.tmp`;
	mkdirSync(blocked);
	assert.throws(() =>
		f.controls.handleSubagentStop({ id: f.running.id }, f.parent.api, 10, f.io),
	);
	assert.equal(f.running.stopState, "failed");
	assert.equal(f.running.stopTimeout, undefined);
	assert.deepEqual(
		f.io.readLedger(f.running).map((row) => row.outcome),
		["stop-pending"],
	);
	rmSync(blocked, { recursive: true });
	assert.equal(
		f
			.makeControls()
			.handleSubagentStop({ id: f.running.id }, f.parent.api, 10, f.io).details
			.status,
		"stop_pending",
	);
	assert.deepEqual(
		f.io.readLedger(f.running).map((row) => row.outcome),
		["stop-pending"],
	);
	assert.equal(f.running.inboxSequence, 2);
	assert.ok(
		readdirSync(f.dir).some((name) =>
			name.endsWith("task-inbox.000000000002.json"),
		),
	);
});

test("timeout in reload gap never calls either stale API and delivers exactly once after retirement", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = specialist(t);
	f.controls.handleSubagentStop({ id: f.running.id }, f.parent.api, 10, f.io);
	f.runtime.liveApi = undefined;
	f.runtime.reloadGap = true;
	f.runtime.pi = f.parent.api;
	f.parent.invalidate();
	t.mock.timers.tick(10);
	assert.equal(f.running.stopState, "failed");
	assert.equal(f.runtime.heldDeliveries?.length, 1);
	assert.equal(f.parent.sentMessages.length, 0);
	// The process can settle before session_start; that must not lose the notice.
	f.running.lifecycle = markDelivery(f.running.lifecycle, "delivered");
	f.runtime.runningSubagents.delete(f.running.id);
	const replacement = createMockExtensionApi();
	bindLiveApi(f.runtime, replacement.api);
	bindLiveApi(f.runtime, replacement.api);
	assert.equal(replacement.sentMessages.length, 1);
	assert.match(
		replacement.sentMessages[0].message.content,
		/exit was not confirmed/,
	);
	assert.equal(f.runtime.heldDeliveries?.length, 0);
});

test("quit releases a held stop failure without sending or retaining a retry", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = specialist(t);
	f.controls.handleSubagentStop({ id: f.running.id }, f.parent.api, 10, f.io);
	f.runtime.liveApi = undefined;
	f.runtime.reloadGap = true;
	f.parent.invalidate();
	t.mock.timers.tick(10);
	f.runtime.reloadGap = false;
	releaseHeldDeliveries(f.runtime, undefined);
	const replacement = createMockExtensionApi();
	bindLiveApi(f.runtime, replacement.api);
	t.mock.timers.tick(2_000);
	assert.equal(replacement.sentMessages.length, 0);
	assert.equal(f.runtime.heldDeliveries?.length, 0);
});

test("timeout evidence and send errors are contained, retried live, and cancelled on quit", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = specialist(t);
	let reads = 0;
	let sends = 0;
	const io: PiPersistentIO = {
		...f.io,
		inspectWorktree() {
			if (++reads === 1) throw new Error("read fault");
			return undefined;
		},
	};
	const send = f.parent.api.sendMessage;
	f.parent.api.sendMessage = (...args: Parameters<typeof send>) => {
		if (++sends === 1) throw new Error("send fault");
		send(...args);
	};
	f.controls.handleSubagentStop({ id: f.running.id }, f.parent.api, 10, io);
	t.mock.timers.tick(10);
	assert.equal(reads, 1);
	t.mock.timers.tick(1_000);
	assert.equal(sends, 1);
	f.runtime.liveApi = undefined;
	f.runtime.reloadGap = true;
	f.parent.invalidate();
	t.mock.timers.tick(1_000);
	const replacement = createMockExtensionApi();
	bindLiveApi(f.runtime, replacement.api);
	t.mock.timers.tick(5_000);
	assert.equal(replacement.sentMessages.length, 1);
	assert.equal(f.runtime.heldDeliveries?.length, 0);
	// A second failed stop attempt is pending when quit arrives.
	f.controls.handleSubagentStop({ id: f.running.id }, replacement.api, 10, io);
	replacement.api.sendMessage = () => {
		throw new Error("unavailable");
	};
	t.mock.timers.tick(10);
	assert.equal(f.runtime.heldDeliveries?.length, 1);
	f.runtime.liveApi = undefined;
	releaseHeldDeliveries(f.runtime, undefined);
	t.mock.timers.tick(5_000);
	assert.equal(f.runtime.heldDeliveries?.length, 0);
});

for (const type of ["task-done", "help-request"] as const) {
	test(`${type}: ack failure across reload retries only the ack, including a reentrant drain`, (t) => {
		const f = specialist(t, true);
		const event = appendPersistentTaskEvent(f.running.sessionFile, {
			type,
			task: "task",
			generation: "generation",
			message: "help",
		});
		f.running.stopState = "pending";
		let acks = 0;
		const io = {
			...f.io,
			acknowledge(record: PiRunRecord, value: PiPersistentEvent) {
				if (++acks === 1) throw new Error("ack failed");
				return f.io.acknowledge(record, value);
			},
		};
		const send = f.parent.api.sendMessage;
		f.parent.api.sendMessage = (...args: Parameters<typeof send>) => {
			f.makeDelivery().drainPersistentTaskEvents(f.running, f.parent.api, io);
			send(...args);
		};
		assert.throws(
			() =>
				f.makeDelivery().drainPersistentTaskEvents(f.running, f.parent.api, io),
			/ack failed/,
		);
		assert.equal(f.parent.sentMessages.length, 1);
		assert.equal(f.running.observedTaskEvents, undefined);
		assert.equal(f.running.tasksCompleted, 0);
		assert.equal(f.running.taskId, "task");
		assert.equal(
			f.running.persistentTaskDeliveries?.get(`${type}:task`),
			"sent",
		);
		f.parent.invalidate();
		f.runtime.pi = f.parent.api; // Never choose this stale loaded API over the live caller.
		f.runtime.liveApi = undefined;
		f.runtime.reloadGap = true;
		const replacement = createMockExtensionApi();
		bindLiveApi(f.runtime, replacement.api);
		const reloaded = f.makeDelivery();
		reloaded.drainPersistentTaskEvents(f.running, replacement.api, io);
		reloaded.deliverPersistentTaskEvent(f.running, event, replacement.api, io);
		assert.equal(acks, 2);
		assert.equal(replacement.sentMessages.length, 0);
		assert.equal(f.io.readLedger(f.running).length, 1);
		assert.equal(f.running.taskId, undefined);
		assert.equal(f.running.tasksCompleted, type === "task-done" ? 1 : 0);
		assert.equal(f.running.observedTaskEvents, 1);
		assert.ok(
			f.running.stopTimeout,
			"both terminal task outcomes start the pending stop wait",
		);
	});
}

test("failed task send remains retryable and does not acknowledge", (t) => {
	const f = specialist(t, true);
	const event = appendPersistentTaskEvent(f.running.sessionFile, {
		type: "task-done",
		task: "task",
		generation: "generation",
	});
	assert.throws(
		() =>
			f.makeDelivery().deliverPersistentTaskEvent(
				f.running,
				event,
				{
					sendMessage() {
						throw new Error("send fault");
					},
				},
				f.io,
			),
		/send fault/,
	);
	assert.equal(f.io.readLedger(f.running).length, 0);
	assert.equal(f.running.persistentTaskDeliveries?.size, 0);
	f.makeDelivery().deliverPersistentTaskEvent(
		f.running,
		event,
		f.parent.api,
		f.io,
	);
	assert.equal(f.parent.sentMessages.length, 1);
	assert.equal(f.running.tasksCompleted, 1);
});

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

// Use the public tool and real runtime with fake terminal acquisition. This also
// exercises index.ts shutdown/adoption rather than simulating its reservation edits.
async function hostFixture(t: TestContext) {
	const configDir = join(process.env.PI_CODING_AGENT_DIR!, "herdr-agents");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			status: { enabled: false },
			persistent: { maxAgents: 1 },
		}),
	);
	const { default: extension } = await import(
		"../../pi-extension/subagents/index.ts"
	);
	const dir = mkdtempSync(join(tmpdir(), "audit-capacity-"));
	const parent = join(dir, "parent.jsonl");
	writeFileSync(
		parent,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) +
			"\n",
	);
	const provider = new FakeSurfaceProvider();
	const supervision = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: provider
				.listSurfaces()
				.map((pane) => ({ paneId: pane.id, workspaceId: "fixture" })),
		}),
		(id) => provider.inspectSurface(id),
	);
	const operations = launchOperationsFromSurface(provider, {
		mode: "tab",
		direction: "right",
		maxPerTab: 4,
	});
	const entered = deferred();
	const gate = deferred();
	let acquisitions = 0;
	operations.waitForShellReady = async () => {
		if (++acquisitions !== 1) return;
		entered.resolve();
		await gate.promise;
	};
	operations.runScript = (_id, _command, options) => options.scriptPath;
	const model = { provider: "test", id: "one", reasoning: true };
	const ctx = {
		cwd: dir,
		model,
		modelRegistry: {
			find: () => model,
			getAvailable: () => [model],
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionFile: () => parent,
			getSessionId: () => "parent",
			getSessionDir: () => dir,
		},
		ui: { notify() {}, setWidget() {} },
	};
	function load() {
		const mock = createMockExtensionApi();
		mock.api.getThinkingLevel = () => "high";
		extension(mock.api, {
			infrastructure: {
				surfaceProvider: provider,
				launchOperations: operations,
				supervision,
			},
		});
		const tool = mock.registeredTools.find(
			(entry) => entry.name === "subagent",
		);
		return {
			...mock,
			start: () => mock.eventHandlers.get("session_start")![0]({}, ctx),
			shutdown: (reason: string) =>
				mock.eventHandlers.get("session_shutdown")![0]({ reason }, ctx),
			spawn: (name: string) =>
				tool.execute(
					name,
					{
						name,
						task: "work",
						persistent: true,
						model: "test/one",
						thinking: "high",
						fork: false,
					},
					new AbortController().signal,
					() => {},
					ctx,
				),
		};
	}
	const first = load();
	await first.start();
	const runtime = readGlobalSlot<SubagentRuntime>(RUNTIME_KEY)!;
	t.after(async () => {
		gate.resolve();
		await first.shutdown("quit");
		await new Promise<void>((resolve) => setImmediate(resolve));
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		first,
		load,
		runtime,
		entered,
		gate,
		provider,
		acquisitions: () => acquisitions,
	};
}

test("maxAgents=1 reserves overlapping acquisitions across reload, releases failure, and transfers success", async (t) => {
	const f = await hostFixture(t);
	const launching = f.first.spawn("first");
	await f.entered.promise;
	assert.equal(f.runtime.runningSubagents.size, 0);
	assert.equal(f.runtime.persistentReservations?.size, 1);
	assert.equal(
		(await f.first.spawn("overlap")).details.error,
		"persistent-cap",
	);
	assert.equal(f.acquisitions(), 1);
	await f.first.shutdown("reload");
	f.first.invalidate();
	const next = f.load();
	await next.start();
	assert.equal(
		(await next.spawn("after-reload")).details.error,
		"persistent-cap",
	);
	f.gate.reject(new Error("acquisition failed"));
	await assert.rejects(launching, /acquisition failed/);
	assert.equal(f.runtime.persistentReservations?.size, 0);
	assert.equal(f.runtime.runningSubagents.size, 0);
	assert.equal((await next.spawn("retry")).details.status, "started");
	assert.equal(f.runtime.persistentReservations?.size, 0);
	assert.equal(f.runtime.runningSubagents.size, 1);
	assert.equal((await next.spawn("at-cap")).details.error, "persistent-cap");
	await next.shutdown("quit");
});

test("quit clears an in-flight capacity reservation and late acquisition cannot resurrect it", async (t) => {
	const f = await hostFixture(t);
	const launching = f.first.spawn("quitting");
	await f.entered.promise;
	const rejected = assert.rejects(launching);
	const shutdown = f.first.shutdown("quit");
	assert.equal(f.runtime.persistentReservations?.size, 0);
	f.gate.resolve();
	await shutdown;
	await rejected;
	assert.equal(f.runtime.persistentReservations?.size, 0);
	assert.equal(f.runtime.runningSubagents.size, 0);
});
