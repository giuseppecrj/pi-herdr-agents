import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	PiRunSession,
	PiProgressEvidence,
	SummarySource,
} from "../../maestro/runtime/index.ts";
import type { ResolvedRuntimePlan } from "../../maestro/core/routing.ts";
import type { SubagentStatusState } from "../../maestro/core/status.ts";
import type { SubagentActivityState } from "../../maestro/core/types.ts";
import type {
	LifecycleProjection,
	SubagentLifecycle,
} from "../../maestro/core/lifecycle.ts";
import { SUBAGENT_RUNTIME_KEY } from "../../maestro/core/undelivered-children.ts";
import type {
	WorktreeHandoff,
	WorktreeLaunch,
} from "../../maestro/core/worktree.ts";

// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
export const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
export const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
export const RUNTIME_KEY = SUBAGENT_RUNTIME_KEY;

export function readGlobalSlot<T>(key: symbol): T | undefined {
	// SAFETY: `globalThis` has no index signature for our extension-private
	// symbol keys; only this module ever writes the values read back here.
	return (globalThis as Record<symbol, T | undefined>)[key];
}

export function writeGlobalSlot<T>(key: symbol, value: T): void {
	// SAFETY: see readGlobalSlot above; this module is the sole writer.
	(globalThis as Record<symbol, T | undefined>)[key] = value;
}

export type NoProgressClassification = PiProgressEvidence["classification"];
export type NoProgressSessionTail = Pick<
	PiProgressEvidence,
	"classification" | "lastEntryKind"
>;

export interface ModelFailure {
	model: string;
	error: string;
}

/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	summarySource: SummarySource;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	error?: string;
	/** Settled provider/agent error text from the child, preserved verbatim. */
	errorMessage?: string;
	/** Ordered models launched for this run, including failed fallback attempts. */
	fallbackAttempts?: string[];
	/** Ordered raw errors associated with failed model attempts. */
	fallbackFailures?: ModelFailure[];
	ping?: { name: string; message: string };
	worktree?: WorktreeHandoff;
	runtimePlan?: ResolvedRuntimePlan;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
export interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile?: string;
	activityFile?: string;
	activity?: SubagentActivityState;
	activityRead?: {
		ok: boolean;
		reason?: "missing" | "invalid" | "wrong-id";
		error?: string;
	};
	abortController?: AbortController;
	/**
	 * Optional legacy status snapshot retained only for hydrating pre-lifecycle
	 * runtime entries after /reload. Live observation uses `lifecycle` only.
	 */
	statusState?: SubagentStatusState;
	lifecycle: SubagentLifecycle;
	/** Last projected kind used to detect stalled/recovered transitions. */
	lastProjectedKind?: LifecycleProjection["kind"];
	/** One active no-progress warning episode, reset when durable progress resumes. */
	noProgressEpisode?: {
		active: true;
		progressAt: number;
		idleMs: number;
		classification: NoProgressClassification;
		lastEntryKind: NoProgressSessionTail["lastEntryKind"];
	};
	/**
	 * When true, status transitions (stalled/recovered) do not wake the parent
	 * session via a steer message. The widget still updates locally. Used for
	 * long-running agents where the user drives the conversation in the
	 * subagent's pane.
	 */
	interactive: boolean;
	/** Parent-resolved model/thinking selection and provenance. */
	runtimePlan: ResolvedRuntimePlan | undefined;
	worktree?: WorktreeLaunch;
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
	stopTimeout?: ReturnType<typeof setTimeout>;
	stopTimeoutMs?: number;
	crashNotified?: boolean;
	cancelState?: "requested" | "confirmed" | "unconfirmed";
}

/**
 * A completion that settled while no live parent API was bound. Its running row
 * stays delivery-pending and RunSession keeps ownership until it is released.
 */
export interface HeldDelivery {
	/** Running-row id of the held completion. */
	id: string;
	/** Resume with the replacement's live API, or `undefined` when the parent exits. */
	release(api: ExtensionAPI | undefined): void;
}

export interface SubagentRuntime {
	runningSubagents: Map<string, RunningSubagent>;
	session?: PiRunSession;
	/** The latest loaded extension API; it can be unbound or already invalidated. */
	pi?: ExtensionAPI;
	latestCtx?: ExtensionContext;
	/**
	 * The parent API proven live: bound at session_start and by this load's own
	 * tool calls, cleared at session_shutdown before Pi invalidates it. Absent
	 * across a reload or session-replacement gap, when nothing may be sent.
	 */
	liveApi?: ExtensionAPI;
	/** Completions held during a gap, released in settle order. Optional for older slots. */
	heldDeliveries?: HeldDelivery[];
	modelCatalog?: string;
}

/** Bind the live parent API and release every completion held for it. */
export function bindLiveApi(runtime: SubagentRuntime, api: ExtensionAPI): void {
	runtime.liveApi = api;
	releaseHeldDeliveries(runtime, api);
}

/** Wait for the next live parent API; `undefined` means the parent exited. */
export function holdDelivery(
	runtime: SubagentRuntime,
	id: string,
): Promise<ExtensionAPI | undefined> {
	return new Promise((release) => {
		(runtime.heldDeliveries ??= []).push({ id, release });
	});
}

/** Release each held completion exactly once, in settle order. */
export function releaseHeldDeliveries(
	runtime: SubagentRuntime,
	api: ExtensionAPI | undefined,
): void {
	for (const held of runtime.heldDeliveries?.splice(0) ?? []) held.release(api);
}

/**
 * Any running subagent except a persistent specialist idle between tasks or
 * one whose stop failed, which may never leave the table.
 */
export function hasWorkingSubagents(
	subagents: Iterable<RunningSubagent>,
): boolean {
	for (const running of subagents) {
		if (running.stopState === "failed") continue;
		if (running.persistent && !running.taskId && !running.stopState) continue;
		return true;
	}
	return false;
}

export function shouldDeliverSubagentCompletion(
	running: Pick<RunningSubagent, "lifecycle">,
): boolean {
	// Authoritative gate: only pending deliveries may be sent.
	// Missing lifecycle (pre-migration fixtures) defaults to pending/true.
	return (running.lifecycle?.delivery ?? "pending") === "pending";
}

export function selectCompletionApi<T>(previous: T, current: T | undefined): T {
	return current ?? previous;
}
