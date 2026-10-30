/**
 * The parent's accept re-check and the outcome ledger. The re-check alone
 * produces `accepted`, `rejected` and `error`; the child's report is evidence.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	buildOutcomeLedgerLine,
	changedCheckFiles,
	OUTCOME_LEDGER_FILE,
	skippedOutcome,
	verdictFromCommand,
	type AcceptOutcome,
	type AcceptSpec,
	type OutcomeLedgerLine,
} from "../core/accept.ts";
import type { CompletionEvidence, RunResult } from "../core/types.ts";
import type { WorktreeHandoff } from "../core/worktree.ts";
import type { AcceptRunner } from "../adapters/pi/accept-runner.ts";
import type { FinalizeControl } from "./run-session.ts";

/** Why a requested check did not run; undefined when the run completed naturally. */
function skipReason(
	result: RunResult,
	evidence: CompletionEvidence | undefined,
	exitCode: number,
): string | undefined {
	if (result.cancellation) return "cancelled";
	if (result.outcome === "killed") return "stopped before completion";
	if (evidence?.ping || result.outcome === "help") return "help request";
	if (evidence?.errorMessage) return "provider error";
	if (!evidence) return "run failed";
	if (result.outcome !== "completed" || exitCode !== 0)
		return `exit code ${exitCode}`;
	return undefined;
}

export interface ParentAcceptInput {
	spec: AcceptSpec;
	result: RunResult;
	evidence: CompletionEvidence | undefined;
	exitCode: number;
	/** The child's checkout: the worktree root or its ordinary cwd. */
	cwd: string | undefined;
	/** Captured before the re-check; its file lists reveal changed check files. */
	worktree: WorktreeHandoff | undefined;
	cancellable: FinalizeControl["cancellable"];
	runner: AcceptRunner;
}

/**
 * Re-run the check only for a completed, uncancelled, exit-0, non-ping
 * result. An operator cancel during it stops the check (verdict `skipped`).
 */
export async function runParentAcceptCheck(
	input: ParentAcceptInput,
): Promise<AcceptOutcome> {
	const { spec, worktree } = input;
	const reason = skipReason(input.result, input.evidence, input.exitCode);
	let outcome: AcceptOutcome;
	if (reason) outcome = skippedOutcome(spec, reason);
	else {
		const cwd = input.cwd;
		const command = cwd
			? await input.cancellable((signal) =>
					input.runner({
						run: spec.run,
						cwd,
						timeoutMs: spec.timeoutSec * 1000,
						signal,
					}),
				)
			: { kind: "cwd-missing" as const, output: "" };
		outcome = verdictFromCommand(command, spec, input.evidence?.accept);
		if (cwd) outcome.cwd = cwd;
		// Other writers and the user may share an ordinary checkout.
		if (outcome.verdict !== "skipped" && !worktree)
			outcome.sharedCheckout = true;
	}
	if (worktree) {
		const changed = changedCheckFiles(spec.paths, [
			...(worktree.changedFiles ?? []),
			...(worktree.untrackedFiles ?? []),
		]);
		if (changed.length) outcome.changedCheckFiles = changed;
	}
	return outcome;
}

/** How one model attempt ended, for its outcome-ledger line. */
export function ledgerOutcome(
	result: RunResult,
	evidence: CompletionEvidence | undefined,
	exitCode: number,
	cancelledInCheck: boolean,
): OutcomeLedgerLine["outcome"] {
	if (result.cancellation || cancelledInCheck || result.outcome === "killed")
		return "cancelled";
	if (evidence?.ping) return "help";
	return exitCode === 0 ? "completed" : "failed";
}

export function outcomeLedgerFile(configDir: string): string {
	return join(configDir, "herdr-agents", OUTCOME_LEDGER_FILE);
}

/** Best effort: a ledger failure never changes or delays a delivery. */
export function appendOutcomeLedger(
	file: string,
	input: Parameters<typeof buildOutcomeLedgerLine>[0],
): OutcomeLedgerLine | undefined {
	try {
		const line = buildOutcomeLedgerLine(input);
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
		return line;
	} catch {
		return undefined;
	}
}
