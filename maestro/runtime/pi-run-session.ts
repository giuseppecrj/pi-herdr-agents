import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpawnOptions } from "../core/harness-adapter.ts";
import type {
	AgentHandle,
	Task,
	Role,
	SubagentLifecycle,
	ActivityReadResult,
	CompletionEvidence,
} from "../core/types.ts";
import type { SurfaceProvider } from "../core/surface-provider.ts";
import { PiHarnessAdapter } from "../adapters/pi/pi-harness-adapter.ts";
import {
	launchOperationsFromSurface,
	type PiLaunchOperations,
} from "../adapters/pi/launch-operations.ts";
import { launchPiWorktreeHandoff } from "../adapters/pi/launch.ts";
import {
	createWorktreeOperations,
	createWorktreeCleanupOperations,
} from "./worktree-operations.ts";
import {
	worktreeResultState,
	type WorktreeOperations,
} from "../core/worktree.ts";
import {
	getNewEntries,
	findLastAssistantSummary,
	findObservedSessionRuntime,
	inspectNoProgressSessionTail,
	type AttributedSummary,
} from "../adapters/pi/session.ts";
import { HerdrSurfaceProvider } from "../surfaces/herdr/herdr-surface-provider.ts";
import { readSubagentActivityFile } from "../adapters/pi/activity-file.ts";
import { projectActivity } from "../core/activity.ts";
import {
	markCompletionDetected,
	markCompleted,
	markFailed,
	markDelivery,
	observeActivity,
	projectLifecycle,
} from "../core/lifecycle.ts";
import { FileWakeRegistry } from "../core/wake.ts";
import { SupervisionCoordinator } from "../core/supervision.ts";
import {
	assertModelInScope,
	isThinkingLevel,
	resolveRuntimePlan,
	resolveRuntimePlans,
	type ResolvedRuntimePlan,
} from "../core/routing.ts";
import { loadPaneConfig } from "../core/config/pane-config.ts";
import {
	DelegatedMarkers,
	herdrMarkerSessionReader,
	herdrMarkerWriter,
	type DelegatedMarker,
} from "./delegated-marker.ts";
import {
	createRunSession,
	type RunSession,
	type RunObservation,
	type OwnedRunAttempt,
	type PreparedRun,
} from "./run-session.ts";
import { createPiPersistentIO } from "./pi-persistent-io.ts";
import {
	appendOutcomeLedger,
	ledgerOutcome,
	outcomeLedgerFile,
	runParentAcceptCheck,
} from "./accept-recheck.ts";
import { runAcceptCommand } from "../adapters/pi/accept-runner.ts";
import type {
	DefaultRunSessionOptions,
	PiCompletedMetadata,
	PiLaunchInput,
	PiLaunchSnapshot,
	PiResumeInput,
	PiRunRecord,
	PiRunSession,
	PiRunSessionInfrastructure,
	PiSettlementIO,
	PiStartedMetadata,
	PiWorktreeHandoff,
} from "./pi-run-session-types.ts";

// pi-herdr-agents extension; no owning session required
export function observePiActivity(
	input: { id: string; activityFile?: string; lifecycle: SubagentLifecycle },
	observedAt: number,
): RunObservation & { activityRead: ActivityReadResult } {
	const read = input.activityFile
		? readSubagentActivityFile(input.activityFile, input.id)
		: projectActivity(undefined);
	const lifecycle = observeActivity(input.lifecycle, read, observedAt);
	return {
		kind: "refresh",
		observedAt,
		lifecycle,
		projection: projectLifecycle(lifecycle, observedAt),
		activity: read.ok ? read.activity : undefined,
		activityRead: read,
	};
}

// pi-herdr-agents extension
interface PiEntry {
	record: PiRunRecord;
	started: PiStartedMetadata;
	completed?: PiCompletedMetadata;
	readResumeResult?: PiSettlementIO["readResumeResult"];
	marker?: DelegatedMarker;
}
// The previous facade carries its live composition explicitly across module replacement.
// No module-local lookup can accidentally rediscover an owner.
const OWNER = Symbol.for("pi-herdr-agents/PiRunSession-owner");
// pi-herdr-agents extension
interface PiSessionOwner {
	options: DefaultRunSessionOptions;
	roles: Role[];
	// Only acquisitions currently in flight; control reservation is kernel-owned.
	pending: Set<{ taskId: string; suppressed: boolean }>;
	resumePi(input: PiResumeInput): Promise<AgentHandle>;
	kernel: RunSession;
	entries: Map<string, PiEntry>;
	infrastructure: Pick<
		PiRunSessionInfrastructure,
		"surfaceProvider" | "supervision" | "processProbe" | "acceptRunner"
	>;
	worktreeOperations: WorktreeOperations;
	/** Absent outside Herdr: without a socket nothing can be marked. */
	markers?: DelegatedMarkers;
}

// A detached close can outlive settlement without capturing a child, metadata,
// adapter, current hook binding or the composition registry.
function temporarySurfaceRelease(
	provider: SurfaceProvider,
	surface: string,
): () => Promise<void> {
	return async () => {
		await provider.closeSurface(surface);
	};
}

function createDelegatedMarkers(
	infrastructure: PiRunSessionInfrastructure | undefined,
): DelegatedMarkers | undefined {
	// Injected infrastructure never falls back to the ambient Herdr socket.
	if (infrastructure) {
		const write = infrastructure.markerWriter;
		const readSession = infrastructure.markerSessionReader;
		return write && readSession
			? new DelegatedMarkers({ write, readSession })
			: undefined;
	}
	const socketPath = process.env.HERDR_SOCKET_PATH;
	return socketPath
		? new DelegatedMarkers({
				write: herdrMarkerWriter(socketPath),
				readSession: herdrMarkerSessionReader(socketPath),
			})
		: undefined;
}

/** Host diagnostics stay host; only text the child wrote is child-error. */
function errorProvenance(
	source: CompletionEvidence["errorSource"],
): "child-error" | "host" {
	return source === "child" ? "child-error" : "host";
}

// Capture only resume presentation scalars, not the child or its owning registry.
function resumeResultReader(
	sessionFile: string,
	cursor: number,
	exitCode: number,
	errorMessage: string | undefined,
	errorSource: CompletionEvidence["errorSource"],
): NonNullable<PiSettlementIO["readResumeResult"]> {
	return () => ({
		...(findLastAssistantSummary(getNewEntries(sessionFile, cursor)) ?? {
			summary: errorMessage
				? `Subagent error: ${errorMessage}`
				: exitCode === 0
					? "Resumed session exited without new output"
					: `Resumed session exited with code ${exitCode}`,
			summarySource: errorProvenance(errorSource),
		}),
		sessionFile,
	});
}

// pi-herdr-agents extension
export function createDefaultRunSession(
	options: DefaultRunSessionOptions,
	previous?: PiRunSession,
): PiRunSession {
	// SAFETY: this factory alone attaches its private symbol owner to Pi facades.
	const adopted =
		previous &&
		(previous as PiRunSession & { [OWNER]?: PiSessionOwner })[OWNER];
	if (previous && !adopted)
		throw new Error(
			"Previous PiRunSession does not carry its owning composition.",
		);
	let state: PiSessionOwner;
	let resumePi: (input: PiResumeInput) => Promise<AgentHandle>;
	if (adopted) {
		state = adopted;
		state.options = options;
		state.roles.splice(0, state.roles.length, ...options.roles);
	} else {
		// Configured placement belongs to each new launch; the coordinator alone owns
		// this explicitly injected registry. Injected infrastructure already owns one.
		const provider =
			options.infrastructure?.surfaceProvider ??
			new HerdrSurfaceProvider({
				paneConfig: loadPaneConfig(
					join(options.configDir, "herdr-agents"),
					options.configExamplePath,
				),
			});
		const wake = options.infrastructure ? undefined : new FileWakeRegistry();
		const supervision =
			options.infrastructure?.supervision ??
			new SupervisionCoordinator(
				async () => {
					try {
						return {
							complete: true,
							panes: (await provider.listSurfaces()).map((s) => ({
								paneId: s.id,
								workspaceId: s.workspaceId ?? "",
							})),
						};
					} catch {
						return { complete: false, panes: [] };
					}
				},
				(id) => provider.inspectSurface(id),
				options.forcePolling,
				wake,
			);
		const infrastructure = options.infrastructure ?? {
			surfaceProvider: provider,
			supervision,
		};
		const entries = new Map<string, PiEntry>();
		const roles = [...options.roles];
		const pending = new Set<{ taskId: string; suppressed: boolean }>();
		// The operations always supply an actual owning adapter. The lazy default is
		// an actual Pi adapter too, only constructed if the generic default is used.
		const kernel = createRunSession({
			get adapter() {
				return adapter(state.options.getLaunchSnapshot());
			},
			roles,
			cwd: process.cwd(),
			operations: {
				async prepare(task, role) {
					const snapshot = state.options.getLaunchSnapshot();
					if (!snapshot.parentRuntime)
						throw new Error("Pi launch requires the active parent runtime");
					const plans = resolveRuntimePlans(
						task.runtime ?? {},
						role.defaults ?? {},
						snapshot.parentRuntime,
						snapshot.modelRegistry,
					);
					for (const candidate of task.runtime?.fallbacks ?? [])
						plans.push(
							resolveRuntimePlan(
								candidate,
								role.defaults ?? {},
								snapshot.parentRuntime,
								snapshot.modelRegistry,
							),
						);
					const [first, ...rest] = plans;
					if (!first) throw new Error("No resolved runtime plans");
					const id = randomUUID();
					return prepare(
						{
							task,
							role,
							plans: [first, ...rest],
							resolved: {
								agent: role.name || undefined,
								cwd: task.cwd,
								tools: task.tools?.join(","),
							},
							identity: {
								id,
								logicalId: id,
								generationId: randomUUID(),
								taskId: randomUUID(),
							},
						},
						snapshot,
					);
				},
				async resume(resumeOptions, task) {
					const acquisition = { taskId: task.id, suppressed: false };
					state.pending.add(acquisition);
					try {
						const snapshot = state.options.getLaunchSnapshot();
						const before = getNewEntries(resumeOptions.sessionId, 0);
						const owner = adapter(snapshot);
						const handle = await owner.resume(resumeOptions);
						task.cwd = handle.cwd;
						return acquired(
							task,
							owner,
							handle,
							[],
							[],
							undefined,
							before.length,
							acquisition.suppressed,
						);
					} finally {
						state.pending.delete(acquisition);
					}
				},
			},
			hooks: {
				async onSpawned(_handle, task) {
					const entry = entries.get(task.id)!;
					await state.options.hooks.onSpawned?.(
						entry.record,
						entry.started,
						task,
					);
				},
				onCancelState(handle, task, cancelState) {
					// The kernel owns the intent; project it onto whichever owner is
					// current, including one transferred after the cancel call.
					const entry = entries.get(task.id);
					if (
						entry &&
						entry.record.id === handle.id &&
						entry.record.sessionFile === handle.sessionId
					)
						entry.record.cancelState = cancelState;
				},
				onObserved(_handle, _projection, observation) {
					const entry = [...entries.values()].find(
						(e) =>
							e.record.id === _handle.id &&
							e.record.sessionFile === _handle.sessionId,
					);
					if (entry) observed(entry.record, observation);
				},
				async onSettled(result, task) {
					const entry = entries.get(task.id)!;
					// Exhausted acquisition failures are attached by the generic kernel after
					// the last real attempt was finalized; preserve its original raw text.
					const completed = { ...entry.completed!, run: result };
					if (result.evidence?.errorMessage !== undefined)
						completed.errorMessage = result.evidence.errorMessage;
					if (result.cancellation) {
						// A cancel can settle after a retryable attempt was finalized with
						// its natural error; present the run's actual cancelled outcome.
						completed.summary = "Subagent cancelled.";
						completed.summarySource = "host";
						completed.error = "cancelled";
						completed.exitCode = 1;
						completed.sessionFile = entry.record.sessionFile;
						completed.errorMessage = undefined;
						completed.ping = undefined;
					}
					entry.completed = completed;
					try {
						const decision = await state.options.hooks.onSettled(
							entry.record,
							completed,
							task,
							entry.readResumeResult
								? { ...io, readResumeResult: entry.readResumeResult }
								: io,
						);
						entry.record.lifecycle = markDelivery(
							entry.record.lifecycle,
							decision === "suppressed" ? "suppressed" : "delivered",
						);
						return decision;
					} finally {
						entries.delete(task.id);
					}
				},
			},
		});
		// Reserve through kernel.resume before any transcript read or adapter creation.
		resumePi = async (input) => {
			const task: Task = {
				id: input.taskId,
				name: input.name,
				prompt: input.message ?? "resumed session",
				role: "",
				cwd: process.cwd(),
			};
			try {
				return await kernel.resume({
					task,
					name: input.name,
					sessionId: input.sessionPath,
					message: input.message,
					autoExit: input.autoExit,
				});
			} finally {
				prune(task.id);
			}
		};
		state = {
			options,
			kernel,
			entries,
			infrastructure,
			roles,
			pending,
			resumePi,
			worktreeOperations:
				options.infrastructure?.worktreeOperations ??
				options.infrastructure?.launchOperations.worktree ??
				createWorktreeOperations(),
		};
	}
	// Replacements must invoke the original kernel's invocation closure, which
	// reads this shared current binding, not the old facade's options.
	if (adopted) resumePi = state.resumePi;
	// Live markers and their sequence survive a reload with their runs.
	state.markers ??= createDelegatedMarkers(options.infrastructure);

	function prune(id: string) {
		if (!state.kernel.getTask(id)) state.entries.delete(id);
	}
	function live(id: string): PiEntry | undefined {
		prune(id);
		return state.entries.get(id);
	}
	function record(id: string): PiRunRecord {
		const value = live(id)?.record;
		if (!value) throw new Error(`Task "${id}" has no active Pi owner.`);
		return value;
	}
	function hydrate(
		child: PiRunRecord,
		at: number,
		kind: RunObservation["kind"],
	): RunObservation {
		const read = readSubagentActivityFile(child.activityFile, child.id);
		child.lifecycle = observeActivity(child.lifecycle, read, at);
		return {
			kind,
			observedAt: at,
			lifecycle: child.lifecycle,
			projection: projectLifecycle(child.lifecycle, at),
			activity: read.ok ? read.activity : undefined,
			activityRead: read,
		};
	}
	function observed(child: PiRunRecord, observation: RunObservation) {
		const entry = [...state.entries.values()].find(
			(candidate) => candidate.record === child,
		);
		if (child.lifecycle.delivery === "suppressed" || !entry) return;
		entry.marker?.renew();
		if (observation.kind === "local-evidence" && child.persistent) {
			try {
				state.options.persistent.drain(child, io);
			} catch {
				/* unread event retries on a later wake */
			}
		}
		state.options.hooks.onObserved?.(child, observation);
	}
	function launchOperations(snapshot: PiLaunchSnapshot): PiLaunchOperations {
		return {
			...(state.options.infrastructure?.launchOperations ??
				launchOperationsFromSurface(
					new HerdrSurfaceProvider({ paneConfig: snapshot.paneConfig }),
					snapshot.paneConfig,
				)),
			worktree: state.worktreeOperations,
		};
	}
	function adapter(snapshot: PiLaunchSnapshot): PiHarnessAdapter {
		return new PiHarnessAdapter({
			surface: state.infrastructure.surfaceProvider,
			paneConfig: snapshot.paneConfig,
			modelRegistry: snapshot.modelRegistry,
			parent: snapshot.parent,
			parentRuntime: snapshot.parentRuntime,
			supervision: state.infrastructure.supervision,
			processProbe: state.infrastructure.processProbe,
			operations: launchOperations(snapshot),
			onObservation(child, kind) {
				const at = Date.now();
				// Local evidence only drains events. Tick/refresh still hydrate fresh
				// activity; preserve the callback without another activity-file parse.
				observed(
					child,
					kind === "local-evidence"
						? {
								kind,
								observedAt: at,
								lifecycle: child.lifecycle,
								projection: projectLifecycle(child.lifecycle, at),
							}
						: hydrate(child, at, kind),
				);
			},
		});
	}
	function acquired(
		task: Task,
		owner: PiHarnessAdapter,
		handle: AgentHandle,
		attempts: string[],
		failures: { model: string; error: string }[],
		warning?: string,
		cursor?: number,
		suppressed = false,
	): OwnedRunAttempt {
		const child = owner.getRunningChild(handle);
		const entry: PiEntry = {
			record: child,
			started: {
				id: child.id,
				name: child.name,
				task: child.task,
				agent: child.agent,
				sessionFile: child.sessionFile,
				launchScriptFile: child.launchScriptFile,
				model: child.runtimePlan?.model,
				thinking: child.runtimePlan?.thinking,
				runtimePlan: child.runtimePlan,
				worktree: child.worktree,
				warning,
				status: "started",
			},
		};
		if (suppressed)
			child.lifecycle = markDelivery(child.lifecycle, "suppressed");
		else {
			entry.marker = state.markers?.attach(child);
			state.entries.set(task.id, entry);
		}
		return {
			handle,
			adapter: owner,
			persistent: child.persistent ?? false,
			closeTemporarySurface: temporarySurfaceRelease(
				state.infrastructure.surfaceProvider,
				child.surface,
			),
			observe: (at) => hydrate(child, at, "refresh"),
			finalize: async (result, _task, control) => {
				// Clear before delivery; a retained worktree root keeps its pane.
				entry.marker?.retire();
				const at = Date.now();
				let evidence = result.evidence;
				if (evidence)
					child.lifecycle = markCompletionDetected(
						child.lifecycle,
						evidence,
						at,
					);
				// A rejected adapter wait follows the shipped watch error result:
				// transcript I/O is not retried as part of presenting that failure.
				let all: ReturnType<typeof getNewEntries> = [];
				try {
					if (evidence && existsSync(child.sessionFile))
						all = getNewEntries(child.sessionFile, 0);
				} catch (error) {
					// This is Pi processing failure AFTER real adapter evidence, not a
					// provider error or a failed parent send. Normalize to the shipped
					// watch error result and settle once; no synthetic evidence/retry.
					result = {
						handle: result.handle,
						outcome: "failed",
						error: error instanceof Error ? error.message : String(error),
						durationMs: result.durationMs,
					};
					evidence = undefined;
				}
				const exitCode = evidence?.exitCode ?? 1;
				const observedRuntime = findObservedSessionRuntime(all);
				if (
					child.runtimePlan &&
					observedRuntime.provider &&
					observedRuntime.modelId
				) {
					const model = `${observedRuntime.provider}/${observedRuntime.modelId}`;
					const thinking =
						observedRuntime.thinking !== undefined &&
						isThinkingLevel(observedRuntime.thinking)
							? observedRuntime.thinking
							: undefined;
					const plan: ResolvedRuntimePlan = {
						...child.runtimePlan,
						observed: { model },
					};
					if (thinking) {
						plan.thinking = thinking;
						plan.observed!.thinking = thinking;
					}
					if (model !== plan.model)
						plan.runtimeMismatch = `Resolved model ${plan.model} but child reported ${model}`;
					child.runtimePlan = plan;
				}
				const { summary, summarySource }: AttributedSummary = evidence
					? (findLastAssistantSummary(
							cursor === undefined ? all : all.slice(cursor),
						) ?? {
							summary: evidence.errorMessage
								? `Subagent error: ${evidence.errorMessage}`
								: exitCode === 0
									? cursor === undefined
										? "Sub-agent exited without output"
										: "Resumed session exited without new output"
									: `${cursor === undefined ? "Sub-agent" : "Resumed session"} exited with code ${exitCode}`,
							// Only a child-written sidecar error is child provenance.
							summarySource: evidence.errorMessage
								? errorProvenance(evidence.errorSource)
								: "host",
						})
					: {
							summary:
								result.outcome === "killed"
									? "Subagent cancelled."
									: `Subagent error: ${result.error}`,
							summarySource: "host",
						};
				let worktree: PiWorktreeHandoff | undefined = child.worktree
					? state.worktreeOperations.captureWorktreeHandoff(child.worktree)
					: undefined;
				// After the handoff capture, before the lifecycle and manifest marks:
				// the parent re-check decides the verdict (ADR-0017).
				const accept = child.accept
					? await runParentAcceptCheck({
							spec: child.accept,
							result,
							evidence,
							exitCode,
							cwd: child.cwd,
							worktree,
							cancellable: control.cancellable,
							runner: state.infrastructure.acceptRunner ?? runAcceptCommand,
						})
					: undefined;
				// A cancel during the re-check delivers the cancelled result.
				const cancelledInCheck =
					!result.cancellation &&
					accept?.reason === "cancelled" &&
					entry.record.cancelState === "confirmed";
				if (child.worktree && worktree) {
					try {
						// Only confirmed termination is a cancellation. Shutdown suppression
						// of an unconfirmed cancel records what a plain shutdown would. A
						// rejected verdict leaves the manifest state unchanged.
						state.worktreeOperations.persistWorktreeResult(
							child.worktree,
							result.cancellation?.termination === "confirmed" ||
								cancelledInCheck
								? "cancelled"
								: worktreeResultState(exitCode, !!evidence?.ping),
							worktree,
						);
					} catch (error) {
						worktree = {
							...worktree,
							gitError: [
								worktree.gitError,
								`Manifest update failed: ${error instanceof Error ? error.message : String(error)}`,
							]
								.filter(Boolean)
								.join("; "),
						};
					}
				}
				child.lifecycle =
					exitCode === 0 && !cancelledInCheck
						? markCompleted(child.lifecycle, at)
						: markFailed(
								child.lifecycle,
								cancelledInCheck ? "Subagent cancelled." : summary,
								at,
								cancelledInCheck ? 1 : exitCode,
							);
				if (evidence?.errorMessage)
					failures.push({
						model: child.runtimePlan?.model ?? attempts.at(-1)!,
						error: evidence.errorMessage,
					});
				entry.completed = {
					run: result,
					name: child.name,
					task: child.task,
					agent: child.agent,
					summary,
					summarySource,
					sessionFile:
						evidence || result.outcome === "killed"
							? child.sessionFile
							: undefined,
					exitCode,
					elapsed: Math.floor((at - child.startTime) / 1000),
					error: evidence
						? undefined
						: result.outcome === "killed"
							? "cancelled"
							: result.error,
					errorMessage: evidence?.errorMessage,
					ping: evidence?.ping,
					// The watch catch omits its result plan; the host still reports the
					// live child's plan in structured details, not in the error summary.
					runtimePlan: evidence ? child.runtimePlan : undefined,
					worktree,
					accept,
					logicalId: child.logicalId,
					generationId: child.generationId,
					policyHash: child.policyHash,
				};
				if (state.options.outcomeLedger !== false)
					appendOutcomeLedger(outcomeLedgerFile(state.options.configDir), {
						at,
						runId: child.id,
						attempt: Math.max(1, attempts.length),
						role: child.agent,
						requestedModel:
							task.requestedModel ?? child.runtimePlan?.requestedModel,
						model:
							child.runtimePlan?.observed?.model ?? child.runtimePlan?.model,
						thinking: child.runtimePlan?.thinking,
						elapsedSec: entry.completed.elapsed,
						outcome: ledgerOutcome(
							result,
							evidence,
							exitCode,
							cancelledInCheck,
						),
						accept,
					});
				if (cursor !== undefined)
					entry.readResumeResult = resumeResultReader(
						child.sessionFile,
						cursor,
						exitCode,
						evidence?.errorMessage,
						evidence?.errorSource,
					);
				if (cursor === undefined) {
					entry.completed.fallbackAttempts = attempts;
					entry.completed.fallbackFailures = failures;
				}
				return worktree && evidence
					? { ...result, evidence: { ...evidence, worktree } }
					: result;
			},
		};
	}
	function prepare(
		input: PiLaunchInput,
		snapshot?: PiLaunchSnapshot,
	): PreparedRun {
		const attempts: string[] = [];
		const failures: { model: string; error: string }[] = [];
		let publicId: string | undefined;
		let logicalId: string | undefined;
		let capturedSnapshot = snapshot;
		return {
			role: input.role,
			persistent:
				input.task.behavior?.persistent ??
				input.role.defaults?.persistent ??
				false,
			candidates: input.plans,
			async spawnAttempt(_spawn: SpawnOptions, index, cancelled) {
				const plan = input.plans[index];
				attempts.push(plan.model);
				const acquisition = { taskId: input.task.id, suppressed: false };
				state.pending.add(acquisition);
				let spawning = false;
				try {
					const current = (await input.prepareAttempt?.(index, cancelled)) ?? {
						...input,
						snapshot: (capturedSnapshot ??= state.options.getLaunchSnapshot()),
					};
					if (
						current.task.id !== input.task.id ||
						current.task.prompt !== input.task.prompt ||
						JSON.stringify(current.task.worktree) !==
							JSON.stringify(input.task.worktree)
					)
						throw new Error(
							"Pi attempt preparation changed the invocation identity, prompt or worktree.",
						);
					// A candidate was authorized at planning time; the scope may have
					// changed since. Re-check it against this attempt's snapshot, which
					// prepareAttempt rebuilds from the live parent for every attempt.
					assertModelInScope(plan.model, current.snapshot.modelRegistry);
					const owner = adapter(current.snapshot);
					spawning = true;
					const handle = await owner.spawn({
						name: input.task.name,
						task: input.task.prompt,
						cwd: current.task.cwd,
						sessionId: current.snapshot.parent.sessionId,
						role: current.role,
						env: current.task.env,
						session: current.task.session,
						behavior: current.task.behavior,
						tools: current.task.tools,
						systemPrompt: current.resolved.agent
							? current.role.systemPrompt
							: current.task.systemPrompt,
						surface: input.surface,
						worktreeRequest: input.task.worktree,
						accept: input.task.accept,
						runtime: { model: plan.model, thinking: plan.thinking },
						resolvedLaunch: { ...current.resolved, runtimePlan: plan },
						launchIdentity: {
							...current.identity,
							id: publicId ?? current.identity.id,
							logicalId: logicalId ?? current.identity.logicalId,
						},
					});
					publicId = handle.id;
					logicalId ??= current.identity.logicalId;
					return acquired(
						input.task,
						owner,
						handle,
						attempts,
						failures,
						input.warning,
						undefined,
						acquisition.suppressed,
					);
				} catch (error) {
					if (cancelled.aborted && !spawning) {
						// Cancelled while preparing: the candidate neither launched nor failed.
						attempts.pop();
						throw error;
					}
					failures.push({
						model: plan.model,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				} finally {
					state.pending.delete(acquisition);
				}
			},
		};
	}
	const io = createPiPersistentIO(state);
	const facade: PiRunSession = {
		...state.kernel,
		async handoffWorktree(input) {
			// This is a long-lived interactive handoff, deliberately outside the
			// watched kernel: no task reservation, acquire, producer or watcher.
			const snapshot = input.snapshot;
			const result = await launchPiWorktreeHandoff(
				{
					kind: "fresh",
					name: input.name,
					task: input.task,
					cwd: snapshot.parent.cwd,
					worktree: { branch: input.branch },
					handoff: { leafId: input.leafId },
					parent: { ...snapshot.parent },
					runtimePlan: input.runtimePlan,
					modelScope: snapshot.modelRegistry.scope,
					behavior: {
						deniedTools: [],
						autoExit: false,
						interactive: true,
						sessionMode: "standalone",
					},
				},
				launchOperations(snapshot),
			);
			return { record: result.running, focusError: result.focusError };
		},
		createWorktreeCleanupOperations: (input) =>
			createWorktreeCleanupOperations(
				state.infrastructure.surfaceProvider,
				input,
			),
		async spawnPi(input) {
			try {
				return await state.kernel.spawn(input.task, prepare(input));
			} finally {
				prune(input.task.id);
			}
		},
		resumePi: (input) => resumePi(input),
		async supervise(handle, task, signal) {
			try {
				return await state.kernel.supervise(handle, task, signal);
			} finally {
				prune(task.id);
			}
		},
		getRecord: (id) => live(id)?.record,
		getStarted: (id) => live(id)?.started,
		getCompleted: (id) => live(id)?.completed,
		getControlTaskId(publicId) {
			for (const [id, entry] of state.entries)
				if (live(id) && entry.record.id === publicId) return id;
			return undefined;
		},
		suppress(id) {
			for (const acquisition of state.pending)
				if (acquisition.taskId === id) acquisition.suppressed = true;
			const suppressed = live(id);
			const r = suppressed?.record;
			if (r) r.lifecycle = markDelivery(r.lifecycle, "suppressed");
			// Nothing renews an unsupervised run's marker; clear it now.
			suppressed?.marker?.retire();
			state.kernel.suppress(id);
			state.entries.delete(id);
		},
		async cancel(id) {
			// The kernel records the intent and projects every owner's cancel state
			// through onCancelState; a natural result taken first keeps its own.
			try {
				return await state.kernel.cancel(id);
			} finally {
				prune(id);
			}
		},
		async sendPersistent(id, text) {
			return state.options.persistent.send(record(id), text, io);
		},
		async stopPersistent(id, timeoutMs = 15_000) {
			return state.options.persistent.stop(record(id), timeoutMs, io);
		},
		async send(id, text) {
			const ack = await facade.sendPersistent(id, text);
			if ("error" in ack) throw new Error(ack.error);
		},
		availability: () => ({
			available: state.infrastructure.surfaceProvider.isAvailable(),
			setupHint: state.infrastructure.surfaceProvider.setupHint(),
		}),
		listWorktreeSurfaces: (opts) =>
			state.infrastructure.surfaceProvider.listWorktreeSurfaces(opts),
		inspectProgress(id) {
			const r = record(id);
			let updatedAt: number | undefined;
			try {
				updatedAt = statSync(r.sessionFile).mtimeMs;
			} catch {
				/* unavailable */
			}
			return { ...inspectNoProgressSessionTail(r.sessionFile), updatedAt };
		},
		diagnostics: () => state.infrastructure.supervision.diagnostics(),
		async shutdown(reason) {
			if (!["reload", "new", "resume", "fork"].includes(reason ?? "")) {
				for (const id of new Set([
					...state.entries.keys(),
					...[...state.pending].map((a) => a.taskId),
				]))
					facade.suppress(id);
				state.infrastructure.supervision.close();
			}
		},
	};
	Object.defineProperty(facade, OWNER, { value: state });
	return facade;
}
