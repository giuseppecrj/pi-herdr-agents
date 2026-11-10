import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import type { SpawnOptions } from "../../maestro/core/harness-adapter.ts";
import type { AgentHandle } from "../../maestro/core/types.ts";
import { registerHarnessAdapterConformance } from "./harness-adapter.conformance.ts";

const WAIT_TIMEOUT_MS = 250;

registerHarnessAdapterConformance(
	{ describe, it },
	"FakeHarnessAdapter",
	async () => {
		const adapter = new FakeHarnessAdapter();
		return {
			adapter,
			managedSessionResume: { kind: "detached" },
			spawnOptions,
			async finish(handle: AgentHandle, kind: "done" | "ping" | "error") {
				if (kind === "done") {
					adapter.complete(handle.id, {
						reason: "done",
						exitCode: 0,
						sessionRef: handle.sessionId,
					});
					return;
				}
				if (kind === "ping") {
					adapter.ping(handle.id, `message from ${handle.name}`);
					return;
				}
				adapter.fail(handle.id, "provider error");
			},
			async dispose() {},
		};
	},
);

describe("FakeHarnessAdapter controls", () => {
	it("records spawn requests, state, output, and inputs in memory", async () => {
		const adapter = new FakeHarnessAdapter();
		const options = spawnOptions();
		const handle = await adapter.spawn({
			...options,
			worktreeRequest: { branch: "feature/fake", base: "HEAD" },
		});

		await adapter.sendInput(handle, "follow-up one");
		adapter.appendOutput(handle.id, "line one\nline two\nline three");

		assert.deepEqual(adapter.spawned(), [handle]);
		assert.deepEqual(adapter.inputs(handle.id), ["follow-up one"]);
		assert.equal(await adapter.readOutput(handle, 2), "line two\nline three");
		const request = adapter.request(handle.id);
		assert.ok(request && "worktreeRequest" in request);
		assert.deepEqual(request.worktreeRequest, {
			branch: "feature/fake",
			base: "HEAD",
		});
		assert.equal(await adapter.getState(handle), "working");
	});

	it("completion before waiter registration resolves with evidence and exitCode", async () => {
		const adapter = new FakeHarnessAdapter();
		const handle = await adapter.spawn(spawnOptions());
		adapter.complete(handle.id, {
			reason: "done",
			exitCode: 0,
			finalMessage: { text: "done before wait" },
		});

		const evidence = await adapter.awaitCompletion(
			handle,
			new AbortController().signal,
		);
		assert.deepEqual(evidence, {
			reason: "done",
			exitCode: 0,
			finalMessage: { text: "done before wait" },
			sessionRef: handle.sessionId,
		});
		assert.equal(adapter.exitCode(handle), 0);
	});

	it("already-aborted signal rejects with the completion abort message", async () => {
		const adapter = new FakeHarnessAdapter();
		const handle = await adapter.spawn(spawnOptions());
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			adapter.awaitCompletion(handle, controller.signal),
			/Aborted while waiting for subagent to finish/,
		);
	});

	it("removes abort listeners after completion", async () => {
		const adapter = new FakeHarnessAdapter();
		const handle = await adapter.spawn(spawnOptions());
		const controller = new AbortController();

		const wait = adapter.awaitCompletion(handle, controller.signal);
		assert.equal(getAbortListenerCount(controller.signal), 1);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await withTimeout(wait);
		assert.equal(getAbortListenerCount(controller.signal), 0);
	});

	it("one waiter aborts while another remains pending and then completes", async () => {
		const adapter = new FakeHarnessAdapter();
		const handle = await adapter.spawn(spawnOptions());
		const abortedController = new AbortController();
		const pendingController = new AbortController();
		const abortedWait = adapter.awaitCompletion(
			handle,
			abortedController.signal,
		);
		const pendingWait = adapter.awaitCompletion(
			handle,
			pendingController.signal,
		);

		assert.equal(getAbortListenerCount(abortedController.signal), 1);
		assert.equal(getAbortListenerCount(pendingController.signal), 1);
		abortedController.abort();
		await assert.rejects(withTimeout(abortedWait), /abort/i);
		assert.equal(getAbortListenerCount(abortedController.signal), 0);
		assert.equal(getAbortListenerCount(pendingController.signal), 1);

		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await withTimeout(pendingWait)).reason, "done");
		assert.equal(getAbortListenerCount(pendingController.signal), 0);
	});

	it("resolves multiple concurrent waiters and isolates other handles", async () => {
		const adapter = new FakeHarnessAdapter();
		const first = await adapter.spawn({ ...spawnOptions(), name: "first" });
		const second = await adapter.spawn({ ...spawnOptions(), name: "second" });
		const firstWaitA = adapter.awaitCompletion(
			first,
			new AbortController().signal,
		);
		const firstWaitB = adapter.awaitCompletion(
			first,
			new AbortController().signal,
		);
		const secondWait = adapter.awaitCompletion(
			second,
			new AbortController().signal,
		);

		adapter.ping(first.id, "need help");
		const firstEvidence = await withTimeout(
			Promise.all([firstWaitA, firstWaitB]),
		);
		assert.deepEqual(
			firstEvidence.map((evidence) => evidence.reason),
			["ping", "ping"],
		);

		adapter.complete(second.id, { reason: "done", exitCode: 0 });
		assert.equal((await withTimeout(secondWait)).reason, "done");
	});

	it("fail resolves error evidence rather than rejecting", async () => {
		const adapter = new FakeHarnessAdapter();
		const handle = await adapter.spawn(spawnOptions());
		const wait = adapter.awaitCompletion(handle, new AbortController().signal);

		adapter.fail(handle.id, "provider exploded");

		await assert.doesNotReject(withTimeout(wait));
		assert.deepEqual(
			await adapter.awaitCompletion(handle, new AbortController().signal),
			{
				reason: "error",
				exitCode: 1,
				errorMessage: "provider exploded",
				sessionRef: handle.sessionId,
			},
		);
	});

	it("kill settles waiters with nonzero evidence and preserves session resumability", async () => {
		const adapter = new FakeHarnessAdapter();
		const handle = await adapter.spawn({
			...spawnOptions(),
			sessionId: "session-kill",
		});
		const firstWait = adapter.awaitCompletion(
			handle,
			new AbortController().signal,
		);
		const secondWait = adapter.awaitCompletion(
			handle,
			new AbortController().signal,
		);

		await adapter.kill(handle);

		const expectedEvidence = {
			reason: "error" as const,
			exitCode: 143,
			errorMessage: "terminated by kill",
			sessionRef: handle.sessionId,
		};
		assert.equal(await adapter.getState(handle), "done");
		assert.deepEqual(await withTimeout(firstWait), expectedEvidence);
		assert.deepEqual(await withTimeout(secondWait), expectedEvidence);
		assert.deepEqual(
			await adapter.awaitCompletion(handle, new AbortController().signal),
			expectedEvidence,
		);
		assert.equal(adapter.exitCode(handle), 143);

		const resumed = await adapter.resume({
			name: "resumed-after-kill",
			sessionId: handle.sessionId,
			message: "continue",
		});
		assert.equal(resumed.sessionId, handle.sessionId);
		assert.notEqual(resumed.id, handle.id);
		assert.equal(await adapter.getState(resumed), "working");
		await adapter.sendInput(resumed, "resumed input");
		assert.deepEqual(adapter.inputs(resumed.id), ["continue", "resumed input"]);
		assert.equal(await adapter.getState(handle), "done");
	});

	it("interrupt preserves resumability while kill does not invalidate shared session handles", async () => {
		const adapter = new FakeHarnessAdapter();
		const interrupted = await adapter.spawn({
			...spawnOptions(),
			sessionId: "session-interrupt",
		});
		await adapter.interrupt(interrupted);
		assert.notEqual(await adapter.getState(interrupted), "done");
		const resumed = await adapter.resume({
			name: "resumed-after-interrupt",
			sessionId: interrupted.sessionId,
		});
		assert.equal(resumed.sessionId, interrupted.sessionId);
		assert.notEqual(resumed.id, interrupted.id);

		const first = await adapter.spawn({
			...spawnOptions(),
			sessionId: "session-shared",
			name: "shared-first",
		});
		const second = await adapter.spawn({
			...spawnOptions(),
			sessionId: first.sessionId,
			name: "shared-second",
		});
		await adapter.kill(first);
		assert.equal(await adapter.getState(first), "done");
		assert.equal(await adapter.getState(second), "working");
		const resumedAfterKill = await adapter.resume({
			name: "resume-shared-after-kill",
			sessionId: first.sessionId,
		});
		assert.equal(resumedAfterKill.sessionId, first.sessionId);
	});

	it("keeps the first terminal evidence and exitCode after duplicate completions", async () => {
		const adapter = new FakeHarnessAdapter();
		const done = await adapter.spawn({ ...spawnOptions(), name: "first-done" });
		const error = await adapter.spawn({
			...spawnOptions(),
			name: "first-error",
		});
		const ping = await adapter.spawn({ ...spawnOptions(), name: "first-ping" });

		adapter.complete(done.id, {
			reason: "done",
			exitCode: 0,
			finalMessage: { text: "first done" },
		});
		adapter.fail(done.id, "second error");
		adapter.ping(done.id, "third ping");
		assert.deepEqual(
			await adapter.awaitCompletion(done, new AbortController().signal),
			{
				reason: "done",
				exitCode: 0,
				finalMessage: { text: "first done" },
				sessionRef: done.sessionId,
			},
		);
		assert.equal(adapter.exitCode(done), 0);

		adapter.fail(error.id, "first error");
		adapter.complete(error.id, { reason: "done", exitCode: 0 });
		adapter.ping(error.id, "third ping");
		assert.deepEqual(
			await adapter.awaitCompletion(error, new AbortController().signal),
			{
				reason: "error",
				exitCode: 1,
				errorMessage: "first error",
				sessionRef: error.sessionId,
			},
		);
		assert.equal(adapter.exitCode(error), 1);

		adapter.ping(ping.id, "first ping");
		adapter.complete(ping.id, { reason: "done", exitCode: 0 });
		adapter.fail(ping.id, "third error");
		assert.deepEqual(
			await adapter.awaitCompletion(ping, new AbortController().signal),
			{
				reason: "ping",
				exitCode: 0,
				ping: { name: ping.name, message: "first ping" },
				sessionRef: ping.sessionId,
			},
		);
		assert.equal(adapter.exitCode(ping), 0);
	});

	it("can script delayed completion without filesystem sidecar persistence", async () => {
		const adapter = new FakeHarnessAdapter();
		const handle = await adapter.spawn(spawnOptions());
		const wait = adapter.awaitCompletion(handle, new AbortController().signal);

		setTimeout(
			() => adapter.complete(handle.id, { reason: "done", exitCode: 0 }),
			10,
		);

		assert.equal((await withTimeout(wait)).reason, "done");
	});
});

function spawnOptions(): SpawnOptions {
	return {
		name: "fake-agent",
		task: "complete the fake task",
		role: {
			name: "worker",
			version: "1.0.0",
			description: "test worker",
			systemPrompt: "You are a test worker.",
			allowedTools: [],
		},
		cwd: "/tmp/fake-harness",
		sessionId: `session-${Math.random().toString(36).slice(2)}`,
	};
}

function getAbortListenerCount(signal: AbortSignal): number {
	return getEventListeners(signal, "abort").length;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
