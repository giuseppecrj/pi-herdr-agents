import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { queryObjects } from "node:v8";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import type {
	ResumeOptions,
	SpawnOptions,
} from "../../maestro/core/harness-adapter.ts";
import type {
	AgentHandle,
	CompletionEvidence,
	Role,
	RunResult,
	Task,
} from "../../maestro/core/types.ts";
import {
	createRunSession,
	defaultRetainSurface,
	type OwnedRunAttempt,
	type PreparedRun,
	type RunObservation,
	type RunSessionHooks,
	type RunSessionOptions,
} from "../../maestro/runtime/index.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";

const ABORT = "Aborted while waiting for subagent to finish";
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
		...overrides,
	};
}
function routed(overrides: Partial<Task> = {}): Task {
	return task({
		runtime: { ...candidates[0], fallbacks: candidates.slice(1) },
		...overrides,
	});
}
function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
class CountingAdapter extends FakeHarnessAdapter {
	launches: SpawnOptions[] = [];
	resumes: ResumeOptions[] = [];
	waits: { handle: AgentHandle; signal: AbortSignal }[] = [];
	unregistered = 0;
	states = 0;
	reads = 0;
	kills: string[] = [];
	interrupts: string[] = [];
	sends: string[] = [];
	waitStarted = deferred<void>();
	launchError?: (options: SpawnOptions) => Error | undefined;
	completionError?: Error;
	returnedSurface?: string;
	returnedPid?: number;
	override async spawn(options: SpawnOptions) {
		this.launches.push(options);
		const error = this.launchError?.(options);
		if (error) throw error;
		return {
			...(await super.spawn(options)),
			surfaceId: this.returnedSurface,
			pid: this.returnedPid,
		};
	}
	override async resume(options: ResumeOptions) {
		this.resumes.push(options);
		return {
			...(await super.resume(options)),
			surfaceId: this.returnedSurface,
			pid: this.returnedPid,
		};
	}
	override awaitCompletion(handle: AgentHandle, signal: AbortSignal) {
		this.waits.push({ handle, signal });
		this.waitStarted.resolve();
		const wait = this.completionError
			? Promise.reject(this.completionError)
			: super.awaitCompletion(handle, signal);
		return wait.finally(() => {
			this.unregistered++;
		});
	}
	override async getState(handle: AgentHandle) {
		this.states++;
		return super.getState(handle);
	}
	override async readOutput(handle: AgentHandle) {
		this.reads++;
		return super.readOutput(handle);
	}
	override async kill(handle: AgentHandle) {
		this.kills.push(handle.id);
		await super.kill(handle);
	}
	override async interrupt(handle: AgentHandle) {
		this.interrupts.push(handle.id);
		await super.interrupt(handle);
	}
	override async sendInput(handle: AgentHandle, text: string) {
		this.sends.push(handle.id);
		await super.sendInput(handle, text);
	}
}
class CountingProvider extends FakeSurfaceProvider {
	closes: string[] = [];
	creates = 0;
	attaches = 0;
	absences = 0;
	inspections = 0;
	closeEffect?: () => void | Promise<void>;
	override createSurface(
		options: Parameters<FakeSurfaceProvider["createSurface"]>[0],
	) {
		this.creates++;
		return super.createSurface(options);
	}
	override attachSurface(id: string) {
		this.attaches++;
		return super.attachSurface(id);
	}
	override closeSurface(id: string): void | Promise<void> {
		this.closes.push(id);
		if (this.closeEffect) return this.closeEffect();
		return super.closeSurface(id);
	}
	override async waitForSurfaceAbsence(id: string) {
		this.absences++;
		return super.waitForSurfaceAbsence(id);
	}
	override async inspectSurface(id: string) {
		this.inspections++;
		return super.inspectSurface(id);
	}
}
function fixture(
	extra: Partial<RunSessionOptions> & {
		adapter?: CountingAdapter;
		surfaceProvider?: CountingProvider;
	} = {},
) {
	const adapter = extra.adapter ?? new CountingAdapter();
	const provider = extra.surfaceProvider ?? new CountingProvider();
	// This is an adapter-returned surface fixture, not runtime pre-acquisition.
	adapter.returnedSurface = provider.createSurface({
		name: "actual owner",
		cwd: "/source",
	});
	provider.creates = 0;
	const session = createRunSession({
		adapter,
		surfaceProvider: provider,
		roles: [role],
		cwd: "/parent",
		sessionIdPrefix: "parent",
		...extra,
	});
	return { adapter, provider, session };
}
function prepared(
	adapter: CountingAdapter,
	extra: Partial<PreparedRun> = {},
): PreparedRun {
	return {
		role,
		persistent: false,
		candidates,
		spawnAttempt: async (options) => ({
			handle: await adapter.spawn(options),
			adapter,
		}),
		...extra,
	};
}
function observation(kind: RunObservation["kind"], at = 42): RunObservation {
	return {
		kind,
		observedAt: at,
		projection: { kind: "interrupted", stateDurationSince: 10 },
		lifecycle: {
			process: { kind: "running", startedAt: 1, confirmedAt: 2 },
			turn: {
				kind: "interrupted",
				requestedAt: 10,
				previousActivitySequence: 3,
			},
			activityHealth: {
				kind: "problem",
				reason: "invalid",
				since: 4,
				error: "bad activity",
			},
			activityDetail: {
				kind: "scope",
				scope: "tool",
				label: "read",
				since: 5,
				observedAt: at,
				sequence: 3,
			},
			pane: { kind: "present", observedAt: at, agentStatus: "working" },
			hasWorked: true,
			lastActivitySequence: 3,
			delivery: "pending",
		},
		activityRead: { ok: false, reason: "invalid", error: "bad activity" },
	};
}
async function terminal(
	f: ReturnType<typeof fixture>,
	t = task(),
	evidence: CompletionEvidence = { reason: "done", exitCode: 0 },
) {
	const handle = await f.session.spawn(t);
	const result = f.session.supervise(handle, t);
	f.adapter.complete(handle.id, evidence);
	return { handle, result: await result };
}
function retired(f: ReturnType<typeof fixture>, t: Task) {
	assert.equal(f.session.getHandle(t.id), undefined);
	assert.equal(f.session.getTask(t.id), undefined);
}

it("an uncertain owner survives a rejected watcher until termination is independently confirmed", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	const taskInput = routed();
	const handle = await f.session.spawn(taskInput);
	handle.launchFailure = "dispatch receipt lost";
	f.adapter.completionError = new Error("watcher unavailable");
	let confirmed = false;
	f.adapter.kill = async () => {
		if (!confirmed) throw new Error("exit unconfirmed");
	};
	let settled = false;
	const wait = f.session.supervise(handle, taskInput).then((result) => {
		settled = true;
		return result;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	assert.equal(f.session.getHandle(taskInput.id), handle);
	assert.deepEqual(f.provider.closes, []);
	confirmed = true;
	t.mock.timers.tick(1000);
	assert.equal((await wait).outcome, "failed");
	assert.equal(f.adapter.launches.length, 1);
});

describe("RunSession preparation and default owners", () => {
	it("resolves roles, merges env and forwards launch input without acquiring infrastructure", async () => {
		const f = fixture({ env: { SHARED: "parent", PARENT: "yes" } });
		const t = task({
			cwd: "/requested",
			env: { SHARED: "task" },
			session: { mode: "fork", parentSessionId: "prior" },
			behavior: { persistent: false, autoExit: true },
			tools: ["bash"],
			systemPrompt: "override",
			worktree: { branch: "change", base: "main" },
			runtime: candidates[0],
		});
		const handle = await f.session.spawn(t);
		assert.ok(f.adapter.launches[0].acquisitionSignal instanceof AbortSignal);
		assert.deepEqual(f.adapter.launches, [
			{
				acquisitionSignal: f.adapter.launches[0].acquisitionSignal,
				name: "writer",
				task: "do the work",
				role,
				cwd: "/requested",
				sessionId: "parent-logical",
				env: { SHARED: "task", PARENT: "yes" },
				session: t.session,
				behavior: t.behavior,
				tools: ["bash"],
				systemPrompt: "override",
				worktreeRequest: t.worktree,
				runtime: candidates[0],
			},
		]);
		assert.equal(handle.worktree, undefined);
		assert.equal(f.provider.creates, 0);
		assert.equal(f.provider.attaches, 0);
		assert.deepEqual(f.provider.closes, []);
		f.session.suppress(t.id);
	});
	it("missing exact role fails before preparation and allows reuse", async () => {
		const f = fixture();
		await assert.rejects(f.session.spawn(task({ role: "Worker" })), /Worker/);
		assert.equal(f.adapter.launches.length, 0);
		await f.session.spawn(task());
		f.session.suppress("logical");
	});
	it("explicit preparation uses its captured bare role and stable full candidate order", async () => {
		const f = fixture({ roles: [] });
		const captured = { ...role, name: "", systemPrompt: "captured" };
		const p = prepared(f.adapter, { role: captured });
		const t = routed({ role: "" });
		const handle = await f.session.spawn(t, p);
		assert.equal(f.adapter.launches[0].role, captured);
		assert.deepEqual(f.adapter.launches[0].runtime, {
			model: "provider/first",
			thinking: "low",
		});
		assert.equal(f.adapter.launches[0].runtime?.fallbacks, undefined);
		f.session.suppress(t.id);
		assert.ok(handle);
	});
	for (const explicit of [false, true]) {
		it(`rejects the complete worktree candidate list before acquisition (prepared=${explicit})`, async () => {
			const f = fixture();
			const t = routed({ worktree: { branch: "work" } });
			await assert.rejects(
				f.session.spawn(t, explicit ? prepared(f.adapter) : undefined),
				/Model fallbacks are not supported for worktree subagents/,
			);
			assert.equal(f.adapter.launches.length, 0);
			assert.equal(f.provider.creates, 0);
			await f.session.spawn(task());
			f.session.suppress(t.id);
		});
	}
	for (const method of ["spawn", "resume"] as const) {
		for (const gate of [
			"delivered",
			"suppressed",
			"rejected",
			"worktree",
		] as const) {
			it(`${method} wraps the actual adapter owner and gates exact-ID cleanup: ${gate}`, async () => {
				const delivery = deferred<void | "suppressed">();
				const entered = deferred<void>();
				const failure = new Error("parent send failed");
				const f = fixture({
					hooks: {
						onSettled: () => {
							entered.resolve();
							return delivery.promise;
						},
					},
				});
				const t = task(
					gate === "worktree" ? { worktree: { branch: "retained" } } : {},
				);
				const handle =
					method === "spawn"
						? await f.session.spawn(t)
						: await f.session.resume({
								task: t,
								name: "resumed",
								sessionId: "stored",
								message: "reply",
							});
				assert.equal(f.session.getHandle(t.id), handle);
				const wait = f.session.supervise(handle, t);
				const rejected =
					gate === "rejected"
						? assert.rejects(wait, (error) => error === failure)
						: undefined;
				f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
				await entered.promise;
				assert.deepEqual(f.provider.closes, []);
				assert.equal(f.session.getTask(t.id), t);
				if (gate === "rejected") {
					delivery.reject(failure);
					await rejected;
				} else {
					delivery.resolve(gate === "suppressed" ? "suppressed" : undefined);
					assert.equal((await wait).outcome, "completed");
				}
				assert.deepEqual(
					f.provider.closes,
					gate === "rejected" || gate === "worktree" ? [] : [handle.surfaceId],
				);
				retired(f, t);
				await assert.rejects(
					f.session.supervise(handle, t),
					/retired|consumed/,
				);
				await assert.rejects(f.session.spawn(t), /logical/);
				f.session.suppress(t.id);
				assert.equal(
					f.provider.closes.length,
					gate === "rejected" || gate === "worktree" ? 0 : 1,
				);
				assert.equal(f.adapter.waits.length, 1);
				assert.equal(f.adapter.unregistered, 1);
				assert.equal(
					f.provider.creates +
						f.provider.attaches +
						f.provider.absences +
						f.provider.inspections +
						f.adapter.kills.length +
						f.adapter.states +
						f.adapter.reads,
					0,
				);
				assert.equal(f.session.observe(t.id), undefined);
			});
		}
	}
	for (const missing of ["provider", "surface"] as const) {
		it(`settles without fabricated cleanup when ${missing} is absent`, async () => {
			const adapter = new CountingAdapter();
			const provider = new CountingProvider();
			adapter.returnedSurface =
				missing === "provider" ? "existing-pane" : undefined;
			adapter.returnedPid = 1234;
			const session = createRunSession({
				adapter,
				roles: [role],
				cwd: "/parent",
				surfaceProvider: missing === "surface" ? provider : undefined,
			});
			const t = task();
			const handle = await session.spawn(t);
			assert.equal(session.observe(t.id), undefined);
			const wait = session.supervise(handle, t);
			adapter.complete(handle.id, { reason: "done", exitCode: 0 });
			assert.equal((await wait).outcome, "completed");
			assert.deepEqual(provider.closes, []);
			assert.equal(adapter.states + adapter.reads + adapter.kills.length, 0);
		});
	}
});

describe("RunSession reservations and acquired hook recovery", () => {
	for (const first of ["spawn", "resume"] as const) {
		for (const second of ["spawn", "resume"] as const) {
			it(`reserves synchronously across ${first}/${second} while acquisition is deferred`, async () => {
				const adapter = new CountingAdapter();
				const gate = deferred<OwnedRunAttempt>();
				let prepares = 0,
					acquisitions = 0;
				const session = createRunSession({
					adapter,
					roles: [role],
					cwd: "/parent",
					operations: {
						prepare: async () => {
							prepares++;
							return prepared(adapter, {
								spawnAttempt: () => {
									acquisitions++;
									return gate.promise;
								},
							});
						},
						resume: () => {
							acquisitions++;
							return gate.promise;
						},
					},
				});
				const t = task();
				const start = () =>
					first === "spawn"
						? session.spawn(t)
						: session.resume({ task: t, name: "resume", sessionId: "session" });
				const pending = start();
				await assert.rejects(
					second === "spawn"
						? session.spawn(t)
						: session.resume({ task: t, name: "resume", sessionId: "session" }),
					/logical/,
				);
				assert.equal(prepares, first === "spawn" ? 1 : 0);
				assert.equal(acquisitions, 1);
				const handle = await adapter.spawn({
					name: "actual",
					role,
					cwd: "/source",
					sessionId: "real",
					task: "task",
				});
				gate.resolve({ handle, adapter });
				await pending;
				session.suppress(t.id);
			});
		}
	}
	it("holds reservation across deferred preparation, then releases a pre-acquisition refusal", async () => {
		const adapter = new CountingAdapter();
		const gate = deferred<PreparedRun>();
		let prepares = 0;
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			operations: {
				prepare: () => {
					prepares++;
					return gate.promise;
				},
			},
		});
		const t = task();
		const pending = session.spawn(t);
		const rejected = assert.rejects(pending, /validation/);
		await assert.rejects(session.spawn(t), /logical/);
		await assert.rejects(
			session.resume({ task: t, name: "resume", sessionId: "real" }),
			/logical/,
		);
		assert.equal(prepares, 1);
		gate.reject(new Error("validation"));
		await rejected;
		await session.spawn(t, prepared(adapter));
		session.suppress(t.id);
	});
	for (const method of ["spawn", "resume"] as const) {
		it(`registers ${method} ownership before a deferred hook fails without fallback or cleanup`, async () => {
			const hook = deferred<void>();
			const entered = deferred<void>();
			const error = new Error("spawned hook failed");
			let spawned = 0,
				settled = 0;
			const f = fixture({
				hooks: {
					onSpawned: () => {
						spawned++;
						entered.resolve();
						return hook.promise;
					},
					onSettled: () => {
						settled++;
					},
				},
			});
			const t = routed();
			const pending =
				method === "spawn"
					? f.session.spawn(t)
					: f.session.resume({ task: t, name: "resume", sessionId: "stored" });
			const rejected = assert.rejects(pending, (actual) => actual === error);
			await entered.promise;
			const handle = f.session.getHandle(t.id);
			assert.ok(handle);
			assert.equal(f.session.getTask(t.id), t);
			await assert.rejects(f.session.spawn(t), /logical/);
			hook.reject(error);
			await rejected;
			assert.equal(f.adapter.launches.length + f.adapter.resumes.length, 1);
			assert.equal(settled, 0);
			assert.deepEqual(f.provider.closes, []);
			await f.session.send(t.id, "recover");
			await f.session.interrupt(t.id);
			assert.deepEqual(f.adapter.inputs(handle.id), ["recover"]);
			const wait = f.session.supervise(handle, t);
			f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
			await wait;
			assert.equal(spawned, 1);
			assert.equal(settled, 1);
			retired(f, t);
		});
	}
	it("a fallback hook error rejects joined waits, preserves the new owner, and explicit recovery does not relaunch", async () => {
		const adapter = new CountingAdapter();
		const hook = deferred<void>();
		const acquired = deferred<AgentHandle>();
		const error = new Error("fallback hook error");
		let spawned = 0,
			settled = 0;
		const f = fixture({
			adapter,
			hooks: {
				onSpawned: (handle) => {
					spawned++;
					if (spawned === 2) {
						acquired.resolve(handle);
						return hook.promise;
					}
				},
				onSettled: () => {
					settled++;
				},
			},
		});
		const t = routed();
		const first = await f.session.spawn(t);
		const one = f.session.supervise(first, t);
		const two = f.session.supervise(first, t);
		const rejectedOne = assert.rejects(one, (actual) => actual === error);
		const rejectedTwo = assert.rejects(two, (actual) => actual === error);
		adapter.fail(first.id, "provider refused");
		const active = await acquired.promise;
		assert.equal(f.session.getHandle(t.id), active);
		hook.reject(error);
		await Promise.all([rejectedOne, rejectedTwo]);
		assert.equal(settled, 0);
		assert.equal(adapter.waits.length, 1);
		assert.equal(adapter.launches.length, 2);
		await f.session.send(t.id, "current owner");
		await f.session.interrupt(t.id);
		assert.deepEqual(adapter.sends, [active.id]);
		assert.deepEqual(adapter.interrupts, [active.id]);
		const recovered = f.session.supervise(active, t);
		adapter.complete(active.id, { reason: "done", exitCode: 0 });
		assert.equal((await recovered).handle, active);
		assert.equal(spawned, 2);
		assert.equal(settled, 1);
		assert.equal(adapter.launches.length, 2);
	});
});

describe("RunSession evidence, observations and retries", () => {
	const mappings: {
		evidence: CompletionEvidence;
		outcome: RunResult["outcome"];
	}[] = [
		{ evidence: { reason: "done", exitCode: 0 }, outcome: "completed" },
		{ evidence: { reason: "done", exitCode: 7 }, outcome: "failed" },
		{ evidence: { reason: "sentinel", exitCode: 0 }, outcome: "completed" },
		{ evidence: { reason: "sentinel", exitCode: 2 }, outcome: "failed" },
		{
			evidence: {
				reason: "ping",
				exitCode: 0,
				ping: { name: "writer", message: "help me" },
			},
			outcome: "help",
		},
		{
			evidence: { reason: "error", exitCode: 1, errorMessage: "bad request" },
			outcome: "failed",
		},
	];
	for (const { evidence, outcome } of mappings) {
		it(`maps ${evidence.reason}/${evidence.exitCode} to ${outcome}, preserving required evidence`, async () => {
			const f = fixture();
			const { result } = await terminal(f, task(), evidence);
			assert.equal(result.outcome, outcome);
			assert.equal(result.exitCode, evidence.exitCode);
			assert.equal(result.evidence?.exitCode, evidence.exitCode);
			assert.equal(result.evidence?.ping?.message, evidence.ping?.message);
			assert.equal(f.provider.closes.length, 1);
		});
	}
	for (const [message, outcome] of [
		["Aborted owned wait", "killed"],
		["unexpected registration failure", "failed"],
	] as const) {
		it(`maps owned rejection ${message} without inventing evidence or retry`, async () => {
			const adapter = new CountingAdapter();
			adapter.completionError = new Error(message);
			const f = fixture({ adapter });
			const t = routed();
			const handle = await f.session.spawn(t);
			const result = await f.session.supervise(handle, t);
			assert.equal(result.outcome, outcome);
			assert.equal(result.error, message);
			assert.equal(result.evidence, undefined);
			assert.equal(adapter.launches.length, 1);
		});
	}
	it("consumes injected cheap observations, including health/detail, without registering or inspecting again", async () => {
		const adapter = new CountingAdapter();
		const events: string[] = [];
		const observations: RunObservation[] = [];
		let refreshes = 0;
		const hooks: RunSessionHooks = {
			onObserved: (_handle, projection, observed) => {
				assert.equal(projection, observed.projection);
				observations.push(observed);
				events.push(observed.kind);
			},
			onSettled: () => {
				events.push("settled");
			},
		};
		const f = fixture({ adapter, hooks });
		const t = task();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				candidates: [],
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					observe: (at) => {
						refreshes++;
						return observation("refresh", at);
					},
					finalize: async (result) => {
						events.push("finalize");
						return { ...result, output: "transcript" };
					},
				}),
			}),
		);
		// The adapter owns ongoing events and completion registration. Emitting
		// from that real wait also detects a runtime bypass or duplicate wait.
		const owningWait = adapter.awaitCompletion.bind(adapter);
		adapter.awaitCompletion = (owner, signal) => {
			const ongoing = observation("local-evidence");
			hooks.onObserved?.(owner, ongoing.projection, ongoing);
			return owningWait(owner, signal).then((evidence) => {
				const completed = observation("completion");
				hooks.onObserved?.(owner, completed.projection, completed);
				return evidence;
			});
		};
		const one = f.session.supervise(handle, t);
		const two = f.session.supervise(handle, t);
		assert.equal(refreshes, 2);
		await adapter.waitStarted.promise;
		assert.equal(adapter.waits.length, 1);
		const explicit = f.session.observe(t.id, 123);
		assert.equal(explicit?.observedAt, 123);
		assert.deepEqual(explicit?.lifecycle.activityHealth, {
			kind: "problem",
			reason: "invalid",
			since: 4,
			error: "bad activity",
		});
		assert.equal(explicit?.lifecycle.activityDetail?.kind, "scope");
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		const results = await Promise.all([one, two]);
		assert.equal(results[0], results[1]);
		assert.equal(results[0].output, "transcript");
		assert.deepEqual(events, [
			"refresh",
			"local-evidence",
			"refresh",
			"refresh",
			"completion",
			"finalize",
			"settled",
		]);
		assert.equal(adapter.waits.length, 1);
		assert.equal(adapter.unregistered, 1);
		assert.equal(adapter.states + adapter.reads + f.provider.inspections, 0);
	});
	it("accepts timeout fields without installing timers or synthesizing completion", async (context) => {
		const f = fixture({ defaultTimeoutMs: 1 });
		const t = task({ timeoutMs: 1 });
		const handle = await f.session.spawn(t);
		const timer = context.mock.method(globalThis, "setTimeout", () => {
			throw new Error("runtime deadline installed");
		});
		const wait = f.session.supervise(handle, t);
		await f.adapter.waitStarted.promise;
		assert.equal(f.session.getHandle(t.id), handle);
		assert.equal(timer.mock.callCount(), 0);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await wait).outcome, "completed");
	});
	for (const persistent of [false, true]) {
		it(`launch throws advance all candidates even when persistent=${persistent}; all failure permits reuse`, async () => {
			const adapter = new CountingAdapter();
			adapter.launchError = (options) =>
				new Error(`denied ${options.runtime?.model}`);
			const f = fixture({ adapter });
			const t = routed({ behavior: { persistent } });
			await assert.rejects(f.session.spawn(t), {
				message:
					"Subagent could not launch with any configured model. Attempted: provider/first, provider/second, provider/third. provider/first: denied provider/first; provider/second: denied provider/second; provider/third: denied provider/third",
			});
			assert.deepEqual(
				adapter.launches.map((options) => options.runtime?.model),
				["provider/first", "provider/second", "provider/third"],
			);
			assert.deepEqual(f.provider.closes, []);
			adapter.launchError = undefined;
			await f.session.spawn(t);
			f.session.suppress(t.id);
		});
	}
	it("starts a selected launch fallback, then retries from the next stable candidate on running error", async () => {
		const adapter = new CountingAdapter();
		adapter.launchError = (options) =>
			options.runtime?.model === "provider/first"
				? new Error("launch first")
				: undefined;
		const third = deferred<AgentHandle>();
		let deliveries = 0;
		const f = fixture({
			adapter,
			hooks: {
				onSpawned: (handle) => {
					if (adapter.launches.length === 3) third.resolve(handle);
				},
				onSettled: () => {
					deliveries++;
				},
			},
		});
		const t = routed();
		const second = await f.session.spawn(t);
		const wait = f.session.supervise(second, t);
		adapter.fail(second.id, "running second");
		const active = await third.promise;
		assert.equal(deliveries, 0);
		adapter.complete(active.id, { reason: "done", exitCode: 0 });
		assert.equal((await wait).handle, active);
		assert.deepEqual(
			adapter.launches.map((options) => options.runtime?.model),
			["provider/first", "provider/second", "provider/third"],
		);
		assert.equal(deliveries, 1);
	});
	for (const errorMessage of [undefined, "", "provider refused"]) {
		it(`running retry tests errorMessage presence, not truthiness (${JSON.stringify(errorMessage)})`, {
			timeout: 10000,
		}, async () => {
			const adapter = new CountingAdapter();
			const f = fixture({
				adapter,
				hooks: {
					onSpawned: (handle) => {
						// Complete any retry, including an unexpected one, so decisions
						// fail by outcome/count assertion rather than a pending wait.
						if (adapter.launches.length > 1)
							adapter.complete(handle.id, { reason: "done", exitCode: 0 });
					},
				},
			});
			const t = routed();
			const first = await f.session.spawn(t);
			const wait = f.session.supervise(first, t);
			adapter.complete(first.id, {
				reason: "error",
				exitCode: 1,
				errorMessage,
			});
			assert.equal(
				(await wait).outcome,
				errorMessage === undefined ? "failed" : "completed",
			);
			assert.equal(adapter.launches.length, errorMessage === undefined ? 1 : 2);
		});
	}
	for (const variant of [
		"result-error",
		"exit-only",
		"negative-summary",
	] as const) {
		it(`${variant} alone does not authorize retry`, async () => {
			const adapter = new CountingAdapter();
			const f = fixture({ adapter });
			const t = routed();
			const p = prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					finalize: async (result) => {
						const finalized = {
							...result,
							output: "The task could not be completed.",
						};
						if (variant === "result-error")
							finalized.error = "provider refused";
						return finalized;
					},
				}),
			});
			const handle = await f.session.spawn(t, p);
			const wait = f.session.supervise(handle, t);
			adapter.complete(handle.id, {
				reason: "done",
				exitCode: variant === "exit-only" ? 9 : 0,
			});
			await wait;
			assert.equal(adapter.launches.length, 1);
		});
	}
	for (const override of [undefined, false]) {
		it(`effective role persistence blocks running retries unless overridden (${override})`, async () => {
			const adapter = new CountingAdapter();
			const second = deferred<AgentHandle>();
			const f = fixture({
				adapter,
				roles: [{ ...role, defaults: { persistent: true } }],
				hooks: {
					onSpawned: (handle) => {
						if (adapter.launches.length === 2) second.resolve(handle);
					},
				},
			});
			const t = routed({
				behavior: override === undefined ? undefined : { persistent: override },
			});
			const handle = await f.session.spawn(t);
			const wait = f.session.supervise(handle, t);
			adapter.fail(handle.id, "provider error");
			if (override === false) {
				const active = await second.promise;
				adapter.complete(active.id, { reason: "done", exitCode: 0 });
			}
			await wait;
			assert.equal(adapter.launches.length, override === false ? 2 : 1);
		});
	}
	it("attempt-reported persistence overrides prepared persistence", {
		timeout: 10000,
	}, async () => {
		const adapter = new CountingAdapter();
		// Bound even an unexpected retry: launch failures return to the original
		// evidence and expose the incorrect candidate count without hanging.
		adapter.launchError = (options) =>
			options.runtime?.model === "provider/first"
				? undefined
				: new Error("unexpected persistent retry");
		const f = fixture({ adapter });
		const t = routed();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					persistent: true,
				}),
			}),
		);
		const wait = f.session.supervise(handle, t);
		adapter.fail(handle.id, "error");
		await wait;
		assert.equal(adapter.launches.length, 1);
	});
	it("exhausted running launch failures preserve prior evidence and append raw ordered errors", async () => {
		const adapter = new CountingAdapter();
		adapter.launchError = (options) =>
			options.runtime?.model === "provider/first"
				? undefined
				: new Error(`cannot launch ${options.runtime?.model}`);
		const f = fixture({ adapter });
		const t = routed();
		const handle = await f.session.spawn(t);
		const wait = f.session.supervise(handle, t);
		adapter.fail(handle.id, "original failure");
		const result = await wait;
		assert.equal(result.outcome, "failed");
		assert.equal(
			result.evidence?.errorMessage,
			"original failure\n\nFallback launch failures: provider/second: cannot launch provider/second; provider/third: cannot launch provider/third",
		);
		assert.equal(adapter.launches.length, 3);
	});
});

describe("RunSession delivery, cleanup and controls", () => {
	for (const decision of ["delivered", "suppressed", "reject"] as const) {
		it(`finalizes every attempt before one final ${decision} gate and releases all or no ordinary panes`, async () => {
			const adapter = new CountingAdapter();
			const provider = new CountingProvider();
			const active = deferred<AgentHandle>();
			const delivery = deferred<void | "suppressed">();
			const entered = deferred<void>();
			const order: string[] = [];
			const panes: string[] = [];
			const f = fixture({
				adapter,
				surfaceProvider: provider,
				hooks: {
					onSettled: () => {
						order.push("delivery");
						entered.resolve();
						return delivery.promise;
					},
				},
			});
			const t = routed();
			const p = prepared(adapter, {
				spawnAttempt: async (options, index) => {
					const pane = provider.createSurface({
						name: options.name,
						cwd: options.cwd,
					});
					panes.push(pane);
					adapter.returnedSurface = pane;
					const handle = await adapter.spawn(options);
					if (index === 1) active.resolve(handle);
					return {
						handle,
						adapter,
						closeTemporarySurface: async () => {
							await provider.closeSurface(pane);
						},
						finalize: async (result) => {
							order.push(`finalize-${index}`);
							return { ...result, output: `final-${index}` };
						},
					};
				},
			});
			const first = await f.session.spawn(t, p);
			const wait = f.session.supervise(first, t);
			const joined = f.session.supervise(first, t);
			const failure = new Error("failed send");
			const errors =
				decision === "reject"
					? Promise.all([
							assert.rejects(wait, (error) => error === failure),
							assert.rejects(joined, (error) => error === failure),
						])
					: undefined;
			adapter.fail(first.id, "retry me");
			const second = await active.promise;
			// Acquisition is visible before hook completion/wait registration.
			adapter.complete(second.id, { reason: "done", exitCode: 0 });
			await entered.promise;
			assert.deepEqual(order, ["finalize-0", "finalize-1", "delivery"]);
			assert.deepEqual(provider.closes, []);
			if (decision === "reject") {
				delivery.reject(failure);
				await errors;
			} else {
				delivery.resolve(decision === "suppressed" ? "suppressed" : undefined);
				const results = await Promise.all([wait, joined]);
				assert.equal(results[0], results[1]);
				assert.equal(results[0].output, "final-1");
			}
			assert.deepEqual(provider.closes, decision === "reject" ? [] : panes);
			retired(f, t);
			f.session.suppress(t.id);
			assert.deepEqual(provider.closes, decision === "reject" ? [] : panes);
		});
	}
	for (const closeFailure of [
		"deferred",
		"sync-throw",
		"async-reject",
	] as const) {
		it(`authorized ${closeFailure} close is nonblocking, best effort, and never redelivers`, async () => {
			const close = deferred<void>();
			let sends = 0;
			const f = fixture({
				hooks: {
					onSettled: () => {
						sends++;
					},
				},
			});
			f.provider.closeEffect = () => {
				if (closeFailure === "sync-throw") throw new Error("sync close");
				if (closeFailure === "async-reject")
					return Promise.reject(new Error("async close"));
				return close.promise;
			};
			const t = task();
			const { handle, result } = await terminal(f, t);
			assert.equal(result.outcome, "completed");
			assert.equal(sends, 1);
			assert.deepEqual(f.provider.closes, [handle.surfaceId]);
			retired(f, t);
			close.reject(new Error("late close rejection"));
			// The test's deferred is only used by the deferred-close case.
			if (closeFailure !== "deferred") await close.promise.catch(() => {});
			await Promise.resolve();
			f.session.suppress(t.id);
			assert.equal(sends, 1);
			assert.equal(f.provider.closes.length, 1);
		});
	}
	it("default retention is worktree only, including ordinary help and persistent process completion", () => {
		const result: RunResult = {
			handle: {
				id: "owner",
				name: "writer",
				role: "worker",
				harness: "fake",
				cwd: "/source",
				startedAt: 0,
				sessionId: "real",
			},
			outcome: "help",
			durationMs: 0,
		};
		assert.equal(defaultRetainSurface(result, task()), false);
		assert.equal(
			defaultRetainSurface(result, task({ behavior: { persistent: true } })),
			false,
		);
		assert.equal(
			defaultRetainSurface(result, task({ worktree: { branch: "kept" } })),
			true,
		);
	});
	it("resume registers a new handle under the logical Task ID and controls await the owning adapter", async () => {
		const adapter = new CountingAdapter();
		const f = fixture({ adapter });
		const t = task();
		const handle = await f.session.resume({
			task: t,
			name: "resume",
			sessionId: "saved",
			message: "reply",
			tools: ["read"],
			autoExit: true,
		});
		assert.notEqual(handle.id, t.id);
		assert.equal(f.session.getHandle(t.id), handle);
		assert.ok(adapter.resumes[0].acquisitionSignal instanceof AbortSignal);
		assert.deepEqual(adapter.resumes, [
			{
				acquisitionSignal: adapter.resumes[0].acquisitionSignal,
				name: "resume",
				sessionId: "saved",
				message: "reply",
				tools: ["read"],
				autoExit: true,
			},
		]);
		const send = deferred<void>(),
			interrupt = deferred<void>(),
			kill = deferred<void>();
		adapter.sendInput = async (owner, text) => {
			assert.equal(owner, handle);
			assert.equal(text, "follow up");
			await send.promise;
		};
		adapter.interrupt = async (owner) => {
			assert.equal(owner, handle);
			await interrupt.promise;
		};
		adapter.kill = async (owner) => {
			assert.equal(owner, handle);
			await kill.promise;
		};
		for (const [control, gate] of [
			[() => f.session.send(t.id, "follow up"), send],
			[() => f.session.interrupt(t.id), interrupt],
			[() => f.session.kill(t.id), kill],
		] as const) {
			let completed = false;
			const pending = control().then(() => {
				completed = true;
			});
			await Promise.resolve();
			assert.equal(completed, false);
			gate.resolve();
			await pending;
		}
		f.session.suppress(t.id);
	});
	it("rejects missing controls and unrelated supervise pairs without starting a producer", async () => {
		const f = fixture();
		const t = task();
		const handle = await f.session.spawn(t);
		await assert.rejects(f.session.send("missing", "text"), /missing/);
		await assert.rejects(f.session.kill("missing"), /missing/);
		await assert.rejects(f.session.interrupt("missing"), /missing/);
		await assert.rejects(
			f.session.supervise({ ...handle, id: "unrelated" }, t),
			/handle|owner|match/,
		);
		await assert.rejects(
			f.session.supervise(handle, task({ id: "another" })),
			/another/,
		);
		const copiedHandle = f.session.supervise({ ...handle }, t);
		const sameId = f.session.supervise(handle, task({ id: t.id }));
		// If identity validation regresses, finish the unexpected producer so the
		// assertions fail explicitly rather than awaiting an unbounded live run.
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await Promise.all([
			assert.rejects(copiedHandle, /handle|owner|match/),
			assert.rejects(sameId, /handle|owner|match/),
		]);
		assert.equal(f.adapter.waits.length, 0);
		f.session.suppress(t.id);
	});
});

describe("RunSession caller cancellation and explicit suppression", () => {
	it("already-aborted callers reject with existing wording and start no work", async () => {
		let observed = 0,
			settled = 0;
		const adapter = new CountingAdapter();
		const f = fixture({
			adapter,
			hooks: {
				onObserved: () => {
					observed++;
				},
				onSettled: () => {
					settled++;
				},
			},
		});
		const t = routed();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					observe: () => observation("refresh"),
				}),
			}),
		);
		const abort = new AbortController();
		abort.abort();
		await assert.rejects(f.session.supervise(handle, t, abort.signal), {
			message: ABORT,
		});
		assert.equal(
			observed + settled + adapter.waits.length + f.provider.closes.length,
			0,
		);
		assert.equal(adapter.launches.length, 1);
		f.session.suppress(t.id);
	});
	it("one caller abort leaves the sole owned registration and another caller live", async () => {
		let settled = 0;
		const f = fixture({
			hooks: {
				onSettled: () => {
					settled++;
				},
			},
		});
		const t = task();
		const handle = await f.session.spawn(t);
		const caller = new AbortController();
		const first = f.session.supervise(handle, t, caller.signal);
		const rejected = assert.rejects(first, { message: ABORT });
		const second = f.session.supervise(handle, t);
		await f.adapter.waitStarted.promise;
		assert.notEqual(f.adapter.waits[0].signal, caller.signal);
		caller.abort();
		await rejected;
		assert.equal(f.adapter.waits[0].signal.aborted, false);
		assert.equal(f.adapter.unregistered, 0);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		assert.equal(settled + f.provider.closes.length, 0);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await second).outcome, "completed");
		assert.equal(settled, 1);
		assert.equal(f.adapter.waits.length, 1);
		assert.equal(f.adapter.unregistered, 1);
	});
	it("last caller abort does not settle or retry; a later caller joins actual completion once", async () => {
		let settled = 0;
		const f = fixture({
			hooks: {
				onSettled: () => {
					settled++;
				},
			},
		});
		const t = routed();
		const handle = await f.session.spawn(t);
		const caller = new AbortController();
		const wait = f.session.supervise(handle, t, caller.signal);
		const rejected = assert.rejects(wait, { message: ABORT });
		await f.adapter.waitStarted.promise;
		caller.abort();
		await rejected;
		assert.equal(f.adapter.waits[0].signal.aborted, false);
		assert.equal(f.adapter.unregistered, 0);
		assert.equal(f.adapter.launches.length, 1);
		assert.equal(settled + f.provider.closes.length, 0);
		const joined = f.session.supervise(handle, t);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await joined).outcome, "completed");
		assert.equal(settled, 1);
		assert.equal(f.adapter.waits.length, 1);
		assert.equal(f.adapter.unregistered, 1);
		await assert.rejects(f.session.supervise(handle, t), /retired|consumed/);
		assert.equal(f.adapter.waits.length, 1);
	});
	it("actual completion still delivers with zero remaining callers", async () => {
		const delivered = deferred<void>();
		let sends = 0;
		const f = fixture({
			hooks: {
				onSettled: () => {
					sends++;
					delivered.resolve();
				},
			},
		});
		const t = task();
		const handle = await f.session.spawn(t);
		const caller = new AbortController();
		const rejected = assert.rejects(
			f.session.supervise(handle, t, caller.signal),
			{ message: ABORT },
		);
		caller.abort();
		await rejected;
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await delivered.promise;
		// Delivery hook runs before retirement; joining while final delivery is live is valid.
		const live = f.session.getHandle(t.id);
		if (live) await f.session.supervise(live, t);
		retired(f, t);
		assert.equal(sends, 1);
		assert.equal(f.provider.closes.length, 1);
	});
	for (const producer of [false, true]) {
		for (const managed of [false, true]) {
			it(`suppression ${producer ? "during" : "before"} supervision gates delivery then aborts; managed=${managed}`, async () => {
				let settled = 0;
				const f = fixture({
					hooks: {
						onSettled: () => {
							settled++;
						},
					},
				});
				const t = task(
					managed
						? { worktree: { branch: "retained" }, runtime: candidates[0] }
						: { runtime: { ...candidates[0], fallbacks: candidates.slice(1) } },
				);
				const handle = await f.session.spawn(t);
				const waits = producer
					? [f.session.supervise(handle, t), f.session.supervise(handle, t)]
					: [];
				if (producer) await f.adapter.waitStarted.promise;
				f.session.suppress(t.id);
				f.session.suppress(t.id);
				for (const wait of waits) assert.equal((await wait).outcome, "killed");
				assert.equal(settled, 0);
				assert.equal(f.adapter.launches.length, 1);
				assert.equal(f.adapter.waits.length, producer ? 1 : 0);
				assert.equal(f.adapter.unregistered, producer ? 1 : 0);
				assert.equal(f.adapter.kills.length, 0);
				assert.equal(f.provider.closes.length, managed ? 0 : 1);
				retired(f, t);
				f.session.suppress(t.id);
				await assert.rejects(
					f.session.supervise(handle, t),
					/retired|consumed/,
				);
				assert.equal(f.provider.closes.length, managed ? 0 : 1);
			});
		}
	}
	it("evidence winning suppression during finalization keeps the real outcome but loses its undelivered hook", async () => {
		const adapter = new CountingAdapter();
		const finalize = deferred<RunResult>();
		const entered = deferred<RunResult>();
		let sends = 0;
		const f = fixture({
			adapter,
			hooks: {
				onSettled: () => {
					sends++;
				},
			},
		});
		const t = task();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				candidates: [],
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					closeTemporarySurface: async () => {
						const pane = handle.surfaceId;
						assert.ok(pane);
						await f.provider.closeSurface(pane);
					},
					finalize: (result) => {
						entered.resolve(result);
						return finalize.promise;
					},
				}),
			}),
		);
		const wait = f.session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		const result = await entered.promise;
		f.session.suppress(t.id);
		finalize.resolve(result);
		assert.equal((await wait).outcome, "completed");
		assert.equal(sends, 0);
		assert.equal(f.provider.closes.length, 1);
	});
	it("suppression during preparation rejects without an owner and prevents all acquisition", async () => {
		const adapter = new CountingAdapter();
		const gate = deferred<PreparedRun>();
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			operations: { prepare: () => gate.promise },
		});
		const t = routed();
		const pending = session.spawn(t);
		const rejected = assert.rejects(pending, { message: ABORT });
		session.suppress(t.id);
		assert.equal(session.getHandle(t.id), undefined);
		gate.resolve(prepared(adapter));
		await rejected;
		assert.equal(adapter.launches.length, 0);
		await session.spawn(t, prepared(adapter));
		session.suppress(t.id);
	});
	it("suppression during acquisition takes ownership of the returned pane, cleans once and never falls back/hooks", async () => {
		const adapter = new CountingAdapter();
		const acquire = deferred<OwnedRunAttempt>();
		const started = deferred<void>();
		let acquisitions = 0,
			hooks = 0,
			closes = 0;
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			hooks: {
				onSpawned: () => {
					hooks++;
				},
				onSettled: () => {
					hooks++;
				},
			},
		});
		const t = routed();
		const pending = session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: () => {
					acquisitions++;
					started.resolve();
					return acquire.promise;
				},
			}),
		);
		const rejected = assert.rejects(pending, { message: ABORT });
		await started.promise;
		session.suppress(t.id);
		assert.equal(session.getHandle(t.id), undefined);
		await assert.rejects(session.spawn(t), /logical/);
		const handle = await adapter.spawn({
			name: "actual",
			task: "work",
			role,
			cwd: "/source",
			sessionId: "real",
		});
		acquire.resolve({
			handle,
			adapter,
			closeTemporarySurface: async () => {
				closes++;
			},
		});
		await rejected;
		assert.equal(acquisitions, 1);
		assert.equal(hooks, 0);
		assert.equal(closes, 1);
		assert.equal(session.getHandle(t.id), undefined);
		await assert.rejects(session.spawn(t), /logical/);
		session.suppress(t.id);
		assert.equal(closes, 1);
	});
});

describe("RunSession ownership edge regressions", { timeout: 10000 }, () => {
	it("initial observation suppression settles the published producer without losing its owner", async () => {
		const adapter = new CountingAdapter();
		let observed = 0,
			sends = 0,
			closes = 0;
		const f = fixture({
			adapter,
			hooks: {
				onObserved: () => {
					observed++;
					f.session.suppress(t.id);
				},
				onSettled: () => {
					sends++;
				},
			},
		});
		const t = routed();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					observe: (at) => observation("refresh", at),
					closeTemporarySurface: async () => {
						closes++;
					},
				}),
			}),
		);
		const result = await f.session.supervise(handle, t);
		assert.equal(result.outcome, "killed");
		assert.equal(result.handle, handle);
		assert.equal(result.error, ABORT);
		assert.equal(observed, 1);
		assert.equal(sends, 0);
		assert.equal(closes, 1);
		assert.equal(adapter.launches.length, 1);
		assert.equal(adapter.waits.length, 1);
		assert.equal(adapter.waits[0].signal.aborted, true);
		assert.equal(adapter.unregistered, 1);
		retired(f, t);
	});
	for (const withCaller of [false, true]) {
		it(`synchronous owned suppression and abort preserves the shared outcome (caller signal=${withCaller})`, async () => {
			let sends = 0;
			const f = fixture({
				hooks: {
					onSettled: () => {
						sends++;
					},
				},
			});
			const t = routed();
			const handle = await f.session.spawn(t);
			const caller = new AbortController();
			let registrations = 0;
			f.adapter.awaitCompletion = (owner, signal) => {
				registrations++;
				assert.equal(owner, handle);
				assert.notEqual(signal, caller.signal);
				f.session.suppress(t.id);
				assert.equal(signal.aborted, true);
				throw new Error(ABORT);
			};
			const result = await f.session.supervise(
				handle,
				t,
				withCaller ? caller.signal : undefined,
			);
			assert.equal(result.outcome, "killed");
			assert.equal(result.handle, handle);
			assert.equal(result.error, ABORT);
			assert.equal(registrations, 1);
			assert.equal(f.adapter.launches.length, 1);
			assert.equal(caller.signal.aborted, false);
			assert.equal(getEventListeners(caller.signal, "abort").length, 0);
			assert.equal(sends, 0);
			assert.deepEqual(f.provider.closes, [handle.surfaceId]);
			retired(f, t);
		});
	}
	it("unsuppressed initial observation errors preserve the original error and recoverable ownership", async () => {
		const adapter = new CountingAdapter();
		const error = new Error("initial observation failed");
		let failObservation = true,
			sends = 0,
			closes = 0;
		const f = fixture({
			adapter,
			hooks: {
				onObserved: () => {
					if (failObservation) throw error;
				},
				onSettled: () => {
					sends++;
				},
			},
		});
		const t = routed();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					observe: (at) => observation("refresh", at),
					closeTemporarySurface: async () => {
						closes++;
					},
				}),
			}),
		);
		await assert.rejects(
			f.session.supervise(handle, t),
			(actual) => actual === error,
		);
		assert.equal(f.session.getHandle(t.id), handle);
		assert.equal(f.session.getTask(t.id), t);
		assert.equal(adapter.launches.length, 1);
		assert.equal(adapter.waits.length + sends + closes, 0);
		await f.session.send(t.id, "recover owner");
		assert.deepEqual(adapter.inputs(handle.id), ["recover owner"]);
		failObservation = false;
		const recovered = f.session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await recovered).outcome, "completed");
		assert.equal(adapter.launches.length, 1);
		assert.equal(adapter.waits.length, 1);
		assert.equal(sends, 1);
		assert.equal(closes, 1);
		retired(f, t);
	});
	for (const cleanup of ["ordinary", "managed", "retention-throw"] as const) {
		it(`initial observation suppress-then-throw retires immediately and preserves the original error (${cleanup})`, async () => {
			const adapter = new CountingAdapter();
			const error = new Error("initial observation failed after suppression");
			let rejoined: Promise<void> | undefined;
			let observed = 0,
				sends = 0,
				retentionCalls = 0;
			const f = fixture({
				adapter,
				retainSurface:
					cleanup === "retention-throw"
						? () => {
								retentionCalls++;
								throw new Error("custom retention failed");
							}
						: undefined,
				hooks: {
					onObserved: (owner) => {
						if (++observed !== 1) return;
						rejoined = assert.rejects(
							f.session.supervise(owner, t),
							(actual) => actual === error,
						);
						f.session.suppress(t.id);
						throw error;
					},
					onSettled: () => {
						sends++;
					},
				},
			});
			const t =
				cleanup === "managed"
					? task({ worktree: { branch: "retained" } })
					: routed();
			const handle = await f.session.spawn(
				t,
				prepared(adapter, {
					candidates:
						cleanup === "managed" ? candidates.slice(0, 1) : candidates,
					spawnAttempt: async (options) => ({
						handle: await adapter.spawn(options),
						adapter,
						observe: (at) => observation("refresh", at),
						closeTemporarySurface: async () => {
							const pane = handle.surfaceId;
							assert.ok(pane);
							await f.provider.closeSurface(pane);
						},
					}),
				}),
			);
			await assert.rejects(
				f.session.supervise(handle, t),
				(actual) => actual === error,
			);
			assert.ok(rejoined);
			await rejoined;
			assert.equal(adapter.launches.length, 1);
			assert.equal(adapter.waits.length, 0);
			assert.equal(sends, 0);
			assert.equal(retentionCalls, cleanup === "retention-throw" ? 1 : 0);
			const expectedCloses = cleanup === "ordinary" ? [handle.surfaceId] : [];
			assert.deepEqual(f.provider.closes, expectedCloses);
			retired(f, t);
			f.session.suppress(t.id);
			f.session.suppress(t.id);
			assert.deepEqual(f.provider.closes, expectedCloses);
			await assert.rejects(f.session.supervise(handle, t), /retired|consumed/);
			await assert.rejects(
				f.session.send(t.id, "not recoverable"),
				/retired|consumed/,
			);
			assert.deepEqual(adapter.sends, []);
			assert.equal(adapter.waits.length, 0);
		});
	}
	it("a startup observation error stays observable even when the callback cancels its caller", async () => {
		const adapter = new CountingAdapter();
		const caller = new AbortController();
		const error = new Error("observation cancelled caller then failed");
		const f = fixture({
			adapter,
			hooks: {
				onObserved: () => {
					caller.abort();
					throw error;
				},
			},
		});
		const t = routed();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					observe: (at) => observation("refresh", at),
				}),
			}),
		);
		await assert.rejects(
			f.session.supervise(handle, t, caller.signal),
			(actual) => actual === error,
		);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		assert.equal(f.session.getHandle(t.id), handle);
		assert.equal(adapter.launches.length, 1);
		assert.equal(adapter.waits.length, 0);
		assert.deepEqual(f.provider.closes, []);
		f.session.suppress(t.id);
	});
	it("initial observation reentry joins one producer and sees the same callback error before recovery", async () => {
		const adapter = new CountingAdapter();
		const error = new Error("observation after reentry");
		const rejected = deferred<Promise<void>>();
		let failObservation = true,
			reentered = false;
		const f = fixture({
			adapter,
			hooks: {
				onObserved: (owner) => {
					if (!failObservation || reentered) return;
					reentered = true;
					rejected.resolve(
						assert.rejects(
							f.session.supervise(owner, t),
							(actual) => actual === error,
						),
					);
					throw error;
				},
			},
		});
		const t = routed();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					observe: (at) => observation("refresh", at),
				}),
			}),
		);
		await assert.rejects(
			f.session.supervise(handle, t),
			(actual) => actual === error,
		);
		assert.equal(adapter.waits.length, 0);
		await rejected.promise;
		assert.equal(adapter.launches.length, 1);
		assert.equal(f.session.getHandle(t.id), handle);
		assert.deepEqual(f.provider.closes, []);
		failObservation = false;
		const recovered = f.session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await recovered).outcome, "completed");
		assert.equal(adapter.waits.length, 1);
		retired(f, t);
	});
	for (const suppress of [false, true]) {
		it(`initial observation reentry shares one producer (suppressed=${suppress})`, async () => {
			const adapter = new CountingAdapter();
			let rejoined: Promise<RunResult> | undefined;
			let observed = 0,
				sends = 0;
			const f = fixture({
				adapter,
				hooks: {
					onObserved: (owner) => {
						if (++observed !== 1) return;
						rejoined = f.session.supervise(owner, t);
						if (suppress) f.session.suppress(t.id);
					},
					onSettled: () => {
						sends++;
					},
				},
			});
			const t = task();
			const handle = await f.session.spawn(
				t,
				prepared(adapter, {
					candidates: [],
					spawnAttempt: async (options) => ({
						handle: await adapter.spawn(options),
						adapter,
						observe: (at) => observation("refresh", at),
					}),
				}),
			);
			const first = f.session.supervise(handle, t);
			assert.ok(rejoined);
			assert.equal(adapter.waits.length, 1);
			if (!suppress)
				adapter.complete(handle.id, { reason: "done", exitCode: 0 });
			const results = await Promise.all([first, rejoined]);
			assert.equal(results[0], results[1]);
			assert.equal(results[0].outcome, suppress ? "killed" : "completed");
			assert.equal(observed, 2);
			assert.equal(sends, suppress ? 0 : 1);
			assert.equal(adapter.waits.length, 1);
			assert.equal(adapter.unregistered, 1);
			retired(f, t);
		});
	}
	it("a joining observation error leaves the running producer and its other waiter intact", async () => {
		const adapter = new CountingAdapter();
		const error = new Error("joining observation failed");
		let observed = 0,
			sends = 0,
			closes = 0;
		const f = fixture({
			adapter,
			hooks: {
				onObserved: () => {
					if (++observed === 2) throw error;
				},
				onSettled: () => {
					sends++;
				},
			},
		});
		const t = routed();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					observe: (at) => observation("refresh", at),
					closeTemporarySurface: async () => {
						closes++;
					},
				}),
			}),
		);
		const first = f.session.supervise(handle, t);
		const caller = new AbortController();
		await assert.rejects(
			f.session.supervise(handle, t, caller.signal),
			(actual) => actual === error,
		);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		assert.equal(f.session.getHandle(t.id), handle);
		assert.equal(adapter.waits.length, 1);
		assert.equal(adapter.waits[0].signal.aborted, false);
		assert.equal(sends + closes, 0);
		const joined = f.session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		const results = await Promise.all([first, joined]);
		assert.equal(results[0], results[1]);
		assert.equal(results[0].outcome, "completed");
		assert.equal(adapter.launches.length, 1);
		assert.equal(adapter.waits.length, 1);
		assert.equal(sends, 1);
		assert.equal(closes, 1);
		retired(f, t);
	});
	it("publishes the shared producer before synchronous owning-adapter callbacks can rejoin", async () => {
		let sends = 0;
		const f = fixture({
			hooks: {
				onSettled: () => {
					sends++;
				},
			},
		});
		const t = task();
		const handle = await f.session.spawn(t);
		const owningWait = f.adapter.awaitCompletion.bind(f.adapter);
		let reentered = false;
		let rejoined: Promise<RunResult> | undefined;
		f.adapter.awaitCompletion = (owner, signal) => {
			if (!reentered) {
				reentered = true;
				rejoined = f.session.supervise(owner, t);
			}
			return owningWait(owner, signal);
		};
		const first = f.session.supervise(handle, t);
		await f.adapter.waitStarted.promise;
		assert.ok(rejoined);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		const results = await Promise.all([first, rejoined]);
		assert.equal(f.adapter.waits.length, 1);
		assert.equal(f.adapter.unregistered, 1);
		assert.equal(results[0], results[1]);
		assert.equal(sends, 1);
		assert.equal(f.provider.closes.length, 1);
	});
	it("terminal retirement drops custom adapter, task, metadata and owned signal even while close is pending", async () => {
		class AttemptAdapter extends FakeHarnessAdapter {
			override awaitCompletion(handle: AgentHandle, signal: AbortSignal) {
				signalRef = new WeakRef(signal);
				return super.awaitCompletion(handle, signal);
			}
		}
		class OwnedTask implements Task {
			id = "collectible";
			name = "writer";
			prompt = "work";
			role = "worker";
			cwd = "/source";
		}
		class Metadata {
			text = "owned metadata";
		}
		let signalRef: WeakRef<AbortSignal> | undefined;
		const close = deferred<void>();
		let closes = 0;
		const adapter = new CountingAdapter();
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			operations: {
				prepare: async () =>
					prepared(adapter, {
						candidates: [],
						spawnAttempt: async (options) => {
							const owner = new AttemptAdapter();
							const metadata = new Metadata();
							const handle = await owner.spawn(options);
							owner.complete(handle.id, { reason: "done", exitCode: 0 });
							return {
								handle,
								adapter: owner,
								finalize: async (result) => ({
									...result,
									output: metadata.text,
								}),
								closeTemporarySurface: () => {
									closes++;
									return close.promise;
								},
							};
						},
					}),
			},
		});
		const result = await (async () => {
			const t = new OwnedTask();
			const handle = await session.spawn(t);
			return session.supervise(handle, t);
		})();
		assert.equal(result.output, "owned metadata");
		assert.equal(closes, 1);
		assert.equal(session.getTask("collectible"), undefined);
		// A test-local event-loop boundary clears the engine's current-job weak
		// roots. queryObjects requests real collection; no sleep or runtime GC API.
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(queryObjects(AttemptAdapter), 0);
		assert.equal(queryObjects(OwnedTask), 0);
		assert.equal(queryObjects(Metadata), 0);
		assert.equal(signalRef?.deref(), undefined);
		close.reject(new Error("late authorized close"));
		await Promise.resolve();
		session.suppress("collectible");
		assert.equal(closes, 1);
		await assert.rejects(
			session.spawn(task({ id: "collectible" })),
			/collectible/,
		);
	});
	it("controls follow a different owning adapter after retry, not the construction adapter", async () => {
		const original = new CountingAdapter();
		const replacement = new CountingAdapter();
		const acquired = deferred<AgentHandle>();
		const f = fixture({
			adapter: original,
			hooks: {
				onSpawned: (handle) => {
					if (replacement.launches.length) acquired.resolve(handle);
				},
			},
		});
		const t = routed();
		const first = await f.session.spawn(
			t,
			prepared(original, {
				candidates: candidates.slice(0, 2),
				spawnAttempt: async (options, index) => {
					const adapter = index === 0 ? original : replacement;
					return { handle: await adapter.spawn(options), adapter };
				},
			}),
		);
		const wait = f.session.supervise(first, t);
		original.fail(first.id, "try next owner");
		const second = await acquired.promise;
		await assert.rejects(f.session.supervise(first, t), /handle|owner|match/);
		await f.session.send(t.id, "replacement input");
		await f.session.interrupt(t.id);
		await f.session.kill(t.id);
		assert.equal((await wait).outcome, "failed");
		assert.deepEqual(original.sends, []);
		assert.deepEqual(original.interrupts, []);
		assert.deepEqual(original.kills, []);
		assert.deepEqual(replacement.inputs(second.id), ["replacement input"]);
		assert.deepEqual(replacement.interrupts, [second.id]);
		assert.deepEqual(replacement.kills, [second.id]);
		assert.equal(replacement.waits.length, 1);
	});
	it("suppression while a running fallback hook rejects still retires and cleans without delivering", async () => {
		const adapter = new CountingAdapter();
		const hook = deferred<void>();
		const acquired = deferred<void>();
		let spawned = 0,
			settled = 0,
			closes = 0;
		const f = fixture({
			adapter,
			hooks: {
				onSpawned: () => {
					spawned++;
					if (spawned === 2) {
						acquired.resolve();
						return hook.promise;
					}
				},
				onSettled: () => {
					settled++;
				},
			},
		});
		const t = routed();
		const first = await f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					closeTemporarySurface: async () => {
						closes++;
					},
				}),
			}),
		);
		const wait = f.session.supervise(first, t);
		adapter.fail(first.id, "actual evidence wins");
		await acquired.promise;
		f.session.suppress(t.id);
		hook.reject(new Error("post-acquisition hook failed"));
		const result = await wait;
		assert.equal(result.outcome, "failed");
		assert.equal(result.evidence?.errorMessage, "actual evidence wins");
		assert.equal(settled, 0);
		assert.equal(spawned, 2);
		assert.equal(adapter.waits.length, 1);
		assert.equal(closes, 2);
		retired(f, t);
	});
	it("suppressed in-flight launch rejection stops fallbacks and releases a never-acquired reservation", async () => {
		const adapter = new CountingAdapter();
		const launch = deferred<OwnedRunAttempt>();
		const entered = deferred<void>();
		let acquisitions = 0;
		const f = fixture({ adapter });
		const t = routed();
		const pending = f.session.spawn(
			t,
			prepared(adapter, {
				spawnAttempt: () => {
					acquisitions++;
					entered.resolve();
					return launch.promise;
				},
			}),
		);
		const rejected = assert.rejects(pending, { message: ABORT });
		await entered.promise;
		f.session.suppress(t.id);
		launch.reject(new Error("launch error"));
		await rejected;
		assert.equal(acquisitions, 1);
		assert.equal(adapter.launches.length, 0);
		await f.session.spawn(t);
		f.session.suppress(t.id);
	});
	it("suppressed pending resume captures its eventual real owner without a fabricated acknowledgement", async () => {
		const adapter = new CountingAdapter();
		const resume = deferred<OwnedRunAttempt>();
		let closes = 0,
			hooks = 0;
		const f = fixture({
			adapter,
			operations: {
				prepare: async () => prepared(adapter),
				resume: () => resume.promise,
			},
			hooks: {
				onSpawned: () => {
					hooks++;
				},
			},
		});
		const t = task();
		const pending = f.session.resume({
			task: t,
			name: "resume",
			sessionId: "saved",
		});
		const rejected = assert.rejects(pending, { message: ABORT });
		f.session.suppress(t.id);
		assert.equal(f.session.getHandle(t.id), undefined);
		const handle = await adapter.resume({
			name: "actual resume",
			sessionId: "saved",
		});
		resume.resolve({
			handle,
			adapter,
			closeTemporarySurface: async () => {
				closes++;
			},
		});
		await rejected;
		assert.equal(closes, 1);
		assert.equal(hooks, 0);
		retired(f, t);
		await assert.rejects(
			f.session.resume({ task: t, name: "again", sessionId: "saved" }),
			/logical/,
		);
	});
	it("an acquired managed hook failure remains recoverable without automatic close or fallback", async () => {
		const error = new Error("managed onSpawned");
		let settled = 0;
		const f = fixture({
			hooks: {
				onSpawned: () => {
					throw error;
				},
				onSettled: () => {
					settled++;
				},
			},
		});
		const t = task({ worktree: { branch: "managed" } });
		await assert.rejects(f.session.spawn(t), (actual) => actual === error);
		const handle = f.session.getHandle(t.id);
		assert.ok(handle);
		assert.equal(f.session.getTask(t.id), t);
		assert.equal(f.adapter.launches.length, 1);
		assert.equal(settled, 0);
		assert.deepEqual(f.provider.closes, []);
		const wait = f.session.supervise(handle, t);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await wait;
		assert.equal(settled, 1);
		assert.deepEqual(f.provider.closes, []);
		retired(f, t);
	});
	it("completion resolved before owned abort retains its evidence and skips the undelivered send", async () => {
		let sends = 0;
		const f = fixture({
			hooks: {
				onSettled: () => {
					sends++;
				},
			},
		});
		const t = task();
		const handle = await f.session.spawn(t);
		const wait = f.session.supervise(handle, t);
		f.adapter.complete(handle.id, { reason: "sentinel", exitCode: 0 });
		f.session.suppress(t.id);
		assert.equal((await wait).outcome, "completed");
		assert.equal(sends, 0);
		assert.equal(f.provider.closes.length, 1);
	});
	it("persistent task/help activity and coarse idle are not process-completion evidence", async () => {
		const adapter = new CountingAdapter();
		let settled = 0;
		let observed = 0;
		let event: "subagent_done" | "caller_ping" = "subagent_done";
		const f = fixture({
			adapter,
			roles: [{ ...role, defaults: { persistent: true } }],
			hooks: {
				onObserved: () => {
					observed++;
				},
				onSettled: () => {
					settled++;
				},
			},
		});
		const t = task();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				persistent: true,
				candidates: [],
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					closeTemporarySurface: async () => {
						const pane = handle.surfaceId;
						assert.ok(pane);
						await f.provider.closeSurface(pane);
					},
					observe: (at) => {
						const observed = observation("local-evidence", at);
						observed.activity = {
							version: 1,
							runningChildId: t.id,
							createdAt: 1,
							updatedAt: at,
							sequence: 2,
							latestEvent: event,
							phase: "waiting",
							agentActive: false,
							turnActive: false,
							providerActive: false,
							toolActive: false,
						};
						return observed;
					},
				}),
			}),
		);
		const wait = f.session.supervise(handle, t);
		await adapter.waitStarted.promise;
		event = "caller_ping";
		assert.equal(f.session.observe(t.id)?.activity?.latestEvent, "caller_ping");
		await f.session.interrupt(t.id);
		await f.session.send(t.id, "next task");
		assert.equal(observed, 2);
		assert.equal(settled, 0);
		assert.equal(adapter.unregistered, 0);
		assert.equal(adapter.states, 0);
		assert.equal(f.session.getHandle(t.id), handle);
		assert.deepEqual(f.provider.closes, []);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await wait).outcome, "completed");
		assert.equal(settled, 1);
		assert.equal(f.provider.closes.length, 1);
	});
	it("catches a synchronous custom-owner release throw, not only an async default-wrapper rejection", async () => {
		const adapter = new CountingAdapter();
		let closes = 0,
			sends = 0;
		const f = fixture({
			adapter,
			hooks: {
				onSettled: () => {
					sends++;
				},
			},
		});
		const t = task();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				candidates: [],
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					closeTemporarySurface: () => {
						closes++;
						throw new Error("synchronous owner close failure");
					},
				}),
			}),
		);
		const wait = f.session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await wait).outcome, "completed");
		retired(f, t);
		f.session.suppress(t.id);
		assert.equal(closes, 1);
		assert.equal(sends, 1);
	});
	it("custom retention sees finalized output only after accepted delivery", async () => {
		const adapter = new CountingAdapter();
		const gate = deferred<void>();
		const entered = deferred<void>();
		let retentionCalls = 0,
			closes = 0;
		const f = fixture({
			adapter,
			retainSurface: (result, actualTask) => {
				retentionCalls++;
				assert.equal(actualTask.id, "logical");
				assert.equal(result.output, "final transcript");
				return true;
			},
			hooks: {
				onSettled: () => {
					entered.resolve();
					return gate.promise;
				},
			},
		});
		const t = task();
		const handle = await f.session.spawn(
			t,
			prepared(adapter, {
				candidates: [],
				spawnAttempt: async (options) => ({
					handle: await adapter.spawn(options),
					adapter,
					finalize: async (result) => ({
						...result,
						output: "final transcript",
					}),
					closeTemporarySurface: async () => {
						closes++;
					},
				}),
			}),
		);
		const wait = f.session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await entered.promise;
		assert.equal(retentionCalls, 0);
		gate.resolve();
		await wait;
		assert.equal(retentionCalls, 1);
		assert.equal(closes, 0);
		retired(f, t);
	});
});
