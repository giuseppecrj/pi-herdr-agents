/**
 * The running accept-check process groups of this process (ADR-0017).
 *
 * Every check `runAcceptCommand` spawns leads its own process group. The
 * runner tracks it here from spawn until it has killed that group, under the
 * owner that stops it at shutdown: the child's accept loop or the parent's
 * run session. An owner's shutdown calls `terminateAcceptChecks`: SIGTERM,
 * SIGKILL after a short grace, awaited, then a synchronous SIGKILL of anything
 * still tracked. A synchronous `exit` hook SIGKILLs every group still tracked
 * when the process exits, as a last resort.
 *
 * The registry lives in a `globalThis` slot, so every loaded copy of this
 * module (an extension reload loads another) shares one set and one hook.
 */
import { ACCEPT_SHUTDOWN_GRACE_MS } from "../../core/accept.ts";

/** Extra wait, after the shutdown grace, for runners to report their exit. */
const SETTLE_MARGIN_MS = 250;

/**
 * Who stops a check at shutdown: one per child accept loop and one per parent
 * run session. Identity is by reference; `label` only names it.
 */
export interface AcceptCheckOwner {
	readonly label: string;
}

export interface TrackedAcceptCheck {
	/** The check shell's pid, which leads its process group. */
	readonly pgid: number;
	/** Who stops it at shutdown; undefined is stopped only at process exit. */
	readonly owner: AcceptCheckOwner | undefined;
	/** Stop it like an abort: SIGTERM to the group, SIGKILL after `graceMs`. */
	terminate(graceMs: number): void;
	/** Settles once the runner has finished and killed the group. */
	readonly finished: Promise<void>;
}

interface Registry {
	checks: Set<TrackedAcceptCheck>;
	exitHook: boolean;
}

const SLOT = Symbol.for("pi-herdr-agents/accept-check-groups");

function registry(): Registry {
	// SAFETY: `globalThis` has no index signature for this symbol key; this
	// module is its only writer and stores a `Registry`.
	const global = globalThis as typeof globalThis & { [SLOT]?: Registry };
	return (global[SLOT] ??= { checks: new Set(), exitHook: false });
}

function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

/** Synchronous, for the `exit` hook: SIGKILL every group still tracked. */
export function killTrackedAcceptChecks(): void {
	for (const check of registry().checks) killGroup(check.pgid);
}

/** Track one running check; the returned function untracks it. */
export function trackAcceptCheck(check: TrackedAcceptCheck): () => void {
	const state = registry();
	if (!state.exitHook) {
		state.exitHook = true;
		process.on("exit", killTrackedAcceptChecks);
	}
	state.checks.add(check);
	return () => {
		state.checks.delete(check);
	};
}

/**
 * Stop every check `owner` still runs: SIGTERM now, SIGKILL after `graceMs`,
 * and wait for their runners up to a short margin past that. A group still
 * tracked then is killed synchronously before this returns.
 */
export async function terminateAcceptChecks(
	owner: AcceptCheckOwner,
	graceMs = ACCEPT_SHUTDOWN_GRACE_MS,
): Promise<void> {
	const { checks } = registry();
	const owned = [...checks].filter((check) => check.owner === owner);
	if (!owned.length) return;
	for (const check of owned) check.terminate(graceMs);
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		Promise.all(owned.map((check) => check.finished)),
		new Promise((resolve) => {
			timer = setTimeout(resolve, graceMs + SETTLE_MARGIN_MS);
		}),
	]);
	clearTimeout(timer);
	for (const check of owned) if (checks.has(check)) killGroup(check.pgid);
}
