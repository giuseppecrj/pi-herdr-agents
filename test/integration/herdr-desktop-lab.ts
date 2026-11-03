/** Optional macOS Desktop fixture. State is private; the physical display is NOT. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
	closeSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	isRecord,
	isString,
	type JsonObject,
} from "../../maestro/core/config/type-guards.ts";
import { CoreLab } from "./herdr-core-lab.ts";

/** No CLI auto-start, inherited app home, retries, or implicit window activation. */
export function desktopLabRequest(
	socketPath: string,
	command: JsonObject,
	timeoutMs = 5_000,
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
			() => finish(new Error("Desktop lab request timed out")),
			timeoutMs,
		);
		socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
		socket.on("error", (error) => finish(error));
		socket.on("close", () =>
			finish(new Error("Desktop lab closed before a reply")),
		);
		socket.on("data", (chunk: Buffer) => {
			data = Buffer.concat([data, chunk]);
			if (data.length > 1024 * 1024)
				return finish(new Error("Desktop lab reply exceeds 1 MiB"));
			const end = data.indexOf(10);
			if (end < 0) return;
			try {
				const reply = JSON.parse(data.subarray(0, end).toString("utf8"));
				if (!isRecord(reply) || reply.error !== undefined)
					throw new Error(`Desktop lab: ${JSON.stringify(reply)}`);
				finish(undefined, reply);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

/** Prevent the copied app from discovering/downloading updates from the network. */
export async function startDesktopReleases(
	appVersion: string,
	coreVersion: string,
): Promise<{ server: Server; url: string; requests: string[] }> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		const version =
			request.url === "/app/latest.json"
				? appVersion
				: request.url === "/core/latest.json"
					? coreVersion
					: undefined;
		response.setHeader("Connection", "close");
		if (request.method !== "GET" || !version) {
			response.writeHead(404).end();
			return;
		}
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ version, generation: 1 }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || isString(address)) {
		server.close();
		throw new Error("Desktop release fixture did not bind loopback TCP");
	}
	return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

export class DesktopLab {
	readonly core: CoreLab;
	readonly appHome: string;
	readonly bundle: string;
	readonly binary: string;
	readonly socket: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly versions: { app: string; core: string };
	#child?: ChildProcess;
	#exited = false;
	#attempted = false;
	#stopped = false;
	#removed = false;
	#releases?: Awaited<ReturnType<typeof startDesktopReleases>>;

	constructor(appBundle: string, coreBinary: string, piBinary: string) {
		this.core = new CoreLab(coreBinary, piBinary, { copyBinary: true });
		this.appHome = join(this.core.root, "desktop");
		this.bundle = join(this.core.root, "Herdr.app");
		this.binary = join(this.bundle, "Contents/MacOS/Herdr");
		this.socket = join(this.appHome, "herdr-app.sock");
		this.env = {
			...this.core.env,
			HERDR_APP_HOME: this.appHome,
			HERDR_APP_ID: this.core.env.HC_SESSION,
			HERDR_CORE_DIRS: join(this.core.root, "bin"),
			HC_INSTALL_DIR: join(this.core.root, "bin"),
			SHELL: "/bin/sh",
			DO_NOT_TRACK: "1",
			HERDR_TELEMETRY: "0",
		};
		try {
			mkdirSync(this.appHome, { mode: 0o700 });
			// Preserve the signed bundle's contents and relative framework links.
			// Never edit Info.plist, re-sign it, or link the daily executable here.
			cpSync(realpathSync(appBundle), this.bundle, {
				recursive: true,
				verbatimSymlinks: true,
			});
			if (realpathSync(this.binary) !== this.binary)
				throw new Error("Desktop lab executable must be a copied file");
			writeFileSync(
				join(this.appHome, "settings.json"),
				JSON.stringify({
					core: this.core.binary,
					telemetry: false,
					clipboard_write: false,
					appearance: "dark",
					zoom: 1,
				}),
			);
			this.versions = {
				app: this.version(this.binary, "herdr-app"),
				core: this.version(this.core.binary, "hc"),
			};
		} catch (error) {
			this.core.remove();
			throw error;
		}
	}

	/** Caller must explicitly authorize a window on the shared physical display. */
	async start(options: { allowWindow: boolean }): Promise<void> {
		if (!options.allowWindow)
			throw new Error(
				"Desktop lab needs explicit shared-display/window consent",
			);
		if (process.platform !== "darwin")
			throw new Error("This Desktop fixture supports macOS only");
		if (this.#attempted || this.#stopped || this.#removed)
			throw new Error("Desktop lab start is one-shot");
		this.assertHome();
		if (existsSync(this.socket))
			throw new Error(
				"Desktop lab socket already exists; refusing to raise it",
			);
		this.#attempted = true;
		this.#releases = await startDesktopReleases(
			this.versions.app,
			this.versions.core,
		);
		await this.core.start();
		const log = openSync(join(this.core.root, "desktop.log"), "ax", 0o600);
		try {
			this.#child = spawn(this.binary, [], {
				cwd: this.core.root,
				env: { ...this.env, HERDR_RELEASES_URL: this.#releases.url },
				stdio: ["ignore", log, log],
			});
		} finally {
			closeSync(log);
		}
		this.#child.once("exit", () => {
			this.#exited = true;
		});
		this.#child.once("error", () => {
			this.#exited = true;
		});
		const deadline = performance.now() + 30_000;
		let lastError: unknown;
		while (performance.now() < deadline) {
			if (this.#exited)
				throw new Error(
					`Desktop lab exited during startup; see ${this.core.root}`,
				);
			try {
				const status = await this.call({ status: true }, 1_000);
				if (!isString(status.layout) || !Array.isArray(status.errors))
					throw new Error("Desktop lab returned no window status");
				if (status.errors.length)
					throw new Error(
						`Desktop startup errors: ${JSON.stringify(status.errors)}`,
					);
				return;
			} catch (error) {
				lastError = error;
			}
			await delay(50);
		}
		throw new Error(`Desktop lab startup unconfirmed: ${String(lastError)}`);
	}

	call(command: JsonObject, timeoutMs?: number): Promise<JsonObject> {
		this.assertHome();
		if (!this.#child?.pid || this.#exited)
			throw new Error("Desktop lab has no live owned app process");
		return desktopLabRequest(this.socket, command, timeoutMs);
	}

	async capture(directory: string): Promise<void> {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		for (const [file, command] of [
			["desktop-status.json", { status: true }],
			["desktop-inventory.json", { ls: true }],
		] as const)
			writeFileSync(
				join(directory, file),
				JSON.stringify(await this.call(command), null, 2),
			);
		writeFileSync(
			join(directory, "core-status.json"),
			JSON.stringify(await this.core.call("server.status"), null, 2),
		);
		const path = join(this.core.root, "desktop.png");
		const shot = await this.call({ shot: path }, 35_000);
		if (shot.path !== path) throw new Error("Desktop screenshot path mismatch");
		const bytes = readFileSync(path);
		if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
			throw new Error("Desktop screenshot is not a PNG");
		writeFileSync(join(directory, "desktop.png"), bytes);
		writeFileSync(
			join(directory, "versions.json"),
			JSON.stringify(this.versions, null, 2),
		);
	}

	/** Only the exact owned socket/process; no PID signalling or broad app kill. */
	async stop(): Promise<void> {
		if (this.#stopped) return;
		try {
			if (this.#child && !this.#exited) {
				try {
					await this.call({ do: "app.quit", args: {} });
				} catch {
					// Quit can close the socket first. Only process exit confirms it.
				}
				const deadline = performance.now() + 10_000;
				while (!this.#exited) {
					if (performance.now() >= deadline)
						throw new Error(
							`Desktop exit unconfirmed; retained ${this.core.root}`,
						);
					await delay(50);
				}
			}
			await this.core.stop();
			this.#stopped = true;
		} finally {
			if (this.#releases) {
				const server = this.#releases.server;
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
				this.#releases = undefined;
			}
		}
	}

	remove(): void {
		if (this.#removed) return;
		if (this.#attempted && !this.#stopped)
			throw new Error(
				`Desktop shutdown unconfirmed; retained ${this.core.root}`,
			);
		this.assertHome();
		this.core.remove();
		this.#removed = true;
	}

	private assertHome(): void {
		for (const path of [this.core.root, this.appHome]) {
			const stat = lstatSync(path);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				realpathSync(path) !== path ||
				stat.uid !== process.getuid?.() ||
				(stat.mode & 0o077) !== 0
			)
				throw new Error(`Not a private Desktop lab directory: ${path}`);
		}
	}

	private version(binary: string, prefix: string): string {
		const text = execFileSync(binary, ["--version"], {
			env: this.env,
			cwd: this.core.root,
			encoding: "utf8",
			timeout: 5_000,
		}).trim();
		const version = text.slice(prefix.length + 1);
		if (
			!text.startsWith(`${prefix} `) ||
			!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)
		)
			throw new Error(`Unexpected ${prefix} version: ${text}`);
		return version;
	}
}
