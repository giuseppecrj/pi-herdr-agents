/**
 * Disposable Herdr servers for tests that must not touch the caller's Herdr:
 * their own HOME, XDG directories, config, sockets, and plugin registry under
 * one temporary root. Nothing inherits the caller's HERDR_* variables.
 */
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	requestHerdrSocket,
	type HerdrSocketReply,
} from "../../maestro/surfaces/herdr/herdr-socket.ts";
import {
	createLinuxProcessEnvironmentReader,
	createLinuxProcessProbe,
} from "../../maestro/adapters/pi/process-identity.ts";
import type { JsonObject } from "../../maestro/core/config/type-guards.ts";

const LAB_PREFIX = "piha-herdr-lab-";
const POLL_MS = 100;
/** Polls after `server.stop` before the fallback SIGTERM: 10 seconds. */
const GRACE_POLLS = 100;
/** Polls after the fallback SIGTERM before the server counts as residue. */
const TERM_POLLS = 50;

export const HERDR_BIN =
	process.env.HERDR_BIN ??
	execFileSync("sh", ["-c", "command -v herdr || true"], {
		encoding: "utf8",
	}).trim();

export interface HerdrLabRoot {
	root: string;
	home: string;
	env: NodeJS.ProcessEnv;
}

export interface HerdrLabServer {
	session: string;
	socket: string;
	pid: number;
	/** `/proc` start time, read before the lab could reap the PID. */
	startTime: string;
	env: NodeJS.ProcessEnv;
	call(method: string, params?: JsonObject): Promise<HerdrSocketReply>;
	/** The result, or a thrown error naming the method and Herdr's answer. */
	ok(method: string, params?: JsonObject): Promise<JsonObject>;
	cli(args: string[]): string;
}

export function createLabRoot(configToml: string): HerdrLabRoot {
	const root = mkdtempSync(join(tmpdir(), LAB_PREFIX));
	const home = join(root, "home");
	const env: NodeJS.ProcessEnv = {
		PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_STATE_HOME: join(home, ".local/state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_RUNTIME_DIR: join(root, "run"),
		TERM: "xterm-256color",
		LANG: "C.UTF-8",
		HERDR_CONFIG_PATH: join(root, "config.toml"),
	};
	for (const dir of [
		home,
		env.XDG_CONFIG_HOME,
		env.XDG_DATA_HOME,
		env.XDG_STATE_HOME,
		env.XDG_CACHE_HOME,
		env.XDG_RUNTIME_DIR,
	])
		if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(root, "config.toml"), configToml);
	return { root, home, env };
}

/**
 * How a server's shutdown ended. Only `stopped` lets `removeLabRoot` delete
 * the root; `residue` keeps it and says why.
 */
export type LabServerShutdown =
	| { kind: "stopped"; how: "absent" | "exited" | "terminated" }
	| { kind: "residue"; reason: string };

/** The process access `stopLabServer` uses; unit tests inject a fake. */
export interface LabProcessHost {
	/** Reads a `/proc` file; throws with `code` like `fs.readFileSync`. */
	read(path: string): string;
	terminate(pid: number): void;
	requestStop(socket: string): Promise<HerdrSocketReply>;
	sleep(ms: number): Promise<void>;
}

const linuxHost: LabProcessHost = {
	read: (path) => readFileSync(path, "utf8"),
	terminate: (pid) => process.kill(pid, "SIGTERM"),
	async requestStop(socket) {
		const keepAlive = setInterval(() => {}, 1_000);
		try {
			return await requestHerdrSocket(socket, "server.stop", {});
		} finally {
			clearInterval(keepAlive);
		}
	},
	sleep: (ms) => delay(ms),
};

type LabServerRecord = { kind: "running" } | LabServerShutdown;

/** Every server each lab spawned, by session, and how it last stopped. */
const labServers = new WeakMap<HerdrLabRoot, Map<string, LabServerRecord>>();

function serversOf(lab: HerdrLabRoot): Map<string, LabServerRecord> {
	const servers = labServers.get(lab) ?? new Map<string, LabServerRecord>();
	labServers.set(lab, servers);
	return servers;
}

type ServerState =
	| { kind: "gone" }
	| { kind: "owned" }
	| { kind: "unknown"; reason: string };

type ServerIdentity = Pick<
	HerdrLabServer,
	"session" | "pid" | "startTime" | "socket"
>;

/**
 * `owned` only when the PID still has the recorded start time, this server's
 * command line, and this lab's HOME. `gone` only when no process holds the
 * PID or the recorded process has exited. Anything else is `unknown`.
 */
function inspectServer(
	lab: HerdrLabRoot,
	server: ServerIdentity,
	host: LabProcessHost,
): ServerState {
	const { pid } = server;
	const probe = createLinuxProcessProbe(host.read);
	try {
		const stat = probe.stat(pid);
		if (!stat) return { kind: "gone" };
		if (stat.startTime !== server.startTime)
			return {
				kind: "unknown",
				reason: `PID ${pid} now names another process (start time ${stat.startTime}, recorded ${server.startTime})`,
			};
		if (stat.state === "Z" || stat.state === "X") return { kind: "gone" };
		let cmdline: string;
		try {
			cmdline = host.read(`/proc/${pid}/cmdline`);
		} catch (error) {
			// It may have exited since the stat read; only a missing PID says so.
			if (!probe.stat(pid)) return { kind: "gone" };
			throw error;
		}
		if (cmdline !== `${HERDR_BIN}\0--session\0${server.session}\0server\0`)
			return {
				kind: "unknown",
				reason: `PID ${pid} runs ${JSON.stringify(cmdline.replaceAll("\0", " ").trim())}, not the ${server.session} server`,
			};
		const environment = createLinuxProcessEnvironmentReader(host.read)(pid);
		if (!environment) return { kind: "gone" };
		if (environment.get("HOME") !== lab.home)
			return {
				kind: "unknown",
				reason: `PID ${pid} has HOME ${environment.get("HOME") ?? "(unset)"}, not ${lab.home}`,
			};
		return { kind: "owned" };
	} catch (error) {
		return {
			kind: "unknown",
			reason: `PID ${pid} identity is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Polls until the server is not `owned`, or `polls` checks have passed. */
async function waitWhileOwned(
	lab: HerdrLabRoot,
	server: ServerIdentity,
	host: LabProcessHost,
	polls: number,
): Promise<ServerState> {
	for (let poll = 1; ; poll++) {
		const state = inspectServer(lab, server, host);
		if (state.kind !== "owned" || poll >= polls) return state;
		await host.sleep(POLL_MS);
	}
}

export async function startLabServer(
	lab: HerdrLabRoot,
	session: string,
): Promise<HerdrLabServer> {
	const socket = join(
		lab.home,
		".config/herdr/sessions",
		session,
		"herdr.sock",
	);
	if (existsSync(socket)) throw new Error(`socket already exists: ${socket}`);
	mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(dirname(socket), "config.toml"),
		readFileSync(join(lab.root, "config.toml")),
	);
	const env = { ...lab.env, HERDR_SOCKET_PATH: socket };
	const child = spawn(HERDR_BIN, ["--session", session, "server"], {
		env,
		stdio: "ignore",
		detached: true,
	});
	// A failed spawn reports its error on a later turn; unheard, that event would
	// crash the test runner. No process exists then, so nothing is registered.
	const spawnError = new Promise<Error>((resolve) =>
		child.once("error", resolve),
	);
	child.unref();
	if (child.pid === undefined)
		throw new Error(
			`herdr server ${session} did not spawn: ${(await spawnError).message}`,
		);
	const pid = child.pid;
	const servers = serversOf(lab);
	servers.set(session, { kind: "running" });
	// Node reaps the child only on a later event-loop turn, so this PID still
	// names the spawned process here.
	let startTime: string;
	try {
		const stat = createLinuxProcessProbe(linuxHost.read).stat(pid);
		if (!stat) throw new Error("no /proc entry right after spawn");
		startTime = stat.startTime;
	} catch (error) {
		const reason = `PID ${pid} identity is unreadable: ${error instanceof Error ? error.message : String(error)}`;
		servers.set(session, { kind: "residue", reason });
		throw new Error(`herdr server ${session}: ${reason}; kept ${lab.root}`);
	}
	const call = async (method: string, params: JsonObject = {}) => {
		// The client unreferences its socket so Pi can always exit; a test must
		// hold its own event loop open while it waits for the answer.
		const keepAlive = setInterval(() => {}, 1_000);
		try {
			return await requestHerdrSocket(socket, method, params, {
				timeoutMs: 10_000,
			});
		} finally {
			clearInterval(keepAlive);
		}
	};
	const server: HerdrLabServer = {
		session,
		socket,
		pid,
		startTime,
		env,
		call,
		async ok(method, params = {}) {
			const reply = await call(method, params);
			if (reply.kind !== "result")
				throw new Error(
					`${method} ${JSON.stringify(params)}: ${JSON.stringify(reply)}`,
				);
			return reply.result;
		},
		cli: (args) =>
			execFileSync(HERDR_BIN, ["--session", session, ...args], {
				env,
				encoding: "utf8",
				timeout: 10_000,
			}),
	};
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (existsSync(socket) && (await call("ping")).kind === "result")
			return server;
		await delay(100);
	}
	const shutdown = await stopLabServer(lab, server);
	throw new Error(
		`herdr server ${session} did not start; shutdown: ${JSON.stringify(shutdown)}`,
	);
}

/**
 * Stops a server this lab started and waits until it has exited. Asks with
 * `server.stop`, then sends SIGTERM only to a PID whose identity it has just
 * re-verified. Never signals a PID it cannot identify; that is `residue`.
 */
export async function stopLabServer(
	lab: HerdrLabRoot,
	server: ServerIdentity,
	host: LabProcessHost = linuxHost,
): Promise<LabServerShutdown> {
	const shutdown = await shutDownServer(lab, server, host);
	serversOf(lab).set(server.session, shutdown);
	return shutdown;
}

async function shutDownServer(
	lab: HerdrLabRoot,
	server: ServerIdentity,
	host: LabProcessHost,
): Promise<LabServerShutdown> {
	const initial = inspectServer(lab, server, host);
	if (initial.kind === "gone") return { kind: "stopped", how: "absent" };
	if (initial.kind === "unknown")
		return { kind: "residue", reason: initial.reason };
	const reply = await host.requestStop(server.socket);
	const graceful = await waitWhileOwned(lab, server, host, GRACE_POLLS);
	if (graceful.kind === "gone") return { kind: "stopped", how: "exited" };
	if (graceful.kind === "unknown")
		return { kind: "residue", reason: graceful.reason };
	// `waitWhileOwned` re-verified the identity on its last poll, with no await
	// since, so the signal reaches this server and not a reused PID. A failed
	// signal is judged by the polls that follow: the server exited or it did not.
	let signalled = "SIGTERM";
	try {
		host.terminate(server.pid);
	} catch (error) {
		signalled = `SIGTERM, which failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	const terminated = await waitWhileOwned(lab, server, host, TERM_POLLS);
	if (terminated.kind === "gone") return { kind: "stopped", how: "terminated" };
	if (terminated.kind === "unknown")
		return { kind: "residue", reason: terminated.reason };
	return {
		kind: "residue",
		reason: `PID ${server.pid} survived server.stop (${reply.kind}) and ${signalled}`,
	};
}

/**
 * Removes the lab root only when every server the lab spawned has stopped.
 * Otherwise keeps the root and throws with each server's residue.
 */
export function removeLabRoot(lab: HerdrLabRoot): void {
	if (!lab.root.startsWith(join(tmpdir(), LAB_PREFIX)))
		throw new Error(`refusing to remove ${lab.root}`);
	const residue = [...serversOf(lab)].flatMap(([session, record]) => {
		if (record.kind === "stopped") return [];
		return [
			`${session}: ${record.kind === "running" ? "never stopped" : record.reason}`,
		];
	});
	if (residue.length > 0)
		throw new Error(`kept ${lab.root}: ${residue.join("; ")}`);
	rmSync(lab.root, { recursive: true, force: true });
}
