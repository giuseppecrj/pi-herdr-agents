/**
 * The HarnessAdapter seam: the single interface every agent engine implements.
 *
 * This is the inversion the product is built on. Today the engines are Pi and
 * (stubbed) Claude Code; tomorrow any agent CLI is "just" a subprocess with a
 * prompt interface. The orchestration core never knows which one it drives.
 *
 * Dependency direction: adapters import @ephemeralabs/maestro-core (for types) and never
 * the reverse. Adapters also never import @ephemeralabs/maestro-surfaces; when an agent
 * should run inside a multiplexer pane, the CLI passes a core-defined
 * SurfaceHandle in SpawnOptions.surface.
 */
import type {
	AgentHandle,
	AgentState,
	CompletionEvidence,
	Role,
	SurfaceHandle,
	Task,
	Worktree,
	WorktreeSpec,
} from "./types.ts";

export interface SpawnOptions {
	/** Launch admission only, never proof of remote cancellation. */
	acquisitionSignal?: AbortSignal;
	name: string;
	/** Full task text for the agent. */
	task: string;
	role: Role;
	/** Directory the agent works in (worktree path when isolated). */
	cwd: string;
	sessionId: string;
	worktree?: Worktree;
	// pi-herdr-agents extension
	/** Unprovisioned launch request. Pi resolves base and writes the ownership manifest before resource acquisition. */
	worktreeRequest?: WorktreeSpec;
	interactive?: boolean;
	timeoutMs?: number;
	/** When set, run the agent's command through this multiplexer surface
	 *  instead of spawning a direct subprocess. */
	surface?: SurfaceHandle;
	/** Extra environment for the agent process. */
	env?: Record<string, string>;
	// pi-herdr-agents extension: carried from Task, see 4.1
	runtime?: Task["runtime"];
	// pi-herdr-agents extension
	session?: Task["session"];
	// pi-herdr-agents extension
	behavior?: Task["behavior"];
	// pi-herdr-agents extension
	tools?: string[];
	// pi-herdr-agents extension
	systemPrompt?: string;
	/** Validated accept check for the child's own loop and the parent re-check. */
	// pi-herdr-agents extension
	accept?: Task["accept"];
}

// pi-herdr-agents extension
export interface ResumeOptions {
	acquisitionSignal?: AbortSignal;
	name: string;
	/** Harness session reference to resume; for Pi, the session file path. */
	sessionId: string;
	message?: string;
	tools?: string[];
	autoExit?: boolean;
	surface?: SurfaceHandle;
	env?: Record<string, string>;
}

export interface HarnessAdapter {
	/** Stable adapter name, e.g. "pi". Recorded on AgentHandle.harness. */
	readonly name: string;

	/** False when the harness CLI is not installed. Never throws. */
	isAvailable(): boolean;

	/**
	 * Spawn one agent. Returns immediately; the agent runs in the background.
	 * Must be non-blocking: supervision happens through the probe/actions.
	 */
	spawn(opts: SpawnOptions): Promise<AgentHandle>;

	/** Probe the agent's coarse state. Pure observation; never mutates. */
	getState(handle: AgentHandle): Promise<AgentState>;

	/** Ask the agent to stop its current turn (e.g. SIGINT). The session
	 *  survives; the agent may continue on the next turn. */
	interrupt(handle: AgentHandle): Promise<void>;

	/** Terminate the agent process. Irreversible. */
	kill(handle: AgentHandle): Promise<void>;

	/** Feed follow-up text to a running agent. */
	sendInput(handle: AgentHandle, text: string): Promise<void>;

	/** Read recent output (tail). Used for result collection and the TUI. */
	readOutput(handle: AgentHandle, lines?: number): Promise<string>;

	/**
	 * Exit code of a finished agent. Optional: harnesses that cannot observe
	 * it (spool-based, remote sessions) omit this and every "done" still maps
	 * to "completed". When present and nonzero, the supervisor reports the run
	 * as "failed" instead of "completed".
	 */
	exitCode?(handle: AgentHandle): number | undefined;

	// pi-herdr-agents extension
	resume(opts: ResumeOptions): Promise<AgentHandle>;

	/**
	 * Resolve when the agent's run has ended, with the evidence the harness
	 * can observe. Driven by wake-ups and sidecar evidence, not polling.
	 * Rejects on abort.
	 */
	// pi-herdr-agents extension
	awaitCompletion(
		handle: AgentHandle,
		signal: AbortSignal,
	): Promise<CompletionEvidence>;
}
