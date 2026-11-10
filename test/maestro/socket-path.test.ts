import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { socketPath } from "../socket-path.ts";

test("socketPath keeps the socket file inside the directory off Windows", () => {
	for (const platform of ["linux", "darwin"] as const)
		assert.equal(
			socketPath("/tmp/fake-herdr-abc", "herdr.sock", platform),
			join("/tmp/fake-herdr-abc", "herdr.sock"),
		);
});

test("socketPath names a unique flat named pipe on Windows", () => {
	const dir = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\hc-unit-Ab12";
	const first = socketPath(dir, "rpc.sock", "win32");
	const second = socketPath(dir, "rpc.sock", "win32");
	const prefix = "\\\\.\\pipe\\";
	for (const path of [first, second]) {
		assert.ok(path.startsWith(prefix), path);
		const name = path.slice(prefix.length);
		assert.match(name, /^hc-unit-Ab12-rpc\.sock-[0-9a-f-]{36}$/);
	}
	assert.notEqual(first, second);
});

test("a server listening on socketPath accepts a client on this platform", async () => {
	const dir = mkdtempSync(join(tmpdir(), "socket-path-"));
	const path = socketPath(dir, "probe.sock");
	const server = createServer((socket) => socket.end("pong\n"));
	try {
		server.listen(path);
		await once(server, "listening");
		const client = connect(path);
		client.setEncoding("utf8");
		let reply = "";
		client.on("data", (chunk: string) => (reply += chunk));
		await once(client, "end");
		assert.equal(reply, "pong\n");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});
