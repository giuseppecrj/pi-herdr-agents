/**
 * Harness-agnostic orchestration domain types.
 *
 * This module (and all of @ephemeralabs/maestro-core) must not import from
 * @ephemeralabs/maestro-adapters, @ephemeralabs/maestro-surfaces, @ephemeralabs/maestro-cli, or @ephemeralabs/maestro-tui.
 * See ARCHITECTURE.md. `check-deps` enforces it.
 */

/** Coarse agent lifecycle state, deliberately small: every harness adapter
 *  must be able to project its own richer states onto these five. */
export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";

// pi-herdr-agents extension
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface WorktreeSpec {
	/** New branch to create for the isolated checkout. */
	branch: string;
	/** Git ref the worktree starts from. Defaults to HEAD. */
	base?: string;
}

export interface Task {
	id: string;
	name: string;
	/** Full task text handed to the agent. */
	prompt: string;
	/** Role name, resolved through the role-pack loader. */
	role: string;
	/** Repository root the task runs against. */
	cwd: string;
	/** When set, the task runs inside an isolated git worktree. */
	worktree?: WorktreeSpec;
	timeoutMs?: number;
	/**
	 * Extra environment for the agent process, keyed by variable name.
	 * The CLI merges task-file `env` over `--env` flags (task wins); each
	 * adapter decides how to deliver it (subprocess env, spool envelope,
	 * surface command prefix). Core passes it through untouched.
	 */
	env?: Record<string, string>;
	// pi-herdr-agents extension
	runtime?: {
		model: string;
		thinking: ThinkingLevel;
		/** Ordered candidates tried after a launch failure or a running child's
		 *  provider error; today's launchSubagentWithFallbacks (index.ts:2631). */
		fallbacks?: { model: string; thinking: ThinkingLevel }[];
	};
	// pi-herdr-agents extension
	session?: {
		mode: "standalone" | "lineage-only" | "fork";
		parentSessionId?: string;
	};
	// pi-herdr-agents extension
	behavior?: {
		persistent?: boolean;
		autoExit?: boolean;
		interactive?: boolean;
		systemPromptMode?: "replace" | "append";
		skills?: string[];
		denyTools?: string[];
	};
	/** Explicit tool allowlist; overrides Role.allowedTools when set. */
	// pi-herdr-agents extension
	tools?: string[];
	/** Explicit system prompt; overrides Role.systemPrompt when set. */
	// pi-herdr-agents extension
	systemPrompt?: string;
}

/**
 * A versioned, installable role definition: name, version, description, the
 * full prompt body, and an optional harness-level tool allowlist.
 *
 * The contract is deliberately small: every field must be honored by at
 * least one adapter. Former fields `deniedTools`, `spawning`, `autoExit`,
 * and `systemPromptMode` were deleted because no harness in scope honors
 * them — an unhonored contract field is worse than no field.
 */
export interface Role {
	name: string;
	version: string;
	description: string;
	/** Full role prompt body (markdown). */
	systemPrompt: string;
	/** Harness-level tool allowlist. Empty means "harness default". */
	allowedTools: string[];
	// pi-herdr-agents extension
	defaults?: {
		model?: string;
		thinking?: ThinkingLevel;
		sessionMode?: "standalone" | "lineage-only" | "fork";
		spawning?: boolean;
		selfSpawn?: boolean;
		autoExit?: boolean;
		interactive?: boolean;
		persistent?: boolean;
		systemPromptMode?: "replace" | "append";
		denyTools?: string[];
		skills?: string[];
		cwd?: string;
	};
	/** Where the definition came from: project, global, or role pack. */
	// pi-herdr-agents extension
	source?: string;
}

export type WorktreeState =
	| "provisioning"
	| "provisioned"
	| "running"
	| "ready_for_review"
	| "failed"
	| "needs_help"
	// pi-herdr-agents extension
	| "cancelled"
	| "removed";

export interface WorktreeOwnership {
	/** Run id that owns this worktree. */
	id: string;
	owner: "maestro";
	branch: string;
	baseRef: string;
	baseSha: string;
	createdAt: number;
}

export interface Worktree extends WorktreeOwnership {
	path: string;
	state: WorktreeState;
	manifestFile: string;
}

/**
 * Structural seam for "run this agent's process inside a multiplexer pane".
 * Defined in core so adapters can accept it without importing surfaces.
 * The surfaces package produces implementations; the CLI wires them together.
 */
export interface SurfaceHandle {
	id: string;
	runCommand(command: string): void | Promise<void>;
	readScreen(lines?: number): string | Promise<string>;
	/**
	 * Send keystrokes to the surface by key name (e.g. "C-c", "Enter",
	 * "Escape"). Harness adapters use this for interrupt semantics on
	 * surface-hosted agents (Ctrl-C mid-turn). Optional: providers without a
	 * key-sending primitive omit it, and the adapter throws a clear error.
	 */
	sendKeys?(keys: string): void | Promise<void>;
	/**
	 * Destroy the surface (close the pane/tab). Harness adapters use this for
	 * kill semantics on surface-hosted agents. Optional for the same reason
	 * as `sendKeys`: absent means the provider cannot tear down the surface.
	 */
	close?(): void | Promise<void>;
}

export interface AgentHandle {
	id: string;
	name: string;
	role: string;
	/** Adapter name that spawned this agent, e.g. "pi". */
	harness: string;
	cwd: string;
	startedAt: number;
	sessionId: string;
	/** Set when the agent runs inside a multiplexer surface. */
	surfaceId?: string;
	/** Direct-spawn bookkeeping (pid) when no surface is used. */
	pid?: number;
	worktree?: Worktree;
}

// pi-herdr-agents extension
export type RunOutcome = "completed" | "failed" | "timeout" | "killed" | "help";

// pi-herdr-agents extension
export interface CompletionResult {
	reason: "done" | "ping" | "sentinel" | "error";
	exitCode: number;
	ping?: { name: string; message: string };
	errorMessage?: string;
}

// pi-herdr-agents extension
export interface WorktreeHandoff {
	path: string;
	branch: string;
	baseRef: string;
	baseSha: string;
	manifestFile: string;
	sessionFile?: string;
	sourceSessionFile?: string;
	handoffMessage?: string;
	headSha: string | null;
	commitsAhead: number | null;
	clean: boolean | null;
	conflicted: boolean | null;
	changedFiles: string[] | null;
	untrackedFiles: string[] | null;
	gitError?: string;
}

// pi-herdr-agents extension
export interface CompletionEvidence {
	reason: "done" | "ping" | "sentinel" | "error";
	/** Required harness exit status from CompletionResult. */
	// pi-herdr-agents extension
	exitCode: number;
	ping?: { name: string; message: string };
	errorMessage?: string;
	finalMessage?: { text: string; stopReason?: string; errorMessage?: string };
	/** Harness session reference; for Pi, the session file path. */
	// pi-herdr-agents extension
	sessionRef?: string;
	worktree?: WorktreeHandoff;
}

export interface RunResult {
	handle: AgentHandle;
	outcome: RunOutcome;
	exitCode?: number;
	/** Tail of captured output. */
	output?: string;
	error?: string;
	durationMs: number;
	// pi-herdr-agents extension
	evidence?: CompletionEvidence;
	/** Present only for operator cancellation; the outcome is then "killed". */
	// pi-herdr-agents extension
	cancellation?: RunCancellation;
}

/**
 * Operator cancellation provenance. A delivered cancellation is always
 * confirmed: unconfirmed termination keeps the run live instead of settling.
 */
// pi-herdr-agents extension
export interface RunCancellation {
	/** When the terminal intent was recorded, before any abort or kill. */
	requestedAt: number;
	/** "confirmed" only after the owning adapter's kill resolved. */
	termination: "confirmed" | "unconfirmed";
	confirmedAt?: number;
	/** Last kill failure while termination remains unconfirmed. */
	error?: string;
}

// pi-herdr-agents extension
export type SurfaceAgentStatus =
	| "idle"
	| "working"
	| "blocked"
	| "done"
	| "unknown";

// pi-herdr-agents extension
export type PaneInspection =
	| {
			kind: "present";
			agent?: string;
			agentStatus: SurfaceAgentStatus;
			observedAt: number;
	  }
	| { kind: "missing"; error?: string }
	| { kind: "unavailable"; error?: string };

// pi-herdr-agents extension
export type ProcessState =
	| { kind: "starting"; startedAt: number }
	| { kind: "running"; startedAt: number; confirmedAt: number }
	| {
			kind: "finalizing";
			startedAt: number;
			detectedAt: number;
			completion: CompletionResult;
	  }
	| {
			kind: "completed";
			startedAt: number;
			detectedAt: number;
			completedAt: number;
			completion: CompletionResult;
	  }
	| {
			kind: "failed";
			startedAt: number;
			detectedAt: number;
			completedAt: number;
			error: string;
			exitCode?: number;
	  };

// pi-herdr-agents extension
export type SubagentActivityPhase = "starting" | "active" | "waiting" | "done";
// pi-herdr-agents extension
export type SubagentActivityScope =
	| "agent"
	| "turn"
	| "provider"
	| "streaming"
	| "tool";

// pi-herdr-agents extension
export type SubagentActivityEvent =
	| "session_start"
	| "input"
	| "before_agent_start"
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "before_provider_request"
	| "after_provider_response"
	| "message_update"
	| "tool_execution_start"
	| "tool_call"
	| "tool_execution_update"
	| "tool_result"
	| "tool_execution_end"
	| "caller_ping"
	| "subagent_done"
	| "session_shutdown";

// pi-herdr-agents extension
export interface SubagentActivityState {
	version: 1;
	runningChildId: string;
	createdAt: number;
	updatedAt: number;
	sequence: number;
	latestEvent: SubagentActivityEvent;
	phase: SubagentActivityPhase;
	agentActive: boolean;
	turnActive: boolean;
	providerActive: boolean;
	toolActive: boolean;
	activeScope?: SubagentActivityScope;
	activeSince?: number;
	waitingSince?: number;
	turnIndex?: number;
	messageEventType?: string;
	toolCallId?: string;
	toolName?: string;
	toolStartedAt?: number;
	toolEndedAt?: number;
}

// pi-herdr-agents extension
export type ActivityReadResult =
	| { ok: true; activity: SubagentActivityState }
	| { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

// pi-herdr-agents extension
export type ActivityDetail =
	| { kind: "none"; observedAt: number }
	| {
			kind: "scope";
			scope: SubagentActivityScope;
			label?: string;
			since: number;
			observedAt: number;
			sequence: number;
	  };

// pi-herdr-agents extension
export type TurnState =
	| { kind: "unknown" }
	| { kind: "starting"; observedAt: number }
	| {
			kind: "active";
			startedAt: number;
			source: "activity" | "herdr" | "fallback";
			activity?: ActivityDetail;
	  }
	| { kind: "blocked"; startedAt: number }
	| { kind: "waiting"; startedAt: number }
	| {
			kind: "interrupted";
			requestedAt: number;
			previousActivitySequence: number | null;
	  };

// pi-herdr-agents extension
export type ActivityHealth =
	| { kind: "unseen" }
	| { kind: "healthy"; observedAt: number }
	| {
			kind: "problem";
			reason: "missing" | "invalid" | "wrong-id";
			since: number;
			error?: string;
	  };

// pi-herdr-agents extension
export type PaneObservation =
	| { kind: "unknown" }
	| { kind: "present"; observedAt: number; agentStatus: SurfaceAgentStatus }
	| {
			kind: "read-error";
			firstFailedAt: number;
			lastFailedAt: number;
			consecutiveFailures: number;
			error?: string;
	  }
	| { kind: "missing"; detectedAt: number; error?: string };

// pi-herdr-agents extension
export type CompletionDelivery = "pending" | "delivered" | "suppressed";

// pi-herdr-agents extension
export interface SubagentLifecycle {
	process: ProcessState;
	turn: TurnState;
	activityHealth: ActivityHealth;
	/** Latest optional Pi detail, independent of Herdr coarse turn state. */
	activityDetail: ActivityDetail | null;
	pane: PaneObservation;
	/** Durable across unavailable/missing observations. */
	hasWorked: boolean;
	lastActivitySequence: number | null;
	delivery: CompletionDelivery;
}

// pi-herdr-agents extension
export interface LifecycleProjection {
	kind:
		| "starting"
		| "running"
		| "active"
		| "blocked"
		| "waiting"
		| "interrupted"
		| "stalled"
		| "finalizing"
		| "completed"
		| "failed";
	label?: string;
	runtimeEndedAt?: number;
	stateDurationSince?: number;
}
