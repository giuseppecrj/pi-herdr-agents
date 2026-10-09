/**
 * The disposable Herdr lab's shutdown and root guard: it signals only a PID
 * whose identity it has just re-verified, and it deletes the lab root only
 * after every server it spawned has stopped. A fake `/proc` stands in for the
 * server, so nothing here starts or signals a real process. A binary that
 * cannot run is spawned for real, in a fresh process: no server can start.
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createLabRoot,
	HERDR_BIN,
	removeLabRoot,
	stopLabServer,
	type HerdrLabRoot,
	type LabProcessHost,
} from "../integration/herdr-lab.ts";

const SERVER = {
	session: "lab-a",
	pid: 4242,
	startTime: "1000",
	socket: "/nonexistent/herdr.sock",
};

/** The `/proc/<pid>` files the lab reads; an Error is thrown on read. */
interface ProcFiles {
	stat: string | Error;
	cmdline: string | Error;
	environ: string | Error;
}
type ProcFile = keyof ProcFiles;
type FakeProc = ProcFiles | undefined;

function errno(code: string): Error {
	return Object.assign(new Error(`${code}: fake /proc`), { code });
}

/** `/proc/<pid>/stat` with the state and start time (field 22) given. */
function statLine(pid: number, startTime: string, state = "S"): string {
	return `${pid} (herdr) ${state} 1 ${Array(17).fill("0").join(" ")} ${startTime} 0 0`;
}

function serverProc(
	lab: HerdrLabRoot,
	server: typeof SERVER = SERVER,
): ProcFiles {
	return {
		stat: statLine(server.pid, server.startTime),
		cmdline: `${HERDR_BIN}\0--session\0${server.session}\0server\0`,
		environ: `PATH=/usr/bin\0HOME=${lab.home}\0`,
	};
}

interface FakeServer {
	host: LabProcessHost;
	/** What the PID shows now; `undefined` once no process holds it. */
	proc: FakeProc;
	events: string[];
}

function fakeServer(
	proc: FakeProc,
	behaviour: {
		onStop?: (server: FakeServer) => void;
		onTerminate?: (server: FakeServer) => void;
	} = {},
): FakeServer {
	let readSinceSleep = new Set<ProcFile>();
	const server: FakeServer = {
		proc,
		events: [],
		host: {
			read(path) {
				const match = path.match(/^\/proc\/(\d+)\/(stat|cmdline|environ)$/);
				assert.ok(match, `unexpected read ${path}`);
				const [, pid, file] = match;
				assert.equal(Number(pid), SERVER.pid, `read of another PID: ${path}`);
				assert.ok(file === "stat" || file === "cmdline" || file === "environ");
				readSinceSleep.add(file);
				const value = server.proc?.[file];
				if (value === undefined) throw errno("ENOENT");
				if (value instanceof Error) throw value;
				return value;
			},
			terminate(pid) {
				assert.deepEqual(
					[...readSinceSleep].sort(),
					["cmdline", "environ", "stat"],
					"signal without a fresh identity check",
				);
				server.events.push(`terminate ${pid}`);
				behaviour.onTerminate?.(server);
			},
			async requestStop(socket) {
				server.events.push(`stop ${socket}`);
				behaviour.onStop?.(server);
				return { kind: "failed", reason: "fake socket" };
			},
			async sleep() {
				readSinceSleep = new Set();
			},
		},
	};
	return server;
}

/** A fresh lab; `rootSuffix` renames its root, as a random name could read. */
function labFor(t: TestContext, rootSuffix = ""): HerdrLabRoot {
	const created = createLabRoot("onboarding = false\n");
	const root = created.root + rootSuffix;
	t.after(() => {
		for (const path of new Set([created.root, root]))
			if (existsSync(path)) rmSync(path, { recursive: true });
	});
	if (root === created.root) return created;
	renameSync(created.root, root);
	const moved = (path: string) =>
		path.startsWith(created.root)
			? root + path.slice(created.root.length)
			: path;
	return {
		root,
		home: moved(created.home),
		env: Object.fromEntries(
			Object.entries(created.env).map(([name, value]) => [
				name,
				value && moved(value),
			]),
		),
	};
}

function assertKept(lab: HerdrLabRoot, reason: RegExp) {
	assert.throws(() => removeLabRoot(lab), reason);
	assert.equal(existsSync(lab.root), true, "lab root was removed");
}

function assertRemoved(lab: HerdrLabRoot) {
	removeLabRoot(lab);
	assert.equal(existsSync(lab.root), false, "lab root remains");
}

describe("herdr lab shutdown", {
	skip: process.platform === "linux" ? false : "reads /proc",
}, () => {
	it("keeps the root and sends nothing when the server's /proc stat is unreadable", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer({ ...serverProc(lab), stat: errno("EACCES") });
		const shutdown = await stopLabServer(lab, SERVER, fake.host);
		assert.equal(shutdown.kind, "residue");
		assert.match(
			shutdown.kind === "residue" ? shutdown.reason : "",
			/identity is unreadable: EACCES/,
		);
		assert.deepEqual(fake.events, []);
		assertKept(lab, /kept .*lab-a: PID 4242 identity is unreadable/);
	});

	it("keeps the root and sends nothing when the server's environment is unreadable", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer({ ...serverProc(lab), environ: errno("EACCES") });
		assert.equal((await stopLabServer(lab, SERVER, fake.host)).kind, "residue");
		assert.deepEqual(fake.events, []);
		assertKept(lab, /identity is unreadable/);
	});

	it("reports a server that is already gone as stopped without contacting it", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer(undefined);
		assert.deepEqual(await stopLabServer(lab, SERVER, fake.host), {
			kind: "stopped",
			how: "absent",
		});
		assert.deepEqual(fake.events, []);
		assertRemoved(lab);
	});

	it("waits for a graceful exit after server.stop and never signals", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer(serverProc(lab), {
			onStop: (server) => {
				server.proc = undefined;
			},
		});
		assert.deepEqual(await stopLabServer(lab, SERVER, fake.host), {
			kind: "stopped",
			how: "exited",
		});
		assert.deepEqual(fake.events, [`stop ${SERVER.socket}`]);
		assertRemoved(lab);
	});

	it("counts an exited server awaiting reaping as stopped", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer(serverProc(lab), {
			onStop: (server) => {
				server.proc = {
					stat: statLine(SERVER.pid, SERVER.startTime, "Z"),
					cmdline: "",
					environ: "",
				};
			},
		});
		assert.deepEqual(await stopLabServer(lab, SERVER, fake.host), {
			kind: "stopped",
			how: "exited",
		});
		assertRemoved(lab);
	});

	it("sends SIGTERM to a server that ignores server.stop and waits for it to exit", async (t) => {
		const lab = labFor(t);
		let pollsAfterSignal = 0;
		const fake = fakeServer(serverProc(lab), {
			onTerminate: () => {
				pollsAfterSignal = 0;
			},
		});
		// The server exits on the third poll after the signal, not at once.
		const read = fake.host.read;
		fake.host.read = (path) => {
			if (fake.events.length === 2 && path.endsWith("/stat"))
				if (++pollsAfterSignal === 3) fake.proc = undefined;
			return read(path);
		};
		assert.deepEqual(await stopLabServer(lab, SERVER, fake.host), {
			kind: "stopped",
			how: "terminated",
		});
		assert.deepEqual(fake.events, [
			`stop ${SERVER.socket}`,
			`terminate ${SERVER.pid}`,
		]);
		assert.equal(pollsAfterSignal, 3);
		assertRemoved(lab);
	});

	it("keeps the root when the server survives SIGTERM", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer(serverProc(lab));
		const shutdown = await stopLabServer(lab, SERVER, fake.host);
		assert.equal(shutdown.kind, "residue");
		assert.deepEqual(fake.events, [
			`stop ${SERVER.socket}`,
			`terminate ${SERVER.pid}`,
		]);
		assertKept(lab, /survived server\.stop \(failed\) and SIGTERM/);
	});

	it("keeps the root when SIGTERM fails and the server stays", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer(serverProc(lab), {
			onTerminate: () => {
				throw errno("EPERM");
			},
		});
		assert.equal((await stopLabServer(lab, SERVER, fake.host)).kind, "residue");
		assertKept(lab, /SIGTERM, which failed: EPERM/);
	});

	it("never signals a PID that now names another process", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer({
			...serverProc(lab),
			stat: statLine(SERVER.pid, "2000"),
		});
		assert.equal((await stopLabServer(lab, SERVER, fake.host)).kind, "residue");
		assert.deepEqual(fake.events, []);
		assertKept(lab, /PID 4242 now names another process/);
	});

	it("never signals when the PID is reused while it waits", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer(serverProc(lab), {
			onStop: (server) => {
				server.proc = {
					...serverProc(lab),
					stat: statLine(SERVER.pid, "2000"),
				};
			},
		});
		assert.equal((await stopLabServer(lab, SERVER, fake.host)).kind, "residue");
		assert.deepEqual(fake.events, [`stop ${SERVER.socket}`]);
		assertKept(lab, /now names another process/);
	});

	it("never signals a process with the recorded start time but another command line", async (t) => {
		const lab = labFor(t);
		const fake = fakeServer({
			...serverProc(lab),
			cmdline: `${HERDR_BIN}\0--session\0other\0server\0`,
		});
		assert.equal((await stopLabServer(lab, SERVER, fake.host)).kind, "residue");
		assert.deepEqual(fake.events, []);
		assertKept(lab, /not the lab-a server/);
	});

	it("keeps the root while any one server has residue", async (t) => {
		// The root's name ends in one session's label; only lab-b has residue.
		const lab = labFor(t, "-lab-a");
		await stopLabServer(lab, SERVER, fakeServer(undefined).host);
		const other = { ...SERVER, session: "lab-b" };
		await stopLabServer(
			lab,
			other,
			fakeServer({ ...serverProc(lab, other), stat: errno("EACCES") }).host,
		);
		const kept = `kept ${lab.root}: `;
		assert.throws(
			() => removeLabRoot(lab),
			(error: Error) =>
				error.message.startsWith(kept) &&
				/^lab-b: PID 4242 identity is unreadable[^;]*$/.test(
					error.message.slice(kept.length),
				),
		);
		assert.equal(existsSync(lab.root), true);
	});
});

/** Runs `startLabServer` against `bin` in a fresh Node with a scrubbed env. */
function startFromBinary(bin: string, tmp: string) {
	const lab = new URL("../integration/herdr-lab.ts", import.meta.url).href;
	const script = `
		const { createLabRoot, removeLabRoot, startLabServer } = await import(${JSON.stringify(lab)});
		const lab = createLabRoot("onboarding = false\\n");
		const rejection = await startLabServer(lab, "missing").then(() => "started", (error) => error.message);
		await new Promise((resolve) => setTimeout(resolve, 200));
		removeLabRoot(lab);
		console.log(JSON.stringify({ rejection }));
	`;
	return new Promise<{ error: Error | null; stdout: string; stderr: string }>(
		(resolve) => {
			execFile(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "--eval", script],
				{
					env: { PATH: dirname(process.execPath), TMPDIR: tmp, HERDR_BIN: bin },
					timeout: 10_000,
					killSignal: "SIGKILL",
				},
				(error, stdout, stderr) => resolve({ error, stdout, stderr }),
			);
		},
	);
}

describe("herdr lab start", () => {
	for (const { name, code, bin } of [
		{
			name: "missing",
			code: "ENOENT",
			bin: (tmp: string) => join(tmp, "absent"),
		},
		{
			name: "non-executable",
			code: "EACCES",
			bin: (tmp: string) => {
				const path = join(tmp, "herdr");
				writeFileSync(path, "", { mode: 0o644 });
				return path;
			},
		},
	])
		it(`rejects a ${name} herdr binary without an uncaught error and frees the root`, async (t) => {
			const tmp = mkdtempSync(join(tmpdir(), "piha-herdr-lab-test-"));
			t.after(() => rmSync(tmp, { recursive: true, force: true }));
			const path = bin(tmp);
			const result = await startFromBinary(path, tmp);
			assert.equal(result.error, null, result.stderr);
			assert.doesNotMatch(result.stderr, /Unhandled|uncaught/i);
			const { rejection } = JSON.parse(result.stdout);
			assert.equal(
				rejection,
				`herdr server missing did not spawn: spawn ${path} ${code}`,
			);
			assert.deepEqual(
				readdirSync(tmp).filter((entry) => entry.startsWith("piha-herdr-lab-")),
				[],
				"lab root remains",
			);
		});
});
