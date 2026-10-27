import {
	readPaneAgentSession,
	reportPaneToken,
	type PaneAgentSessionRead,
	type PaneTokenOutcome,
	type PaneTokenWrite,
} from "../surfaces/herdr/herdr-socket.ts";

/** The pane token the Pi Herdr Agents Sidebar plugin reads. */
export const DELEGATED_MARKER_TOKEN = "piha_delegated_v1";
/** Recently classified as a delegated child; never proof of a live occupant. */
export const DELEGATED_MARKER_VALUE = "live";
/** One stable source: a pane accepts sequenced reports from at most 32. */
export const DELEGATED_MARKER_SOURCE = "pi-herdr-agents";
/** Bounds a leftover marker after the last write Herdr applied, not liveness. */
export const DELEGATED_MARKER_TTL_MS = 15_000;
/**
 * Renewal rides on supervision observations: the 4.8s reconciliation, or
 * 1s fallback polling. Both leave several renewals inside one TTL.
 */
export const DELEGATED_MARKER_RENEW_MS = 4_000;
/**
 * Consecutive failed renewal reads or writes before a live marker stops; its
 * TTL ends it. Discovery instead retries until its window ends.
 */
export const DELEGATED_MARKER_MAX_FAILURES = 3;
/** How long a new marker waits for Herdr to report the child's session. */
export const DELEGATED_MARKER_DISCOVERY_MS = 15_000;
export const DELEGATED_MARKER_DISCOVERY_POLL_MS = 250;

export type MarkerWriter = (write: {
	paneId: string;
	seq: number;
	live: boolean;
}) => Promise<PaneTokenOutcome>;

/** The agent session Herdr currently stores for a pane. */
export type MarkerSessionReader = (
	paneId: string,
) => Promise<PaneAgentSessionRead>;

export function herdrMarkerWriter(socketPath: string): MarkerWriter {
	return ({ paneId, seq, live }) => {
		const write: PaneTokenWrite = {
			paneId,
			source: DELEGATED_MARKER_SOURCE,
			seq,
			token: DELEGATED_MARKER_TOKEN,
			value: null,
		};
		if (live) {
			write.value = DELEGATED_MARKER_VALUE;
			write.ttlMs = DELEGATED_MARKER_TTL_MS;
		}
		return reportPaneToken(socketPath, write);
	};
}

export function herdrMarkerSessionReader(
	socketPath: string,
): MarkerSessionReader {
	return (paneId) => readPaneAgentSession(socketPath, paneId);
}

type MarkerState =
	| { kind: "pending" }
	| { kind: "live"; lastSentAt: number }
	| { kind: "retired" };

function unrefSleep(ms: number): Promise<void> {
	// Discovery must never hold the parent process open.
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * This parent process's marker writes. Every pane shares one sequence that
 * starts at wall-clock microseconds, so a restarted parent still outranks
 * its predecessor's writes unless the clock moved backwards.
 */
export class DelegatedMarkers {
	readonly write: MarkerWriter;
	readonly readSession: MarkerSessionReader;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	private lastSeq = 0;

	constructor(options: {
		write: MarkerWriter;
		readSession: MarkerSessionReader;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	}) {
		this.write = options.write;
		this.readSession = options.readSession;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? unrefSleep;
	}

	/**
	 * A marker for one launched child. It publishes only once Herdr reports
	 * the child's own session file for its pane; until then it never writes.
	 */
	attach(child: { surface: string; sessionFile: string }): DelegatedMarker {
		return new DelegatedMarker(this, child.surface, child.sessionFile);
	}

	nextSeq(): number {
		this.lastSeq = Math.max(this.lastSeq + 1, this.now() * 1000);
		return this.lastSeq;
	}
}

/**
 * One child's marker. Writes are serialized: at most one renewal is queued or
 * in flight, followed by at most one clear. Renewal continues only while
 * Herdr reports the child's session file for the pane. Herdr drops that
 * session when the child exits or another agent takes the pane, so a later
 * occupant never inherits the marker's renewal.
 */
export class DelegatedMarker {
	readonly paneId: string;
	readonly sessionFile: string;
	private readonly owner: DelegatedMarkers;
	private state: MarkerState = { kind: "pending" };
	private sentLive = false;
	private renewalQueued = false;
	private failures = 0;
	private queue: Promise<void> = Promise.resolve();
	private readonly discovery: Promise<void>;

	constructor(owner: DelegatedMarkers, paneId: string, sessionFile: string) {
		this.owner = owner;
		this.paneId = paneId;
		this.sessionFile = sessionFile;
		this.discovery = this.discover();
	}

	get kind(): MarkerState["kind"] {
		return this.state.kind;
	}

	/** Resolves once discovery ends and every write queued by then settles. */
	async settled(): Promise<void> {
		await this.discovery;
		for (let seen: Promise<void> | undefined; seen !== this.queue; ) {
			seen = this.queue;
			await seen;
		}
	}

	/** Called on each supervision observation; renews at most every 4s. */
	renew(): void {
		const state = this.state;
		const at = this.owner.now();
		if (
			state.kind !== "live" ||
			this.renewalQueued ||
			at - state.lastSentAt < DELEGATED_MARKER_RENEW_MS
		)
			return;
		state.lastSentAt = at;
		this.renewalQueued = true;
		this.queue = this.queue.then(() => this.renewal());
	}

	/** Idempotent. Clears the token if any live write may have reached Herdr. */
	retire(): void {
		if (this.state.kind === "retired") return;
		this.state = { kind: "retired" };
		if (this.sentLive) this.queue = this.queue.then(() => this.send(false));
	}

	private async discover(): Promise<void> {
		const deadline = this.owner.now() + DELEGATED_MARKER_DISCOVERY_MS;
		for (;;) {
			if (this.state.kind !== "pending") return;
			const read = await this.read();
			if (this.state.kind !== "pending") return;
			if (this.owns(read)) {
				this.state = { kind: "live", lastSentAt: this.owner.now() };
				this.queue = this.queue.then(() => this.send(true));
				return;
			}
			if (read.kind === "pane-missing" || this.owner.now() >= deadline) {
				this.state = { kind: "retired" };
				return;
			}
			await this.owner.sleep(DELEGATED_MARKER_DISCOVERY_POLL_MS);
		}
	}

	private async renewal(): Promise<void> {
		// The guard holds until this renewal's read and write settle, so a slow
		// renewal never lets another queue behind it.
		try {
			// A renewal queued before retirement is dropped, never sent after it.
			if (this.state.kind !== "live") return;
			const read = await this.read();
			if (this.state.kind !== "live") return;
			if (this.owns(read)) await this.send(true);
			else if (read.kind === "pane-missing") this.state = { kind: "retired" };
			else if (read.kind === "failed") this.fail();
			// No session or another one: the child exited or the pane was reused.
			else this.retire();
		} finally {
			this.renewalQueued = false;
		}
	}

	private owns(read: PaneAgentSessionRead): boolean {
		return read.kind === "session" && read.path === this.sessionFile;
	}

	private async read(): Promise<PaneAgentSessionRead> {
		try {
			return await this.owner.readSession(this.paneId);
		} catch (error) {
			return {
				kind: "failed",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private fail(): void {
		if (++this.failures >= DELEGATED_MARKER_MAX_FAILURES) this.retire();
	}

	private async send(live: boolean): Promise<void> {
		if (live && this.state.kind !== "live") return;
		if (live) this.sentLive = true;
		let outcome: PaneTokenOutcome;
		try {
			outcome = await this.owner.write({
				paneId: this.paneId,
				seq: this.owner.nextSeq(),
				live,
			});
		} catch {
			outcome = "failed";
		}
		// A late result never revives or reclassifies a retired marker.
		if (!live || this.state.kind !== "live") return;
		if (outcome === "answered") this.failures = 0;
		else if (outcome === "pane-missing") this.state = { kind: "retired" };
		else this.fail();
	}
}
