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
	type HeldDelivery,
} from "./state.ts";
import type { Controls } from "./controls.ts";
import {
	encodeHostValue,
	HOST_PATH_CHARS,
} from "../../maestro/core/host-text.ts";
import {
	type HostField,
	hostLine,
	hostText,
	list,
	sendParentMessage,
	value,
} from "./presentation.ts";

export function asPiRecord(running: RunningSubagent): PiRunRecord {
	// SAFETY: live rows are the adapter's actual records. Legacy presentation
	// fixtures omit script/activity paths, which persistent I/O never consumes.
	return running as PiRunRecord;
}

export function persistentSpecialistState(
	running: RunningSubagent,
): "idle" | "working" | "stalled" | "stopped" {
	const projection = projectLifecycle(running.lifecycle, Date.now()).kind;
	if (running.stopState === "failed" || asPiRecord(running).launchFailure)
		return "stalled";
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
		lastObservedPhase: projectLifecycle(running.lifecycle, Date.now()).kind,
	};
	if (worktree) facts.worktree = worktree;
	return facts;
}

/**
 * Facts for a crash or stop notice. The ledger is child-writable, so its
 * outcomes are one bounded list of encoded entries with an omitted count;
 * details keep every entry.
 */
export function persistentFactsFields(
	facts: PersistentSpecialistFacts,
): HostField[] {
	const fields = [
		hostLine`Logical ID: ${facts.logicalId}`,
		hostLine`Generation ID: ${facts.generationId}`,
		hostLine`Policy hash: ${facts.policyHash}`,
		{
			...hostLine`Task outcomes: ${list(
				facts.tasks.map((task) => `${task.task}=${task.outcome}`),
				"ledger entries",
			)}`,
			drop: 1,
		},
		hostLine`Session: ${value(facts.sessionFile, HOST_PATH_CHARS)}`,
		hostLine`Last observed phase: ${facts.lastObservedPhase}`,
	];
	if (facts.worktree)
		fields.push(
			hostLine`Worktree Git state: ${facts.worktree.gitError ? "unknown" : facts.worktree.conflicted ? "conflicted" : facts.worktree.clean ? "clean" : "dirty"}`,
		);
	return fields;
}

function sendPersistentStopFailure(
	api: Pick<ExtensionAPI, "sendMessage">,
	facts: PersistentSpecialistFacts,
): void {
	sendParentMessage(
		api,
		"subagent_stop",
		{
			head: [
				[
					hostText(
						"Persistent specialist stop failed: process exit was not confirmed. Evidence is retained.",
					),
				],
			],
			evidence: [persistentFactsFields(facts)],
		},
		{ status: "failed", facts },
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

export type PersistentControls = ReturnType<typeof createPersistentControls>;

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
				const denied = running.policyDeniedTools?.join(",") || "none";
				return `• ${encodeHostValue(running.name)} | ${encodeHostValue(running.logicalId ?? "")} | ${encodeHostValue(running.generationId ?? "")} | ${encodeHostValue(running.agent ?? "bare")} | ${persistentSpecialistState(running)} | ${running.tasksCompleted ?? 0} completed | tools: ${encodeHostValue(allowlist, HOST_PATH_CHARS)}; denied: ${encodeHostValue(denied, HOST_PATH_CHARS)}; persistent: true`;
			}),
		];
	}

	function resolvePersistentTarget(params: { id?: string; name?: string }) {
		const resolved = resolveInterruptTarget(params);
		if ("error" in resolved) return resolved;
		if (!resolved.running.persistent) {
			return {
				error: `Subagent "${encodeHostValue(resolved.running.name)}" is not persistent.`,
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
		const acquiring = [...(runtime.persistentReservations ?? [])].filter(
			(id) => !runningSubagents.get(id)?.persistent,
		).length;
		if (specialists.length + acquiring < config.maxAgents) return undefined;
		return `Persistent specialist cap (${config.maxAgents}) reached. Current specialists: ${specialists.map((running) => `${encodeHostValue(running.name)} (${persistentSpecialistState(running)}, ${running.tasksCompleted ?? 0} completed)`).join(", ")}. Launches acquiring resources: ${acquiring}.`;
	}

	function notifyStopFailure(
		running: RunningSubagent,
		io: PiPersistentIO,
	): void {
		let retry: ReturnType<typeof setTimeout> | undefined;
		let busy = false,
			sent = false;
		const generation = running.generationId;
		const sequence = running.inboxSequence;
		const failure = running.stopFailure;
		const current = () =>
			!sent &&
			runningSubagents.get(running.id) === running &&
			running.generationId === generation &&
			running.inboxSequence === sequence &&
			running.stopState === "failed" &&
			running.stopFailure === failure &&
			running.lifecycle.delivery !== "suppressed";
		const hold = () => {
			if (!current() || (!runtime.liveApi && !runtime.reloadGap)) return;
			const queue = (runtime.heldDeliveries ??= []);
			if (!queue.includes(notice)) queue.push(notice);
			if (!runtime.liveApi) return;
			retry = setTimeout(() => {
				if (!runtime.liveApi && runtime.reloadGap) return;
				const at = queue.indexOf(notice);
				if (at < 0) return;
				queue.splice(at, 1);
				notice.release(runtime.liveApi);
			}, 1_000);
			retry.unref();
		};
		const notice: HeldDelivery = {
			id: running.id,
			release(api) {
				if (retry) clearTimeout(retry);
				if (!api || busy || !current()) return;
				busy = true;
				void (async () => {
					try {
						const worktree = await io.inspectWorktree(asPiRecord(running));
						// Evidence collection can cross reload, successful exit, or another stop.
						if (!current()) return;
						const liveApi = runtime.liveApi;
						if (!liveApi) {
							hold();
							return;
						}
						sendPersistentStopFailure(
							liveApi,
							persistentSpecialistFacts(running, io, worktree),
						);
						sent = true;
					} catch {
						hold();
					} finally {
						busy = false;
					}
				})();
			},
		};
		if (runtime.liveApi) notice.release(runtime.liveApi);
		else if (runtime.reloadGap) (runtime.heldDeliveries ??= []).push(notice);
	}

	function startPersistentStopTimeout(
		running: RunningSubagent,
		_api: Pick<ExtensionAPI, "sendMessage">,
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
				notifyStopFailure(running, io);
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
		const shownName = encodeHostValue(running.name);
		if (running.stopState === "requested" || running.stopState === "pending") {
			const error = `Stop is already requested for persistent specialist "${shownName}".`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, id: running.id, name: running.name },
			};
		}
		const state = persistentSpecialistState(running);
		if (state === "stopped") {
			const error = `Persistent specialist "${shownName}" is already stopped.`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, id: running.id, name: running.name },
			};
		}
		const pending = running.taskId != null;
		running.stopState = pending ? "pending" : "requested";
		running.stopTimeoutMs = stopTimeoutMs;
		running.stopFailure = undefined;
		try {
			io.requestStop(asPiRecord(running));
		} catch (error) {
			running.stopState = "failed";
			running.stopFailure = `stop publication failed: ${String(error)}`;
			throw new Error(
				`${running.stopFailure}. Evidence is retained and follow-up work is blocked; request subagent_stop again to retry.`,
				{ cause: error },
			);
		}
		if (!pending) startPersistentStopTimeout(running, api, stopTimeoutMs, io);
		return {
			content: [
				{
					type: "text",
					text: pending
						? `Stop pending for persistent specialist "${shownName}"; its active task will settle first.`
						: `Stop requested for persistent specialist "${shownName}".`,
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
		const shownName = encodeHostValue(running.name);
		const task = randomUUID();
		if (running.stopState === "failed") {
			io.rejectBusy(asPiRecord(running), task);
			const error = `Persistent specialist "${shownName}" is in an unconfirmed-stop state; task ${task} was rejected-busy. Process exit is unconfirmed and evidence is retained at session ${encodeHostValue(running.sessionFile, HOST_PATH_CHARS)}. Request subagent_stop again or spawn a new specialist.`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, task, outcome: "rejected-busy" },
			};
		}
		const state = persistentSpecialistState(running);
		if (state !== "idle") {
			io.rejectBusy(asPiRecord(running), task);
			const error = `Persistent specialist "${shownName}" is ${state}; task ${task} was rejected-busy. Resend after the pending result.`;
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
					text: `Task ${task} dispatched to persistent specialist "${shownName}".`,
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
