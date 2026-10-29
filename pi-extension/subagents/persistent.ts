import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type {
	PiRunRecord,
	PiPersistentIO,
} from "../../maestro/runtime/index.ts";
import type { PersistentConfig } from "../../maestro/core/config/persistent-config.ts";
import { projectLifecycle } from "../../maestro/core/lifecycle.ts";
import type { WorktreeHandoff } from "../../maestro/core/worktree.ts";
import {
	type RunningSubagent,
	type SubagentRuntime,
	selectCompletionApi,
} from "./state.ts";
import { ensureLifecycle } from "./observation.ts";
import type { Controls } from "./controls.ts";

export function asPiRecord(running: RunningSubagent): PiRunRecord {
	// SAFETY: live rows are the adapter's actual records. Legacy presentation
	// fixtures omit script/activity paths, which persistent I/O never consumes.
	return running as PiRunRecord;
}

export function persistentSpecialistState(
	running: RunningSubagent,
): "idle" | "working" | "stalled" | "stopped" {
	const projection = projectLifecycle(
		ensureLifecycle(running),
		Date.now(),
	).kind;
	if (running.stopState === "failed") return "stalled";
	if (running.stopState)
		return projection === "stalled" ? "stalled" : "working";
	if (running.taskId) return projection === "stalled" ? "stalled" : "working";
	// Persistent task completion is authoritative for logical specialist state.
	// Herdr can continue reporting the long-lived Pi pane as working while the
	// process remains open between turns.
	if (running.persistent && running.tasksCompleted != null) return "idle";
	if (projection === "stalled") return "stalled";
	if (
		projection === "active" ||
		projection === "blocked" ||
		projection === "starting" ||
		projection === "running"
	)
		return "working";
	if (
		projection === "completed" ||
		projection === "failed" ||
		projection === "finalizing"
	)
		return "stopped";
	return "idle";
}

interface SubagentSendDetails {
	error?: string;
	id?: string;
	task?: string;
	inbox?: string;
	outcome?: "dispatched" | "rejected-busy";
}

interface PersistentSpecialistFacts {
	logicalId: string;
	generationId: string;
	policyHash: string;
	tasks: Array<{ task: string; outcome: string }>;
	sessionFile: string;
	worktree?: WorktreeHandoff;
	lastObservedPhase: string;
}

export function persistentSpecialistFacts(
	running: RunningSubagent,
	io: PiPersistentIO,
	worktree?: WorktreeHandoff,
): PersistentSpecialistFacts {
	const facts: PersistentSpecialistFacts = {
		logicalId: running.logicalId!,
		generationId: running.generationId!,
		policyHash: running.policyHash!,
		tasks: io.readLedger(asPiRecord(running)).map((entry) => ({
			task: entry.task,
			outcome: entry.outcome,
		})),
		sessionFile: running.sessionFile,
		lastObservedPhase: projectLifecycle(ensureLifecycle(running), Date.now())
			.kind,
	};
	if (worktree) facts.worktree = worktree;
	return facts;
}

export function formatPersistentSpecialistFacts(
	facts: PersistentSpecialistFacts,
): string {
	const lines = [
		`Logical ID: ${facts.logicalId}`,
		`Generation ID: ${facts.generationId}`,
		`Policy hash: ${facts.policyHash}`,
		`Task outcomes: ${facts.tasks.map((task) => `${task.task}=${task.outcome}`).join(", ") || "none"}`,
		`Session: ${facts.sessionFile}`,
		`Last observed phase: ${facts.lastObservedPhase}`,
	];
	if (facts.worktree)
		lines.push(
			`Worktree Git state: ${facts.worktree.gitError ? "unknown" : facts.worktree.conflicted ? "conflicted" : facts.worktree.clean ? "clean" : "dirty"}`,
		);
	return lines.join("\n");
}

function sendPersistentStopFailure(
	api: Pick<ExtensionAPI, "sendMessage">,
	running: RunningSubagent,
	io: PiPersistentIO,
): void {
	const facts = persistentSpecialistFacts(
		running,
		io,
		io.inspectWorktree(asPiRecord(running)),
	);
	api.sendMessage(
		{
			customType: "subagent_stop",
			content: `Persistent specialist stop failed: process exit was not confirmed. Evidence is retained.\n\n${formatPersistentSpecialistFacts(facts)}`,
			display: true,
			details: { status: "failed", facts },
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

interface SubagentStopDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: "stop_requested" | "stop_pending";
}

interface PersistentControlDeps {
	runtime: SubagentRuntime;
	persistentConfig: PersistentConfig;
	resolveInterruptTarget: Controls["resolveInterruptTarget"];
}

/** Persistent specialist controls bound to one extension instance. */
export function createPersistentControls({
	runtime,
	persistentConfig,
	resolveInterruptTarget,
}: PersistentControlDeps) {
	const runningSubagents = runtime.runningSubagents;

	function formatLivePersistentSpecialists(): string[] {
		const specialists = Array.from(runningSubagents.values()).filter(
			(running) => running.persistent,
		);
		if (specialists.length === 0) return [];
		return [
			"Live persistent specialists:",
			...specialists.map((running) => {
				const allowlist = running.policyTools?.join(",") ?? "unrestricted";
				return `• ${running.name} | ${running.logicalId} | ${running.generationId} | ${running.agent ?? "bare"} | ${persistentSpecialistState(running)} | ${running.tasksCompleted ?? 0} completed | tools: ${allowlist}; denied: ${running.policyDeniedTools?.join(",") || "none"}; persistent: true`;
			}),
		];
	}

	function resolvePersistentTarget(params: { id?: string; name?: string }) {
		const resolved = resolveInterruptTarget(params);
		if ("error" in resolved) return resolved;
		if (!resolved.running.persistent) {
			return {
				error: `Subagent "${resolved.running.name}" is not persistent.`,
			};
		}
		return resolved;
	}

	function persistentCapacityError(
		config: PersistentConfig = persistentConfig,
	): string | undefined {
		const specialists = Array.from(runningSubagents.values()).filter(
			(running) => running.persistent,
		);
		if (specialists.length < config.maxAgents) return undefined;
		return `Persistent specialist cap (${config.maxAgents}) reached. Current specialists: ${specialists.map((running) => `${running.name} (${persistentSpecialistState(running)}, ${running.tasksCompleted ?? 0} completed)`).join(", ")}.`;
	}

	function startPersistentStopTimeout(
		running: RunningSubagent,
		api: Pick<ExtensionAPI, "sendMessage">,
		stopTimeoutMs = 15_000,
		io: PiPersistentIO,
	): void {
		if (
			running.stopTimeout ||
			(running.stopState !== "requested" && running.stopState !== "pending")
		)
			return;
		running.stopTimeout = setTimeout(() => {
			running.stopTimeout = undefined;
			if (!runningSubagents.has(running.id)) return;
			if (
				running.stopState === "requested" ||
				running.stopState === "pending"
			) {
				running.stopState = "failed";
				running.stopFailure =
					"process exit was not confirmed within the bounded stop wait";
				const completionApi = runtime.session?.getControlTaskId(running.id)
					? selectCompletionApi(api, runtime.pi)
					: api;
				sendPersistentStopFailure(completionApi, running, io);
			}
		}, stopTimeoutMs);
		running.stopTimeout.unref();
	}

	function handleSubagentStop(
		params: { id?: string; name?: string },
		api: Pick<ExtensionAPI, "sendMessage">,
		stopTimeoutMs = 15_000,
		io: PiPersistentIO,
	): AgentToolResult<SubagentStopDetails> {
		const resolved = resolvePersistentTarget(params);
		if ("error" in resolved) {
			return {
				content: [{ type: "text", text: resolved.error }],
				details: { error: resolved.error },
			};
		}
		const running = resolved.running;
		if (running.stopState === "requested" || running.stopState === "pending") {
			const error = `Stop is already requested for persistent specialist "${running.name}".`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, id: running.id, name: running.name },
			};
		}
		const state = persistentSpecialistState(running);
		if (state === "stopped") {
			const error = `Persistent specialist "${running.name}" is already stopped.`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, id: running.id, name: running.name },
			};
		}
		const pending = running.taskId != null;
		running.stopState = pending ? "pending" : "requested";
		running.stopTimeoutMs = stopTimeoutMs;
		io.requestStop(asPiRecord(running));
		if (!pending) startPersistentStopTimeout(running, api, stopTimeoutMs, io);
		return {
			content: [
				{
					type: "text",
					text: pending
						? `Stop pending for persistent specialist "${running.name}"; its active task will settle first.`
						: `Stop requested for persistent specialist "${running.name}".`,
				},
			],
			details: {
				id: running.id,
				name: running.name,
				status: pending ? "stop_pending" : "stop_requested",
			},
		};
	}

	function handleSubagentSend(
		params: {
			id?: string;
			name?: string;
			message: string;
		},
		io: PiPersistentIO,
	): AgentToolResult<SubagentSendDetails> {
		const resolved = resolvePersistentTarget(params);
		if ("error" in resolved)
			return {
				content: [{ type: "text", text: resolved.error }],
				details: { error: resolved.error },
			};
		const running = resolved.running;
		const task = randomUUID();
		if (running.stopState === "failed") {
			io.rejectBusy(asPiRecord(running), task);
			const error = `Persistent specialist "${running.name}" is in an unconfirmed-stop state; task ${task} was rejected-busy. Process exit is unconfirmed and evidence is retained at session ${running.sessionFile}. Request subagent_stop again or spawn a new specialist.`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, task, outcome: "rejected-busy" },
			};
		}
		const state = persistentSpecialistState(running);
		if (state !== "idle") {
			io.rejectBusy(asPiRecord(running), task);
			const error = `Persistent specialist "${running.name}" is ${state}; task ${task} was rejected-busy. Resend after the pending result.`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, task, outcome: "rejected-busy" },
			};
		}
		const inbox = io.dispatch(asPiRecord(running), task, params.message);
		return {
			content: [
				{
					type: "text",
					text: `Task ${task} dispatched to persistent specialist "${running.name}".`,
				},
			],
			details: { id: running.id, task, inbox, outcome: "dispatched" },
		};
	}

	return {
		formatLivePersistentSpecialists,
		resolvePersistentTarget,
		persistentCapacityError,
		startPersistentStopTimeout,
		handleSubagentStop,
		handleSubagentSend,
	};
}
