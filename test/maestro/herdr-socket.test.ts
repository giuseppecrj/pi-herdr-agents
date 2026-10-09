import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseHerdrSocketReply,
	reportPaneToken,
	requestHerdrSocket,
} from "../../maestro/surfaces/herdr/herdr-socket.ts";
import {
	replyError,
	replyResult,
	withFakeHerdrSocket,
} from "../fake-herdr-socket.ts";

describe("Herdr socket request", () => {
	it("writes one newline-terminated request per connection and returns its result", () =>
		withFakeHerdrSocket(replyResult({ type: "ok" }), async (path, requests) => {
			assert.deepEqual(
				await requestHerdrSocket(path, "ping", { probe: true }),
				{ kind: "result", result: { type: "ok" } },
			);
			await requestHerdrSocket(path, "ping", {});
			assert.equal(requests.length, 2);
			assert.notEqual(requests[0].connection, requests[1].connection);
			assert.notEqual(requests[0].id, requests[1].id);
			assert.deepEqual(JSON.parse(requests[0].line), {
				id: requests[0].id,
				method: "ping",
				params: { probe: true },
			});
		}));

	it("reports Herdr errors with their code and message", () =>
		withFakeHerdrSocket(
			replyError("pane_not_found", "pane w9:p9 not found"),
			async (path) => {
				assert.deepEqual(await requestHerdrSocket(path, "pane.get", {}), {
					kind: "error",
					code: "pane_not_found",
					message: "pane w9:p9 not found",
				});
			},
		));

	it("assembles a reply split across chunks", () =>
		withFakeHerdrSocket(
			(request, socket) => {
				const line = `${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`;
				socket.write(line.slice(0, 5));
				setTimeout(() => socket.end(line.slice(5)), 20);
			},
			async (path) => {
				assert.equal(
					(await requestHerdrSocket(path, "ping", {})).kind,
					"result",
				);
			},
		));

	it("fails within its timeout when Herdr never answers", () =>
		withFakeHerdrSocket(
			() => {},
			async (path) => {
				const started = Date.now();
				const reply = await requestHerdrSocket(
					path,
					"ping",
					{},
					{
						timeoutMs: 100,
					},
				);
				assert.deepEqual(reply, {
					kind: "failed",
					reason: "ping got no reply in 100ms",
				});
				assert.ok(Date.now() - started < 2_000);
			},
		));

	it("fails when the connection closes after partial data", () =>
		withFakeHerdrSocket(
			(_request, socket) => socket.end('{"id":"partial'),
			async (path) => {
				assert.deepEqual(await requestHerdrSocket(path, "ping", {}), {
					kind: "failed",
					reason: "ping: connection closed before a reply",
				});
			},
		));

	it("never accepts a reply for another request id", () =>
		withFakeHerdrSocket(
			(_request, socket) =>
				socket.end(
					`${JSON.stringify({ id: "other", result: { type: "ok" } })}\n`,
				),
			async (path) => {
				const reply = await requestHerdrSocket(path, "ping", {});
				assert.equal(reply.kind, "failed");
				assert.match(
					reply.kind === "failed" ? reply.reason : "",
					/reply id "other"/,
				);
			},
		));

	it("bounds the reply frame with or without a newline", async () => {
		for (const terminated of [false, true])
			await withFakeHerdrSocket(
				(_request, socket) =>
					socket.write(`${"x".repeat(2_048)}${terminated ? "\n" : ""}`),
				async (path) => {
					assert.deepEqual(
						await requestHerdrSocket(
							path,
							"ping",
							{},
							{ maxReplyBytes: 1_024 },
						),
						{ kind: "failed", reason: "ping reply exceeds 1024 bytes" },
					);
				},
			);
	});

	it("fails when nothing listens on the socket", async () => {
		const reply = await requestHerdrSocket(
			"/nonexistent/herdr.sock",
			"ping",
			{},
		);
		assert.equal(reply.kind, "failed");
	});

	it("rejects malformed and result-less replies", () => {
		assert.equal(parseHerdrSocketReply("not json", "a").kind, "failed");
		assert.equal(parseHerdrSocketReply("[]", "a").kind, "failed");
		assert.deepEqual(parseHerdrSocketReply('{"id":"a"}', "a"), {
			kind: "failed",
			reason: "reply has no result",
		});
		assert.deepEqual(parseHerdrSocketReply('{"id":"a","error":{}}', "a"), {
			kind: "error",
			code: "herdr_error",
			message: "",
		});
	});
});

describe("pane token report", () => {
	it("sends one sequenced report_metadata token patch", () =>
		withFakeHerdrSocket(replyResult({ type: "ok" }), async (path, requests) => {
			assert.equal(
				await reportPaneToken(path, {
					paneId: "w1:p2",
					source: "pi-herdr-agents",
					seq: 7,
					token: "piha_delegated_v1",
					value: "live",
					ttlMs: 15_000,
				}),
				"answered",
			);
			assert.equal(
				await reportPaneToken(path, {
					paneId: "w1:p2",
					source: "pi-herdr-agents",
					seq: 8,
					token: "piha_delegated_v1",
					value: null,
				}),
				"answered",
			);
			assert.deepEqual(
				requests.map(({ method, params }) => ({ method, params })),
				[
					{
						method: "pane.report_metadata",
						params: {
							pane_id: "w1:p2",
							source: "pi-herdr-agents",
							seq: 7,
							tokens: { piha_delegated_v1: "live" },
							ttl_ms: 15_000,
						},
					},
					{
						method: "pane.report_metadata",
						params: {
							pane_id: "w1:p2",
							source: "pi-herdr-agents",
							seq: 8,
							tokens: { piha_delegated_v1: null },
						},
					},
				],
			);
		}));

	it("distinguishes a missing pane from other failures", async () => {
		const write = {
			paneId: "w1:p2",
			source: "pi-herdr-agents",
			seq: 1,
			token: "piha_delegated_v1",
			value: "live",
		};
		await withFakeHerdrSocket(
			replyError("pane_not_found", "gone"),
			async (path) => {
				assert.equal(await reportPaneToken(path, write), "pane-missing");
			},
		);
		await withFakeHerdrSocket(
			replyError("invalid_params", "bad"),
			async (path) => {
				assert.equal(await reportPaneToken(path, write), "failed");
			},
		);
	});
});
