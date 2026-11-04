/** A private local Core for integration tests; never inherits the caller's server. */
import { execFile, execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
	isFiniteNumber,
	isRecord,
	isString,
	type JsonObject,
} from "../../maestro/core/config/type-guards.ts";

const run = promisify(execFile);
const PREFIX = "piha-core-lab-";

export function findLabBinary(name: "herdr-core" | "pi" | "fd"): string {
	const found = execFileSync("sh", ["-c", `command -v ${name} || true`], {
		encoding: "utf8",
		timeout: 5_000,
	}).trim();
	return found ? realpathSync(found) : "";
}

export interface CoreLabIdentity {
	id: string;
	pid: number;
}

export function coreLabIdentity(reply: JsonObject): CoreLabIdentity {
	if (
		!isRecord(reply.core) ||
		!isString(reply.core.id) ||
		!reply.core.id ||
		!isFiniteNumber(reply.pid) ||
		!Number.isSafeInteger(reply.pid) ||
		reply.pid <= 0
	)
		throw new Error("Core lab server returned no usable identity");
	return { id: reply.core.id, pid: reply.pid };
}

/** Independent test driver: newline JSON-RPC, bounded replies, no auto-start. */
export function coreLabRequest(
	socketPath: string,
	method: string,
	params: JsonObject = {},
): Promise<JsonObject> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let finished = false;
		let data = Buffer.alloc(0);
		const finish = (error?: Error, result?: JsonObject) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(result!);
		};
		const timer = setTimeout(
			() => finish(new Error(`Core lab ${method} timed out`)),
			15_000,
		);
		socket.on("connect", () =>
			socket.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
			),
		);
		socket.on("error", (error) => finish(error));
		socket.on("close", () =>
			finish(new Error(`Core lab ${method} closed before a reply`)),
		);
		socket.on("data", (chunk: Buffer) => {
			data = Buffer.concat([data, chunk]);
			if (data.length > 1024 * 1024)
				return finish(new Error(`Core lab ${method} reply exceeds 1 MiB`));
			const end = data.indexOf(10);
			if (end < 0) return;
			try {
				const reply = JSON.parse(data.subarray(0, end).toString("utf8"));
				if (
					!isRecord(reply) ||
					reply.jsonrpc !== "2.0" ||
					reply.id !== 1 ||
					reply.error !== undefined ||
					!isRecord(reply.result)
				)
					throw new Error(`Core lab ${method}: ${JSON.stringify(reply)}`);
				finish(undefined, reply.result);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

export class CoreLab {
	readonly root: string;
	readonly socket: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly binary: string;
	#identity?: CoreLabIdentity;
	#attempted = false;
	#stopped = false;
	#removed = false;

	constructor(
		binary: string,
		piBinary: string,
		options: { copyBinary?: boolean } = {},
	) {
		// macOS's default TMPDIR makes Unix socket addresses too long. mkdtemp
		// supplies a fresh 0700 directory; canonicalize /tmp before recording it.
		this.root = realpathSync(mkdtempSync(join("/tmp", PREFIX)));
		this.socket = join(this.root, "core.sock");
		this.binary = options.copyBinary
			? join(this.root, "bin", "herdr-core")
			: binary;
		if (options.copyBinary) {
			try {
				mkdirSync(dirname(this.binary), { mode: 0o700 });
				copyFileSync(binary, this.binary);
			} catch (error) {
				rmSync(this.root, { recursive: true });
				throw error;
			}
		}
		this.env = {
			PATH: [
				dirname(piBinary),
				dirname(this.binary),
				dirname(process.execPath),
				"/usr/bin",
				"/bin",
				"/usr/sbin",
				"/sbin",
			].join(":"),
			HOME: join(this.root, "home"),
			TMPDIR: join(this.root, "tmp"),
			XDG_CONFIG_HOME: join(this.root, "config"),
			XDG_STATE_HOME: join(this.root, "state"),
			XDG_DATA_HOME: join(this.root, "data"),
			XDG_CACHE_HOME: join(this.root, "cache"),
			XDG_RUNTIME_DIR: join(this.root, "run"),
			HC_SOCKET: this.socket,
			HC_SESSION: basename(this.root),
			PI_CODING_AGENT_DIR: join(this.root, "agent"),
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
			BASH_SILENCE_DEPRECATION_WARNING: "1",
			NO_COLOR: "1",
		};
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
			mkdirSync(this.env[key]!, { recursive: true, mode: 0o700 });
	}

	async start(): Promise<void> {
		if (this.#attempted) throw new Error("Core lab start is one-shot");
		this.assertRoot();
		this.#attempted = true;
		const { stdout } = await run(this.binary, ["server", "start"], {
			env: this.env,
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 1024 * 1024,
		});
		const reply = JSON.parse(stdout);
		if (!isRecord(reply)) throw new Error("Core lab start returned no record");
		this.#identity = coreLabIdentity(reply);
		const current = coreLabIdentity(await this.call("server.status"));
		if (current.id !== this.#identity.id || current.pid !== this.#identity.pid)
			throw new Error("Core lab socket does not name its started server");
	}

	call(method: string, params: JsonObject = {}): Promise<JsonObject> {
		this.assertRoot();
		return coreLabRequest(this.socket, method, params);
	}

	/** Stops only the server identity in this fresh lab. Never signals a PID. */
	async stop(): Promise<void> {
		if (!this.#attempted || this.#stopped) return;
		if (!this.#identity)
			throw new Error(`Core launch identity unknown; retained ${this.root}`);
		const current = coreLabIdentity(await this.call("server.status"));
		if (current.id !== this.#identity.id || current.pid !== this.#identity.pid)
			throw new Error(`Core lab identity changed; retained ${this.root}`);
		const status = await this.call("server.status");
		const listing = await this.call("terminal.list", { all: true });
		if (!Array.isArray(listing.terminals) || !Array.isArray(status.holders))
			throw new Error(
				`Core lab process inventory unknown; retained ${this.root}`,
			);
		const pids = [current.pid];
		for (const entry of [...listing.terminals, ...status.holders]) {
			if (!isRecord(entry))
				throw new Error(
					`Core lab process inventory malformed; retained ${this.root}`,
				);
			if (
				entry.state !== "finished" &&
				isFiniteNumber(entry.pid) &&
				Number.isSafeInteger(entry.pid) &&
				entry.pid > 0
			)
				pids.push(entry.pid);
		}
		const answer = await this.call("server.stop");
		if (answer.stopped !== true)
			throw new Error(`Core stop unconfirmed; retained ${this.root}`);
		const deadline = performance.now() + 10_000;
		while (existsSync(this.socket) || pids.some(processExists)) {
			if (performance.now() >= deadline)
				throw new Error(
					`Core lab processes still present; retained ${this.root}`,
				);
			await delay(50);
		}
		this.#stopped = true;
	}

	remove(): void {
		if (this.#removed) return;
		this.assertRoot();
		if (this.#attempted && !this.#stopped)
			throw new Error(`Core lab shutdown unconfirmed; retained ${this.root}`);
		rmSync(this.root, { recursive: true });
		this.#removed = true;
	}

	private assertRoot(): void {
		const stat = lstatSync(this.root);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			dirname(this.root) !== realpathSync("/tmp") ||
			!basename(this.root).startsWith(PREFIX)
		)
			throw new Error(`Not a private Core lab root: ${this.root}`);
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// SAFETY: Node process errors carry an optional errno code.
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}
