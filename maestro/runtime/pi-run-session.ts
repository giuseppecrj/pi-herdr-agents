import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpawnOptions } from "../core/harness-adapter.ts";
import type {
	AgentHandle,
	Task,
	Role,
	ThinkingLevel,
	SurfaceHandle,
	SubagentLifecycle,
	RunResult,
	ActivityReadResult,
} from "../core/types.ts";
import type {
	SurfaceProvider,
	WorktreeSurfaceInfo,
} from "../core/surface-provider.ts";
import { PiHarnessAdapter } from "../adapters/pi/pi-harness-adapter.ts";
import type { ProcessIdentityProbe } from "../adapters/pi/process-identity.ts";
import {
	launchOperationsFromSurface,
	launchPiWorktreeHandoff,
	type PiLaunchOperations,
} from "../adapters/pi/launch.ts";
import {
	createWorktreeOperations,
	createWorktreeCleanupOperations,
} from "./worktree-operations.ts";
import {
	worktreeResultState,
	type WorktreeOperations,
	type WorktreeLaunch,
	type WorktreeHandoff,
} from "../core/worktree.ts";
import type { WorktreeCleanupOperations } from "../core/worktree-cleanup.ts";
import {
	appendPersistentDeliveryLedger,
	readPersistentDeliveryLedger,
	readPersistentTaskEvents,
	writePersistentTaskInbox,
	getNewEntries,
	findLastAssistantMessage,
	findObservedSessionRuntime,
	inspectNoProgressSessionTail,
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
	isThinkingLevel,
	resolveRuntimePlan,
	resolveRuntimePlans,
	type ParentRuntime,
	type ResolvedRuntimePlan,
	type ModelRegistryAdapter,
} from "../core/routing.ts";
import { loadPaneConfig, type PaneConfig } from "../core/config/pane-config.ts";
import {
	DelegatedMarkers,
	herdrMarkerWriter,
	type DelegatedMarker,
	type MarkerWriter,
} from "./delegated-marker.ts";
import {
	createRunSession,
	type RunSession,
	type RunObservation,
	type DeliveryDecision,
	type OwnedRunAttempt,
	type PreparedRun,
} from "./run-session.ts";

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
export interface PiLaunchSnapshot {
	parent: {
		cwd: string;
		invocationCwd?: string;
		sessionFile: string;
		sessionId: string;
		sessionDir: string;
		agentDir?: string;
	};
	parentRuntime?: ParentRuntime;
	modelRegistry: ModelRegistryAdapter;
	paneConfig: PaneConfig;
}

// pi-herdr-agents extension
export interface PiLaunchInput {
	task: Task;
	role: Role;
	plans: readonly [ResolvedRuntimePlan, ...ResolvedRuntimePlan[]];
	resolved: { agent?: string; cwd?: string; roleCwd?: string; tools?: string };
	identity: {
		id: string;
		logicalId: string;
		generationId: string;
		taskId: string;
	};
	warning?: string;
	surface?: SurfaceHandle;
	/** Existing host normalization may re-read role files for each actual retry launch. */
	prepareAttempt?(candidateIndex: number): PiAttemptSnapshot;
}
// pi-herdr-agents extension
export interface PiAttemptSnapshot {
	task: Task;
	role: Role;
	resolved: { agent?: string; cwd?: string; roleCwd?: string; tools?: string };
	identity: {
		id: string;
		logicalId: string;
		generationId: string;
		taskId: string;
	};
	snapshot: PiLaunchSnapshot;
}

// pi-herdr-agents extension
export interface PiResumeInput {
	taskId: string;
	name: string;
	sessionPath: string;
	message?: string;
	autoExit?: boolean;
}

// pi-herdr-agents extension
export type PiWorktreeLaunch = WorktreeLaunch;
// pi-herdr-agents extension
export type WorktreeHandoffBase = Omit<
	WorktreeLaunch,
	"workspaceId" | "paneId"
>;
// pi-herdr-agents extension
export type PiWorktreeHandoff = WorktreeHandoff;

/** Structural view of the adapter's actual mutable child, not a copied registry row. */
// pi-herdr-agents extension
export interface PiRunRecord {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile: string;
	activityFile: string;
	interactive: boolean;
	runtimePlan: ResolvedRuntimePlan | undefined;
	worktree?: PiWorktreeLaunch;
	lifecycle: SubagentLifecycle;
	persistent?: boolean;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
	policyTools?: string[] | null;
	policyDeniedTools?: string[];
	tasksCompleted?: number;
	taskId?: string;
	inboxSequence?: number;
	observedTaskEvents?: number;
	stopState?: "requested" | "pending" | "failed";
	stopFailure?: string;
	crashNotified?: boolean;
	/** Presentation of the latest operator cancel; the kernel owns the intent. */
	cancelState?: "requested" | "confirmed" | "unconfirmed";
}

// pi-herdr-agents extension
export interface PiStartedMetadata {
	id: string;
	name: string;
	task: string;
	agent?: string;
	sessionFile: string;
	launchScriptFile?: string;
	model?: string;
	thinking?: ThinkingLevel;
	runtimePlan?: ResolvedRuntimePlan;
	worktree?: PiWorktreeLaunch;
	warning?: string;
	status: "started";
}
// pi-herdr-agents extension
export interface PiCompletedMetadata {
	run: RunResult;
	name: string;
	task: string;
	agent?: string;
	summary: string;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	error?: string;
	errorMessage?: string;
	ping?: { name: string; message: string };
	fallbackAttempts?: string[];
	fallbackFailures?: { model: string; error: string }[];
	runtimePlan?: ResolvedRuntimePlan;
	worktree?: PiWorktreeHandoff;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
}

// pi-herdr-agents extension
export interface PiPersistentEvent {
	version: 1;
	type: "task-done" | "help-request";
	task: string;
	generation: string;
	at: string;
	message?: string;
}
// pi-herdr-agents extension
export interface PiLedgerEntry {
	task: string;
	outcome:
		| "dispatched"
		| "delivered"
		| "rejected-busy"
		| "help-requested"
		| "stop-pending"
		| "stopped";
	generation: string;
	logicalId: string;
	policyHash: string;
	at: string;
}
// pi-herdr-agents extension
export type PiSendAcknowledgement =
	| { id: string; task: string; inbox: string; outcome: "dispatched" }
	| { error: string; task?: string; outcome?: "rejected-busy" };
// pi-herdr-agents extension
export type PiStopAcknowledgement =
	| { id: string; name: string; status: "stop_requested" | "stop_pending" }
	| { error: string; id?: string; name?: string };

/** Narrow I/O for the existing host persistent policy, not a task scheduler. */
// pi-herdr-agents extension
export interface PiPersistentIO {
	/** Raw events only; cursor indexes this array before generation filtering. */
	readEvents(record: PiRunRecord): PiPersistentEvent[];
	inspectWorktree(record: PiRunRecord): PiWorktreeHandoff | undefined;
	/** Explicit lazy read, once per drain with eligible post-cursor events. */
	readLedger(record: PiRunRecord): PiLedgerEntry[];
	/** Transcript read only for an undelivered task-done, never help/quiet wakes. */
	readTaskSummary(record: PiRunRecord): string;
	rejectBusy(record: PiRunRecord, task: string): void;
	dispatch(record: PiRunRecord, task: string, text: string): string;
	requestStop(record: PiRunRecord): void;
	acknowledge(record: PiRunRecord, event: PiPersistentEvent): PiLedgerEntry;
	recordStopped(record: PiRunRecord): void;
}
/** Run-scoped settlement I/O; only resumed acquisitions supply the late reader. */
// pi-herdr-agents extension
export interface PiSettlementIO extends PiPersistentIO {
	readResumeResult?(): { summary: string; sessionFile: string };
}
// pi-herdr-agents extension
export interface PiPersistentHostOperations {
	send(
		record: PiRunRecord,
		text: string,
		io: PiPersistentIO,
	): PiSendAcknowledgement;
	stop(
		record: PiRunRecord,
		timeoutMs: number,
		io: PiPersistentIO,
	): PiStopAcknowledgement;
	drain(record: PiRunRecord, io: PiPersistentIO): void;
}

// pi-herdr-agents extension
export interface PiProgressEvidence {
	updatedAt?: number;
	classification: "blocked-tool" | "truncated-turn" | "generic-no-progress";
	lastEntryKind: "assistant" | "tool-result" | "message" | "other" | "none";
}
// pi-herdr-agents extension
export interface PiRunSessionHooks {
	onSpawned?(
		record: PiRunRecord,
		started: PiStartedMetadata,
		task: Task,
	): void | Promise<void>;
	onObserved?(record: PiRunRecord, observation: RunObservation): void;
	onSettled(
		record: PiRunRecord,
		result: PiCompletedMetadata,
		task: Task,
		io: PiSettlementIO,
	): void | DeliveryDecision | Promise<void | DeliveryDecision>;
}
// pi-herdr-agents extension
export interface PiRunSessionInfrastructure {
	surfaceProvider: SurfaceProvider;
	launchOperations: PiLaunchOperations;
	worktreeOperations?: WorktreeOperations;
	supervision: SupervisionCoordinator;
	/** Kernel process-identity probe for worktree cancel; tests inject it. */
	processProbe?: ProcessIdentityProbe;
	/** Sidebar marker transport; defaults to this pane's Herdr socket. */
	markerWriter?: MarkerWriter;
}
// pi-herdr-agents extension
export interface DefaultRunSessionOptions {
	/** Test injection consumes the actual Stage 3 seams, not replacement launch logic. */
	infrastructure?: PiRunSessionInfrastructure;
	configDir: string;
	configExamplePath: string;
	/** Synchronous fresh snapshot, captured once at each launch/resume call. */
	getLaunchSnapshot(): PiLaunchSnapshot;
	roles: Role[];
	hooks: PiRunSessionHooks;
	persistent: PiPersistentHostOperations;
	forcePolling: boolean;
	/** Mark delegated children's panes for the Herdr sidebar plugin. */
	sidebarMarkers?: boolean;
}
// pi-herdr-agents extension
export interface PiWorktreeHandoffInput {
	name: string;
	task: string;
	branch: string;
	leafId: string;
	snapshot: PiLaunchSnapshot;
	runtimePlan: ResolvedRuntimePlan;
}

// pi-herdr-agents extension
export interface PiRunSession extends RunSession {
	handoffWorktree(
		input: PiWorktreeHandoffInput,
	): Promise<{ record: PiRunRecord; focusError?: string }>;
	createWorktreeCleanupOperations(input: {
		manifestDir: string;
		liveHolders: () => { path: string; persistent?: boolean }[];
		managedRoot?: string;
	}): WorktreeCleanupOperations;
	spawnPi(input: PiLaunchInput): Promise<AgentHandle>;
	resumePi(input: PiResumeInput): Promise<AgentHandle>;
	/** Live-run metadata queries; all undefined after terminal retirement. */
	getRecord(taskId: string): PiRunRecord | undefined;
	getStarted(taskId: string): PiStartedMetadata | undefined;
	getCompleted(taskId: string): PiCompletedMetadata | undefined;
	/** Live public Pi run ID -> control Task ID; undefined after retirement, not inbox ID. */
	getControlTaskId(publicRunId: string): string | undefined;
	availability(): { available: boolean; setupHint: string };
	listWorktreeSurfaces(options?: {
		cwd?: string;
		timeoutMs?: number;
	}): Promise<WorktreeSurfaceInfo[]>;
	sendPersistent(taskId: string, text: string): Promise<PiSendAcknowledgement>;
	stopPersistent(
		taskId: string,
		timeoutMs?: number,
	): Promise<PiStopAcknowledgement>;
	inspectProgress(taskId: string): PiProgressEvidence;
	diagnostics(): {
		mode: "wake+batch" | "polling(forced)" | "polling(fallback)";
		watcherCount: number;
	};
	shutdown(
		reason: "reload" | "new" | "resume" | "fork" | "quit" | undefined,
	): Promise<void>;
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
		"surfaceProvider" | "supervision" | "processProbe"
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
	probe: ProcessIdentityProbe | undefined,
): DelegatedMarkers | undefined {
	// Injected infrastructure never falls back to the ambient Herdr socket.
	if (infrastructure) {
		const write = infrastructure.markerWriter;
		return write ? new DelegatedMarkers({ write, probe }) : undefined;
	}
	const socketPath = process.env.HERDR_SOCKET_PATH;
	return socketPath
		? new DelegatedMarkers({ write: herdrMarkerWriter(socketPath), probe })
		: undefined;
}

// Capture only resume presentation scalars, not the child or its owning registry.
function resumeResultReader(
	sessionFile: string,
	cursor: number,
	exitCode: number,
	errorMessage: string | undefined,
): NonNullable<PiSettlementIO["readResumeResult"]> {
	return () => ({
		summary:
			findLastAssistantMessage(getNewEntries(sessionFile, cursor)) ??
			(errorMessage
				? `Subagent error: ${errorMessage}`
				: exitCode === 0
					? "Resumed session exited without new output"
					: `Resumed session exited with code ${exitCode}`),
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
	state.markers ??= createDelegatedMarkers(
		options.infrastructure,
		state.infrastructure.processProbe,
	);
	// Turning the setting off retires every marker now, pending ones included;
	// a retired marker never writes live again, even if the setting returns.
	if (!options.sidebarMarkers)
		for (const entry of state.entries.values()) entry.marker?.retire();

	/** Markers for new launches, only while the sidebar setting is on. */
	function enabledMarkers(): DelegatedMarkers | undefined {
		return state.options.sidebarMarkers ? state.markers : undefined;
	}

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
			recordProcessIdentity: enabledMarkers() !== undefined,
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
			entry.marker = enabledMarkers()?.attach(child);
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
			finalize: async (result) => {
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
				const summary = evidence
					? (findLastAssistantMessage(
							cursor === undefined ? all : all.slice(cursor),
						) ??
						(evidence.errorMessage
							? `Subagent error: ${evidence.errorMessage}`
							: exitCode === 0
								? cursor === undefined
									? "Sub-agent exited without output"
									: "Resumed session exited without new output"
								: `${cursor === undefined ? "Sub-agent" : "Resumed session"} exited with code ${exitCode}`))
					: result.outcome === "killed"
						? "Subagent cancelled."
						: `Subagent error: ${result.error}`;
				let worktree: PiWorktreeHandoff | undefined;
				if (child.worktree) {
					worktree = state.worktreeOperations.captureWorktreeHandoff(
						child.worktree,
					);
					try {
						// Only confirmed termination is a cancellation. Shutdown suppression
						// of an unconfirmed cancel records what a plain shutdown would.
						state.worktreeOperations.persistWorktreeResult(
							child.worktree,
							result.cancellation?.termination === "confirmed"
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
					exitCode === 0
						? markCompleted(child.lifecycle, at)
						: markFailed(child.lifecycle, summary, at, exitCode);
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
					logicalId: child.logicalId,
					generationId: child.generationId,
					policyHash: child.policyHash,
				};
				if (cursor !== undefined)
					entry.readResumeResult = resumeResultReader(
						child.sessionFile,
						cursor,
						exitCode,
						evidence?.errorMessage,
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
			async spawnAttempt(_spawn: SpawnOptions, index) {
				const plan = input.plans[index];
				attempts.push(plan.model);
				const acquisition = { taskId: input.task.id, suppressed: false };
				state.pending.add(acquisition);
				try {
					const current = input.prepareAttempt?.(index) ?? {
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
					const owner = adapter(current.snapshot);
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
	const io: PiPersistentIO = {
		inspectWorktree: (r) =>
			r.worktree
				? state.worktreeOperations.captureWorktreeHandoff(r.worktree)
				: undefined,
		readEvents: (r) => readPersistentTaskEvents(r.sessionFile),
		readLedger: (r) => readPersistentDeliveryLedger(r.sessionFile),
		readTaskSummary: (r) =>
			existsSync(r.sessionFile)
				? (findLastAssistantMessage(getNewEntries(r.sessionFile, 0)) ??
					"Persistent specialist completed without output.")
				: "Persistent specialist session is unavailable.",
		rejectBusy(r, task) {
			ledger(r, task, "rejected-busy");
		},
		dispatch(r, task, text) {
			const inbox = writePersistentTaskInbox(
				r.sessionFile,
				(r.inboxSequence = (r.inboxSequence ?? 0) + 1),
				{ task, message: text },
			);
			r.taskId = task;
			ledger(r, task, "dispatched");
			return inbox;
		},
		requestStop(r) {
			const task = r.taskId ?? "stop";
			if (r.taskId) ledger(r, task, "stop-pending");
			writePersistentTaskInbox(
				r.sessionFile,
				(r.inboxSequence = (r.inboxSequence ?? 0) + 1),
				{ type: "stop", task, message: "" },
			);
		},
		acknowledge(r, event) {
			const row = ledger(
				r,
				event.task,
				event.type === "help-request" ? "help-requested" : "delivered",
			);
			if (r.taskId === event.task) r.taskId = undefined;
			if (event.type === "task-done")
				r.tasksCompleted = (r.tasksCompleted ?? 0) + 1;
			return row;
		},
		recordStopped(r) {
			ledger(r, "stop", "stopped");
		},
	};
	function ledger(
		r: PiRunRecord,
		task: string,
		outcome: PiLedgerEntry["outcome"],
	): PiLedgerEntry {
		return appendPersistentDeliveryLedger(r.sessionFile, {
			task,
			outcome,
			generation: r.generationId!,
			logicalId: r.logicalId!,
			policyHash: r.policyHash!,
		});
	}
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
