import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import {
	CoreLab,
	coreLabIdentity,
	coreLabRequest,
} from "../integration/herdr-core-lab.ts";

const unix = { skip: process.platform === "win32" };

// The fixture does not start a Core; all RPCs below end at a private fake socket.
test("Core lab identity requires an exact core and positive integer PID", () => {
	assert.deepEqual(coreLabIdentity({ core: { id: "owned" }, pid: 42 }), {
		id: "owned",
		pid: 42,
	});
	for (const reply of [
		{},
		{ core: { id: "" }, pid: 42 },
		{ core: { id: "owned" }, pid: 0 },
		{ core: { id: "owned" }, pid: 1.5 },
		{ core: { id: "owned" }, pid: "42" },
	])
		assert.throws(() => coreLabIdentity(reply), /usable identity/);
});

test(
	"Core lab starts with private canonical paths and no inherited connection/auth context",
	unix,
	() => {
		const lab = new CoreLab("/opt/core/herdr-core", "/opt/pi/pi");
		try {
			assert.ok(
				lab.root.startsWith("/private/tmp/piha-core-lab-") ||
					lab.root.startsWith("/tmp/piha-core-lab-"),
			);
			assert.ok(
				Buffer.byteLength(lab.socket) < 104,
				"Darwin Unix socket path limit",
			);
			assert.equal(lstatSync(lab.root).mode & 0o077, 0);
			assert.equal(lab.env.HC_SOCKET, lab.socket);
			assert.ok(lab.env.HC_SESSION?.startsWith("piha-core-lab-"));
			for (const key of [
				"HOME",
				"TMPDIR",
				"XDG_CONFIG_HOME",
				"XDG_STATE_HOME",
				"XDG_DATA_HOME",
				"XDG_CACHE_HOME",
				"XDG_RUNTIME_DIR",
				"PI_CODING_AGENT_DIR",
			])
				assert.ok(lab.env[key]?.startsWith(lab.root + "/"), key);
			for (const key of [
				"HC_TERMINAL_ID",
				"HC_TERMINAL_SOCKET",
				"HERDR_ENV",
				"HERDR_SOCKET_PATH",
				"PI_SUBAGENT_ID",
				"OPENAI_API_KEY",
			])
				assert.equal(lab.env[key], undefined, key);
			assert.ok(lab.env.PATH?.startsWith("/opt/pi:/opt/core:"));
		} finally {
			lab.remove();
			lab.remove();
		}
		assert.equal(existsSync(lab.root), false);
	},
);

test(
	"Core lab refuses cleanup when the root stopped being private",
	unix,
	() => {
		const lab = new CoreLab("/bin/false", "/bin/false");
		try {
			chmodSync(lab.root, 0o777);
			assert.throws(() => lab.remove(), /Not a private Core lab root/);
			assert.equal(existsSync(lab.root), true);
		} finally {
			chmodSync(lab.root, 0o700);
			lab.remove();
		}
	},
);

test(
	"unknown start ownership is retained, never retried, removed or signalled",
	unix,
	async () => {
		const lab = new CoreLab("/bin/false", "/bin/false");
		try {
			await assert.rejects(lab.start());
			await assert.rejects(lab.start(), /one-shot/);
			await assert.rejects(lab.stop(), /launch identity unknown/);
			assert.throws(() => lab.remove(), /shutdown unconfirmed/);
			assert.equal(existsSync(lab.root), true);
		} finally {
			// /bin/false exited: this test acquired no server, and owns the directory.
			rmSync(lab.root, { recursive: true });
		}
	},
);

test(
	"Core lab RPC validates framing, IDs and errors using only its socket",
	unix,
	async () => {
		const lab = new CoreLab("/bin/false", "/bin/false");
		const requests: string[] = [];
		let response = '{"jsonrpc":"2.0","id":1,"result":{"alive":true}}\n';
		const server = createServer((socket) => {
			socket.once("data", (data) => {
				requests.push(data.toString());
				socket.end(response);
			});
		});
		try {
			await new Promise<void>((resolve) => server.listen(lab.socket, resolve));
			assert.deepEqual(await coreLabRequest(lab.socket, "server.status"), {
				alive: true,
			});
			assert.deepEqual(JSON.parse(requests[0]), {
				jsonrpc: "2.0",
				id: 1,
				method: "server.status",
				params: {},
			});
			for (const value of [
				'{"jsonrpc":"2.0","id":2,"result":{}}\n',
				'{"id":1,"result":{}}\n',
				'{"jsonrpc":"2.0","id":1,"error":{"message":"no"}}\n',
				'{"jsonrpc":"2.0","id":1,"result":null}\n',
				"invalid\n",
			]) {
				response = value;
				await assert.rejects(coreLabRequest(lab.socket, "server.status"));
			}
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			lab.remove();
		}
	},
);

test(
	"Core lab stop refuses a replacement server before sending stop",
	unix,
	async () => {
		const staging = new CoreLab("/bin/false", "/bin/false");
		const binary = join(staging.root, "fake-core");
		writeFileSync(
			binary,
			`#!${process.execPath}\nconsole.log(JSON.stringify({core:{id:'original'},pid:42}));\n`,
			{ mode: 0o700 },
		);
		const lab = new CoreLab(binary, "/bin/false");
		const methods: string[] = [];
		let id = "original";
		const server = createServer((socket) => {
			socket.once("data", (data) => {
				const request = JSON.parse(data.toString());
				methods.push(request.method);
				socket.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { core: { id }, pid: 42 },
					}) + "\n",
				);
			});
		});
		try {
			await new Promise<void>((resolve) => server.listen(lab.socket, resolve));
			await lab.start();
			id = "replacement";
			await assert.rejects(lab.stop(), /identity changed/);
			assert.equal(methods.includes("server.stop"), false);
			assert.throws(() => lab.remove(), /shutdown unconfirmed/);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			// The only server was the fake above, now closed; no Core process existed.
			rmSync(lab.root, { recursive: true });
			staging.remove();
		}
	},
);
