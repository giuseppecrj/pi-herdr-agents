import {
	judgeProcessIdentity,
	linuxProcessProbe,
	type PiProcessIdentity,
	type ProcessIdentityProbe,
	type ProcessIdentityState,
} from "../adapters/pi/process-identity.ts";
import {
	reportPaneToken,
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
/** Consecutive failed writes before a marker stops trying; its TTL ends it. */
export const DELEGATED_MARKER_MAX_FAILURES = 3;

export type MarkerWriter = (write: {
	paneId: string;
	seq: number;
	live: boolean;
}) => Promise<PaneTokenOutcome>;

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

type MarkerState =
	| { kind: "pending" }
	| { kind: "live"; identity: PiProcessIdentity; lastSentAt: number }
	| { kind: "retired" };

/**
 * This parent process's marker writes. Every pane shares one sequence that
 * starts at wall-clock microseconds, so a restarted parent still outranks
 * its predecessor's writes unless the clock moved backwards.
 */
export class DelegatedMarkers {
	readonly write: MarkerWriter;
	readonly now: () => number;
	private readonly probe: ProcessIdentityProbe;
	private lastSeq = 0;

	constructor(options: {
		write: MarkerWriter;
		probe?: ProcessIdentityProbe;
		now?: () => number;
	}) {
		this.write = options.write;
		this.probe = options.probe ?? linuxProcessProbe;
		this.now = options.now ?? Date.now;
	}

	/**
	 * A marker for one launched child. It publishes only after the child's
	 * own process identity is verified; without one it never writes.
	 */
	attach(child: {
		surface: string;
		processIdentityCapture?: Promise<PiProcessIdentity | undefined>;
	}): DelegatedMarker {
		return new DelegatedMarker(
			this,
			child.surface,
			child.processIdentityCapture,
		);
	}

	judge(identity: PiProcessIdentity): ProcessIdentityState {
		return judgeProcessIdentity(identity, this.probe);
	}

	nextSeq(): number {
		this.lastSeq = Math.max(this.lastSeq + 1, this.now() * 1000);
		return this.lastSeq;
	}
}

/**
 * One child's marker. Writes are serialized: at most one renewal is queued or
 * in flight, followed by at most one clear. Renewal continues only while the
 * launch-verified process identity is alive, so a later process in the same
 * pane never inherits it.
 */
export class DelegatedMarker {
	readonly paneId: string;
	private readonly owner: DelegatedMarkers;
	private state: MarkerState = { kind: "pending" };
	private sentLive = false;
	private liveQueued = false;
	private failures = 0;
	private queue: Promise<void> = Promise.resolve();

	constructor(
		owner: DelegatedMarkers,
		paneId: string,
		capture: Promise<PiProcessIdentity | undefined> | undefined,
	) {
		this.owner = owner;
		this.paneId = paneId;
		if (!capture) {
			this.state = { kind: "retired" };
			return;
		}
		void capture.then(
			(identity) => this.start(identity),
			() => this.start(undefined),
		);
	}

	get kind(): MarkerState["kind"] {
		return this.state.kind;
	}

	/** Resolves when every write queued so far has settled. */
	settled(): Promise<void> {
		return this.queue;
	}

	/** Called on each supervision observation; renews at most every 4s. */
	renew(): void {
		const state = this.state;
		const at = this.owner.now();
		if (
			state.kind !== "live" ||
			this.liveQueued ||
			at - state.lastSentAt < DELEGATED_MARKER_RENEW_MS
		)
			return;
		if (this.owner.judge(state.identity).kind !== "alive") {
			this.retire();
			return;
		}
		state.lastSentAt = at;
		this.queueWrite(true);
	}

	/** Idempotent. Clears the token if any live write may have reached Herdr. */
	retire(): void {
		if (this.state.kind === "retired") return;
		this.state = { kind: "retired" };
		if (this.sentLive) this.queueWrite(false);
	}

	private start(identity: PiProcessIdentity | undefined): void {
		if (this.state.kind !== "pending") return;
		if (!identity || this.owner.judge(identity).kind !== "alive") {
			this.state = { kind: "retired" };
			return;
		}
		this.state = { kind: "live", identity, lastSentAt: this.owner.now() };
		this.queueWrite(true);
	}

	private queueWrite(live: boolean): void {
		if (live) this.liveQueued = true;
		this.queue = this.queue.then(() => this.send(live));
	}

	private async send(live: boolean): Promise<void> {
		if (live) this.liveQueued = false;
		// A renewal queued before retirement is dropped, never sent after it.
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
		else if (++this.failures >= DELEGATED_MARKER_MAX_FAILURES) this.retire();
	}
}
