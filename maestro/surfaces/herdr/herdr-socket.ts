import { connect } from "node:net";
import {
	isNonEmptyString,
	isRecord,
	isString,
	type JsonObject,
} from "../../core/config/type-guards.ts";

export const HERDR_SOCKET_TIMEOUT_MS = 2_000;
export const HERDR_SOCKET_MAX_REPLY_BYTES = 64 * 1024;
const MAX_REPORTED_CHARS = 200;

export type HerdrSocketReply =
	| { kind: "result"; result: JsonObject }
	/** Herdr answered with an error object. */
	| { kind: "error"; code: string; message: string }
	/** No usable answer: refused, closed, timed out, oversized, malformed, or another id. */
	| { kind: "failed"; reason: string };

function bounded(text: string): string {
	return text.replace(/\p{Cc}+/gu, " ").slice(0, MAX_REPORTED_CHARS);
}

let requestCount = 0;

/**
 * One request on one connection: Herdr closes ordinary connections after a
 * reply. Settles once with the first newline-terminated reply, or fails on a
 * timeout, an oversized reply, or a connection that ends first. The socket
 * and timer are unreferenced, so a pending request never keeps Pi running.
 */
export function requestHerdrSocket(
	socketPath: string,
	method: string,
	params: JsonObject,
	options: { timeoutMs?: number; maxReplyBytes?: number } = {},
): Promise<HerdrSocketReply> {
	const timeoutMs = options.timeoutMs ?? HERDR_SOCKET_TIMEOUT_MS;
	const maxReplyBytes = options.maxReplyBytes ?? HERDR_SOCKET_MAX_REPLY_BYTES;
	const id = `pi-herdr-agents:${process.pid}:${++requestCount}`;
	return new Promise((resolve) => {
		let settled = false;
		let received = Buffer.alloc(0);
		const socket = connect(socketPath);
		socket.unref();
		const finish = (reply: HerdrSocketReply) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(reply);
		};
		const timer = setTimeout(
			() =>
				finish({
					kind: "failed",
					reason: `${method} got no reply in ${timeoutMs}ms`,
				}),
			timeoutMs,
		);
		timer.unref();
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		socket.on("error", (error) =>
			finish({ kind: "failed", reason: bounded(error.message) }),
		);
		socket.on("close", () =>
			finish({
				kind: "failed",
				reason: `${method}: connection closed before a reply`,
			}),
		);
		socket.on("data", (chunk: Buffer) => {
			received = Buffer.concat([received, chunk]);
			const end = received.indexOf(10);
			if ((end < 0 ? received.length : end) > maxReplyBytes) {
				finish({
					kind: "failed",
					reason: `${method} reply exceeds ${maxReplyBytes} bytes`,
				});
				return;
			}
			if (end >= 0)
				finish(
					parseHerdrSocketReply(received.subarray(0, end).toString("utf8"), id),
				);
		});
	});
}

/**
 * Herdr answers `ok` even when it ignores a write whose `seq` is not newer
 * than the last one it applied from this source, so `answered` is not proof
 * that the token changed.
 */
export type PaneTokenOutcome = "answered" | "pane-missing" | "failed";

export interface PaneTokenWrite {
	paneId: string;
	source: string;
	seq: number;
	token: string;
	/** `null` clears the token. */
	value: string | null;
	ttlMs?: number;
}

/** One sequenced `pane.report_metadata` token patch. */
export async function reportPaneToken(
	socketPath: string,
	write: PaneTokenWrite,
	options?: { timeoutMs?: number },
): Promise<PaneTokenOutcome> {
	const params: JsonObject = {
		pane_id: write.paneId,
		source: write.source,
		seq: write.seq,
		tokens: { [write.token]: write.value },
	};
	if (write.ttlMs !== undefined) params.ttl_ms = write.ttlMs;
	const reply = await requestHerdrSocket(
		socketPath,
		"pane.report_metadata",
		params,
		options,
	);
	if (reply.kind === "result") return "answered";
	if (reply.kind === "error" && reply.code === "pane_not_found")
		return "pane-missing";
	return "failed";
}

/** Parses one reply line; a reply for another request id is never accepted. */
export function parseHerdrSocketReply(
	line: string,
	id: string,
): HerdrSocketReply {
	let reply: JsonObject | undefined;
	try {
		const parsed: unknown = JSON.parse(line);
		if (isRecord(parsed)) reply = parsed;
	} catch {
		// Malformed JSON is the same failure as a non-object reply below.
	}
	if (!reply) return { kind: "failed", reason: "reply is not a JSON object" };
	if (reply.id !== id)
		return {
			kind: "failed",
			reason: `reply id ${bounded(JSON.stringify(reply.id) ?? "missing")} is not ${id}`,
		};
	if (isRecord(reply.error))
		return {
			kind: "error",
			code: isNonEmptyString(reply.error.code)
				? bounded(reply.error.code)
				: "herdr_error",
			message: isString(reply.error.message)
				? bounded(reply.error.message)
				: "",
		};
	if (!isRecord(reply.result))
		return { kind: "failed", reason: "reply has no result" };
	return { kind: "result", result: reply.result };
}
