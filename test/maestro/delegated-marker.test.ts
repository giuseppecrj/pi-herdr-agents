import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DELEGATED_MARKER_RENEW_MS,
	DELEGATED_MARKER_TTL_MS,
	DelegatedMarkers,
	herdrMarkerWriter,
	type MarkerWriter,
} from "../../maestro/runtime/delegated-marker.ts";
import { RECONCILE_INTERVAL_MS } from "../../maestro/core/supervision.ts";
import type {
	PiProcessIdentity,
	ProcessIdentityProbe,
} from "../../maestro/adapters/pi/process-identity.ts";
import type { PaneTokenOutcome } from "../../maestro/surfaces/herdr/herdr-socket.ts";
import { replyResult, withFakeHerdrSocket } from "../fake-herdr-socket.ts";

const identity: PiProcessIdentity = {
	pid: 4242,
	startTime: "100",
	bootId: "boot",
	pidNamespace: "pid:[1]",
};

type ProcessFact = "alive" | "exited" | "replaced" | "unreadable";

/** What the fake /proc reports for the child's PID. */
interface ChildProcess {
	fact: ProcessFact;
}

interface PendingWrite {
	paneId: string;
	seq: number;
	live: boolean;
	settle(outcome: PaneTokenOutcome): void;
}

function harness() {
	const clock = { now: 1_000_000 };
	const child: ChildProcess = { fact: "alive" };
	const probe: ProcessIdentityProbe = {
		host: () => ({ bootId: "boot", pidNamespace: "pid:[1]" }),
		stat(pid) {
			assert.equal(pid, identity.pid);
			if (child.fact === "unreadable") throw new Error("EACCES");
			if (child.fact === "exited") return undefined;
			return {
				state: "S",
				ppid: 1,
				startTime: child.fact === "replaced" ? "999" : identity.startTime,
			};
		},
		terminate() {
			throw new Error("markers never signal");
		},
	};
	const writes: PendingWrite[] = [];
	const write: MarkerWriter = (request) =>
		new Promise((settle) => writes.push({ ...request, settle }));
	const markers = new DelegatedMarkers({
		write,
		probe,
		now: () => clock.now,
	});
	return { clock, child, writes, markers };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function liveMarker(h: ReturnType<typeof harness>) {
	const marker = h.markers.attach({
		surface: "w1:p2",
		processIdentityCapture: Promise.resolve(identity),
	});
	await flush();
	return marker;
}

describe("delegated marker", () => {
	it("never writes without a verified, live identity", async () => {
		const h = harness();
		const uncaptured = h.markers.attach({ surface: "w1:p1" });
		const failed = h.markers.attach({
			surface: "w1:p2",
			processIdentityCapture: Promise.resolve(undefined),
		});
		const rejected = h.markers.attach({
			surface: "w1:p3",
			processIdentityCapture: Promise.reject(new Error("capture failed")),
		});
		h.child.fact = "exited";
		const dead = h.markers.attach({
			surface: "w1:p4",
			processIdentityCapture: Promise.resolve(identity),
		});
		await flush();
		h.clock.now += DELEGATED_MARKER_RENEW_MS * 2;
		for (const marker of [uncaptured, failed, rejected, dead]) {
			marker.renew();
			marker.retire();
			assert.equal(marker.kind, "retired");
		}
		await flush();
		assert.deepEqual(h.writes, []);
	});

	it("publishes after verification and renews at most every 4s while alive", async () => {
		const h = harness();
		const marker = await liveMarker(h);
		assert.deepEqual(
			h.writes.map(({ paneId, seq, live }) => ({ paneId, seq, live })),
			[{ paneId: "w1:p2", seq: 1_000_000_000, live: true }],
		);
		h.writes[0].settle("answered");
		await flush();
		h.clock.now += DELEGATED_MARKER_RENEW_MS - 1;
		marker.renew();
		await flush();
		assert.equal(h.writes.length, 1);
		h.clock.now += 1;
		marker.renew();
		await flush();
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

	for (const fact of ["exited", "replaced", "unreadable"] as const)
		it(`stops renewing and clears once the original process is ${fact}`, async () => {
			const h = harness();
			const marker = await liveMarker(h);
			h.writes[0].settle("answered");
			await flush();
			h.child.fact = fact;
			h.clock.now += DELEGATED_MARKER_RENEW_MS;
			marker.renew();
			await flush();
			assert.equal(marker.kind, "retired");
			assert.deepEqual(
				h.writes.map(({ live }) => live),
				[true, false],
			);
			h.child.fact = "alive";
			h.clock.now += DELEGATED_MARKER_RENEW_MS;
			marker.renew();
			h.writes[1].settle("answered");
			await flush();
			assert.equal(h.writes.length, 2);
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

	it("retiring before the identity is verified writes nothing", async () => {
		const h = harness();
		let resolve!: (value: PiProcessIdentity) => void;
		const marker = h.markers.attach({
			surface: "w1:p2",
			processIdentityCapture: new Promise((r) => {
				resolve = r;
			}),
		});
		marker.retire();
		resolve(identity);
		await flush();
		assert.deepEqual(h.writes, []);
	});

	it("retires without a clear when Herdr reports the pane missing", async () => {
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
			probe: {
				host: () => ({ bootId: "boot", pidNamespace: "pid:[1]" }),
				stat: () => ({ state: "S", ppid: 1, startTime: "100" }),
				terminate() {},
			},
		});
		const marker = markers.attach({
			surface: "w1:p2",
			processIdentityCapture: Promise.resolve(identity),
		});
		await flush();
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

describe("Herdr marker writer", () => {
	it("writes the exact marker contract with a TTL and clears without one", () =>
		withFakeHerdrSocket(replyResult({ type: "ok" }), async (path, requests) => {
			const write = herdrMarkerWriter(path);
			assert.equal(
				await write({ paneId: "w1:p2", seq: 5, live: true }),
				"answered",
			);
			assert.equal(
				await write({ paneId: "w1:p2", seq: 6, live: false }),
				"answered",
			);
			assert.deepEqual(
				requests.map(({ params }) => params),
				[
					{
						pane_id: "w1:p2",
						source: "pi-herdr-agents",
						seq: 5,
						tokens: { piha_delegated_v1: "live" },
						ttl_ms: 15_000,
					},
					{
						pane_id: "w1:p2",
						source: "pi-herdr-agents",
						seq: 6,
						tokens: { piha_delegated_v1: null },
					},
				],
			);
		}));
});
