import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
	createLifecycle,
	markCompletionDetected,
	markCompleted,
	markFailed,
} from "../../maestro/core/lifecycle.ts";
import type { Task } from "../../maestro/core/types.ts";
import type {
	PiCompletedMetadata,
	PiLedgerEntry,
	PiRunRecord,
	PiSettlementIO,
} from "../../maestro/runtime/index.ts";
import { createDelivery } from "../../pi-extension/subagents/delivery.ts";
import { createPersistentControls } from "../../pi-extension/subagents/persistent.ts";
import {
	bindLiveApi,
	releaseHeldDeliveries,
	type RunningSubagent,
	type SubagentRuntime,
} from "../../pi-extension/subagents/state.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

const STOP_WAIT = 10;
const NOTICE_RETRY = 1_000;

function specialist(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const running: PiRunRecord & RunningSubagent = {
		id: "specialist",
		name: "specialist",
		task: "work",
		surface: "pane",
		startTime: 0,
		sessionFile: "/memory/specialist.jsonl",
		launchScriptFile: "unused",
		activityFile: "unused",
		interactive: false,
		runtimePlan: undefined,
		lifecycle: createLifecycle(0),
		persistent: true,
		logicalId: "specialist",
		generationId: "generation",
		policyHash: "a".repeat(64),
		tasksCompleted: 0,
	};
	const runtime: SubagentRuntime = {
		runningSubagents: new Map([[running.id, running]]),
	};
	const ledger: PiLedgerEntry[] = [];
	const stopRequests: string[] = [];
	const io: PiSettlementIO = {
		readEvents: () => [],
		inspectWorktree: async () => undefined,
		readLedger: () => [...ledger],
		readTaskSummary: () => assert.fail("no task result expected"),
		rejectBusy: () => assert.fail("no task rejection expected"),
		dispatch: () => assert.fail("no task dispatch expected"),
		acknowledge: () => assert.fail("no task acknowledgement expected"),
		requestStop(record) {
			stopRequests.push(record.id);
			record.inboxSequence = (record.inboxSequence ?? 0) + 1;
		},
		recordStopped(record) {
			ledger.push({
				task: "stop",
				outcome: "stopped",
				generation: record.generationId!,
				logicalId: record.logicalId!,
				policyHash: record.policyHash!,
				at: new Date(0).toISOString(),
			});
		},
	};
	const parent = createMockExtensionApi();
	bindLiveApi(runtime, parent.api);
	const makeControls = () =>
		createPersistentControls({
			runtime,
			persistentConfig: { maxAgents: 1 },
			resolveInterruptTarget: () => ({ running }),
		});
	const controls = makeControls();
	const delivery = createDelivery({
		runtime,
		updateWidget() {},
		startPersistentStopTimeout: controls.startPersistentStopTimeout,
	});
	const task: Task = {
		id: running.id,
		name: running.name,
		prompt: running.task,
		role: "",
		cwd: "/memory",
	};
	// The runtime invokes this settlement hook only after verified process exit.
	const completion: PiCompletedMetadata = {
		name: running.name,
		task: running.task,
		summary: "",
		summarySource: "host",
		sessionFile: running.sessionFile,
		exitCode: 0,
		elapsed: STOP_WAIT,
		run: {
			handle: {
				id: running.id,
				name: running.name,
				role: "",
				harness: "pi",
				cwd: task.cwd,
				startedAt: 0,
				sessionId: "generation",
			},
			outcome: "completed",
			exitCode: 0,
			durationMs: STOP_WAIT,
		},
	};
	t.after(() => {
		if (running.stopTimeout) clearTimeout(running.stopTimeout);
		runtime.liveApi = undefined;
		runtime.reloadGap = false;
		releaseHeldDeliveries(runtime, undefined);
	});
	return {
		running,
		runtime,
		parent,
		ledger,
		io,
		stopRequests,
		stop(stopTimeoutMs = STOP_WAIT) {
			// Recreate the per-load controller: invalidation must survive reload.
			const result = makeControls().handleSubagentStop(
				{ id: running.id },
				runtime.liveApi ?? parent.api,
				stopTimeoutMs,
				io,
			);
			assert.equal(result.details.status, "stop_requested");
		},
		complete: () => delivery.deliverPiCompletion(running, completion, task, io),
	};
}

const flushEvidence = () =>
	new Promise<void>((resolve) => setImmediate(resolve));

async function holdTimeout(
	t: TestContext,
	f: ReturnType<typeof specialist>,
	cause: "reload" | "send failure",
) {
	f.stop();
	const send = f.parent.api.sendMessage;
	if (cause === "reload") {
		f.runtime.liveApi = undefined;
		f.runtime.reloadGap = true;
		f.parent.invalidate();
	} else {
		f.parent.api.sendMessage = () => {
			throw new Error("parent send unavailable");
		};
	}
	t.mock.timers.tick(STOP_WAIT);
	await flushEvidence();
	assert.equal(f.running.stopState, "failed");
	assert.equal(f.parent.sentMessages.length, 0);
	assert.equal(f.runtime.heldDeliveries?.length, 1);
	return async () => {
		if (cause === "reload") {
			const replacement = createMockExtensionApi();
			bindLiveApi(f.runtime, replacement.api);
			await flushEvidence();
			return replacement;
		}
		f.parent.api.sendMessage = send;
		t.mock.timers.tick(NOTICE_RETRY);
		await flushEvidence();
		return f.parent;
	};
}

for (const cause of ["reload", "send failure"] as const) {
	test(`${cause}: retry invalidates the previous held stop-timeout notice`, async (t) => {
		const f = specialist(t);
		const release = await holdTimeout(t, f, cause);
		// Keep the new attempt live while the old notice gets its retry turn.
		f.stop(NOTICE_RETRY * 3);
		assert.equal(f.stopRequests.length, 2);
		const live = await release();
		assert.equal(live.sentMessages.length, 0, "old failure is superseded");
		assert.equal(f.runtime.heldDeliveries?.length ?? 0, 0);
	});

	test(`${cause}: two timeouts leave only the newest failure eligible`, async (t) => {
		const f = specialist(t);
		const release = await holdTimeout(t, f, cause);
		f.stop();
		t.mock.timers.tick(STOP_WAIT);
		await flushEvidence();
		assert.equal(f.running.stopState, "failed");
		assert.equal(f.stopRequests.length, 2);
		const live = await release();
		t.mock.timers.tick(NOTICE_RETRY);
		await flushEvidence();
		assert.equal(live.sentMessages.length, 1, "only the latest attempt failed");
		assert.equal(live.sentMessages[0].message.details.status, "failed");
		assert.match(
			live.sentMessages[0].message.content,
			/exit was not confirmed/,
		);
		assert.equal(f.runtime.heldDeliveries?.length ?? 0, 0);
	});

	test(`${cause}: verified exit suppresses an older held timeout notice`, async (t) => {
		const f = specialist(t);
		const release = await holdTimeout(t, f, cause);
		// In the send-failure case restore sends without flushing the retry queue.
		const live = createMockExtensionApi();
		if (cause === "send failure") f.runtime.liveApi = live.api;
		const settled = f.complete();
		const recipient = cause === "reload" ? await release() : live;
		await settled;
		t.mock.timers.tick(NOTICE_RETRY * 2);
		await flushEvidence();
		assert.equal(f.runtime.runningSubagents.has(f.running.id), false);
		assert.deepEqual(
			recipient.sentMessages.map(({ message }) => message.details.status),
			["stopped"],
			"verified exit must replace, not follow, an unconfirmed-exit notice",
		);
		assert.deepEqual(
			f.ledger.map((row) => row.outcome),
			["stopped"],
		);
		assert.equal(f.runtime.heldDeliveries?.length ?? 0, 0);
	});

	test(`${cause}: confirmed stop on retry suppresses the previous attempt's notice`, async (t) => {
		const f = specialist(t);
		const release = await holdTimeout(t, f, cause);
		f.stop();
		const live = createMockExtensionApi();
		if (cause === "send failure") f.runtime.liveApi = live.api;
		const settled = f.complete();
		const recipient = cause === "reload" ? await release() : live;
		await settled;
		t.mock.timers.tick(NOTICE_RETRY * 2);
		await flushEvidence();
		assert.deepEqual(
			recipient.sentMessages.map(({ message }) => message.details.status),
			["stopped"],
		);
		assert.deepEqual(
			f.ledger.map((row) => row.outcome),
			["stopped"],
		);
		assert.equal(f.runtime.heldDeliveries?.length ?? 0, 0);
	});

	test(`${cause}: quitting suppresses held notices and their retry timers`, async (t) => {
		const f = specialist(t);
		await holdTimeout(t, f, cause);
		f.runtime.liveApi = undefined;
		f.runtime.reloadGap = false;
		releaseHeldDeliveries(f.runtime, undefined);
		const replacement = createMockExtensionApi();
		bindLiveApi(f.runtime, replacement.api);
		t.mock.timers.tick(NOTICE_RETRY * 2);
		await flushEvidence();
		assert.equal(replacement.sentMessages.length, 0);
		assert.equal(f.runtime.heldDeliveries?.length ?? 0, 0);
	});
}

test("late verified exit after a delivered timeout sends one stopped update and ledger row", async (t) => {
	const f = specialist(t);
	f.stop();
	t.mock.timers.tick(STOP_WAIT);
	await flushEvidence();
	assert.equal(f.running.stopState, "failed");
	assert.equal(f.parent.sentMessages[0].message.details.status, "failed");
	await f.complete();
	await f.complete();
	t.mock.timers.tick(NOTICE_RETRY * 2);
	assert.equal(f.runtime.runningSubagents.has(f.running.id), false);
	assert.deepEqual(
		f.parent.sentMessages.map(({ message }) => message.details.status),
		["failed", "stopped"],
	);
	assert.deepEqual(f.ledger, [
		{
			task: "stop",
			outcome: "stopped",
			generation: f.running.generationId,
			logicalId: f.running.logicalId,
			policyHash: f.running.policyHash,
			at: new Date(0).toISOString(),
		},
	]);
});

for (const cause of ["reload", "send failure"] as const) {
	test(`${cause}: failed publication invalidates the held notice before inbox sequence changes`, async (t) => {
		const f = specialist(t);
		const release = await holdTimeout(t, f, cause);
		const sequence = f.running.inboxSequence;
		f.io.requestStop = () => {
			throw new Error("publication failed");
		};
		assert.throws(() => f.stop(), /publication failed/);
		assert.throws(() => f.stop(), /publication failed/);
		assert.equal(f.running.inboxSequence, sequence);
		assert.equal(f.runtime.heldDeliveries?.length ?? 0, 0);
		const live = await release();
		assert.equal(live.sentMessages.length, 0);
		await f.complete();
		await f.complete();
		assert.deepEqual(
			live.sentMessages.map(({ message }) => message.details.status),
			["stopped"],
		);
		assert.deepEqual(
			f.ledger.map((row) => row.outcome),
			["stopped"],
		);
	});
}

for (const change of [
	"exit",
	"retry",
	"quit",
	"reload",
	"second timeout",
] as const) {
	test(`delayed notice evidence: ${change} supersedes or rebinds the notice`, async (t) => {
		const f = specialist(t);
		const finishes: Array<() => void> = [];
		f.io.inspectWorktree = () =>
			new Promise((resolve) => {
				finishes.push(() => resolve(undefined));
			});
		// Stop identity must not depend on a successful inbox publication's counter.
		f.io.requestStop = () => {};
		f.stop();
		t.mock.timers.tick(STOP_WAIT);
		assert.equal(finishes.length, 1);
		const firstFailure = f.running.stopFailure;
		const replacement = createMockExtensionApi();
		f.runtime.liveApi = undefined;
		f.runtime.reloadGap = true;
		f.parent.invalidate();
		let settled;
		if (change === "exit") settled = f.complete();
		else if (change === "retry" || change === "second timeout") {
			f.stop(NOTICE_RETRY * 3);
			if (change === "second timeout") {
				t.mock.timers.tick(NOTICE_RETRY * 3);
				assert.equal(f.running.stopFailure, firstFailure);
				assert.equal(f.running.inboxSequence, undefined);
			}
		} else if (change === "quit") {
			f.runtime.reloadGap = false;
			releaseHeldDeliveries(f.runtime, undefined);
		}
		// Rebinding before old evidence resolves must not revive a quit notice.
		bindLiveApi(f.runtime, replacement.api);
		finishes[0]();
		await flushEvidence();
		if (change === "second timeout") {
			assert.equal(replacement.sentMessages.length, 0);
			assert.equal(finishes.length, 2);
			finishes[1]();
			await flushEvidence();
		}
		await settled;
		t.mock.timers.tick(NOTICE_RETRY);
		await flushEvidence();
		assert.equal(f.parent.sentMessages.length, 0);
		assert.deepEqual(
			replacement.sentMessages.map(({ message }) => message.details.status),
			change === "exit"
				? ["stopped"]
				: change === "reload" || change === "second timeout"
					? ["failed"]
					: [],
		);
		assert.deepEqual(
			f.ledger.map((row) => row.outcome),
			change === "exit" ? ["stopped"] : [],
		);
		assert.equal(f.runtime.heldDeliveries?.length ?? 0, 0);
	});
}

for (const phase of ["finalizing", "completed", "failed"] as const) {
	test(`delayed notice evidence: known ${phase} process suppresses failure before delivery`, async (t) => {
		const f = specialist(t);
		let finish!: () => void;
		f.io.inspectWorktree = () =>
			new Promise((resolve) => {
				finish = () => resolve(undefined);
			});
		f.stop();
		t.mock.timers.tick(STOP_WAIT);
		f.running.lifecycle = markCompletionDetected(
			f.running.lifecycle,
			{ reason: "done", exitCode: 0 },
			STOP_WAIT,
		);
		if (phase === "completed")
			f.running.lifecycle = markCompleted(f.running.lifecycle, STOP_WAIT);
		if (phase === "failed")
			f.running.lifecycle = markFailed(
				f.running.lifecycle,
				"exit",
				STOP_WAIT,
				1,
			);
		finish();
		await flushEvidence();
		assert.equal(f.parent.sentMessages.length, 0);
		assert.equal(f.runtime.heldDeliveries?.length ?? 0, 0);
		assert.equal(f.running.lifecycle.delivery, "pending");
		await f.complete();
		assert.deepEqual(
			f.parent.sentMessages.map(({ message }) => message.details.status),
			["stopped"],
		);
		assert.deepEqual(
			f.ledger.map((row) => row.outcome),
			["stopped"],
		);
	});
}
