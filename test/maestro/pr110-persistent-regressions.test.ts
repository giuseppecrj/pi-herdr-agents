import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	createLifecycle,
	markCompleted,
	markCompletionDetected,
	markFailed,
	observePaneInspection,
} from "../../maestro/core/lifecycle.ts";
import type { CompletionResult } from "../../maestro/core/types.ts";
import type { WorktreeHandoff } from "../../maestro/core/worktree.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import { createDefaultRunSession } from "../../maestro/runtime/pi-run-session.ts";
import { createPiPersistentIO } from "../../maestro/runtime/pi-persistent-io.ts";
import { createWorktreeOperations } from "../../maestro/runtime/worktree-operations.ts";
import type {
	DefaultRunSessionOptions,
	PiLaunchInput,
	PiPersistentIO,
	PiRunRecord,
} from "../../maestro/runtime/pi-run-session-types.ts";
import {
	appendPersistentTaskEvent,
	readPersistentDeliveryLedger,
} from "../../maestro/adapters/pi/session.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import {
	createPersistentControls,
	persistentSpecialistState,
} from "../../pi-extension/subagents/persistent.ts";
import { createDelivery } from "../../pi-extension/subagents/delivery.ts";
import {
	bindLiveApi,
	releaseHeldDeliveries,
	type RunningSubagent,
	type SubagentRuntime,
} from "../../pi-extension/subagents/state.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

const STOP_WAIT = 10;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

const inboxes = (sessionFile: string) =>
	readdirSync(dirname(sessionFile)).filter((name) =>
		name.includes(".task-inbox."),
	);

async function finalizingSession(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pr110-finalizing-"));
	const parentFile = join(dir, "parent.jsonl");
	writeFileSync(
		parentFile,
		JSON.stringify({ type: "session", version: 3, id: "p", cwd: dir }) + "\n",
	);
	const provider = new FakeSurfaceProvider();
	const paneConfig = {
		mode: "tab" as const,
		direction: "right" as const,
		maxPerTab: 4,
	};
	const worktreeOps = createWorktreeOperations();
	worktreeOps.resolveGitCommit = async () => "a".repeat(40);
	worktreeOps.resolveWorktreeProvisionCwd = async (cwd) => cwd;
	const captureEntered = deferred();
	const releaseCapture = deferred();
	worktreeOps.captureWorktreeHandoff = async (worktree) => {
		captureEntered.resolve();
		await releaseCapture.promise;
		const handoff: WorktreeHandoff = {
			...worktree,
			headSha: null,
			commitsAhead: null,
			clean: null,
			conflicted: null,
			changedFiles: null,
			untrackedFiles: null,
			gitError: "paused fixture",
		};
		return handoff;
	};
	const operations = launchOperationsFromSurface(
		provider,
		paneConfig,
		worktreeOps,
	);
	operations.runScript = (_id, _command, options) => options.scriptPath;
	operations.captureProcessIdentity = async () => {
		throw new Error("startup is not under test");
	};
	const supervision = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: provider
				.listSurfaces()
				.map((pane) => ({ paneId: pane.id, workspaceId: "w" })),
		}),
		(id) => provider.inspectSurface(id),
		true,
	);
	const runtime: SubagentRuntime = { runningSubagents: new Map() };
	let record: (PiRunRecord & RunningSubagent) | undefined;
	const controls = createPersistentControls({
		runtime,
		persistentConfig: { maxAgents: 1 },
		resolveInterruptTarget: () =>
			record ? { running: record } : { error: "no specialist" },
	});
	const parent = createMockExtensionApi();
	const options: DefaultRunSessionOptions = {
		configDir: dir,
		configExamplePath: new URL("../../config.json.example", import.meta.url)
			.pathname,
		forcePolling: true,
		roles: [],
		infrastructure: {
			surfaceProvider: provider,
			launchOperations: operations,
			supervision,
			worktreeOperations: worktreeOps,
		},
		getLaunchSnapshot: () => ({
			parent: {
				cwd: dir,
				invocationCwd: dir,
				sessionFile: parentFile,
				sessionId: "p",
				sessionDir: dir,
				agentDir: dir,
			},
			parentRuntime: { provider: "test", modelId: "one", thinking: "high" },
			paneConfig,
			modelRegistry: {
				find: (p, id) => ({ provider: p, id, reasoning: true }),
				available: () => [],
				hasConfiguredAuth: () => true,
				supportedThinkingLevels: () => ["high"],
				clampThinkingLevel: (_model, level) => level,
			},
		}),
		hooks: {
			onSpawned(spawned) {
				record = spawned;
				runtime.runningSubagents.set(spawned.id, spawned);
			},
			onSettled: () => "delivered",
		},
		persistent: {
			send(r, text, io) {
				const details = controls.handleSubagentSend(
					{ id: r.id, message: text },
					io,
				).details;
				if (details.error)
					return {
						error: details.error,
						task: details.task,
						outcome:
							details.outcome === "rejected-busy" ? details.outcome : undefined,
					};
				return {
					id: r.id,
					task: details.task!,
					inbox: details.inbox!,
					outcome: "dispatched",
				};
			},
			stop(r, timeoutMs, io) {
				const details = controls.handleSubagentStop(
					{ id: r.id },
					parent.api,
					timeoutMs,
					io,
				).details;
				return details.error
					? { error: details.error, id: details.id, name: details.name }
					: { id: r.id, name: r.name, status: details.status! };
			},
			drain() {},
		},
	};
	const session = createDefaultRunSession(options);
	const task: PiLaunchInput["task"] = {
		id: "specialist",
		name: "specialist",
		prompt: "first",
		cwd: dir,
		role: "",
		behavior: { autoExit: false, persistent: true },
		worktree: { branch: "b" },
	};
	const input: PiLaunchInput = {
		task,
		role: {
			name: "",
			version: "1",
			description: "",
			systemPrompt: "",
			allowedTools: [],
		},
		plans: [
			{
				provider: "test",
				modelId: "one",
				model: "test/one",
				thinking: "high",
				modelSource: "request",
				thinkingSource: "parent",
			},
		],
		resolved: {},
		identity: {
			id: "s",
			logicalId: "s",
			generationId: "g",
			taskId: "initial",
		},
	};
	let outcome: Promise<unknown> | undefined;
	t.after(async () => {
		releaseCapture.resolve();
		if (outcome) await outcome;
		await session.shutdown("quit");
		supervision.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const handle = await session.spawnPi(input);
	const live = record!;
	const io = createPiPersistentIO({ worktreeOperations: worktreeOps });
	io.acknowledge(live, {
		version: 1,
		type: "task-done",
		task: "initial",
		generation: "g",
		at: new Date(0).toISOString(),
	});
	writeFileSync(
		live.sessionFile,
		JSON.stringify({ type: "session", version: 3, id: "s", cwd: live.cwd }) +
			"\n",
	);
	writeFileSync(
		`${live.sessionFile}.exit`,
		JSON.stringify({ type: "error", errorMessage: "process exited" }),
	);
	provider.appendScreen(live.surface, "__SUBAGENT_DONE_1__");
	outcome = session.supervise(handle, task);
	await captureEntered.promise;
	return { session, record: live, taskId: task.id };
}

for (const priorStop of [undefined, "failed"] as const)
	test(`real session: exited process during paused handoff rejects send and stop (stopState=${priorStop ?? "none"})`, async (t) => {
		const f = await finalizingSession(t);
		assert.equal(f.record.lifecycle.process.kind, "finalizing");
		f.record.stopState = priorStop;
		const issued = [...(f.record.issuedTaskIds ?? [])];
		const inboxBefore = inboxes(f.record.sessionFile);
		const ledgerBefore = readPersistentDeliveryLedger(f.record.sessionFile);

		const ack = await f.session.sendPersistent(f.taskId, "next task");
		assert.ok("error" in ack, "an exited process must not accept work");
		assert.equal(ack.outcome, "rejected-busy");
		assert.deepEqual(inboxes(f.record.sessionFile), inboxBefore);
		assert.deepEqual(f.record.issuedTaskIds ?? [], issued);
		assert.equal(f.record.taskId, undefined);
		const ledgerAfterSend = readPersistentDeliveryLedger(f.record.sessionFile);
		assert.equal(ledgerAfterSend.length, ledgerBefore.length + 1);
		assert.deepEqual(
			{
				task: ledgerAfterSend.at(-1)!.task,
				outcome: ledgerAfterSend.at(-1)!.outcome,
			},
			{ task: ack.task, outcome: "rejected-busy" },
		);

		const stop = await f.session.stopPersistent(f.taskId, STOP_WAIT);
		assert.ok("error" in stop, "an exited process gets no stop directive");
		assert.match(stop.error, /already stopped/);
		assert.equal(f.record.stopState, priorStop);
		assert.equal(f.record.stopTimeout, undefined);
		assert.deepEqual(inboxes(f.record.sessionFile), inboxBefore);
		assert.deepEqual(
			readPersistentDeliveryLedger(f.record.sessionFile),
			ledgerAfterSend,
		);
		assert.equal(f.record.lifecycle.process.kind, "finalizing");
	});

function specialist(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const dir = mkdtempSync(join(tmpdir(), "pr110-persistent-"));
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
		issuedTaskIds: ["initial"],
		tasksCompleted: 0,
	};
	const runtime: SubagentRuntime = {
		runningSubagents: new Map([[running.id, running]]),
	};
	const real = createPiPersistentIO({
		worktreeOperations: createWorktreeOperations(),
	});
	const calls = { dispatch: 0, requestStop: 0, rejectBusy: 0 };
	const io: PiPersistentIO = {
		...real,
		dispatch(r, task, text) {
			calls.dispatch++;
			return real.dispatch(r, task, text);
		},
		requestStop(r) {
			calls.requestStop++;
			real.requestStop(r);
		},
		rejectBusy(r, task) {
			calls.rejectBusy++;
			real.rejectBusy(r, task);
		},
	};
	const controls = createPersistentControls({
		runtime,
		persistentConfig: { maxAgents: 1 },
		resolveInterruptTarget: () => ({ running }),
	});
	const delivery = createDelivery({
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
		running,
		runtime,
		io,
		calls,
		controls,
		delivery,
		parent,
		stop: () =>
			controls.handleSubagentStop(
				{ id: running.id },
				parent.api,
				STOP_WAIT,
				io,
			),
		send: () =>
			controls.handleSubagentSend({ id: running.id, message: "next" }, io),
		outcomes: () => real.readLedger(running).map((row) => row.outcome),
	};
}

const completion: CompletionResult = { reason: "done", exitCode: 0 };
const exited = {
	finalizing: () => markCompletionDetected(createLifecycle(0), completion, 1),
	completed: () =>
		markCompleted(markCompletionDetected(createLifecycle(0), completion, 1), 2),
	failed: () => markFailed(createLifecycle(0), "process exited", 1, 1),
};
const flags = {
	"completed task": { tasksCompleted: 1 },
	"open task": { taskId: "initial" },
	"requested stop": { stopState: "requested" },
	"pending stop": { stopState: "pending", taskId: "initial" },
	"failed stop": { stopState: "failed" },
	"uncertain launch": {
		launchFailure: "dispatch uncertain",
		taskId: "initial",
	},
} satisfies Record<string, Partial<PiRunRecord & RunningSubagent>>;

for (const [process, lifecycle] of Object.entries(exited))
	for (const [label, extra] of Object.entries(flags))
		test(`${process} process dominates ${label}: stopped, rejected-busy, no stop directive`, (t) => {
			const f = specialist(t);
			Object.assign(f.running, extra, { lifecycle: lifecycle() });
			const before = { ...f.running };
			assert.equal(persistentSpecialistState(f.running), "stopped");
			const sent = f.send();
			assert.equal(sent.details.outcome, "rejected-busy");
			assert.equal(f.calls.dispatch, 0);
			assert.equal(f.calls.rejectBusy, 1);
			const stopped = f.stop();
			assert.match(stopped.details.error ?? "", /already stopped/);
			assert.equal(f.calls.requestStop, 0);
			assert.equal(f.running.stopState, before.stopState);
			assert.equal(f.running.stopTimeout, undefined);
			assert.equal(f.running.taskId, before.taskId);
			assert.deepEqual(f.outcomes(), ["rejected-busy"]);
		});

test("open process idle after a completed task accepts work despite a stale Herdr working status", (t) => {
	const f = specialist(t);
	f.running.tasksCompleted = 1;
	f.running.lifecycle = observePaneInspection(
		createLifecycle(0),
		{ kind: "present", agentStatus: "working", observedAt: 1 },
		1,
	);
	assert.equal(f.running.lifecycle.process.kind, "running");
	assert.equal(persistentSpecialistState(f.running), "idle");
	const sent = f.send();
	assert.equal(sent.details.outcome, "dispatched");
	assert.equal(f.calls.dispatch, 1);
	assert.deepEqual(f.outcomes(), ["dispatched"]);
});

test("uncertain launch with an initial task gets a bounded, retryable stop", async (t) => {
	const f = specialist(t);
	f.running.taskId = "initial";
	f.running.launchFailure = "dispatch uncertain";

	const first = f.stop();
	assert.equal(first.details.status, "stop_requested");
	assert.equal(f.running.stopState, "requested");
	assert.ok(f.running.stopTimeout, "the exit wait starts immediately");
	assert.equal(f.calls.requestStop, 1);

	t.mock.timers.tick(STOP_WAIT);
	await turn();
	assert.equal(f.running.stopState, "failed");
	assert.match(f.running.stopFailure!, /not confirmed/);
	assert.equal(f.runtime.runningSubagents.get(f.running.id), f.running);
	assert.equal(f.running.taskId, "initial");
	assert.deepEqual(f.running.issuedTaskIds, ["initial"]);
	assert.deepEqual(
		f.parent.sentMessages.map(({ message }) => message.details.status),
		["failed"],
	);
	assert.equal(persistentSpecialistState(f.running), "stalled");

	const retry = f.stop();
	assert.equal(retry.details.status, "stop_requested");
	assert.equal(f.calls.requestStop, 2);
	assert.ok(f.running.stopTimeout, "a retry gets a fresh bounded wait");
	t.mock.timers.tick(STOP_WAIT);
	await turn();
	assert.equal(f.running.stopState, "failed");
	assert.equal(f.running.taskId, "initial");
	assert.equal(f.runtime.runningSubagents.get(f.running.id), f.running);
	assert.deepEqual(
		f.parent.sentMessages.map(({ message }) => message.details.status),
		["failed", "failed"],
	);
	assert.deepEqual(f.outcomes(), ["stop-pending"]);
});

for (const [process, lifecycle] of Object.entries(exited))
	test(`stop timeout cannot outlive a ${process} process`, async (t) => {
		const f = specialist(t);
		assert.equal(f.stop().details.status, "stop_requested");
		assert.ok(f.running.stopTimeout);
		f.running.lifecycle = lifecycle();

		t.mock.timers.tick(STOP_WAIT);
		await turn();
		assert.equal(f.running.stopTimeout, undefined);
		assert.equal(f.running.stopState, "requested");
		assert.equal(f.running.stopFailure, undefined);
		assert.equal(f.parent.sentMessages.length, 0);

		f.controls.startPersistentStopTimeout(
			f.running,
			f.parent.api,
			STOP_WAIT,
			f.io,
		);
		assert.equal(f.running.stopTimeout, undefined);
	});

test("healthy busy specialist stays stop_pending without a timer until its task event", (t) => {
	const f = specialist(t);
	f.running.taskId = "initial";

	const pending = f.stop();
	assert.equal(pending.details.status, "stop_pending");
	assert.equal(f.running.stopState, "pending");
	assert.equal(f.running.stopTimeout, undefined);
	t.mock.timers.tick(15_000 * 4);
	assert.equal(f.running.stopState, "pending");
	assert.equal(f.parent.sentMessages.length, 0);

	appendPersistentTaskEvent(f.running.sessionFile, {
		type: "task-done",
		task: "initial",
		generation: "generation",
	});
	f.delivery.drainPersistentTaskEvents(f.running, f.parent.api, f.io);
	assert.equal(f.running.taskId, undefined);
	assert.ok(f.running.stopTimeout, "the settled task starts the exit wait");
	t.mock.timers.tick(STOP_WAIT);
	assert.equal(f.running.stopState, "failed");
});
