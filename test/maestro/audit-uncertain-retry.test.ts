import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import {
	AcquisitionUncertainError,
	isAcquisitionUncertainError,
	type UncertainAcquisition,
} from "../../maestro/core/surface-provider.ts";
import type {
	AgentHandle,
	CompletionEvidence,
	Role,
	RunResult,
	Task,
} from "../../maestro/core/types.ts";
import { createRunSession } from "../../maestro/runtime/run-session.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const role: Role = {
	name: "worker",
	version: "1",
	description: "test",
	systemPrompt: "",
	allowedTools: [],
};
const task: Task = {
	id: "uncertain",
	name: "uncertain",
	role: role.name,
	prompt: "test",
	cwd: "/repo",
	runtime: {
		model: "p/first",
		thinking: "off",
		fallbacks: [{ model: "p/second", thinking: "off" }],
	},
};

class UncertainAdapter extends FakeHarnessAdapter {
	waits: number[] = [];
	kills: number[] = [];
	signal?: AbortSignal;
	terminationConfirmed = false;
	killGate?: Promise<void>;
	evidence?: CompletionEvidence;
	override async awaitCompletion(_handle: AgentHandle, signal: AbortSignal) {
		this.signal = signal;
		this.waits.push(Date.now());
		if (this.evidence) return this.evidence;
		throw new Error("watcher unavailable");
	}
	override async kill(_handle: AgentHandle) {
		this.kills.push(Date.now());
		await this.killGate;
		if (!this.terminationConfirmed) throw new Error("exit unconfirmed");
	}
}

async function fixture({
	launchFailure = true,
	cancel = false,
}: {
	launchFailure?: boolean;
	cancel?: boolean;
} = {}) {
	const adapter = new UncertainAdapter();
	const delivered: RunResult[] = [];
	const session = createRunSession({
		adapter,
		roles: [role],
		cwd: "/repo",
		hooks: {
			onSettled: (result) => {
				delivered.push(result);
			},
		},
	});
	const handle = await session.spawn(task);
	if (launchFailure) handle.launchFailure = "dispatch receipt lost";
	const result = session.supervise(handle, task);
	const cancellation = cancel ? await session.cancel(task.id) : undefined;
	await turn();
	return { adapter, delivered, session, handle, result, cancellation };
}

it("uncertain watcher failures back off to 30s without a retry limit, fallback, or lost owner", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const f = await fixture();
	const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
	const expected = [0];
	for (const delay of delays) {
		t.mock.timers.tick(delay - 1);
		await turn();
		assert.deepEqual(f.adapter.waits, expected, "no early watcher probe");
		assert.deepEqual(f.adapter.kills, expected, "no early kill probe");
		assert.equal(f.session.getHandle(task.id), f.handle);
		assert.deepEqual(f.delivered, []);
		assert.equal(f.adapter.spawned().length, 1);
		t.mock.timers.tick(1);
		await turn();
		expected.push(Date.now());
		assert.deepEqual(f.adapter.waits, expected);
		assert.deepEqual(f.adapter.kills, expected);
	}
	assert.equal(getEventListeners(f.adapter.signal!, "abort").length, 1);
	f.adapter.terminationConfirmed = true;
	t.mock.timers.tick(30000);
	const result = await f.result;
	assert.equal(result.outcome, "failed");
	assert.equal(result.error, "watcher unavailable");
	assert.deepEqual(f.delivered, [result]);
	assert.equal(f.session.getHandle(task.id), undefined);
	assert.equal(f.adapter.spawned().length, 1);
	assert.equal(getEventListeners(f.adapter.signal!, "abort").length, 0);
	t.mock.timers.tick(300000);
	await turn();
	assert.equal(f.adapter.waits.length, expected.length + 1);
	assert.equal(f.delivered.length, 1);
});

for (const action of ["cancel", "suppress"] as const) {
	it(`${action} interrupts the capped retry wait and releases its timer and listener immediately`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const scheduled = t.mock.method(globalThis, "setTimeout");
		const cleared = t.mock.method(globalThis, "clearTimeout");
		const f = await fixture();
		for (const delay of [1000, 2000, 4000, 8000, 16000]) {
			t.mock.timers.tick(delay);
			await turn();
		}
		const pendingTimer = scheduled.mock.calls.at(-1)!.result;
		const probes = f.adapter.waits.length;
		if (action === "cancel") {
			f.adapter.terminationConfirmed = true;
			assert.equal((await f.session.cancel(task.id)).status, "confirmed");
		} else f.session.suppress(task.id);
		await turn();
		assert.ok(
			cleared.mock.calls.some((call) => call.arguments[0] === pendingTimer),
			"pending timer was cleared without advancing time",
		);
		assert.equal(getEventListeners(f.adapter.signal!, "abort").length, 0);
		await f.result;
		assert.equal(f.session.getHandle(task.id), undefined);
		assert.equal(f.delivered.length, action === "cancel" ? 1 : 0);
		if (action === "cancel")
			assert.equal(f.delivered[0].cancellation?.termination, "confirmed");
		t.mock.timers.tick(300000);
		await turn();
		assert.equal(f.adapter.waits.length, probes, "abort starts no new watcher");
		assert.equal(f.adapter.spawned().length, 1);
	});
}

it("unconfirmed cancellation retains the retry wait and owner until a confirmed retry", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const f = await fixture();
	assert.equal((await f.session.cancel(task.id)).status, "unconfirmed");
	assert.equal(f.session.getHandle(task.id), f.handle);
	assert.deepEqual(f.delivered, []);
	assert.equal(getEventListeners(f.adapter.signal!, "abort").length, 1);
	assert.equal(f.adapter.signal!.aborted, false);
	f.adapter.terminationConfirmed = true;
	assert.equal((await f.session.cancel(task.id)).status, "confirmed");
	await f.result;
	assert.equal(getEventListeners(f.adapter.signal!, "abort").length, 0);
	assert.equal(f.delivered.length, 1);
	assert.equal(f.adapter.waits.length, 1);
	assert.equal(f.adapter.spawned().length, 1);
});

for (const launchFailure of [false, true]) {
	it(`unconfirmed cancel rearms failed observation with capped backoff, not more kills (launchFailure=${launchFailure})`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const f = await fixture({ launchFailure, cancel: true });
		assert.equal(f.cancellation?.status, "unconfirmed");
		const joined = f.session.supervise(f.handle, task);
		const caller = new AbortController();
		const abandoned = assert.rejects(
			f.session.supervise(f.handle, task, caller.signal),
			/Aborted while waiting/,
		);
		caller.abort();
		await abandoned;
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		const expected = [0];
		for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
			t.mock.timers.tick(delay - 1);
			await turn();
			assert.deepEqual(f.adapter.waits, expected, "no early watcher probe");
			t.mock.timers.tick(1);
			await turn();
			expected.push(Date.now());
			assert.deepEqual(
				f.adapter.waits,
				expected,
				"same producer rearms observation",
			);
			assert.deepEqual(
				f.adapter.kills,
				[0],
				"watcher failure is not exit evidence",
			);
			assert.equal(f.session.getHandle(task.id), f.handle);
			assert.equal(f.session.getTask(task.id), task);
			assert.deepEqual(f.delivered, []);
			assert.equal(f.adapter.spawned().length, 1);
		}
		assert.ok(f.adapter.signal);
		assert.equal(f.adapter.signal.aborted, false);
		assert.equal(getEventListeners(f.adapter.signal, "abort").length, 1);
		f.adapter.evidence = {
			reason: "error",
			exitCode: 1,
			errorMessage: "late exit",
		};
		f.adapter.terminationConfirmed = true;
		t.mock.timers.tick(30000);
		const result = await f.result;
		assert.equal(await joined, result);
		assert.equal(result.handle, f.handle);
		assert.equal(result.outcome, "killed");
		assert.equal(result.evidence, undefined);
		assert.deepEqual(result.cancellation, {
			requestedAt: f.cancellation?.requestedAt,
			termination: "confirmed",
			confirmedAt: Date.now(),
		});
		assert.deepEqual(f.adapter.kills, [0, Date.now()]);
		assert.deepEqual(f.delivered, [result]);
		assert.equal(f.session.getHandle(task.id), undefined);
		assert.equal(getEventListeners(f.adapter.signal, "abort").length, 0);
		t.mock.timers.tick(300000);
		await turn();
		assert.equal(f.adapter.waits.length, expected.length + 1);
		assert.equal(f.adapter.kills.length, 2);
		assert.equal(f.adapter.spawned().length, 1);
		assert.equal(f.delivered.length, 1);
	});

	it(`resolved evidence makes one producer confirmation attempt then parks for operator retry (launchFailure=${launchFailure})`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const scheduled = t.mock.method(globalThis, "setTimeout");
		const f = await fixture({ launchFailure, cancel: true });
		t.mock.timers.tick(1000);
		await turn();
		assert.deepEqual(f.adapter.waits, [0, 1000]);
		assert.deepEqual(f.adapter.kills, [0]);
		f.adapter.evidence = { reason: "done", exitCode: 0 };
		t.mock.timers.tick(2000);
		await turn();
		assert.deepEqual(f.adapter.waits, [0, 1000, 3000]);
		assert.deepEqual(f.adapter.kills, [0, 3000]);
		assert.ok(f.adapter.signal);
		assert.equal(getEventListeners(f.adapter.signal, "abort").length, 0);
		assert.equal(scheduled.mock.callCount(), 2);
		t.mock.timers.tick(300000);
		await turn();
		assert.deepEqual(
			f.adapter.kills,
			[0, 3000],
			"no timer-driven termination retry",
		);
		assert.equal(scheduled.mock.callCount(), 2);
		assert.equal(f.session.getHandle(task.id), f.handle);
		assert.deepEqual(f.delivered, []);

		let confirm!: () => void;
		f.adapter.killGate = new Promise<void>((resolve) => {
			confirm = resolve;
		});
		f.adapter.terminationConfirmed = true;
		const retry = f.session.cancel(task.id);
		t.mock.timers.tick(10);
		const joined = f.session.cancel(task.id);
		await turn();
		assert.equal(
			f.adapter.kills.length,
			3,
			"explicit retries join the in-flight kill",
		);
		assert.deepEqual(f.delivered, []);
		confirm();
		for (const report of await Promise.all([retry, joined])) {
			assert.equal(report.status, "confirmed");
			assert.equal(report.repeated, true);
			assert.equal(report.requestedAt, f.cancellation?.requestedAt);
		}
		const result = await f.result;
		assert.equal(result.cancellation?.termination, "confirmed");
		assert.equal(result.cancellation.requestedAt, f.cancellation?.requestedAt);
		assert.deepEqual(f.delivered, [result]);
		assert.equal(f.session.getHandle(task.id), undefined);
		assert.equal(f.adapter.spawned().length, 1);
		assert.equal(f.adapter.waits.length, 3);
		assert.equal(f.adapter.kills.length, 3);
	});

	for (const action of ["cancel", "suppress"] as const) {
		it(`${action} promptly clears cancelled observation backoff (launchFailure=${launchFailure})`, async (t) => {
			t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
			const scheduled = t.mock.method(globalThis, "setTimeout");
			const cleared = t.mock.method(globalThis, "clearTimeout");
			const f = await fixture({ launchFailure, cancel: true });
			for (const delay of [1000, 2000, 4000, 8000, 16000]) {
				t.mock.timers.tick(delay);
				await turn();
			}
			assert.equal(scheduled.mock.callCount(), 6);
			assert.deepEqual(f.adapter.kills, [0]);
			const timer = scheduled.mock.calls.at(-1)!.result;
			assert.ok(f.adapter.signal);
			assert.equal(getEventListeners(f.adapter.signal, "abort").length, 1);
			const probes = f.adapter.waits.length;
			if (action === "cancel") {
				f.adapter.terminationConfirmed = true;
				assert.equal((await f.session.cancel(task.id)).status, "confirmed");
			} else f.session.suppress(task.id);
			await turn();
			assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === timer));
			assert.equal(getEventListeners(f.adapter.signal, "abort").length, 0);
			const result = await f.result;
			assert.equal(
				result.cancellation?.termination,
				action === "cancel" ? "confirmed" : "unconfirmed",
			);
			assert.equal(f.session.getHandle(task.id), undefined);
			assert.equal(f.delivered.length, action === "cancel" ? 1 : 0);
			t.mock.timers.tick(300000);
			await turn();
			assert.equal(f.adapter.waits.length, probes);
			assert.equal(f.adapter.kills.length, action === "cancel" ? 2 : 1);
			assert.equal(f.adapter.spawned().length, 1);
		});
	}
}

it("suppression while the termination probe is pending starts no retry timer", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const scheduled = t.mock.method(globalThis, "setTimeout");
	const f = await fixture();
	let rejectKill!: (cause: Error) => void;
	f.adapter.kill = () =>
		new Promise<void>((_resolve, reject) => {
			rejectKill = reject;
		});
	t.mock.timers.tick(1000);
	await turn();
	assert.equal(scheduled.mock.callCount(), 1);
	f.session.suppress(task.id);
	rejectKill(new Error("exit still unknown"));
	await f.result;
	assert.equal(scheduled.mock.callCount(), 1);
	assert.equal(getEventListeners(f.adapter.signal!, "abort").length, 0);
	assert.deepEqual(f.delivered, []);
	assert.equal(f.adapter.spawned().length, 1);
});

it("successful completion evidence ends uncertain retries without another kill or fallback", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const f = await fixture();
	t.mock.timers.tick(1000);
	await turn();
	f.adapter.evidence = {
		reason: "error",
		exitCode: 1,
		errorMessage: "dispatch receipt lost",
	};
	t.mock.timers.tick(2000);
	const result = await f.result;
	assert.equal(result.evidence, f.adapter.evidence);
	assert.equal(f.adapter.kills.length, 2);
	assert.equal(f.adapter.spawned().length, 1);
	assert.deepEqual(f.delivered, [result]);
	assert.equal(getEventListeners(f.adapter.signal!, "abort").length, 0);
});

it("recognizes cross-load structural uncertainty errors without changing Error message or cause", () => {
	const cause = new Error("transport receipt lost");
	const variants: UncertainAcquisition[] = [
		{
			kind: "surface-create",
			placement: "tab",
			workspaceId: "w",
			anchorSurfaceId: "a",
			observedSurfaceId: "p",
		},
		{ kind: "surface-create", placement: "split" },
		{ kind: "command-dispatch", surfaceId: "p" },
		{ kind: "worktree-create", sourceCwd: "/repo", branch: "fix" },
		{
			kind: "worktree-create",
			sourceCwd: "/repo",
			branch: "fix",
			recovered: {
				path: "/checkout",
				branch: "fix",
				workspaceId: "w",
				paneId: "p",
			},
		},
		{
			kind: "worktree-create",
			sourceCwd: "/repo",
			branch: "fix",
			recovered: { path: "/checkout", branch: "fix" },
		},
	];
	for (const uncertainty of variants) {
		const error = new AcquisitionUncertainError(
			"original message",
			uncertainty,
			{ cause },
		);
		assert.equal(isAcquisitionUncertainError(error), true);
		assert.equal(error.message, "original message");
		assert.equal(error.cause, cause);
		const foreign: unknown = runInNewContext(
			`Object.assign(new Error("original message", { cause }), { code: "PIHA_ACQUISITION_UNCERTAIN", uncertainty })`,
			{ cause, uncertainty },
		);
		assert.equal(foreign instanceof AcquisitionUncertainError, false);
		assert.ok(isAcquisitionUncertainError(foreign));
		assert.equal(foreign.message, error.message);
		assert.equal(foreign.cause, cause);
		assert.equal(
			isAcquisitionUncertainError({
				code: error.code,
				name: error.name,
				message: error.message,
				uncertainty,
				cause,
			}),
			true,
		);
	}
});

it("rejects malformed uncertainty variants and optional identity/recovery fields", () => {
	const surface = { kind: "surface-create", placement: "tab" };
	const worktree = {
		kind: "worktree-create",
		sourceCwd: "/repo",
		branch: "fix",
	};
	const recovered = { path: "/checkout", branch: "fix" };
	const malformed: unknown[] = [
		null,
		[],
		{},
		{ kind: "other" },
		{ ...surface, placement: "grouped" },
		...["workspaceId", "anchorSurfaceId", "observedSurfaceId"].map((key) => ({
			...surface,
			[key]: 1,
		})),
		{ kind: "command-dispatch", surfaceId: 1 },
		{ ...worktree, sourceCwd: null },
		{ ...worktree, branch: [] },
		...[
			null,
			[],
			{},
			{ path: "/checkout" },
			{ branch: "fix" },
			{ ...recovered, path: 1 },
			{ ...recovered, branch: false },
			{ ...recovered, workspaceId: 1 },
			{ ...recovered, paneId: {} },
		].map((value) => ({ ...worktree, recovered: value })),
	];
	for (const uncertainty of malformed) {
		const error = Object.assign(new Error("uncertain"), {
			code: "PIHA_ACQUISITION_UNCERTAIN",
			uncertainty,
		});
		assert.equal(
			isAcquisitionUncertainError(error),
			false,
			JSON.stringify(uncertainty),
		);
	}
	for (const error of [
		null,
		undefined,
		1,
		"error",
		{},
		{
			code: "PIHA_ACQUISITION_UNCERTAIN",
			message: "uncertain",
			uncertainty: surface,
			name: 1,
		},
		Object.assign(new Error("uncertain"), {
			code: "OTHER",
			uncertainty: surface,
		}),
		...[
			{ message: 1 },
			{ message: Object("boxed") },
			{ stack: [] },
			{ toString: 1 },
		].map((fields) =>
			Object.assign(
				new Error("uncertain"),
				{
					code: "PIHA_ACQUISITION_UNCERTAIN",
					uncertainty: surface,
				},
				fields,
			),
		),
	]) {
		assert.equal(isAcquisitionUncertainError(error), false);
	}
});
