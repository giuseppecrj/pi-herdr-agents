import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	herdrMarkerSessionReader,
	herdrMarkerWriter,
} from "../../pi-extension/subagents/marker-transport.ts";
import type { PaneAgentSessionRead } from "../../maestro/surfaces/herdr/herdr-socket.ts";
import { replyResult, withFakeHerdrSocket } from "../fake-herdr-socket.ts";

const SESSION = "/home/u/.pi/agent/sessions/child.jsonl";
const PANE = "w1:p2";

const own: PaneAgentSessionRead = { kind: "session", path: SESSION };

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
