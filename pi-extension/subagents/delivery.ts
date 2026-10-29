import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Task } from "../../maestro/core/types.ts";
import type {
	PiRunRecord,
	PiCompletedMetadata,
	PiPersistentIO,
	PiSettlementIO,
	PiPersistentEvent,
	PiLedgerEntry,
} from "../../maestro/runtime/index.ts";
import { markDelivery } from "../../maestro/core/lifecycle.ts";
import type { WorktreeHandoff } from "../../maestro/core/worktree.ts";
import {
	type RunningSubagent,
	type SubagentRuntime,
	shouldDeliverSubagentCompletion,
	selectCompletionApi,
} from "./state.ts";
import {
	formatElapsed,
	boundChildDelivery,
	type SubagentResultDetails,
	type SubagentPingDetails,
	sendSubagentResult,
	formatWorktreeHandoff,
	resolveResultPresentation,
	resolveCancelledPresentation,
} from "./presentation.ts";
import {
	asPiRecord,
	persistentSpecialistFacts,
	formatPersistentSpecialistFacts,
	type PersistentControls,
} from "./persistent.ts";

interface DeliveryDeps {
	runtime: SubagentRuntime;
	updateWidget: () => void;
	startPersistentStopTimeout: PersistentControls["startPersistentStopTimeout"];
}

/** Parent delivery of child results, bound to one extension instance. */
export function createDelivery({
	runtime,
	updateWidget,
	startPersistentStopTimeout,
}: DeliveryDeps) {
	const runningSubagents = runtime.runningSubagents;

	const inFlightPersistentTaskDeliveries = new Set<string>();

	function deliverPersistentTaskEvent(
		running: RunningSubagent,
		event: PiPersistentEvent,
		api: Pick<ExtensionAPI, "sendMessage">,
		io: PiPersistentIO,
		ledgerSnapshot?: PiLedgerEntry[],
	): void {
		if (
			!shouldDeliverSubagentCompletion(running) ||
			!running.persistent ||
			event.generation !== running.generationId
		)
			return;
		const deliveryKey = `${running.id}:${event.type}:${event.task}`;
		if (inFlightPersistentTaskDeliveries.has(deliveryKey)) return;
		const ledger = ledgerSnapshot ?? io.readLedger(asPiRecord(running));
		if (event.type === "help-request") {
			if (
				ledger.some(
					(entry) =>
						entry.task === event.task && entry.outcome === "help-requested",
				)
			)
				return;
			inFlightPersistentTaskDeliveries.add(deliveryKey);
			try {
				api.sendMessage(
					{
						customType: "subagent_ping",
						content: boundChildDelivery({
							head: `Persistent specialist "${running.name}" requests help for task ${event.task}:`,
							name: running.name,
							kind: "help-request",
							body: event.message ?? "",
							bodySource: "child",
							tail: `\n\nReply with subagent_send to ${running.name}.`,
						}),
						display: true,
						details: {
							name: running.name,
							task: event.task,
							sessionFile: running.sessionFile,
						},
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
				ledger.push(io.acknowledge(asPiRecord(running), event));
			} finally {
				inFlightPersistentTaskDeliveries.delete(deliveryKey);
			}
			return;
		}
		if (
			ledger.some(
				(entry) => entry.task === event.task && entry.outcome === "delivered",
			)
		)
			return;
		inFlightPersistentTaskDeliveries.add(deliveryKey);
		try {
			const completed = (running.tasksCompleted ?? 0) + 1;
			const { summary, summarySource } = io.readTaskSummary(
				asPiRecord(running),
			);
			sendSubagentResult(
				api,
				boundChildDelivery({
					head: `Persistent specialist "${running.name}" completed task ${event.task} (${completed} tasks completed) and is idle and accepting subagent_send.`,
					name: running.name,
					kind: "task-result",
					body: summary,
					bodySource: summarySource,
				}),
				{
					name: running.name,
					task: event.task,
					agent: running.agent,
					sessionFile: running.sessionFile,
					logicalId: running.logicalId!,
					generationId: running.generationId!,
					policyHash: running.policyHash!,
				},
			);
			ledger.push(io.acknowledge(asPiRecord(running), event));
			if (running.stopState === "pending")
				startPersistentStopTimeout(running, api, running.stopTimeoutMs, io);
		} finally {
			inFlightPersistentTaskDeliveries.delete(deliveryKey);
		}
	}

	function drainPersistentTaskEvents(
		running: RunningSubagent,
		api: Pick<ExtensionAPI, "sendMessage">,
		io: PiPersistentIO,
	): void {
		if (!shouldDeliverSubagentCompletion(running)) return;
		const events = io.readEvents(asPiRecord(running));
		let ledger: PiLedgerEntry[] | undefined;
		for (const event of events.slice(running.observedTaskEvents ?? 0)) {
			if (!running.persistent || event.generation !== running.generationId)
				continue;
			if (
				inFlightPersistentTaskDeliveries.has(
					`${running.id}:${event.type}:${event.task}`,
				)
			)
				continue;
			ledger ??= io.readLedger(asPiRecord(running));
			deliverPersistentTaskEvent(
				running,
				event,
				selectCompletionApi(api, runtime.pi),
				io,
				ledger,
			);
		}
		running.observedTaskEvents = events.length;
	}

	function notifyPersistentCrash(
		running: RunningSubagent,
		api: Pick<ExtensionAPI, "sendMessage">,
		io: PiPersistentIO,
		worktree?: WorktreeHandoff,
	): void {
		drainPersistentTaskEvents(running, api, io);
		if (running.crashNotified) return;
		running.crashNotified = true;
		const facts = persistentSpecialistFacts(running, io, worktree);
		api.sendMessage(
			{
				customType: "subagent_result",
				content: `Persistent specialist crashed. Evidence is retained. Persistent sessions cannot be resumed in v1; spawn a new specialist.\n\n${formatPersistentSpecialistFacts(facts)}`,
				display: true,
				details: { error: "persistent-crash", facts },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	function deliverPiCompletion(
		record: PiRunRecord,
		result: PiCompletedMetadata,
		task: Task,
		io: PiSettlementIO,
	): "delivered" | "suppressed" {
		const running: RunningSubagent = record;
		if (running.stopTimeout) clearTimeout(running.stopTimeout);
		if (!shouldDeliverSubagentCompletion(running)) {
			running.lifecycle = markDelivery(running.lifecycle, "suppressed");
			runningSubagents.delete(running.id);
			updateWidget();
			return "suppressed";
		}
		const api = runtime.pi!;
		if (running.persistent) {
			// Task sends remain retryable while the process is live. This is the distinct
			// terminal PROCESS handoff; failed terminal delivery retires runtime ownership.
			drainPersistentTaskEvents(running, api, io);
			running.lifecycle = markDelivery(running.lifecycle, "delivered");
			if (
				running.stopState === "requested" ||
				running.stopState === "pending"
			) {
				io.recordStopped(record);
				const facts = persistentSpecialistFacts(running, io, result.worktree);
				api.sendMessage(
					{
						customType: "subagent_stop",
						content: `Persistent specialist stopped.\n\n${formatPersistentSpecialistFacts(facts)}`,
						display: true,
						details: { status: "stopped", facts },
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} else if (running.stopState !== "failed")
				notifyPersistentCrash(running, api, io, result.worktree);
			runningSubagents.delete(running.id);
			updateWidget();
			return "delivered";
		}
		// Preserve ordinary mark-delivered/delete-before-send and failed-send retention.
		running.lifecycle = markDelivery(running.lifecycle, "delivered");
		runningSubagents.delete(running.id);
		updateWidget();
		const cancellation = result.run.cancellation;
		if (cancellation) {
			const details: SubagentResultDetails = {
				name: running.name,
				task: task.prompt,
				exitCode: result.exitCode,
				elapsed: result.elapsed,
				sessionFile: result.sessionFile,
				error: "cancelled",
				cancellation,
			};
			if (!io.readResumeResult) details.agent = running.agent;
			if (result.fallbackAttempts)
				details.fallbackAttempts = result.fallbackAttempts;
			if (result.fallbackFailures)
				details.fallbackFailures = result.fallbackFailures;
			if (result.worktree) details.worktree = result.worktree;
			if (running.runtimePlan) details.runtimePlan = running.runtimePlan;
			sendSubagentResult(
				api,
				resolveCancelledPresentation(result, running.name, cancellation),
				details,
			);
			return "delivered";
		}
		if (result.ping) {
			const worktreeRef = result.worktree
				? `\n\n${formatWorktreeHandoff(result.worktree)}`
				: "";
			const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
			const details: SubagentPingDetails = {
				name: result.ping.name,
				message: result.ping.message,
				sessionFile: result.sessionFile!,
			};
			if (task.role) details.agent = running.agent;
			if (result.worktree) details.worktree = result.worktree;
			api.sendMessage(
				{
					customType: "subagent_ping",
					content: boundChildDelivery({
						head: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):`,
						name: result.ping.name,
						kind: "help-request",
						body: result.ping.message,
						bodySource: "child",
						tail: worktreeRef,
						sessionRef,
					}),
					display: true,
					details,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} else {
			// Resume's second read belongs after the absorbing delivery mark/map delete
			// and ping branch. A real read rejection retains the manual pane via the
			// existing rejected-settlement path; do not suppress, resend or close it.
			const presentationResult = io.readResumeResult
				? { ...result, ...io.readResumeResult() }
				: result;
			const details: SubagentResultDetails = {
				name: running.name,
				task: task.prompt,
				exitCode: result.exitCode,
				elapsed: result.elapsed,
				sessionFile: presentationResult.sessionFile,
			};
			if (!io.readResumeResult) details.agent = running.agent;
			if (result.errorMessage) details.errorMessage = result.errorMessage;
			if (result.fallbackAttempts)
				details.fallbackAttempts = result.fallbackAttempts;
			if (result.fallbackFailures)
				details.fallbackFailures = result.fallbackFailures;
			if (result.worktree) details.worktree = result.worktree;
			if (running.runtimePlan) details.runtimePlan = running.runtimePlan;
			sendSubagentResult(
				api,
				resolveResultPresentation(
					presentationResult,
					running.name,
					running.runtimePlan?.runtimeMismatch,
				),
				details,
			);
		}
		return "delivered";
	}

	return {
		deliverPersistentTaskEvent,
		drainPersistentTaskEvents,
		notifyPersistentCrash,
		deliverPiCompletion,
	};
}
