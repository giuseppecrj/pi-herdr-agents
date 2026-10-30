/**
 * The child's own accept-check loop. After a turn ends normally, run the
 * caller's check; on failure with retries left, append the bounded failing
 * output as a custom message and ask Pi for one continuation. The parent's
 * re-check, not this loop, decides the verdict.
 */
import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	ACCEPT_CHILD_OUTPUT_CHARS,
	ACCEPT_RETRY_MESSAGE_TYPE,
	outputTail,
	type AcceptCommandResult,
	type AcceptSpec,
	type ChildAcceptReport,
} from "../../../core/accept.ts";
import { runAcceptCommand, type AcceptRunner } from "../accept-runner.ts";
import { terminateAcceptChecks } from "../accept-groups.ts";

function failureText(result: AcceptCommandResult, spec: AcceptSpec): string {
	switch (result.kind) {
		case "exit":
			return `exited with code ${result.exitCode}`;
		case "timeout":
			return `timed out after ${spec.timeoutSec}s`;
		case "signal":
			return `was killed by signal ${result.signal}`;
		case "cwd-missing":
			return "could not run: its directory is missing";
		case "spawn-error":
			return `could not start: ${result.error}`;
		default:
			return "was stopped";
	}
}

/** The retry message the child model reads; its output is bounded. */
export function acceptRetryMessage(
	result: AcceptCommandResult,
	spec: AcceptSpec,
	tries: number,
): string {
	const tail = outputTail(result.output, ACCEPT_CHILD_OUTPUT_CHARS);
	return [
		`The accept check \`${spec.run}\` ${failureText(result, spec)} (try ${tries} of ${spec.maxRetries + 1}).`,
		"Fix the cause, then finish your task again. The check runs again when you finish, and the parent re-runs it to decide the verdict.",
		"",
		`Last ${ACCEPT_CHILD_OUTPUT_CHARS.toLocaleString("en-US")} characters of check output:`,
		"```",
		tail || "(no output)",
		"```",
	].join("\n");
}

export interface ChildAcceptLoop {
	/** The latest recorded report, for the `.exit` sidecar. */
	report(): ChildAcceptReport | undefined;
	beforeSettle(
		event: Pick<AgentBeforeSettleEvent, "outcome" | "entries">,
		signal?: AbortSignal,
	): Promise<AgentBeforeSettleEventResult | undefined>;
	/** At session shutdown: terminate a running check, bounded and awaited. */
	shutdown(): Promise<void>;
}

export function createChildAcceptLoop(options: {
	spec: AcceptSpec;
	cwd: string;
	runner?: AcceptRunner;
}): ChildAcceptLoop {
	const { spec, cwd } = options;
	const runner = options.runner ?? runAcceptCommand;
	let tries = 0;
	let report: ChildAcceptReport | undefined;
	const owner = { label: "child accept loop" };
	return {
		report: () => report,
		shutdown: () => terminateAcceptChecks(owner),
		async beforeSettle(event, signal) {
			if (event.outcome !== "completed") return undefined;
			const result = await runner({
				run: spec.run,
				cwd,
				timeoutMs: spec.timeoutSec * 1000,
				signal,
				owner,
			});
			// A user abort during the check is no verdict and no try.
			if (result.kind === "aborted") return undefined;
			tries++;
			const passed = result.kind === "exit" && result.exitCode === 0;
			report = {
				tries,
				childVerdict: passed ? "passed" : "failed",
				timedOut: result.kind === "timeout",
			};
			if (result.kind === "exit") report.lastExitCode = result.exitCode;
			if (passed || tries > spec.maxRetries) return undefined;
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message",
						customType: ACCEPT_RETRY_MESSAGE_TYPE,
						content: acceptRetryMessage(result, spec, tries),
						display: true,
						details: { tries, exitCode: report.lastExitCode },
					},
				],
				continue: true,
			};
		},
	};
}
