/** A real Unix socket that answers like Herdr, scripted per request. */
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
	isRecord,
	isString,
	type JsonObject,
} from "../maestro/core/config/type-guards.ts";

export interface ReceivedRequest {
	/** The exact line the client wrote, without its newline. */
	line: string;
	id: string;
	method: string;
	params: JsonObject;
	/** Requests are one per connection, so each has its own socket. */
	connection: number;
}

/** Reply to one request by writing to, ending, or ignoring its socket. */
export type FakeHerdrReply = (request: ReceivedRequest, socket: Socket) => void;

export function replyResult(result: JsonObject): FakeHerdrReply {
	return (request, socket) =>
		socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
}

export function replyError(code: string, message: string): FakeHerdrReply {
	return (request, socket) =>
		socket.end(
			`${JSON.stringify({ id: request.id, error: { code, message } })}\n`,
		);
}

export async function withFakeHerdrSocket(
	reply: FakeHerdrReply,
	run: (socketPath: string, requests: ReceivedRequest[]) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
	const socketPath = join(dir, "herdr.sock");
	const requests: ReceivedRequest[] = [];
	const sockets = new Set<Socket>();
	let connections = 0;
	const server: Server = createServer((socket) => {
		const connection = ++connections;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			const parsed = JSON.parse(line);
			const request: ReceivedRequest = {
				line,
				id: isString(parsed.id) ? parsed.id : "",
				method: isString(parsed.method) ? parsed.method : "",
				params: isRecord(parsed.params) ? parsed.params : {},
				connection,
			};
			requests.push(request);
			reply(request, socket);
		});
	});
	server.listen(socketPath);
	await once(server, "listening");
	try {
		await run(socketPath, requests);
	} finally {
		for (const socket of sockets) socket.destroy();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
