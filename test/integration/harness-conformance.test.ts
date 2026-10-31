import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmdirSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { PiHarnessAdapter } from "../../maestro/adapters/pi/pi-harness-adapter.ts";
import {
	isExpectedPiProcess,
	launchOperationsFromSurface,
} from "../../maestro/adapters/pi/launch-operations.ts";
import { createWorktreeOperations } from "../../maestro/runtime/worktree-operations.ts";
import type { SpawnOptions } from "../../maestro/core/harness-adapter.ts";
import {
	WorktreeProvisioningError,
	type CreateWorktreeSurfaceOptions,
} from "../../maestro/core/surface-provider.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import { readSubagentActivityFile } from "../../maestro/adapters/pi/activity-file.ts";
import { getProviderRequests } from "./fake-provider.ts";
import { getNewEntries } from "../../maestro/adapters/pi/session.ts";
import {
	registerHarnessAdapterConformance,
	type HarnessAdapterFixture,
} from "../maestro/harness-adapter.conformance.ts";
import {
	cleanupTestEnv,
	createTestEnv,
	getAvailableBackends,
	runInPane,
	sleep,
	TEST_MODEL,
	USE_TEST_PROVIDER,
	type TestEnv,
} from "./harness.ts";

const paneConfig = {
	mode: "grouped",
	direction: "right",
	maxPerTab: 4,
} as const;
const WAIT_MS = 15_000;

async function until(
	check: () => boolean | Promise<boolean>,
	label: string,
): Promise<void> {
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(25);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function fixture(
	beforeSetup?: (env: TestEnv) => void,
): Promise<HarnessAdapterFixture & { adapter: PiHarnessAdapter }> {
	assert.equal(
		USE_TEST_PROVIDER,
		true,
		"This conformance fixture is deterministic-only",
	);
	assert.ok(
		getAvailableBackends().length,
		"HERDR_ENV=1 and herdr are required; no skips",
	);
	const env = createTestEnv("herdr");
	const ownedWorkspaces = new Set<string>();
	const ownedBuckets = new Set<string>();
	const absenceObservers = new Map<string, () => void>();
	const wake = new FileWakeRegistry();
	class TrackedProvider extends HerdrSurfaceProvider {
		override async createWorktreeSurface(opts: CreateWorktreeSurfaceOptions) {
			try {
				const result = await super.createWorktreeSurface(opts);
				ownedWorkspaces.add(result.workspaceId);
				ownedBuckets.add(dirname(result.path));
				return result;
			} catch (error) {
				if (
					error instanceof WorktreeProvisioningError &&
					error.recoveredWorktree.branch === opts.branch &&
					error.recoveredWorktree.workspaceId
				) {
					ownedWorkspaces.add(error.recoveredWorktree.workspaceId);
					ownedBuckets.add(dirname(error.recoveredWorktree.path));
				}
				throw error;
			}
		}
	}
	const surface = new TrackedProvider({ paneConfig });
	const supervision = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: (await surface.listSurfaces()).map((s) => ({
				paneId: s.id,
				workspaceId: s.workspaceId ?? "",
			})),
		}),
		(id) => surface.inspectSurface(id),
		false,
		wake,
	);
	async function dispose() {
		supervision.close();
		wake.close();
		try {
			for (const id of ownedWorkspaces) {
				await surface.removeWorktreeSurface(id);
				console.log(`Disposed current-test-owned worktree workspace ${id}`);
			}
			for (const bucket of ownedBuckets) {
				// Herdr leaves an empty source bucket after worktree removal. Never recurse or remove a shared/nonempty bucket.
				if (basename(bucket) === basename(env.dir) && existsSync(bucket)) {
					rmdirSync(bucket);
					console.log(`Disposed empty current-test-owned bucket ${bucket}`);
				}
			}
		} finally {
			await cleanupTestEnv(env);
			console.log(
				`Disposed current-test-owned fixture ${env.workspaceId} ${env.dir}`,
			);
		}
	}
	try {
		beforeSetup?.(env);
		// The shared deterministic provider's generic ping branch is not one-shot.
		// Withdraw only the test child's ping tool after its real tool result so Pi can settle.
		writeFileSync(
			join(env.dir, ".pi", "agent", "extensions", "one-shot-ping.ts"),
			`export default function(pi) {
 pi.on("tool_result", (event) => {
  if (event.toolName === "caller_ping") pi.setActiveTools(pi.getActiveTools().filter(name => name !== "caller_ping"));
 });
}\n`,
		);
		const sessionDir = join(env.dir, "parent-sessions");
		mkdirSync(sessionDir);
		const sessionFile = join(sessionDir, "parent.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "parent",
				timestamp: new Date().toISOString(),
				cwd: env.dir,
			}) + "\n",
		);
		const adapter = new PiHarnessAdapter({
			worktreeOperations: createWorktreeOperations(),
			surface,
			paneConfig,
			wake,
			supervision,
			parent: {
				cwd: env.dir,
				sessionDir,
				sessionFile,
				sessionId: "parent",
				agentDir: join(env.dir, ".pi", "agent"),
			},
			parentRuntime: {
				provider: "pi-integration",
				modelId: "test",
				thinking: "off",
			},
			modelRegistry: {
				find: (provider, id) =>
					provider === "pi-integration"
						? { provider, id, reasoning: true }
						: undefined,
				available: () => [
					{ provider: "pi-integration", id: "test", reasoning: true },
				],
				hasConfiguredAuth: () => true,
				supportedThinkingLevels: () => [
					"off",
					"minimal",
					"low",
					"medium",
					"high",
				],
				clampThinkingLevel: (_model, level) => level,
			},
			onObservation(child) {
				if (child.lifecycle.pane.kind === "missing")
					absenceObservers.get(child.id)?.();
			},
		});
		const gates = new Map<string, string>();
		return {
			adapter,
			waitTimeoutMs: WAIT_MS,
			errorMessagePattern:
				/400:.*account-rejected.*not supported when using this account/,
			managedSessionResume: {
				kind: "refused",
				message:
					/Cannot resume managed-worktree session through subagent_resume.*retained managed-worktree workspace/,
			},
			spawnOptions(): SpawnOptions {
				const gate = join(env.dir, `gate-${randomUUID()}`);
				const name = `conformance-${randomUUID()}`;
				gates.set(name, gate);
				return {
					name,
					task: `INTEGRATION_WAIT_FOR_FILE: ${gate}\nReturn exactly CONFORMANCE_DONE`,
					cwd: env.dir,
					sessionId: randomUUID(),
					role: {
						name: "test-echo",
						version: "1",
						description: "conformance",
						systemPrompt: "Follow the bounded task.",
						allowedTools: ["read"],
						defaults: { autoExit: true, spawning: false },
					},
					runtime: { model: TEST_MODEL, thinking: "off" },
				};
			},
			async finish(handle, kind) {
				const child = adapter.getRunningChild(handle);
				await launchOperationsFromSurface(surface, paneConfig).waitForPiReady!(
					child.surface,
					child.sessionFile,
					handle.cwd,
				);
				if (kind === "done") writeFileSync(gates.get(handle.name)!, "open\n");
				else {
					// Process acquisition precedes UI/provider readiness. Escape must target an active request.
					await until(() => {
						const state = readSubagentActivityFile(
							child.activityFile,
							child.id,
						);
						return state.ok && state.activity.providerActive;
					}, "gated provider request active");
					// Cancel the gated request, leaving a real Pi process available for the next turn.
					await adapter.interrupt(handle);
					await until(() => {
						const state = readSubagentActivityFile(
							child.activityFile,
							child.id,
						);
						return state.ok && state.activity.phase === "waiting";
					}, "interrupted Pi waiting");
					writeFileSync(gates.get(handle.name)!, "open\n");
					if (kind === "error") {
						await runInPane(
							child.surface,
							"/model pi-integration/account-rejected",
						);
						await until(
							() =>
								getNewEntries(child.sessionFile, 0).some(
									(entry) =>
										entry.type === "model_change" &&
										entry.modelId === "account-rejected",
								),
							"deterministic rejected model selection",
						);
						await runInPane(child.surface, "Return exactly ERROR_COMPLETION");
					} else {
						await runInPane(
							child.surface,
							"ONLY call caller_ping with a request for help.",
						);
					}
				}
				if (child.persistent) {
					await until(
						() =>
							adapter
								.readPersistentEvents(handle)
								.some((event) => event.type === "task-done"),
						"persistent task outcome, not process exit",
					);
					return;
				}
				try {
					await until(
						async () =>
							!(
								await surface.getProcessInfo(child.surface)
							).foregroundProcesses.some((process) => {
								try {
									return isExpectedPiProcess(
										process,
										child.sessionFile,
										handle.cwd,
									);
								} catch {
									// An exiting process's environment is unreadable; that is not exit evidence.
									return true;
								}
							}),
						`${kind} Pi process exit`,
					);
				} catch (error) {
					console.error(
						"fixture diagnostic",
						kind,
						await surface.readScreen(child.surface, 40),
						readFileSync(child.activityFile, "utf8"),
						getProviderRequests(),
					);
					throw error;
				}
			},
			async lateSidecar(handle) {
				const child = adapter.getRunningChild(handle);
				await launchOperationsFromSurface(surface, paneConfig).waitForPiReady!(
					child.surface,
					child.sessionFile,
					handle.cwd,
				);
				let observed = false;
				absenceObservers.set(handle.id, () => {
					observed = true;
				});
				await adapter.kill(handle);
				assert.equal(
					(await surface.inspectSurface(child.surface)).kind,
					"missing",
				);
				// The actual adapter entered its existing disappearance grace window.
				await until(() => observed, "adapter-confirmed pane absence");
				await sleep(200); // Deliberate elapsed-time publication race, not transition synchronization.
				writeFileSync(
					`${child.sessionFile}.exit`,
					JSON.stringify({ type: "done", exitCode: 0 }),
				);
				absenceObservers.delete(handle.id);
				console.log(
					"Published late sidecar 200ms after adapter-confirmed Herdr pane absence",
				);
			},
			async worktreeSpawnOptions(base) {
				for (const args of [
					["init", "-q", "-b", "main"],
					["config", "user.email", "harness@example.invalid"],
					["config", "user.name", "Harness Test"],
				])
					execFileSync("git", args, { cwd: env.dir });
				writeFileSync(join(env.dir, "README.md"), "harness conformance\n");
				execFileSync("git", ["add", "README.md"], { cwd: env.dir });
				execFileSync(
					"git",
					["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
					{ cwd: env.dir },
				);
				return {
					...base,
					worktreeRequest: { branch: `pi-integ-harness-${randomUUID()}` },
				};
			},
			dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

registerHarnessAdapterConformance(
	{ describe, it },
	"PiHarnessAdapter (real Pi/Herdr)",
	fixture,
);

it("cleans partial fixture acquisition before dispose is returned", async () => {
	let acquired: TestEnv | undefined;
	await assert.rejects(
		fixture((env) => {
			acquired = env;
			throw new Error("deliberate setup failure");
		}),
		/deliberate setup failure/,
	);
	assert.ok(acquired);
	assert.equal(existsSync(acquired.dir), false);
	const workspaces: { result: { workspaces: { workspace_id: string }[] } } =
		JSON.parse(
			execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" }),
		);
	assert.equal(
		workspaces.result.workspaces.some(
			(workspace) => workspace.workspace_id === acquired?.workspaceId,
		),
		false,
	);
});

it("real persistent task outcome keeps Pi alive and saved policy refuses resume", {
	timeout: 60_000,
}, async () => {
	const f = await fixture();
	try {
		const handle = await f.adapter.spawn({
			...f.spawnOptions(),
			behavior: { persistent: true },
			launchIdentity: {
				id: "persistent-opaque-logical",
				generationId: "persistent-opaque-generation",
				taskId: "persistent-opaque-task",
			},
		});
		await f.finish(handle, "done");
		assert.equal(f.adapter.exitCode(handle), undefined);
		assert.notEqual(await f.adapter.getState(handle), "done");
		assert.equal(existsSync(`${handle.sessionId}.exit`), false);
		const event = f.adapter.readPersistentEvents(handle)[0];
		assert.equal(event.type, "task-done");
		assert.equal(event.task, "persistent-opaque-task");
		assert.equal(event.generation, "persistent-opaque-generation");
		await assert.rejects(
			f.adapter.resume({ name: "unsafe-resume", sessionId: handle.sessionId }),
			/Cannot resume persistent specialist.*Spawn a new specialist/,
		);
	} finally {
		await f.dispose();
	}
});

it("real Pi fallback attempts preserve the legacy ID and isolate session evidence", {
	timeout: 60_000,
}, async () => {
	const f = await fixture();
	try {
		const launchIdentity = { id: "real-fallback-opaque-id" };
		const first = await f.adapter.spawn({
			...f.spawnOptions(),
			launchIdentity,
		});
		await f.finish(first, "error");
		assert.equal(
			(await f.adapter.awaitCompletion(first, new AbortController().signal))
				.reason,
			"error",
		);
		const next = await f.adapter.spawn({ ...f.spawnOptions(), launchIdentity });
		assert.equal(next.id, first.id);
		assert.notEqual(next.sessionId, first.sessionId);
		assert.equal(f.adapter.exitCode(next), undefined);
		await f.finish(next, "done");
		assert.equal(
			(await f.adapter.awaitCompletion(next, new AbortController().signal))
				.reason,
			"done",
		);
		assert.equal(f.adapter.exitCode(first), 1);
		assert.equal(f.adapter.exitCode(next), 0);
	} finally {
		await f.dispose();
	}
});

it("real Pi completion before wait, independent cancellation, and first terminal evidence", {
	timeout: 60_000,
}, async () => {
	const f = await fixture();
	try {
		const first = await f.adapter.spawn(f.spawnOptions());
		await f.finish(first, "done");
		const evidence = await f.adapter.awaitCompletion(
			first,
			new AbortController().signal,
		);
		assert.equal(evidence.reason, "done");
		assert.equal(evidence.finalMessage?.text, "CONFORMANCE_DONE");
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await assert.rejects(
			f.adapter.awaitCompletion(first, alreadyAborted.signal),
			/abort/i,
		);
		const next = await f.adapter.spawn(f.spawnOptions());
		const controller = new AbortController();
		const cancelled = f.adapter.awaitCompletion(next, controller.signal);
		const rejection = assert.rejects(cancelled, /abort/i);
		const pending = f.adapter.awaitCompletion(
			next,
			new AbortController().signal,
		);
		controller.abort();
		await rejection;
		await f.finish(next, "done");
		const result = await pending;
		assert.equal(result.reason, "done");
		writeFileSync(
			`${next.sessionId}.exit`,
			JSON.stringify({ type: "error", errorMessage: "late evidence" }),
		);
		assert.deepEqual(
			await f.adapter.awaitCompletion(next, new AbortController().signal),
			result,
		);
	} finally {
		await f.dispose();
	}
});
