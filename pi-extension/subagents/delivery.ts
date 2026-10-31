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
import { encodeHostValue } from "../../maestro/core/host-text.ts";
import type { WorktreeHandoff } from "../../maestro/core/worktree.ts";
import {
	type RunningSubagent,
	type SubagentRuntime,
	shouldDeliverSubagentCompletion,
	holdDelivery,
} from "./state.ts";
import {
	checkField,
	formatElapsed,
	hostLine,
	hostText,
	type SubagentResultDetails,
	type SubagentPingDetails,
	sendParentMessage,
	sendSubagentResult,
	sessionFields,
	summaryMessage,
	worktreeHandoffFields,
	resolveResultPresentation,
	resolveCancelledPresentation,
} from "./presentation.ts";
import {
	asPiRecord,
	persistentSpecialistFacts,
	persistentFactsFields,
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

	/**
	 * Issuance lives in parent memory: the record's current task and the IDs
	 * the host dispatched. The ledger is child-writable, so it never decides.
	 */
	function isIssuedTask(running: RunningSubagent, task: string): boolean {
		return (
			task === running.taskId || running.issuedTaskIds?.includes(task) === true
		);
	}

	/**
	 * An event for a task the parent never issued changes nothing: no ledger
	 * row, no completion count, no idle claim. The first one per specialist is
	 * one encoded notice that does not start a turn, so a child can neither
	 * wake nor flood the parent; later ones are only counted.
	 */
	function ignoreUnrecognizedTaskEvent(
		running: RunningSubagent,
		event: PiPersistentEvent,
		api: Pick<ExtensionAPI, "sendMessage">,
	): void {
		running.ignoredTaskEvents = (running.ignoredTaskEvents ?? 0) + 1;
		if (running.ignoredTaskEvents > 1) return;
		const line = hostLine`Persistent specialist "${running.name}" reported a ${event.type} event for task ${event.task}, which the parent did not issue. The event was ignored; the specialist's state and completion count are unchanged, and later unrecognized events are ignored without a notice.`;
		sendParentMessage(
			api,
			"subagent_status",
			{ head: [[line]] },
			{
				lines: [
					`${encodeHostValue(running.name)}: ignored an event for a task the parent did not issue.`,
				],
				overflow: 0,
				ignoredEvent: { type: event.type, task: event.task },
			},
			{ triggerTurn: false },
		);
	}

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
		const deliveryKey = `${event.type}:${event.task}`;
		const deliveries = (running.persistentTaskDeliveries ??= new Map());
		const progress = deliveries.get(deliveryKey);
		if (progress === "sending" || progress === "acknowledged") return;
		if (!isIssuedTask(running, event.task))
			return ignoreUnrecognizedTaskEvent(running, event, api);
		const ledger = ledgerSnapshot ?? io.readLedger(asPiRecord(running));
		if (event.type === "help-request") {
			if (
				progress !== "sent" &&
				ledger.some(
					(entry) =>
						entry.task === event.task && entry.outcome === "help-requested",
				)
			)
				return;
			sendAndAcknowledge(() =>
				sendParentMessage(
					api,
					"subagent_ping",
					{
						head: [
							[
								hostLine`Persistent specialist "${running.name}" requests help for task ${event.task}:`,
							],
						],
						report: {
							name: running.name,
							kind: "help-request",
							body: event.message ?? "",
						},
						evidence: [
							[hostLine`Reply with subagent_send to ${running.name}.`],
						],
					},
					{
						name: running.name,
						task: event.task,
						message: event.message ?? "",
						sessionFile: running.sessionFile,
					},
				),
			);
			return;
		}
		if (
			progress !== "sent" &&
			ledger.some(
				(entry) => entry.task === event.task && entry.outcome === "delivered",
			)
		)
			return;
		sendAndAcknowledge(() => {
			const completed = (running.tasksCompleted ?? 0) + 1;
			const summary = summaryMessage(
				io.readTaskSummary(asPiRecord(running)),
				running.name,
				"task-result",
			);
			sendSubagentResult(
				api,
				{
					head: [
						[
							hostLine`Persistent specialist "${running.name}" completed task ${event.task} (${String(completed)} tasks completed) and is idle and accepting subagent_send.`,
						],
						...summary.head,
					],
					report: summary.report,
				},
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
		});

		function sendAndAcknowledge(send: () => void): void {
			try {
				if (progress !== "sent") {
					deliveries.set(deliveryKey, "sending");
					send();
					// Parent memory, not the child-writable ledger, records that Pi
					// accepted the notification. An ack retry must not send it again.
					deliveries.set(deliveryKey, "sent");
				}
				ledger.push(io.acknowledge(asPiRecord(running), event));
				deliveries.set(deliveryKey, "acknowledged");
				if (running.stopState === "pending")
					startPersistentStopTimeout(running, api, running.stopTimeoutMs, io);
			} catch (error) {
				if (deliveries.get(deliveryKey) === "sending")
					deliveries.delete(deliveryKey);
				throw error;
			}
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
			// A reentrant drain must not advance the cursor past a send whose
			// acknowledgement can still fail in the outer drain.
			if (
				running.persistentTaskDeliveries?.get(`${event.type}:${event.task}`) ===
				"sending"
			)
				return;
			ledger ??= io.readLedger(asPiRecord(running));
			deliverPersistentTaskEvent(running, event, api, io, ledger);
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
		sendParentMessage(
			api,
			"subagent_result",
			{
				head: [
					[
						hostText(
							"Persistent specialist crashed. Evidence is retained. Persistent sessions cannot be resumed in v1; spawn a new specialist.",
						),
					],
				],
				evidence: [persistentFactsFields(facts)],
			},
			{ error: "persistent-crash", facts },
		);
	}

	function deliverPiCompletion(
		record: PiRunRecord,
		result: PiCompletedMetadata,
		task: Task,
		io: PiSettlementIO,
	): "delivered" | "suppressed" | Promise<"delivered" | "suppressed"> {
		const running: RunningSubagent = record;
		if (running.stopTimeout) clearTimeout(running.stopTimeout);
		if (!shouldDeliverSubagentCompletion(running)) return suppress(running);
		const api = runtime.liveApi;
		if (api) return settle(api, record, result, task, io);
		// Reload or session-replacement gap: Pi has invalidated the replaced API and
		// the replacement's session_start has not bound one. Hold the row pending;
		// RunSession keeps ownership (and the pane) until this settles. A quit
		// releases it without an API, and a suppression meanwhile still wins.
		return holdDelivery(runtime, running.id).then((live) =>
			live && shouldDeliverSubagentCompletion(running)
				? settle(live, record, result, task, io)
				: suppress(running),
		);
	}

	function suppress(running: RunningSubagent): "suppressed" {
		running.lifecycle = markDelivery(running.lifecycle, "suppressed");
		runningSubagents.delete(running.id);
		updateWidget();
		return "suppressed";
	}

	function settle(
		api: ExtensionAPI,
		record: PiRunRecord,
		result: PiCompletedMetadata,
		task: Task,
		io: PiSettlementIO,
	): "delivered" {
		const running: RunningSubagent = record;
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
				sendParentMessage(
					api,
					"subagent_stop",
					{
						head: [[hostText("Persistent specialist stopped.")]],
						evidence: [persistentFactsFields(facts)],
					},
					{ status: "stopped", facts },
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
			if (result.accept) details.accept = result.accept;
			sendSubagentResult(
				api,
				resolveCancelledPresentation(result, running.name, cancellation),
				details,
			);
			return "delivered";
		}
		if (result.ping) {
			// The sidecar's name is child-written; headers use the parent-owned name.
			const details: SubagentPingDetails = {
				name: running.name,
				message: result.ping.message,
				sessionFile: result.sessionFile!,
			};
			if (result.ping.name !== running.name)
				details.reportedName = result.ping.name;
			if (task.role) details.agent = running.agent;
			if (result.worktree) details.worktree = result.worktree;
			if (result.accept) details.accept = result.accept;
			sendParentMessage(
				api,
				"subagent_ping",
				{
					head: [
						[
							hostLine`Sub-agent "${running.name}" needs help (${formatElapsed(result.elapsed)}):`,
							checkField(result.accept),
						],
					],
					report: {
						name: running.name,
						kind: "help-request",
						body: result.ping.message,
					},
					evidence: [
						result.worktree ? worktreeHandoffFields(result.worktree) : [],
						sessionFields(result.sessionFile),
					],
				},
				details,
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
			if (result.accept) details.accept = result.accept;
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
