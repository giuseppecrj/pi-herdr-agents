import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DELEGATED_MARKER_DISCOVERY_MS,
	DELEGATED_MARKER_DISCOVERY_POLL_MS,
	DELEGATED_MARKER_RENEW_MS,
	DELEGATED_MARKER_TTL_MS,
	DelegatedMarkers,
	herdrMarkerSessionReader,
	herdrMarkerWriter,
	type MarkerSessionReader,
	type MarkerWriter,
} from "../../maestro/runtime/delegated-marker.ts";
import { RECONCILE_INTERVAL_MS } from "../../maestro/core/supervision.ts";
import type {
	PaneAgentSessionRead,
	PaneTokenOutcome,
} from "../../maestro/surfaces/herdr/herdr-socket.ts";
import { replyResult, withFakeHerdrSocket } from "../fake-herdr-socket.ts";

const SESSION = "/home/u/.pi/agent/sessions/child.jsonl";
const PANE = "w1:p2";

const own: PaneAgentSessionRead = { kind: "session", path: SESSION };
const other: PaneAgentSessionRead = {
	kind: "session",
	path: "/home/u/.pi/agent/sessions/other.jsonl",
};

interface PendingWrite {
	paneId: string;
	seq: number;
	live: boolean;
	settle(outcome: PaneTokenOutcome): void;
}

/**
 * A fake Herdr pane: `session` is what `pane.get` reports for it now.
 * Discovery polls advance the fake clock at once, or, when `gated`, only as
 * `poll()` releases them one at a time.
 */
function harness(initial: PaneAgentSessionRead = own, gated = false) {
	const clock = { now: 1_000_000 };
	const pane = { session: initial };
	const reads: string[] = [];
	const sleeps: number[] = [];
	const waiting: Array<() => void> = [];
	const writes: PendingWrite[] = [];
	const write: MarkerWriter = (request) =>
		new Promise((settle) => writes.push({ ...request, settle }));
	const readSession: MarkerSessionReader = async (paneId) => {
		reads.push(paneId);
		return pane.session;
	};
	const markers = new DelegatedMarkers({
		write,
		readSession,
		now: () => clock.now,
		sleep: async (ms) => {
			sleeps.push(ms);
			if (gated) await new Promise<void>((resolve) => waiting.push(resolve));
			clock.now += ms;
		},
	});
	const poll = async () => {
		await flush();
		waiting.shift()?.();
		await flush();
	};
	return { clock, pane, reads, sleeps, writes, markers, poll };
}

const flush = async () => {
	for (let i = 0; i < 5; i++)
		await new Promise<void>((resolve) => setImmediate(resolve));
};

async function liveMarker(h: ReturnType<typeof harness>) {
	const marker = h.markers.attach({ surface: PANE, sessionFile: SESSION });
	await flush();
	assert.equal(marker.kind, "live");
	return marker;
}

describe("delegated marker", () => {
	it("publishes once Herdr reports the child's own session for its pane", async () => {
		const h = harness({ kind: "none" }, true);
		const marker = h.markers.attach({ surface: PANE, sessionFile: SESSION });
		await flush();
		h.pane.session = other;
		await h.poll();
		assert.equal(marker.kind, "pending");
		h.pane.session = own;
		await h.poll();
		assert.equal(marker.kind, "live");
		assert.deepEqual(h.reads, [PANE, PANE, PANE]);
		assert.ok(
			h.sleeps.every((ms) => ms === DELEGATED_MARKER_DISCOVERY_POLL_MS),
		);
		assert.deepEqual(
			h.writes.map(({ paneId, live }) => ({ paneId, live })),
			[{ paneId: PANE, live: true }],
		);
	});

	for (const [label, session] of [
		["no session", { kind: "none" }],
		["another session", other],
		["an id-only session", { kind: "session" }],
		["only failed reads", { kind: "failed", reason: "timeout" }],
	] as const)
		it(`never writes when Herdr reports ${label} for the whole discovery window`, async () => {
			const h = harness(session);
			const marker = h.markers.attach({ surface: PANE, sessionFile: SESSION });
			await marker.settled();
			assert.equal(marker.kind, "retired");
			assert.ok(
				h.sleeps.reduce((sum, ms) => sum + ms, 0) >=
					DELEGATED_MARKER_DISCOVERY_MS,
			);
			marker.renew();
			marker.retire();
			await flush();
			assert.deepEqual(h.writes, []);
		});

	it("stops discovering without a write once the pane is missing", async () => {
		const h = harness({ kind: "pane-missing" });
		const marker = h.markers.attach({ surface: PANE, sessionFile: SESSION });
		await marker.settled();
		assert.equal(marker.kind, "retired");
		assert.equal(h.reads.length, 1);
		assert.deepEqual(h.writes, []);
	});

	it("retiring before the session appears writes nothing", async () => {
		const h = harness({ kind: "none" });
		const marker = h.markers.attach({ surface: PANE, sessionFile: SESSION });
		marker.retire();
		h.pane.session = own;
		await marker.settled();
		assert.equal(marker.kind, "retired");
		assert.deepEqual(h.writes, []);
	});

	it("renews at most every 4s, each time only after Herdr still reports the session", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		assert.deepEqual(
			h.writes.map(({ paneId, seq, live }) => ({ paneId, seq, live })),
			[{ paneId: PANE, seq: 1_000_000_000, live: true }],
		);
		h.writes[0].settle("answered");
		const readsAfterStart = h.reads.length;
		await flush();
		h.clock.now += DELEGATED_MARKER_RENEW_MS - 1;
		marker.renew();
		await flush();
		assert.equal(h.writes.length, 1);
		assert.equal(
			h.reads.length,
			readsAfterStart,
			"no read inside the interval",
		);
		h.clock.now += 1;
		marker.renew();
		await flush();
		assert.equal(h.reads.length, readsAfterStart + 1);
		assert.equal(h.writes.length, 2);
		assert.ok(h.writes[1].live && h.writes[1].seq > h.writes[0].seq);
	});

	it("keeps one renewal in flight; an unanswered renewal is never queued twice", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		for (let i = 0; i < 3; i++) {
			h.clock.now += DELEGATED_MARKER_RENEW_MS * 2;
			marker.renew();
			await flush();
		}
		assert.equal(h.writes.length, 1);
		h.writes[0].settle("answered");
		await flush();
		marker.renew();
		await flush();
		assert.equal(h.writes.length, 2);
	});

	it("never queues a renewal behind a stalled renewal", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		h.writes[0].settle("answered");
		await flush();
		h.clock.now += DELEGATED_MARKER_RENEW_MS;
		marker.renew();
		await flush();
		assert.equal(h.writes.length, 2, "the renewal's write is in flight");
		const reads = h.reads.length;
		for (let i = 0; i < 3; i++) {
			h.clock.now += DELEGATED_MARKER_RENEW_MS * 2;
			marker.renew();
			await flush();
		}
		assert.equal(h.reads.length, reads, "no read while a renewal is in flight");
		h.writes[1].settle("answered");
		await flush();
		assert.equal(h.writes.length, 2, "no catch-up renewal ran");
		marker.renew();
		await flush();
		assert.equal(h.writes.length, 3, "the next observation renews again");
	});

	for (const [label, session] of [
		["no session (the child exited)", { kind: "none" }],
		["another agent's session (the pane was reused)", other],
		["an id-only session", { kind: "session" }],
	] as const)
		it(`stops renewing and clears once Herdr reports ${label}`, async () => {
			const h = harness();
			const marker = await liveMarker(h);
			h.writes[0].settle("answered");
			await flush();
			h.pane.session = session;
			h.clock.now += DELEGATED_MARKER_RENEW_MS;
			marker.renew();
			await flush();
			assert.equal(marker.kind, "retired");
			assert.deepEqual(
				h.writes.map(({ live }) => live),
				[true, false],
			);
			h.pane.session = own;
			h.clock.now += DELEGATED_MARKER_RENEW_MS;
			marker.renew();
			h.writes[1].settle("answered");
			await flush();
			assert.equal(h.writes.length, 2, "a retired marker never revives");
		});

	it("retires without a clear when a renewal finds the pane missing", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		h.writes[0].settle("answered");
		await flush();
		h.pane.session = { kind: "pane-missing" };
		h.clock.now += DELEGATED_MARKER_RENEW_MS;
		marker.renew();
		await flush();
		assert.equal(marker.kind, "retired");
		marker.retire();
		await flush();
		assert.equal(h.writes.length, 1);
	});

	it("skips a renewal it cannot read and stops after three failed reads", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		h.writes[0].settle("answered");
		await flush();
		h.pane.session = { kind: "failed", reason: "timeout" };
		for (let attempt = 0; attempt < 3; attempt++) {
			assert.equal(marker.kind, "live");
			h.clock.now += DELEGATED_MARKER_RENEW_MS;
			marker.renew();
			await flush();
		}
		assert.equal(marker.kind, "retired");
		assert.deepEqual(
			h.writes.map(({ live }) => live),
			[true, false],
		);
	});

	it("counts a throwing reader as a failed read", async () => {
		const clock = { now: 1_000_000 };
		let reads = 0;
		const writes: boolean[] = [];
		const markers = new DelegatedMarkers({
			write: async ({ live }) => {
				writes.push(live);
				return "answered";
			},
			readSession: async () => {
				if (++reads > 1) throw new Error("socket exploded");
				return own;
			},
			now: () => clock.now,
		});
		const marker = markers.attach({ surface: PANE, sessionFile: SESSION });
		await marker.settled();
		assert.equal(marker.kind, "live");
		for (let attempt = 0; attempt < 3; attempt++) {
			assert.equal(
				marker.kind,
				"live",
				`still live before throw ${attempt + 1}`,
			);
			clock.now += DELEGATED_MARKER_RENEW_MS;
			marker.renew();
			await marker.settled();
		}
		assert.equal(reads, 4, "one discovery read and three throwing renewals");
		assert.equal(marker.kind, "retired");
		assert.deepEqual(writes, [true, false]);
	});

	it("orders the clear after an in-flight write and ignores that write's late result", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		marker.retire();
		await flush();
		assert.equal(h.writes.length, 1, "the clear waits for the in-flight write");
		h.writes[0].settle("pane-missing");
		await flush();
		assert.equal(marker.kind, "retired");
		assert.equal(h.writes.length, 2);
		assert.equal(h.writes[1].live, false);
		assert.ok(h.writes[1].seq > h.writes[0].seq);
		marker.retire();
		await flush();
		assert.equal(h.writes.length, 2, "retire is idempotent");
	});

	it("drops a renewal that was queued before retirement", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		h.writes[0].settle("answered");
		await flush();
		// Hold a clear-free queue behind a slow first renewal.
		h.clock.now += DELEGATED_MARKER_RENEW_MS;
		marker.renew();
		await flush();
		marker.retire();
		h.clock.now += DELEGATED_MARKER_RENEW_MS;
		marker.renew();
		h.writes[1].settle("answered");
		await flush();
		assert.deepEqual(
			h.writes.map(({ live }) => live),
			[true, true, false],
		);
	});

	it("retires without a clear when Herdr reports the pane missing to a write", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		h.writes[0].settle("pane-missing");
		await flush();
		assert.equal(marker.kind, "retired");
		h.clock.now += DELEGATED_MARKER_RENEW_MS;
		marker.renew();
		marker.retire();
		await flush();
		assert.equal(h.writes.length, 1);
	});

	it("never retries a failed write and stops after three consecutive failures", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		for (let attempt = 0; attempt < 3; attempt++) {
			h.writes[attempt].settle("failed");
			await flush();
			assert.equal(h.writes.length, attempt === 2 ? 4 : attempt + 1);
			h.clock.now += DELEGATED_MARKER_RENEW_MS;
			marker.renew();
			await flush();
		}
		assert.equal(marker.kind, "retired");
		assert.deepEqual(
			h.writes.map(({ live }) => live),
			[true, true, true, false],
		);
		h.writes[3].settle("failed");
		await flush();
		assert.equal(h.writes.length, 4, "the clear is not retried either");
	});

	it("resets the failure budget after an answered write", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		const outcomes: PaneTokenOutcome[] = [
			"failed",
			"failed",
			"answered",
			"failed",
			"failed",
		];
		for (const [index, outcome] of outcomes.entries()) {
			h.writes[index].settle(outcome);
			await flush();
			h.clock.now += DELEGATED_MARKER_RENEW_MS;
			marker.renew();
			await flush();
		}
		assert.equal(marker.kind, "live");
	});

	it("counts a throwing writer as a failed write", async () => {
		let calls = 0;
		const markers = new DelegatedMarkers({
			write: async () => {
				calls++;
				throw new Error("socket exploded");
			},
			readSession: async () => own,
		});
		const marker = markers.attach({ surface: PANE, sessionFile: SESSION });
		await marker.settled();
		assert.equal(calls, 1);
		assert.equal(marker.kind, "live");
	});

	it("shares one increasing sequence across panes, even if the clock goes back", async () => {
		const h = harness();
		const first = await liveMarker(h);
		h.clock.now -= 60_000;
		const second = await liveMarker(h);
		first.retire();
		second.retire();
		for (const write of h.writes) write.settle("answered");
		await flush();
		for (const write of h.writes) write.settle("answered");
		await flush();
		const seqs = h.writes.map(({ seq }) => seq);
		assert.deepEqual(
			seqs,
			[...seqs].sort((a, b) => a - b),
		);
		assert.equal(new Set(seqs).size, seqs.length);
	});

	it("renews well inside the TTL at the supervision reconciliation cadence", () => {
		// Renewal is driven by supervision observations; two reconciliations
		// plus a full renewal interval must still fit inside one TTL.
		assert.ok(
			RECONCILE_INTERVAL_MS * 2 + DELEGATED_MARKER_RENEW_MS <
				DELEGATED_MARKER_TTL_MS,
		);
	});
});

describe("Herdr marker transport", () => {
	it("writes the exact marker contract with a TTL and clears without one", () =>
		withFakeHerdrSocket(replyResult({ type: "ok" }), async (path, requests) => {
			const write = herdrMarkerWriter(path);
			assert.equal(
				await write({ paneId: PANE, seq: 5, live: true }),
				"answered",
			);
			assert.equal(
				await write({ paneId: PANE, seq: 6, live: false }),
				"answered",
			);
			assert.deepEqual(
				requests.map(({ params }) => params),
				[
					{
						pane_id: PANE,
						source: "pi-herdr-agents",
						seq: 5,
						tokens: { piha_delegated_v1: "live" },
						ttl_ms: 15_000,
					},
					{
						pane_id: PANE,
						source: "pi-herdr-agents",
						seq: 6,
						tokens: { piha_delegated_v1: null },
					},
				],
			);
		}));

	it("reads the pane's session through pane.get", () =>
		withFakeHerdrSocket(
			replyResult({
				type: "pane_info",
				pane: {
					pane_id: PANE,
					agent_session: { agent: "pi", kind: "path", value: SESSION },
				},
			}),
			async (path, requests) => {
				assert.deepEqual(await herdrMarkerSessionReader(path)(PANE), own);
				assert.equal(requests[0].method, "pane.get");
			},
		));
});
