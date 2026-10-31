import { existsSync } from "node:fs";
import type { WorktreeOperations } from "../core/worktree.ts";
import {
	appendPersistentDeliveryLedger,
	readPersistentDeliveryLedger,
	readPersistentTaskEvents,
	writePersistentTaskInbox,
	getNewEntries,
	findLastAssistantSummary,
} from "../adapters/pi/session.ts";
import type {
	PiLedgerEntry,
	PiPersistentIO,
	PiRunRecord,
} from "./pi-run-session-types.ts";

/** Persistent inbox, event and ledger I/O, reading the owner's live worktree operations. */
export function createPiPersistentIO(state: {
	readonly worktreeOperations: WorktreeOperations;
}): PiPersistentIO {
	const io: PiPersistentIO = {
		inspectWorktree: async (r) =>
			r.worktree
				? state.worktreeOperations.captureWorktreeHandoff(r.worktree)
				: undefined,
		readEvents: (r) => readPersistentTaskEvents(r.sessionFile),
		readLedger: (r) => readPersistentDeliveryLedger(r.sessionFile),
		readTaskSummary: (r) =>
			existsSync(r.sessionFile)
				? (findLastAssistantSummary(getNewEntries(r.sessionFile, 0)) ?? {
						summary: "Persistent specialist completed without output.",
						summarySource: "host",
					})
				: {
						summary: "Persistent specialist session is unavailable.",
						summarySource: "host",
					},
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
			(r.issuedTaskIds ??= []).push(task);
			ledger(r, task, "dispatched");
			return inbox;
		},
		requestStop(r) {
			const task = r.taskId ?? "stop";
			if (
				r.taskId &&
				!io
					.readLedger(r)
					.some(
						(row) =>
							row.task === task &&
							row.generation === r.generationId &&
							row.outcome === "stop-pending",
					)
			)
				ledger(r, task, "stop-pending");
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
	return io;
}
