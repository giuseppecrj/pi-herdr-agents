import { existsSync, readFileSync, rmSync } from "node:fs";

import { isNonEmptyString, isString } from "../../core/config/type-guards.ts";
import {
	parseChildAcceptReport,
	type ChildAcceptReport,
} from "../../core/accept.ts";

const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;

export interface CompletionResult {
	reason: "done" | "ping" | "sentinel" | "error";
	exitCode: number;
	ping?: { name: string; message: string };
	errorMessage?: string;
	/** Who wrote errorMessage: the child's sidecar, or the host's own diagnostic. */
	errorSource?: "child" | "host";
	/** The child's own accept-check report; evidence, never the verdict. */
	accept?: ChildAcceptReport;
}

export interface CompletionOptions {
	intervalMs: number;
	readTerminalTail: () => Promise<string>;
	inspectPane?: () => Promise<import("../../core/types.ts").PaneInspection>;
	/** Bounded artifact grace after explicit pane disappearance. Default: 500ms. */
	paneDisappearanceGraceMs?: number;
	onPaneInspection?: (
		inspection: import("../../core/types.ts").PaneInspection,
		observedAt: number,
	) => void;
	sessionFile?: string;
	/** Persistent lifetime ownership cannot end on a pre-shutdown sidecar. */
	requireProcessExit?: boolean;
	/** Only launch-verified process identity, never transcript or activity state. */
	inspectProcess?: () => "alive" | "exited" | "unknown";
	onTick?: (elapsedSeconds: number) => void;
	/** Wait for a local file wake-up or a scheduled reconciliation. */
	waitForNextCheck?: (signal: AbortSignal) => Promise<"wake" | "reconcile">;
	/** Drain local task evidence before any terminal fallback. */
	onLocalEvidence?: () => void;
}

export function interpretExitSidecar(payload: any): CompletionResult {
	if (payload?.type === "ping") {
		return {
			reason: "ping",
			exitCode: 0,
			ping: {
				name: isString(payload.name) ? payload.name : "subagent",
				message: isString(payload.message) ? payload.message : "",
			},
		};
	}

	if (payload?.type === "error") {
		return isNonEmptyString(payload.errorMessage)
			? {
					reason: "error",
					exitCode: 1,
					errorMessage: payload.errorMessage,
					errorSource: "child",
				}
			: {
					reason: "error",
					exitCode: 1,
					errorMessage:
						"Subagent exited with stopReason=error (no errorMessage in sidecar).",
					errorSource: "host",
				};
	}

	if (payload?.type === "done") {
		const accept = parseChildAcceptReport(payload.accept);
		return accept
			? { reason: "done", exitCode: 0, accept }
			: { reason: "done", exitCode: 0 };
	}

	return {
		reason: "error",
		exitCode: 1,
		errorMessage:
			"Invalid subagent completion sidecar: unsupported payload type.",
		errorSource: "host",
	};
}

function readExitSidecar(
	sessionFile: string | undefined,
	consume = true,
): CompletionResult | null {
	if (!sessionFile) return null;

	const exitFile = `${sessionFile}.exit`;
	if (!existsSync(exitFile)) return null;

	try {
		const result = interpretExitSidecar(
			JSON.parse(readFileSync(exitFile, "utf8")),
		);
		if (consume) rmSync(exitFile, { force: true });
		return result;
	} catch {
		// The child may still be writing the file. Retry on the next polling cycle.
		return null;
	}
}

function terminalExitCode(screen: string): number | null {
	const match = screen.match(TERMINAL_SENTINEL);
	return match ? Number.parseInt(match[1], 10) : null;
}

function completionArtifact(
	options: CompletionOptions,
): CompletionResult | null {
	return readExitSidecar(options.sessionFile, !options.requireProcessExit);
}

async function waitForDelayedSidecar(
	signal: AbortSignal,
	options: CompletionOptions,
): Promise<CompletionResult | null> {
	const immediate = completionArtifact(options);
	if (immediate) return immediate;

	const graceMs = Math.max(0, options.paneDisappearanceGraceMs ?? 500);
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		await abortableDelay(Math.min(25, remaining), signal);
		const result = completionArtifact(options);
		if (result) return result;
	}
	return null;
}

function abortableDelay(
	milliseconds: number,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));

	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error(ABORT_MESSAGE));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function waitForCompletion(
	signal: AbortSignal,
	options: CompletionOptions,
): Promise<CompletionResult> {
	const result = await detectCompletion(signal, options);
	if (options.requireProcessExit && options.sessionFile) {
		try {
			rmSync(`${options.sessionFile}.exit`, { force: true });
		} catch {
			// Exit is already verified; a failed artifact cleanup cannot undo it.
		}
	}
	return result;
}

async function detectCompletion(
	signal: AbortSignal,
	options: CompletionOptions,
): Promise<CompletionResult> {
	const startedAt = Date.now();

	// Coordinated supervision waits for its first shared epoch; legacy callers
	// retain the immediate terminal probe.
	let reconcile = !options.waitForNextCheck;
	for (;;) {
		if (signal.aborted) throw new Error(ABORT_MESSAGE);

		// The child writes .exit before ctx.shutdown(). Keep semantic evidence
		// on disk until independent exit evidence permits releasing a persistent
		// owner, including when all waiters abort and a later wait starts afresh.
		const sidecarResult = readExitSidecar(
			options.sessionFile,
			!options.requireProcessExit,
		);
		if (sidecarResult && !options.requireProcessExit) return sidecarResult;
		options.onLocalEvidence?.();

		if (options.requireProcessExit && options.inspectProcess?.() === "exited") {
			const completion = await waitForDelayedSidecar(signal, options);
			return (
				completion ?? {
					reason: "error",
					exitCode: 1,
					errorMessage:
						"Subagent process exited before completion evidence was recorded.",
					errorSource: "host",
				}
			);
		}

		if (reconcile)
			try {
				const exitCode = terminalExitCode(await options.readTerminalTail());
				if (
					exitCode !== null &&
					(!options.requireProcessExit ||
						options.inspectProcess?.() !== "alive")
				) {
					// The shell sentinel can become readable while the child publishes its
					// authoritative semantic record. Always recheck after the asynchronous
					// terminal read; a zero exit can race a ping or error just like a failure.
					options.onLocalEvidence?.();
					const racedCompletion = completionArtifact(options);
					if (racedCompletion) return racedCompletion;
					if (exitCode !== 0) {
						const delayedCompletion = await waitForDelayedSidecar(
							signal,
							options,
						);
						if (
							options.requireProcessExit &&
							options.inspectProcess?.() === "alive"
						)
							continue;
						if (delayedCompletion) return delayedCompletion;
					}
					return { reason: "sentinel", exitCode };
				}
			} catch {
				// Terminal reads are only sentinel/output probes; Herdr status is polled
				// independently below, even when terminal reads succeed.
			}

		if (reconcile && options.inspectPane) {
			let inspection: import("../../core/types.ts").PaneInspection;
			try {
				inspection = await options.inspectPane();
			} catch {
				inspection = { kind: "unavailable", error: "inspectPane threw" };
			}
			const observedAt = Date.now();
			options.onPaneInspection?.(inspection, observedAt);
			if (
				inspection.kind === "missing" &&
				(!options.requireProcessExit || options.inspectProcess?.() !== "alive")
			) {
				// Drain concurrent persistent events before accepting pane fallback.
				options.onLocalEvidence?.();
				// Pane closure and atomic artifact publication are separate operations.
				// Allow a short bounded grace window before declaring evidence lost.
				const racedCompletion = await waitForDelayedSidecar(signal, options);
				if (
					options.requireProcessExit &&
					options.inspectProcess?.() === "alive"
				)
					continue;
				if (racedCompletion) return racedCompletion;
				return {
					reason: "error",
					exitCode: 1,
					errorMessage:
						"Subagent pane disappeared before completion evidence was recorded.",
					errorSource: "host",
				};
			}
		}

		options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
		if (options.waitForNextCheck) {
			reconcile = (await options.waitForNextCheck(signal)) === "reconcile";
		} else {
			await abortableDelay(options.intervalMs, signal);
			reconcile = true;
		}
	}
}
