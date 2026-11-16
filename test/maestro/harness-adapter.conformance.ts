import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import type {
	HarnessAdapter,
	SpawnOptions,
} from "@nubl/maestro/core/harness-adapter";
import type {
	AgentHandle,
	AgentState,
	Worktree,
} from "@nubl/maestro/core/types";

interface TestRunner {
	describe: typeof nodeDescribe;
	it: typeof nodeIt;
}

export interface HarnessAdapterFixture {
	adapter: HarnessAdapter;
	/** Fake fixtures retain the tight default; real process fixtures choose a bounded budget. */
	waitTimeoutMs?: number;
	/** Raw provider errors need not contain the literal word "error". */
	errorMessagePattern?: RegExp;
	/** Explicit saved-session policy expectation, not an arbitrary rejection allowance. */
	managedSessionResume?:
		| { kind: "refused"; message: RegExp }
		| { kind: "detached" };
	spawnOptions(): SpawnOptions;
	finish(handle: AgentHandle, kind: "done" | "ping" | "error"): Promise<void>;
	/** Optional implementation-specific simulation of delayed sidecar evidence after pane absence. */
	lateSidecar?(handle: AgentHandle): Promise<void>;
	/** Optional hook for implementations that need provider-specific worktree setup before spawn. */
	worktreeSpawnOptions?(base: SpawnOptions): Promise<SpawnOptions>;
	dispose(): Promise<void>;
}

const VALID_STATES = new Set<AgentState>([
	"idle",
	"working",
	"blocked",
	"done",
	"unknown",
]);
const WAIT_TIMEOUT_MS = 500;

export function registerHarnessAdapterConformance(
	runner: TestRunner,
	name: string,
	factory: () => Promise<HarnessAdapterFixture>,
): void {
	runner.describe(`${name} HarnessAdapter conformance`, () => {
		runner.it(
			"spawn returns a handle whose harness equals adapter.name and startedAt is recent",
			async () => {
				await usingFixture(factory, async ({ adapter, spawnOptions }) => {
					const before = Date.now();
					const handle = await adapter.spawn(spawnOptions());
					const after = Date.now();

					assert.equal(handle.harness, adapter.name);
					assert.equal(handle.startedAt >= before, true);
					assert.equal(handle.startedAt <= after, true);
					assert.ok(handle.id.length > 0);
				});
			},
		);

		runner.it(
			"getState never throws and returns one of the five states",
			async () => {
				await usingFixture(factory, async ({ adapter, spawnOptions }) => {
					const handle = await adapter.spawn(spawnOptions());
					const state = await adapter.getState(handle);
					assert.equal(VALID_STATES.has(state), true);
				});
			},
		);

		runner.it("awaitCompletion resolves done evidence", async () => {
			await usingFixture(
				factory,
				async ({ adapter, spawnOptions, finish, waitTimeoutMs }) => {
					const handle = await adapter.spawn(spawnOptions());
					const wait = adapter.awaitCompletion(
						handle,
						new AbortController().signal,
					);
					await finish(handle, "done");
					const evidence = await withTimeout(wait, waitTimeoutMs);

					assert.equal(evidence.reason, "done");
					assert.equal(evidence.exitCode, 0);
				},
			);
		});

		runner.it(
			"awaitCompletion resolves ping evidence with name and message",
			async () => {
				await usingFixture(
					factory,
					async ({ adapter, spawnOptions, finish, waitTimeoutMs }) => {
						const handle = await adapter.spawn(spawnOptions());
						const wait = adapter.awaitCompletion(
							handle,
							new AbortController().signal,
						);
						await finish(handle, "ping");
						const evidence = await withTimeout(wait, waitTimeoutMs);

						assert.equal(evidence.reason, "ping");
						assert.equal(evidence.exitCode, 0);
						assert.equal(evidence.ping?.name, handle.name);
						assert.ok(evidence.ping?.message);
					},
				);
			},
		);

		runner.it(
			"awaitCompletion resolves error evidence with errorMessage",
			async () => {
				await usingFixture(
					factory,
					async ({
						adapter,
						spawnOptions,
						finish,
						waitTimeoutMs,
						errorMessagePattern,
					}) => {
						const handle = await adapter.spawn(spawnOptions());
						const wait = adapter.awaitCompletion(
							handle,
							new AbortController().signal,
						);
						await finish(handle, "error");
						const evidence = await withTimeout(wait, waitTimeoutMs);

						assert.equal(evidence.reason, "error");
						assert.equal(evidence.exitCode, 1);
						assert.match(
							evidence.errorMessage ?? "",
							errorMessagePattern ?? /error/i,
						);
					},
				);
			},
		);

		runner.it("awaitCompletion rejects when the signal aborts", async () => {
			await usingFixture(
				factory,
				async ({ adapter, spawnOptions, waitTimeoutMs }) => {
					const handle = await adapter.spawn(spawnOptions());
					const controller = new AbortController();
					const wait = adapter.awaitCompletion(handle, controller.signal);
					setTimeout(() => controller.abort(), 50);
					await assert.rejects(withTimeout(wait, waitTimeoutMs), /abort/i);
				},
			);
		});

		runner.it("interrupt leaves getState not done", async () => {
			await usingFixture(factory, async ({ adapter, spawnOptions }) => {
				const handle = await adapter.spawn(spawnOptions());
				await adapter.interrupt(handle);
				assert.notEqual(await adapter.getState(handle), "done");
			});
		});

		runner.it("kill then getState returns done or unknown", async () => {
			await usingFixture(factory, async ({ adapter, spawnOptions }) => {
				const handle = await adapter.spawn(spawnOptions());
				await adapter.kill(handle);
				assert.match(await adapter.getState(handle), /^(done|unknown)$/);
			});
		});

		runner.it(
			"resume of a known session returns a new handle with the same sessionId",
			async () => {
				await usingFixture(
					factory,
					async ({ adapter, spawnOptions, finish, waitTimeoutMs }) => {
						const original = await adapter.spawn(spawnOptions());
						await finish(original, "done");
						await withTimeout(
							adapter.awaitCompletion(original, new AbortController().signal),
							waitTimeoutMs,
						);
						const resumed = await adapter.resume({
							name: `${original.name}-resumed`,
							sessionId: original.sessionId,
							message: "continue",
						});

						assert.notEqual(resumed.id, original.id);
						assert.equal(resumed.sessionId, original.sessionId);
						assert.equal(resumed.name, `${original.name}-resumed`);
					},
				);
			},
		);

		runner.it(
			"late sidecar after pane absence resolves done when supported",
			async (t) => {
				await usingFixture(factory, async (fixture) => {
					if (!fixture.lateSidecar) {
						t.skip(
							"late sidecar after pane absence is implementation-specific and unsupported by this fixture",
						);
						return;
					}
					const handle = await fixture.adapter.spawn(fixture.spawnOptions());
					const wait = fixture.adapter.awaitCompletion(
						handle,
						new AbortController().signal,
					);
					await fixture.lateSidecar(handle);
					const evidence = await withTimeout(wait, fixture.waitTimeoutMs);

					assert.equal(evidence.reason, "done");
					assert.equal(evidence.exitCode, 0);
				});
			},
		);

		runner.it(
			"resume honors the fixture's explicit managed-session policy",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const baseOptions = fixture.spawnOptions();
					const options = fixture.worktreeSpawnOptions
						? await fixture.worktreeSpawnOptions(baseOptions)
						: withProvisionedWorktree(baseOptions);
					const original = await fixture.adapter.spawn(options);
					assert.ok(original.worktree, "original handle must own a worktree");

					await fixture.finish(original, "done");
					await withTimeout(
						fixture.adapter.awaitCompletion(
							original,
							new AbortController().signal,
						),
						fixture.waitTimeoutMs,
					);
					const request = {
						name: `${original.name}-resume-no-worktree`,
						sessionId: original.sessionId,
					};
					if (fixture.managedSessionResume?.kind === "refused") {
						await assert.rejects(
							fixture.adapter.resume(request),
							fixture.managedSessionResume.message,
						);
						return;
					}
					const resumed = await fixture.adapter.resume(request);

					assert.equal(resumed.sessionId, original.sessionId);
					assert.equal(resumed.worktree, undefined);
				});
			},
		);
	});
}

async function usingFixture(
	factory: () => Promise<HarnessAdapterFixture>,
	test: (fixture: HarnessAdapterFixture) => Promise<void>,
) {
	const fixture = await factory();
	try {
		await test(fixture);
	} finally {
		await fixture.dispose();
	}
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

function withProvisionedWorktree(options: SpawnOptions): SpawnOptions {
	const worktree: Worktree = {
		id: `${options.sessionId}-worktree-owner`,
		owner: "maestro",
		branch: "conformance-worktree",
		baseRef: "HEAD",
		baseSha: "0000000000000000000000000000000000000000",
		createdAt: Date.now(),
		path: `${options.cwd}/.fake-worktrees/conformance-worktree`,
		state: "running",
		manifestFile: `${options.cwd}/.fake-worktrees/conformance-worktree/.maestro.json`,
	};
	return {
		...options,
		worktree,
		worktreeRequest: { branch: worktree.branch, base: worktree.baseRef },
	};
}
