import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import type { SpawnOptions } from "../../maestro/core/harness-adapter.ts";
import type {
	AgentHandle,
	Role,
	RunResult,
	Task,
} from "../../maestro/core/types.ts";
import {
	createRunSession,
	type OwnedRunAttempt,
	type PreparedRun,
	type RunSession,
} from "../../maestro/runtime/index.ts";

const role: Role = {
	name: "worker",
	version: "1",
	description: "writer",
	systemPrompt: "role prompt",
	allowedTools: ["read"],
};
const candidates = [
	{ model: "provider/first", thinking: "low" as const },
	{ model: "provider/second", thinking: "high" as const },
	{ model: "provider/third", thinking: "off" as const },
];
function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "logical",
		name: "writer",
		prompt: "do the work",
		role: "worker",
		cwd: "/source",
		runtime: { ...candidates[0], fallbacks: candidates.slice(1) },
		...overrides,
	};
}
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The fake's kill settles error evidence, exactly like a closed Herdr pane that
 * the watcher reports as "pane disappeared": the incident's fallback trigger.
 */
class Adapter extends FakeHarnessAdapter {
	launches: SpawnOptions[] = [];
	kills: string[] = [];
	/** Order of observable effects, for intent-before-kill assertions. */
	events: string[] = [];
	killGate?: Promise<void>;
	killError?: () => Error | undefined;
	override async spawn(options: SpawnOptions) {
		this.launches.push(options);
		return super.spawn(options);
	}
	override async kill(handle: AgentHandle) {
		this.kills.push(handle.id);
		this.events.push(`kill:${handle.id}`);
		await this.killGate;
		const error = this.killError?.();
		if (error) throw error;
		await super.kill(handle);
	}
}
function fixture(options: { finalize?: OwnedRunAttempt["finalize"] } = {}) {
	const adapter = new Adapter();
	const delivered: RunResult[] = [];
	/** What each attempt's owner finalized (Pi persists manifests from it). */
	const finalized: RunResult[] = [];
	const closes: string[] = [];
	const hooks: string[] = [];
	const finalize: OwnedRunAttempt["finalize"] = async (result, t, control) => {
		finalized.push(result);
		return options.finalize ? options.finalize(result, t, control) : result;
	};
	const prepared = (extra: Partial<PreparedRun> = {}): PreparedRun => ({
		role,
		persistent: false,
		candidates,
		spawnAttempt: async (spawn) => {
			const handle = await adapter.spawn(spawn);
			return {
				handle,
				adapter,
				finalize,
				closeTemporarySurface: async () => {
					closes.push(handle.id);
				},
			};
		},
		...extra,
	});
	const session = createRunSession({
		adapter,
		roles: [role],
		cwd: "/parent",
		hooks: {
			onSpawned: (handle) => {
				hooks.push(`spawned:${handle.id}`);
			},
			onSettled: (result) => {
				delivered.push(result);
			},
		},
	});
	return {
		adapter,
		session,
		delivered,
		finalized,
		finalize,
		closes,
		hooks,
		prepared,
	};
}
async function running(f: ReturnType<typeof fixture>, t = task()) {
	const handle = await f.session.spawn(t, f.prepared());
	const result = f.session.supervise(handle, t);
	return { t, handle, result };
}
function models(adapter: Adapter) {
	return adapter.launches.map((launch) => launch.runtime?.model);
}
function assertCancelled(result: RunResult, handle: AgentHandle) {
	assert.equal(result.outcome, "killed");
	assert.equal(result.handle, handle);
	assert.equal(result.cancellation?.termination, "confirmed");
	const { requestedAt, confirmedAt } = result.cancellation!;
	assert.ok(Number.isFinite(requestedAt));
	assert.ok(confirmedAt! >= requestedAt, "confirmed after the recorded intent");
	assert.equal(
		result.evidence,
		undefined,
		"cancel never reports natural evidence",
	);
}

describe("RunSession operator cancel", { timeout: 5000 }, () => {
	it("negative control: a raw kill's error evidence starts the next model", async () => {
		const f = fixture();
		const { t, handle, result } = await running(f);
		await f.session.kill(t.id);
		await turn();
		assert.deepEqual(models(f.adapter), ["provider/first", "provider/second"]);
		f.adapter.complete(f.adapter.spawned()[1]!.id, {
			reason: "done",
			exitCode: 0,
		});
		assert.notEqual((await result).handle, handle);
	});

	it("records intent before the kill, so kill error evidence never falls back, and delivers once", async () => {
		const f = fixture();
		const { t, handle, result } = await running(f);
		const report = await f.session.cancel(t.id);
		assert.equal(report.status, "confirmed");
		assert.equal(report.repeated, undefined);
		const settled = await result;
		assertCancelled(settled, handle);
		// The attempt's owner finalizes the cancel, never the kill's error evidence.
		assert.deepEqual(f.finalized, [settled]);
		assert.deepEqual(models(f.adapter), ["provider/first"]);
		assert.deepEqual(f.adapter.kills, [handle.id]);
		assert.deepEqual(f.delivered, [settled]);
		assert.deepEqual(f.closes, [handle.id]);
		assert.equal(f.session.getHandle(t.id), undefined);
		// Late callbacks and repeated cancels after retirement change nothing.
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.deepEqual(await f.session.cancel(t.id), {
			status: "already-terminal",
		});
		await turn();
		assert.equal(f.delivered.length, 1);
		assert.deepEqual(f.adapter.kills, [handle.id]);
	});

	it("cancels before supervision; the later producer delivers the one cancelled result", async () => {
		const f = fixture();
		const t = task();
		const handle = await f.session.spawn(t, f.prepared());
		assert.equal((await f.session.cancel(t.id)).status, "confirmed");
		assertCancelled(await f.session.supervise(handle, t), handle);
		assert.equal(f.delivered.length, 1);
		assert.deepEqual(models(f.adapter), ["provider/first"]);
	});

	it("double cancel joins the one in-flight kill; both report confirmation", async () => {
		const f = fixture();
		const gate = deferred();
		f.adapter.killGate = gate.promise;
		const { t, handle, result } = await running(f);
		const first = f.session.cancel(t.id);
		const second = f.session.cancel(t.id);
		await turn();
		assert.deepEqual(f.adapter.kills, [handle.id]);
		gate.resolve();
		assert.equal((await first).status, "confirmed");
		const repeated = await second;
		assert.equal(repeated.status, "confirmed");
		assert.equal(repeated.repeated, true);
		assertCancelled(await result, handle);
		assert.deepEqual(f.adapter.kills, [handle.id]);
		assert.equal(f.delivered.length, 1);
	});

	it("an unconfirmed kill retains live supervised ownership; a retry confirms and delivers once", async () => {
		const f = fixture();
		f.adapter.killError = () =>
			new Error("pane absence unconfirmed after 5000ms");
		const { t, handle, result } = await running(f);
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		const report = await f.session.cancel(t.id);
		assert.deepEqual(report, {
			status: "unconfirmed",
			requestedAt: report.requestedAt,
			error: "pane absence unconfirmed after 5000ms",
		});
		await turn();
		assert.equal(settled, false, "unconfirmed termination must not settle");
		assert.equal(f.session.getHandle(t.id), handle, "ownership is retained");
		assert.deepEqual(f.closes, [], "no surface is released while unconfirmed");
		assert.equal(f.delivered.length, 0);
		assert.deepEqual(models(f.adapter), ["provider/first"]);
		f.adapter.killError = undefined;
		const retry = await f.session.cancel(t.id);
		assert.equal(retry.status, "confirmed");
		assert.equal(retry.repeated, true);
		assert.equal(retry.requestedAt, report.requestedAt, "first intent is kept");
		assertCancelled(await result, handle);
		assert.deepEqual(f.adapter.kills, [handle.id, handle.id]);
		assert.equal(f.delivered.length, 1);
		assert.deepEqual(models(f.adapter), ["provider/first"]);
	});

	it("natural exit evidence after an unconfirmed kill makes one producer retry, never a fallback", async () => {
		const f = fixture();
		let failures = 1;
		f.adapter.killError = () =>
			failures-- > 0 ? new Error("close failed") : undefined;
		const { t, handle, result } = await running(f);
		assert.equal((await f.session.cancel(t.id)).status, "unconfirmed");
		f.adapter.fail(
			handle.id,
			"Subagent pane disappeared before completion evidence was recorded.",
		);
		assertCancelled(await result, handle);
		assert.deepEqual(f.adapter.kills, [handle.id, handle.id]);
		assert.deepEqual(models(f.adapter), ["provider/first"]);
		assert.equal(f.delivered.length, 1);
	});

	it("shutdown suppression wakes a parked unconfirmed producer without delivery", async () => {
		const f = fixture();
		f.adapter.killError = () => new Error("still present");
		const { t, handle, result } = await running(f);
		assert.equal((await f.session.cancel(t.id)).status, "unconfirmed");
		f.adapter.fail(handle.id, "pane disappeared");
		await turn();
		await turn();
		assert.deepEqual(f.adapter.kills, [handle.id, handle.id]);
		f.session.suppress(t.id);
		const settled = await result;
		assert.equal(settled.outcome, "killed");
		assert.equal(settled.cancellation?.termination, "unconfirmed");
		assert.equal(settled.cancellation?.error, "still present");
		assert.equal(f.delivered.length, 0);
		assert.deepEqual(models(f.adapter), ["provider/first"]);
	});

	it("cancel during a fallback acquisition terminates the transferred owner and starts no further candidate", async () => {
		const f = fixture();
		const acquired = deferred<OwnedRunAttempt>();
		const started = deferred();
		let attempts = 0;
		const prepared = f.prepared();
		const base = prepared.spawnAttempt;
		prepared.spawnAttempt = async (spawn, index, cancelled) => {
			attempts++;
			if (index === 0) return base(spawn, index, cancelled);
			started.resolve();
			return acquired.promise;
		};
		const t = task();
		const first = await f.session.spawn(t, prepared);
		const result = f.session.supervise(first, t);
		f.adapter.fail(first.id, "provider refused");
		await started.promise;
		const report = await f.session.cancel(t.id);
		assert.equal(report.status, "requested");
		assert.deepEqual(f.adapter.kills, [], "nothing is killed until transfer");
		const second = await f.adapter.spawn({
			name: "second",
			task: "work",
			role,
			cwd: "/source",
			sessionId: "second",
		});
		acquired.resolve({
			handle: second,
			adapter: f.adapter,
			finalize: f.finalize,
			closeTemporarySurface: async () => {
				f.closes.push(second.id);
			},
		});
		const settled = await result;
		assertCancelled(settled, second);
		assert.deepEqual(
			f.finalized.map((r) => r.outcome),
			["failed", "killed"],
			"the transferred owner finalizes the cancel",
		);
		assert.equal(attempts, 2, "the third candidate is never attempted");
		assert.deepEqual(f.adapter.kills, [second.id]);
		assert.deepEqual(f.closes.sort(), [first.id, second.id].sort());
		assert.equal(f.delivered.length, 1);
		assert.equal(f.session.getHandle(t.id), undefined);
	});

	it("cancel during a fallback acquisition that fails terminates the settled previous owner", async () => {
		const f = fixture();
		const refused = deferred<OwnedRunAttempt>();
		const started = deferred();
		const prepared = f.prepared();
		const base = prepared.spawnAttempt;
		let attempts = 0;
		prepared.spawnAttempt = async (spawn, index, cancelled) => {
			attempts++;
			if (index === 0) return base(spawn, index, cancelled);
			started.resolve();
			return refused.promise;
		};
		const t = task();
		const first = await f.session.spawn(t, prepared);
		const result = f.session.supervise(first, t);
		f.adapter.fail(first.id, "provider refused");
		await started.promise;
		assert.equal((await f.session.cancel(t.id)).status, "requested");
		refused.reject(new Error("launch failed"));
		assertCancelled(await result, first);
		assert.equal(attempts, 2);
		assert.deepEqual(f.adapter.kills, [first.id]);
		assert.equal(f.delivered.length, 1);
	});

	it("after every fallback launch fails, a cancel during delivery is already-terminal", async () => {
		const adapter = new Adapter();
		const delivering = deferred();
		const release = deferred();
		const delivered: RunResult[] = [];
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			hooks: {
				onSettled: async (result) => {
					delivered.push(result);
					delivering.resolve();
					await release.promise;
				},
			},
		});
		let attempts = 0;
		const t = task();
		const handle = await session.spawn(t, {
			role,
			persistent: false,
			candidates,
			spawnAttempt: async (spawn, index) => {
				attempts++;
				if (index > 0) throw new Error(`launch ${index} failed`);
				return { handle: await adapter.spawn(spawn), adapter };
			},
		});
		const result = session.supervise(handle, t);
		adapter.fail(handle.id, "provider refused");
		await delivering.promise;
		assert.equal(attempts, 3, "every fallback was attempted");
		// The natural failure is being delivered: a cancel cannot add an outcome.
		assert.deepEqual(await session.cancel(t.id), {
			status: "already-terminal",
		});
		release.resolve();
		const settled = await result;
		assert.equal(settled.outcome, "failed");
		assert.equal(settled.cancellation, undefined);
		assert.match(settled.error!, /Fallback launch failures: .*launch 2 failed/);
		assert.deepEqual(adapter.kills, []);
		assert.deepEqual(delivered, [settled]);
	});

	it("projects cancel state onto a transferred owner and its automatic kill outcome", async () => {
		const states: string[] = [];
		const adapter = new Adapter();
		const delivered: RunResult[] = [];
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			hooks: {
				onCancelState: (handle, _task, state) => {
					states.push(`${handle.id}:${state}`);
				},
				onSettled: (result) => void delivered.push(result),
			},
		});
		const acquired = deferred<OwnedRunAttempt>();
		const started = deferred();
		const t = task();
		const first = await session.spawn(t, {
			role,
			persistent: false,
			candidates,
			spawnAttempt: async (spawn, index) => {
				if (index === 0) return { handle: await adapter.spawn(spawn), adapter };
				started.resolve();
				return acquired.promise;
			},
		});
		const result = session.supervise(first, t);
		adapter.fail(first.id, "provider refused");
		await started.promise;
		assert.equal((await session.cancel(t.id)).status, "requested");
		assert.deepEqual(states, [`${first.id}:requested`]);
		const second = await adapter.spawn({
			name: "second",
			task: "work",
			role,
			cwd: "/source",
			sessionId: "second",
		});
		adapter.killError = () => new Error("pane still present");
		acquired.resolve({ handle: second, adapter });
		while (adapter.kills.length === 0) await turn();
		await turn();
		// The kernel's own kill of the transferred owner failed: the new owner,
		// not the one captured by the cancel call, shows it, and nothing settles.
		assert.deepEqual(states, [
			`${first.id}:requested`,
			`${second.id}:requested`,
			`${second.id}:unconfirmed`,
		]);
		assert.equal(session.getHandle(t.id), second);
		assert.equal(delivered.length, 0);
		adapter.killError = undefined;
		const retry = await session.cancel(t.id);
		assert.equal(retry.status, "confirmed");
		assert.deepEqual(states.slice(3), [
			`${second.id}:requested`,
			`${second.id}:confirmed`,
		]);
		assertCancelled(await result, second);
		assert.equal(delivered.length, 1);
	});

	it("a cancel taken too late projects no cancel state", async () => {
		const states: string[] = [];
		const adapter = new Adapter();
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			hooks: {
				onCancelState: (handle, _task, state) =>
					void states.push(`${handle.id}:${state}`),
			},
		});
		const t = task({ runtime: candidates[0] });
		const handle = await session.spawn(t, {
			role,
			persistent: false,
			candidates: [candidates[0]],
			spawnAttempt: async (spawn) => ({
				handle: await adapter.spawn(spawn),
				adapter,
			}),
		});
		const result = session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await result;
		assert.deepEqual(await session.cancel(t.id), {
			status: "already-terminal",
		});
		assert.deepEqual(states, []);
	});

	it("cancel during the initial acquisition terminates the acquired owner without a leak", async () => {
		const f = fixture();
		const acquired = deferred<OwnedRunAttempt>();
		const started = deferred();
		const t = task();
		const spawning = f.session.spawn(
			t,
			f.prepared({
				spawnAttempt: () => {
					started.resolve();
					return acquired.promise;
				},
			}),
		);
		await started.promise;
		assert.equal((await f.session.cancel(t.id)).status, "requested");
		const handle = await f.adapter.spawn({
			name: "initial",
			task: "work",
			role,
			cwd: "/source",
			sessionId: "initial",
		});
		acquired.resolve({ handle, adapter: f.adapter });
		assert.equal(await spawning, handle);
		await turn();
		assert.deepEqual(f.adapter.kills, [handle.id], "killed once transferred");
		assertCancelled(await f.session.supervise(handle, t), handle);
		assert.equal(f.delivered.length, 1);
	});

	it("cancel before any acquisition rejects the launch and acquires nothing", async () => {
		const adapter = new Adapter();
		const gate = deferred<PreparedRun>();
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			operations: { prepare: () => gate.promise },
		});
		const t = task();
		const spawning = session.spawn(t);
		assert.equal((await session.cancel(t.id)).status, "requested");
		gate.resolve({
			role,
			persistent: false,
			candidates,
			spawnAttempt: async (spawn) => ({
				handle: await adapter.spawn(spawn),
				adapter,
			}),
		});
		await assert.rejects(spawning, /cancelled before launch/);
		assert.equal(adapter.launches.length, 0);
		assert.equal(session.getTask(t.id), undefined);
	});

	it("a natural terminal result taken before the cancel stays authoritative", async () => {
		const finalizing = deferred();
		const release = deferred();
		const f = fixture({
			finalize: async (result) => {
				finalizing.resolve();
				await release.promise;
				return result;
			},
		});
		const { t, handle, result } = await running(f);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await finalizing.promise;
		assert.deepEqual(await f.session.cancel(t.id), {
			status: "already-terminal",
		});
		release.resolve();
		const settled = await result;
		assert.equal(settled.outcome, "completed");
		assert.equal(settled.cancellation, undefined);
		assert.deepEqual(f.adapter.kills, []);
		assert.equal(f.delivered.length, 1);
	});

	it("cancel while finalizing a retryable error prevents its fallback and delivers the cancel", async () => {
		const finalizing = deferred();
		const release = deferred();
		const f = fixture({
			finalize: async (result) => {
				finalizing.resolve();
				await release.promise;
				return result;
			},
		});
		const { t, handle, result } = await running(f);
		f.adapter.fail(handle.id, "provider refused");
		await finalizing.promise;
		const report = f.session.cancel(t.id);
		release.resolve();
		assert.equal((await report).status, "confirmed");
		const settled = await result;
		assertCancelled(settled, handle);
		assert.deepEqual(models(f.adapter), ["provider/first"]);
		assert.deepEqual(f.delivered, [settled]);
		assert.equal(f.finalized.length, 1, "each attempt is finalized once");
		assert.equal(f.finalized[0]!.outcome, "failed");
	});

	it("cancels an interrupted run", async () => {
		const f = fixture();
		const { t, handle, result } = await running(f);
		await f.session.interrupt(t.id);
		assert.equal((await f.session.cancel(t.id)).status, "confirmed");
		assertCancelled(await result, handle);
		assert.equal(f.delivered.length, 1);
	});

	it("rejects persistent runs before any kill and unknown IDs", async () => {
		const f = fixture();
		const t = task({ behavior: { persistent: true } });
		const handle = await f.session.spawn(t, f.prepared({ persistent: true }));
		await assert.rejects(
			f.session.cancel(t.id),
			/persistent; use its graceful stop/,
		);
		assert.deepEqual(f.adapter.kills, []);
		assert.equal(f.session.getHandle(t.id), handle);
		await assert.rejects(f.session.cancel("missing"), /was not found/);
		f.session.suppress(t.id);
	});

	it("worktree runs are never released by the kernel after cancel", async () => {
		const f = fixture();
		const t = task({
			runtime: candidates[0],
			worktree: { branch: "cancel-retained" },
		});
		const handle = await f.session.spawn(
			t,
			f.prepared({ candidates: [candidates[0]] }),
		);
		const result = f.session.supervise(handle, t);
		assert.equal((await f.session.cancel(t.id)).status, "confirmed");
		assertCancelled(await result, handle);
		assert.deepEqual(f.closes, []);
	});

	it("cancel during resume acquisition terminates the resumed owner", async () => {
		const adapter = new Adapter();
		const gate = deferred();
		const delivered: RunResult[] = [];
		let session!: RunSession;
		session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			hooks: { onSettled: (result) => void delivered.push(result) },
			operations: {
				prepare: async () => {
					throw new Error("unused");
				},
				async resume(options) {
					await gate.promise;
					return { handle: await adapter.resume(options), adapter };
				},
			},
		});
		const t = task({ id: "resumed" });
		const resuming = session.resume({ task: t, name: "r", sessionId: "s" });
		assert.equal((await session.cancel(t.id)).status, "requested");
		gate.resolve();
		const handle = await resuming;
		await turn();
		assert.deepEqual(adapter.kills, [handle.id]);
		assertCancelled(await session.supervise(handle, t), handle);
		assert.equal(delivered.length, 1);
	});
});
