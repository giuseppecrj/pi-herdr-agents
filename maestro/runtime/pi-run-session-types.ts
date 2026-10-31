import type {
	AgentHandle,
	Task,
	Role,
	ThinkingLevel,
	SurfaceHandle,
	SubagentLifecycle,
	RunResult,
} from "../core/types.ts";
import type {
	SurfaceProvider,
	WorktreeSurfaceInfo,
} from "../core/surface-provider.ts";
import type { ProcessIdentityProbe } from "../adapters/pi/process-identity.ts";
import type { AcceptRunner } from "../adapters/pi/accept-runner.ts";
import type { AcceptOutcome, AcceptSpec } from "../core/accept.ts";
import type { PiLaunchOperations } from "../adapters/pi/launch-operations.ts";
import type {
	WorktreeOperations,
	WorktreeLaunch,
	WorktreeHandoff,
} from "../core/worktree.ts";
import type { WorktreeCleanupOperations } from "../core/worktree-cleanup.ts";
import type {
	AttributedSummary,
	SummarySource,
} from "../adapters/pi/session.ts";
import type { SupervisionCoordinator } from "../core/supervision.ts";
import type {
	ParentRuntime,
	ResolvedRuntimePlan,
	ModelRegistryAdapter,
} from "../core/routing.ts";
import type { PaneConfig } from "../core/config/pane-config.ts";
import type { MarkerSessionReader, MarkerWriter } from "./delegated-marker.ts";
import type {
	RunSession,
	RunObservation,
	DeliveryDecision,
} from "./run-session.ts";

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
	/**
	 * Existing host normalization may re-read role files for each actual retry
	 * launch, and may wait (for example, across a parent reload) before it does.
	 */
	prepareAttempt?(
		candidateIndex: number,
		cancelled: AbortSignal,
	): PiAttemptSnapshot | Promise<PiAttemptSnapshot>;
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
	launchFailure?: string;
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
	/** Task IDs this parent dispatched; the child-writable ledger never decides. */
	issuedTaskIds?: string[];
	inboxSequence?: number;
	observedTaskEvents?: number;
	stopState?: "requested" | "pending" | "failed";
	stopFailure?: string;
	crashNotified?: boolean;
	/** Presentation of the latest operator cancel; the kernel owns the intent. */
	cancelState?: "requested" | "confirmed" | "unconfirmed";
	/** Where the child runs; the accept re-check runs here. */
	cwd?: string;
	accept?: AcceptSpec;
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
	status: "started" | "uncertain";
	launchFailure?: string;
}
// pi-herdr-agents extension
export interface PiCompletedMetadata {
	run: RunResult;
	name: string;
	task: string;
	agent?: string;
	summary: string;
	summarySource: SummarySource;
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
	/** The verdict; absent means no check was requested (`none`). */
	accept?: AcceptOutcome;
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
	inspectWorktree(record: PiRunRecord): Promise<PiWorktreeHandoff | undefined>;
	/** Explicit lazy read, once per drain with eligible post-cursor events. */
	readLedger(record: PiRunRecord): PiLedgerEntry[];
	/** Transcript read only for an undelivered task-done, never help/quiet wakes. */
	readTaskSummary(record: PiRunRecord): AttributedSummary;
	rejectBusy(record: PiRunRecord, task: string): void;
	dispatch(record: PiRunRecord, task: string, text: string): string;
	requestStop(record: PiRunRecord): void;
	acknowledge(record: PiRunRecord, event: PiPersistentEvent): PiLedgerEntry;
	recordStopped(record: PiRunRecord): void;
}
/** Run-scoped settlement I/O; only resumed acquisitions supply the late reader. */
// pi-herdr-agents extension
export interface PiSettlementIO extends PiPersistentIO {
	readResumeResult?(): AttributedSummary & { sessionFile: string };
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
	/** The parent accept re-check's command runner; tests inject it. */
	acceptRunner?: AcceptRunner;
	/** Sidebar marker transport; defaults to this pane's Herdr socket. */
	markerWriter?: MarkerWriter;
	/** Sidebar marker session evidence; defaults to this pane's Herdr socket. */
	markerSessionReader?: MarkerSessionReader;
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
	/** Append one outcome-ledger line per model attempt. Default true. */
	outcomeLedger?: boolean;
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
