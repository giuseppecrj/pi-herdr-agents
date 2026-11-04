import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import {
	DesktopLab,
	desktopLabRequest,
	startDesktopReleases,
} from "../integration/herdr-desktop-lab.ts";

const unix = { skip: process.platform === "win32" };

/** These fake binaries answer --version only: no native app or Core is opened. */
function source() {
	const root = realpathSync(mkdtempSync("/tmp/piha-desktop-source-"));
	const bundle = join(root, "Herdr.app");
	const app = join(bundle, "Contents/MacOS/Herdr");
	const core = join(root, "herdr-core");
	mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
	for (const [path, answer] of [
		[app, "herdr-app 0.1.12"],
		[core, "hc 0.1.17"],
	])
		writeFileSync(
			path,
			`#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(99); console.log(${JSON.stringify(answer)});\n`,
			{ mode: 0o700 },
		);
	return { root, bundle, app, core };
}

test(
	"Desktop lab copies executables and isolates all writable state without opening a window",
	unix,
	async () => {
		const files = source();
		const appBefore = readFileSync(files.app);
		const coreBefore = readFileSync(files.core);
		const lab = new DesktopLab(files.bundle, files.core, "/bin/false");
		try {
			assert.deepEqual(lab.versions, { app: "0.1.12", core: "0.1.17" });
			assert.notEqual(lstatSync(files.app).ino, lstatSync(lab.binary).ino);
			assert.notEqual(
				lstatSync(files.core).ino,
				lstatSync(lab.core.binary).ino,
			);
			assert.equal(realpathSync(lab.binary), lab.binary);
			assert.ok(Buffer.byteLength(lab.socket) < 104);
			for (const key of [
				"HOME",
				"TMPDIR",
				"XDG_CONFIG_HOME",
				"XDG_STATE_HOME",
				"XDG_DATA_HOME",
				"XDG_CACHE_HOME",
				"XDG_RUNTIME_DIR",
				"PI_CODING_AGENT_DIR",
				"HERDR_APP_HOME",
				"HERDR_CORE_DIRS",
				"HC_INSTALL_DIR",
				"HC_SOCKET",
			])
				assert.ok(lab.env[key]?.startsWith(lab.core.root + "/"), key);
			for (const key of [
				"HC_TERMINAL_ID",
				"HC_TERMINAL_SOCKET",
				"HERDR_SOCKET_PATH",
				"HERDR_ENV",
				"PI_SUBAGENT_ID",
				"OPENAI_API_KEY",
			])
				assert.equal(lab.env[key], undefined, key);
			assert.equal(lab.env.DO_NOT_TRACK, "1");
			assert.equal(lab.env.HERDR_TELEMETRY, "0");
			assert.equal(lab.env.SHELL, "/bin/sh");
			assert.deepEqual(
				JSON.parse(readFileSync(join(lab.appHome, "settings.json"), "utf8")),
				{
					core: lab.core.binary,
					telemetry: false,
					clipboard_write: false,
					appearance: "dark",
					zoom: 1,
				},
			);
			await assert.rejects(lab.start({ allowWindow: false }), /consent/);
			assert.equal(existsSync(lab.socket), false);
			assert.equal(existsSync(lab.core.socket), false);
			assert.throws(() => lab.call({ do: "app.quit" }), /no live owned/);
			await lab.stop();
			await lab.stop();
			if (process.platform === "darwin")
				await assert.rejects(lab.start({ allowWindow: true }), /one-shot/);
			assert.deepEqual(readFileSync(files.app), appBefore);
			assert.deepEqual(readFileSync(files.core), coreBefore);
		} finally {
			lab.remove();
			lab.remove();
			rmSync(files.root, { recursive: true });
		}
		assert.equal(existsSync(lab.core.root), false);
	},
);

test(
	"Desktop lab rejects an executable symlink instead of running the daily app",
	unix,
	() => {
		const files = source();
		try {
			rmSync(files.app);
			symlinkSync(files.core, files.app);
			assert.throws(
				() => new DesktopLab(files.bundle, files.core, "/bin/false"),
				/copied file/,
			);
		} finally {
			rmSync(files.root, { recursive: true });
		}
	},
);

test(
	"Desktop lab refuses calls and cleanup after home privacy is lost",
	unix,
	() => {
		const files = source();
		const lab = new DesktopLab(files.bundle, files.core, "/bin/false");
		try {
			chmodSync(lab.appHome, 0o755);
			assert.throws(() => lab.call({ status: true }), /Not a private Desktop/);
			assert.throws(() => lab.remove(), /Not a private Desktop/);
			assert.equal(existsSync(lab.core.root), true);
		} finally {
			chmodSync(lab.appHome, 0o700);
			lab.remove();
			rmSync(files.root, { recursive: true });
		}
	},
);

test(
	"Desktop RPC is bounded, validates replies, and never retries a mutating request",
	unix,
	async () => {
		const root = realpathSync(mkdtempSync("/tmp/piha-desktop-rpc-"));
		const socket = join(root, "app.sock");
		const commands: unknown[] = [];
		let response = '{"ok":true}\n';
		const server = createServer((client) => {
			client.once("data", (data) => {
				commands.push(JSON.parse(data.toString()));
				client.end(response);
			});
		});
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		try {
			assert.deepEqual(await desktopLabRequest(socket, { status: true }), {
				ok: true,
			});
			for (const invalid of [
				"null\n",
				"[]\n",
				"invalid\n",
				'{"error":"no"}\n',
				"",
				"x".repeat(1024 * 1024 + 1),
			]) {
				response = invalid;
				const before = commands.length;
				await assert.rejects(
					desktopLabRequest(socket, {
						do: "terminal.keep",
						args: { terminal: "t1" },
					}),
				);
				assert.equal(
					commands.length,
					before + 1,
					"one submission even after bad/absent reply",
				);
			}
			assert.deepEqual(commands[0], { status: true });
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			rmSync(root, { recursive: true });
		}
	},
);

test("Desktop updates see pinned loopback metadata, no redirects or downloadable releases", async () => {
	const releases = await startDesktopReleases("0.1.12", "0.1.17");
	try {
		assert.match(releases.url, /^http:\/\/127\.0\.0\.1:\d+$/);
		for (const [name, version] of [
			["app", "0.1.12"],
			["core", "0.1.17"],
		]) {
			const reply = await fetch(`${releases.url}/${name}/latest.json`);
			assert.deepEqual(await reply.json(), { version, generation: 1 });
		}
		assert.equal((await fetch(`${releases.url}/core/install.sh`)).status, 404);
		assert.equal(
			(await fetch(`${releases.url}/app/release.tar.gz`)).status,
			404,
		);
		assert.equal(
			(await fetch(`${releases.url}/app/latest.json`, { method: "POST" }))
				.status,
			404,
		);
		assert.equal(releases.requests.length, 5);
	} finally {
		await new Promise<void>((resolve, reject) =>
			releases.server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
