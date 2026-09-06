// THROWAWAY PROTOTYPE: isolated Herdr/Pi fixtures, not production code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
export const quote = (value) =>
	"'" + String(value).replaceAll("'", "'\\''") + "'";
export const now = () => Number(process.hrtime.bigint()) / 1e6;
export async function until(
	test,
	milliseconds = 15000,
	description = "condition",
) {
	const deadline = now() + milliseconds;
	while (now() < deadline) {
		const value = await test();
		if (value) return value;
		await delay(25);
	}
	throw new Error(`Prototype timeout: ${description}`);
}

export function run(command, args, env, timeout = 10000) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "",
			stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code !== 0) {
				const error = new Error(
					`${command} ${args.slice(0, 3).join(" ")}: ${stderr || stdout || signal}`,
				);
				for (const text of [stderr, stdout]) {
					try {
						error.code = JSON.parse(text).error?.code;
					} catch {}
				}
				reject(error);
			} else resolveRun(stdout);
		});
	});
}

export function rpc(socketPath, method, params = {}) {
	return new Promise((resolveRpc, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`RPC timeout: ${method}`));
		}, 5000);
		const finish = (error, result) => {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolveRpc(result);
		};
		socket.once("connect", () =>
			socket.write(JSON.stringify({ id: "prototype", method, params }) + "\n"),
		);
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > 2 * 1024 * 1024)
				return finish(new Error("Oversized RPC response"));
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const value = JSON.parse(buffer.slice(0, newline));
				finish(
					value.error ? new Error(JSON.stringify(value.error)) : null,
					value.result,
				);
			} catch (error) {
				finish(error);
			}
		});
		socket.once("error", (error) => finish(error));
	});
}

function procStat(pid) {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const columns = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
		return {
			pid: Number(pid),
			parent: Number(columns[1]),
			ticks: Number(columns[11]) + Number(columns[12]),
			childTicks: Number(columns[13]) + Number(columns[14]),
		};
	} catch {
		return null;
	}
}

// Linux CPU ticks, including reaped CLI children; snapshots occur before child release.
export async function cpuSnapshot(serverPid) {
	const self = procStat(process.pid);
	const stats = (await readdir("/proc"))
		.filter((name) => /^\d+$/.test(name))
		.map(procStat)
		.filter(Boolean);
	const owned = new Set([serverPid]);
	for (let changed = true; changed; ) {
		changed = false;
		for (const stat of stats)
			if (owned.has(stat.parent) && !owned.has(stat.pid)) {
				owned.add(stat.pid);
				changed = true;
			}
	}
	const tree = stats.filter((stat) => owned.has(stat.pid));
	return {
		supervisorTicks: self.ticks + self.childTicks,
		herdrTreeTicks: tree.reduce(
			(sum, stat) => sum + stat.ticks + stat.childTicks,
			0,
		),
		herdrPids: tree.map((stat) => stat.pid),
	};
}

export async function createLab() {
	const root = await mkdtemp(join(tmpdir(), "issue29-lab-"));
	const home = join(root, "home");
	const socketPath = join(
		home,
		".config/herdr/sessions/issue29-prototype/herdr.sock",
	);
	assert.notEqual(socketPath, process.env.HERDR_SOCKET_PATH);
	await mkdir(dirname(socketPath), { recursive: true });
	const config = join(root, "config.toml");
	await writeFile(
		config,
		'onboarding = false\n[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n[ui.sound]\nenabled = false\n[ui.toast]\ndelivery = "off"\n[session]\nresume_agents_on_restore = false\n[experimental]\nallow_nested = true\n',
	);
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		SHELL: "/bin/bash",
		LANG: "C.UTF-8",
		TERM: "xterm-256color",
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_STATE_HOME: join(home, ".local/state"),
		HERDR_CONFIG_PATH: config,
		HERDR_SOCKET_PATH: socketPath,
		PI_OFFLINE: "1",
	};
	await writeFile(
		join(home, ".config/herdr/config.toml"),
		await readFile(config),
	);
	await writeFile(
		join(dirname(socketPath), "config.toml"),
		await readFile(config),
	);
	const spawnServer = () => {
		const logFd = openSync(join(root, "server.log"), "a");
		const child = spawn("herdr", ["--session", "issue29-prototype", "server"], {
			env,
			stdio: ["ignore", logFd, logFd],
		});
		closeSync(logFd);
		return child;
	};
	let server = spawnServer();
	await writeFile(
		join(root, "ownership.json"),
		JSON.stringify(
			{
				owner: "issue29-prototype",
				serverPid: server.pid,
				socketPath,
				state: "starting",
			},
			null,
			2,
		),
	);
	const lab = {
		root,
		home,
		env,
		socketPath,
		server,
		serverPid: server.pid,
		fixtures: [],
		calls: [],
		measuring: false,
		inFlight: 0,
	};
	lab.cli = async (args) => {
		if (lab.measuring)
			lab.calls.push({
				at: now(),
				command: args.slice(0, 2).join(" "),
				pane: args[2],
			});
		lab.inFlight++;
		try {
			const output = await run("herdr", args, env);
			if (args[0] === "pane" && args[1] === "read") return output;
			return output.trim() ? JSON.parse(output) : {};
		} finally {
			lab.inFlight--;
		}
	};
	lab.restart = async () => {
		assert.ok(socketPath.startsWith(root + "/"));
		await run("herdr", ["server", "stop"], env, 5000);
		await until(
			() => server.exitCode !== null || server.signalCode !== null,
			5000,
			"owned restart shutdown",
		);
		server = spawnServer();
		lab.server = server;
		lab.serverPid = server.pid;
		await until(
			async () => {
				try {
					return await rpc(socketPath, "workspace.list");
				} catch {
					return false;
				}
			},
			15000,
			"owned restart startup",
		);
		await writeFile(
			join(root, "ownership.json"),
			JSON.stringify(
				{
					owner: "issue29-prototype",
					serverPid: server.pid,
					socketPath,
					state: "restarted",
				},
				null,
				2,
			),
		);
	};
	lab.stop = async () => {
		lab.measuring = false;
		for (const fixture of lab.fixtures)
			if (lab.pending?.has(fixture.id)) fixture.release("done");
		try {
			await run("herdr", ["server", "stop"], env, 5000);
		} catch {}
		if (server.exitCode === null && server.signalCode === null) {
			try {
				await until(
					() => server.exitCode !== null || server.signalCode !== null,
					5000,
					"owned server exit",
				);
			} catch {
				server.kill("SIGTERM");
			}
		}
		if (lab.http) {
			lab.http.closeAllConnections();
			await new Promise((resolveStop) => lab.http.close(resolveStop));
		}
	};
	try {
		await until(
			async () => {
				if (server.exitCode !== null)
					throw new Error(await readFile(join(root, "server.log"), "utf8"));
				try {
					return await rpc(socketPath, "workspace.list");
				} catch {
					return false;
				}
			},
			15000,
			"isolated Herdr startup",
		);
		const created = await lab.cli([
			"workspace",
			"create",
			"--cwd",
			root,
			"--label",
			"PROTOTYPE owned fixtures",
			"--no-focus",
		]);
		lab.workspace = created.result.workspace.workspace_id;
		lab.rootPane = created.result.root_pane.pane_id;
		await writeFile(
			join(root, "ownership.json"),
			JSON.stringify(
				{
					owner: "issue29-prototype",
					serverPid: server.pid,
					socketPath,
					workspace: lab.workspace,
					rootPane: lab.rootPane,
				},
				null,
				2,
			),
		);
		return lab;
	} catch (error) {
		await lab.stop();
		throw error;
	}
}

export async function startProvider(lab) {
	const pending = new Map();
	const http = createServer(async (request, response) => {
		if (
			request.method !== "POST" ||
			!request.url?.endsWith("/chat/completions")
		) {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) {
			body += chunk;
			if (body.length > 1024 * 1024) {
				response.writeHead(413).end();
				return;
			}
		}
		let data;
		try {
			data = JSON.parse(body);
		} catch {
			response.writeHead(400).end();
			return;
		}
		const text = JSON.stringify(data.messages);
		const id = text.match(/PROTOTYPE_CHILD_([a-z0-9-]+)/)?.[1];
		if (!id) {
			response.writeHead(400).end(
				JSON.stringify({
					error: { message: "Missing prototype fixture id" },
				}),
			);
			return;
		}
		const finish = (mode) => {
			if (response.writableEnded || response.destroyed) return;
			if (mode === "error") {
				response.writeHead(400, { "content-type": "application/json" }).end(
					JSON.stringify({
						error: { message: "prototype account/model rejection" },
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			const toolRequested =
				mode === "ping" &&
				!data.messages.some((message) => message.role === "tool");
			const delta = toolRequested
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "prototype-ping",
								type: "function",
								function: {
									name: "caller_ping",
									arguments: '{"message":"prototype needs help"}',
								},
							},
						],
					}
				: { role: "assistant", content: `PROTOTYPE_RESULT_${id}` };
			response.write(
				`data: ${JSON.stringify({ id: "prototype", object: "chat.completion.chunk", created: 1, model: "hold", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({ id: "prototype", object: "chat.completion.chunk", created: 1, model: "hold", choices: [{ index: 0, delta: {}, finish_reason: toolRequested ? "tool_calls" : "stop" }] })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		};
		const existing = pending.get(id);
		if (existing?.released) finish(existing.mode);
		else pending.set(id, { finish, released: false });
	});
	await new Promise((resolveStart) =>
		http.listen(0, "127.0.0.1", resolveStart),
	);
	lab.http = http;
	lab.pending = pending;
	lab.instrument = join(
		dirname(fileURLToPath(import.meta.url)),
		"instrumented-child.ts",
	);
	const agentDir = join(lab.root, "agent");
	await mkdir(agentDir);
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				prototype: {
					baseUrl: `http://127.0.0.1:${http.address().port}/v1`,
					api: "openai-completions",
					apiKey: "prototype-not-a-secret",
					models: [
						{
							id: "hold",
							name: "Deterministic prototype",
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 128,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	lab.agentDir = agentDir;
}

export async function fixture(lab, id) {
	const created = await lab.cli([
		"tab",
		"create",
		"--workspace",
		lab.workspace,
		"--cwd",
		lab.root,
		"--label",
		id,
		"--no-focus",
	]);
	const pane = created.result.root_pane.pane_id;
	const dir = join(lab.root, id);
	await mkdir(dir);
	const session = join(dir, "session.jsonl");
	const script = join(dir, "launch.sh");
	const args = [
		"--session",
		session,
		"--model",
		"prototype/hold",
		"--thinking",
		"off",
		"--no-extensions",
		"-e",
		lab.instrument,
		"--no-skills",
		"--no-context-files",
		"--no-approve",
		"--tools",
		"caller_ping",
		`PROTOTYPE_CHILD_${id}`,
	];
	const command = `PI_CODING_AGENT_DIR=${quote(lab.agentDir)} PI_SUBAGENT_ID=${quote(id)} PI_SUBAGENT_NAME=${quote(id)} PI_SUBAGENT_SESSION=${quote(session)} PI_SUBAGENT_ACTIVITY_FILE=${quote(join(dir, "activity.json"))} PI_SUBAGENT_AUTO_EXIT=1 pi ${args.map(quote).join(" ")}`;
	await writeFile(
		script,
		`#!/bin/bash\n${command}\ncode=$?\nprintf '__SUBAGENT_DONE_%s__\\n' "$code"\nexit "$code"\n`,
	);
	await until(
		async () => {
			const value = await lab.cli(["pane", "process-info", "--pane", pane]);
			return value.result;
		},
		5000,
		"fixture shell",
	);
	await lab.cli(["pane", "run", pane, `bash ${quote(script)}`]);
	const value = {
		id,
		pane,
		dir,
		session,
		release: (mode) => {
			const state = lab.pending.get(id);
			assert.ok(state, `Fixture ${id} did not reach deterministic provider`);
			state.released = true;
			state.mode = mode;
			value.releasedAt = now();
			state.finish(mode);
		},
	};
	lab.fixtures.push(value);
	await until(() => lab.pending.has(id), 30000, `Pi fixture ${id}`);
	return value;
}

export async function disposeFixture(lab, value) {
	try {
		await lab.cli(["pane", "close", value.pane]);
	} catch {}
	lab.fixtures = lab.fixtures.filter((item) => item !== value);
}
