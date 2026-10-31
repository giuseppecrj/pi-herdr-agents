import type { PaneInspection } from "./types.ts";
import {
	FileWakeRegistry,
	type WakeRegistration,
	type WakeReason,
} from "./wake.ts";

export const RECONCILE_INTERVAL_MS = 4_800;
export const POLLING_INTERVAL_MS = 1_000;
const BATCH_UNHEALTHY_MS = 5_000;
const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const UNREGISTERED_MESSAGE = "Supervision registration was unregistered";
const CONCURRENT_WAIT_MESSAGE =
	"Supervision registration already has a parked wait";

export interface PaneListEntry {
	paneId: string;
	workspaceId: string;
}

export interface PaneListSnapshot {
	complete: boolean;
	panes: PaneListEntry[];
}

export interface SupervisionRegistration {
	wait(signal: AbortSignal): Promise<WakeReason>;
	inspectPane(): Promise<PaneInspection>;
	unregister(): void;
}

interface Entry {
	sessionFile: string;
	surface: string;
	generation: number;
	wakeRegistration?: WakeRegistration;
	pending?: WakeReason;
	parked?: ParkedWait;
	unregistered?: boolean;
	inspection?: PaneInspection;
	fallback: boolean;
	fileFallback: boolean;
}

interface ParkedWait {
	polling: boolean;
	resolve(reason: WakeReason): void;
	reject(error: Error): void;
}

export interface SupervisionDiagnostics {
	mode: "wake+batch" | "polling(forced)" | "polling(fallback)";
	watcherCount: number;
}

interface SupervisionTimers {
	setTimeout(
		callback: () => void,
		milliseconds: number,
	): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

/** A runtime-owned coordinator for file wake-ups and shared pane snapshots. */
export class SupervisionCoordinator {
	private readonly entries = new Set<Entry>();
	private readonly listPanes: () => Promise<PaneListSnapshot>;
	private readonly inspectFallback: (
		surface: string,
	) => Promise<PaneInspection>;
	private forcePolling: boolean;
	private readonly wakeRegistry: FileWakeRegistry;
	private readonly timers: SupervisionTimers;
	private timer: ReturnType<typeof setInterval> | undefined;
	private unhealthyTimer: ReturnType<typeof setTimeout> | undefined;
	private reconciling = false;
	private unhealthyUntil = 0;
	private nextGeneration = 0;
	private closed = false;

	constructor(
		listPanes: () => Promise<PaneListSnapshot>,
		inspectFallback: (surface: string) => Promise<PaneInspection>,
		forcePolling = false,
		wakeRegistry = new FileWakeRegistry(),
		timers: SupervisionTimers = { setTimeout, clearTimeout },
	) {
		this.listPanes = listPanes;
		this.inspectFallback = inspectFallback;
		this.forcePolling = forcePolling;
		this.wakeRegistry = wakeRegistry;
		this.timers = timers;
	}

	register(sessionFile: string, surface: string): SupervisionRegistration {
		const entry: Entry = {
			sessionFile,
			surface,
			generation: this.nextGeneration++,
			fallback: this.forcePolling,
			fileFallback: this.forcePolling,
		};
		this.entries.add(entry);
		this.configureEntry(entry);
		// Forced polling retains the legacy immediate probe, then 1s cadence.
		if (entry.fileFallback) entry.pending = "reconcile";
		this.ensureTimer();
		if (!this.forcePolling) this.reconcile();
		return {
			wait: (signal) => this.wait(entry, signal),
			inspectPane: () => this.inspect(entry),
			unregister: () => this.unregister(entry),
		};
	}

	/** Reconfigure the live owner; registration handles and its shared timer survive. */
	setForcePolling(forcePolling: boolean): void {
		if (this.forcePolling === forcePolling) return;
		if (this.closed) throw new Error("Supervision coordinator is closed");
		this.forcePolling = forcePolling;
		for (const entry of this.entries) {
			entry.wakeRegistration?.unregister();
			entry.wakeRegistration = undefined;
			entry.inspection = undefined;
			this.configureEntry(entry);
			// Finish the old transport's wait (and release its ref/timer). The
			// existing consumer probes evidence once, then waits on the new mode.
			if (entry.parked) entry.parked.resolve("reconcile");
			else this.signal(entry, "reconcile");
		}
	}

	private configureEntry(entry: Entry): void {
		entry.fileFallback = true;
		if (!this.forcePolling && process.platform !== "win32") {
			entry.wakeRegistration = this.wakeRegistry.register(
				entry.sessionFile,
				() => this.signal(entry, "wake"),
				() => this.enterFallback(entry),
			);
			entry.fileFallback = !entry.wakeRegistration.watching;
		}
		entry.fallback = entry.fileFallback || Date.now() < this.unhealthyUntil;
	}

	diagnostics(): SupervisionDiagnostics {
		const mode = this.forcePolling
			? "polling(forced)"
			: [...this.entries].some((entry) => entry.fallback)
				? "polling(fallback)"
				: "wake+batch";
		return { mode, watcherCount: this.wakeRegistry.watcherCount };
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.unhealthyTimer) this.timers.clearTimeout(this.unhealthyTimer);
		this.unhealthyTimer = undefined;
		for (const entry of this.entries) this.unregister(entry);
		this.entries.clear();
		this.wakeRegistry.close();
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
		this.timer.unref?.();
	}

	private unregister(entry: Entry): void {
		entry.unregistered = true;
		entry.wakeRegistration?.unregister();
		this.entries.delete(entry);
		if (this.entries.size === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		// Nothing can wake a parked wait now; settle it so its retain is released.
		entry.parked?.reject(new Error(UNREGISTERED_MESSAGE));
	}

	private enterFallback(entry: Entry): void {
		if (this.closed) return;
		entry.fileFallback = true;
		entry.fallback = true;
		entry.inspection = undefined;
		this.signal(entry, "reconcile");
	}

	private wait(entry: Entry, signal: AbortSignal): Promise<WakeReason> {
		if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));
		if (entry.unregistered)
			return Promise.reject(new Error(UNREGISTERED_MESSAGE));
		// One completion loop consumes a registration: `pending` queues a single
		// reason for a single waiter, so a second concurrent wait is a caller bug.
		if (entry.parked) return Promise.reject(new Error(CONCURRENT_WAIT_MESSAGE));
		if (entry.pending) {
			const reason = entry.pending;
			entry.pending = undefined;
			return Promise.resolve(reason);
		}
		return new Promise((resolve, reject) => {
			// Both transports have one owned wait, so a mode change can release
			// the old timer or watch retain without replacing the registration.
			const release = entry.fallback ? undefined : this.wakeRegistry.retain();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const finish = (settle: () => void) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				entry.parked = undefined;
				if (timer) this.timers.clearTimeout(timer);
				release?.();
				settle();
			};
			const onAbort = () => {
				finish(() => reject(new Error(ABORT_MESSAGE)));
			};
			entry.parked = {
				polling: entry.fallback,
				resolve: (reason) => finish(() => resolve(reason)),
				reject: (error) => finish(() => reject(error)),
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (entry.fallback)
				timer = this.timers.setTimeout(
					() => entry.parked?.resolve("reconcile"),
					POLLING_INTERVAL_MS,
				);
		});
	}

	private signal(entry: Entry, reason: WakeReason): void {
		if (this.closed) return;
		if (reason === "wake") entry.inspection = undefined;
		// Ordinary signals queue behind a poll's 1s cadence. Only a transport
		// change explicitly settles that timer early.
		if (entry.parked && !entry.parked.polling) entry.parked.resolve(reason);
		// A wake must never downgrade a queued reconciliation: the reconcile
		// reason carries the epoch's pane inspection, and skipping it would
		// defer pane-disappearance detection past the documented 5s bound.
		else if (entry.pending !== "reconcile") entry.pending = reason;
	}

	private async reconcile(): Promise<void> {
		if (this.closed || this.reconciling || this.entries.size === 0) return;
		this.reconciling = true;
		const snapshotGeneration = this.nextGeneration - 1;
		try {
			const snapshot = await this.listPanes();
			if (this.closed) return;
			if (!snapshot.complete) throw new Error("malformed pane list");
			const bySurface = new Set(snapshot.panes.map((pane) => pane.paneId));
			for (const entry of this.entries) {
				entry.fallback = entry.fileFallback;
				if (entry.fallback || entry.generation > snapshotGeneration) {
					// Legacy polling and later registrants always inspect their own pane.
					entry.inspection = undefined;
				} else if (bySurface.has(entry.surface)) {
					entry.inspection = {
						kind: "present",
						agentStatus: "unknown",
						observedAt: Date.now(),
					};
				} else {
					// A complete list can establish presence, not absence. Only pane get
					// may establish a missing pane before completion acts on it.
					entry.inspection = undefined;
				}
				this.signal(entry, "reconcile");
			}
			this.unhealthyUntil = 0;
			if (this.unhealthyTimer) this.timers.clearTimeout(this.unhealthyTimer);
			this.unhealthyTimer = undefined;
		} catch {
			if (this.closed) return;
			this.unhealthyUntil = Date.now() + BATCH_UNHEALTHY_MS;
			for (const entry of this.entries) {
				entry.fallback = true;
				entry.inspection = undefined;
				this.signal(entry, "reconcile");
			}
			if (this.unhealthyTimer) this.timers.clearTimeout(this.unhealthyTimer);
			this.unhealthyTimer = this.timers.setTimeout(() => {
				this.unhealthyTimer = undefined;
				if (!this.closed && Date.now() >= this.unhealthyUntil) this.reconcile();
			}, BATCH_UNHEALTHY_MS);
			this.unhealthyTimer.unref?.();
		} finally {
			this.reconciling = false;
		}
	}

	private async inspect(entry: Entry): Promise<PaneInspection> {
		if (entry.inspection) return entry.inspection;
		return this.inspectFallback(entry.surface);
	}
}
