import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { captureSurfacePiProcessIdentity } from "../../maestro/adapters/pi/launch-operations.ts";
import {
	createLinuxProcessProbe,
	judgeProcessIdentity,
	linuxProcessProbe,
	parseProcessStat,
	readProcessIdentityRecord,
	terminateProcessIdentity,
	verifyProcessIdentityRecord,
	writeProcessIdentityRecord,
	type PiProcessIdentityRecord,
	type ProcessIdentityProbe,
	type ProcessStat,
} from "../../maestro/adapters/pi/process-identity.ts";

const linux = process.platform === "linux";
const HOST = { bootId: "boot-a", pidNamespace: "pid:[4026531836]" };
const identity = { pid: 20, startTime: "5000", ...HOST };
const record = (
	overrides: Partial<PiProcessIdentityRecord> = {},
): PiProcessIdentityRecord => ({
	version: 1,
	id: "run",
	sessionFile: "/s.jsonl",
	...identity,
	...overrides,
});

type Entry = ProcessStat | Error | undefined;
function fakeProbe(entries: Array<[number, Entry]>, terminate?: () => void) {
	const table = new Map(entries);
	const signals: number[] = [];
	const probe: ProcessIdentityProbe = {
		host: () => HOST,
		stat(pid) {
			const entry = table.get(pid);
			if (entry instanceof Error) throw entry;
			return entry;
		},
		terminate(pid) {
			signals.push(pid);
			terminate?.();
		},
	};
	return { probe, signals };
}
const stat = (startTime = "5000", state = "S", ppid = 10): ProcessStat => ({
	state,
	ppid,
	startTime,
});
const errno = (code: string) =>
	Object.assign(new Error(`${code}: test`), { code });

function withDir(run: (dir: string, t: TestContext) => Promise<void> | void) {
	return async (t: TestContext) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-identity-test-"));
		try {
			await run(dir, t);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

const ANCHORED_TEST_TIMEOUT_MS = 10_000;

// Capture timers are unref'd so a background attempt cannot hold the process
// open. These tests await that attempt directly, so they keep the loop alive
// the way a parent session does. Capture deadlines stay the ones under test.
// The anchor must never outlive the test: a capture that misses its deadline
// has to fail the file, not hang it.
function whileParentLoopAlive(
	t: TestContext,
	run: () => Promise<void>,
): Promise<void> {
	const anchor = setTimeout(() => {}, ANCHORED_TEST_TIMEOUT_MS);
	const drop = () => clearTimeout(anchor);
	t.signal.addEventListener("abort", drop, { once: true });
	return run().finally(() => {
		t.signal.removeEventListener("abort", drop);
		drop();
	});
}

// Runs one capture in a fresh process that holds nothing else open. The
// process exits on its own only if every timer the capture leaves pending is
// unref'd.
const DRAINING_CAPTURE_CHILD = `
const [launch, file, stall] = process.argv.slice(1);
const { captureSurfacePiProcessIdentity } = await import(launch);
const provider = {
	getProcessInfo: () =>
		stall === "herdr"
			? new Promise(() => {})
			: { shellPid: process.pid, pids: [], foregroundProcesses: [] },
};
captureSurfacePiProcessIdentity(
	provider,
	"pane",
	{ file, id: "run", sessionFile: "/s.jsonl" },
	{ timeoutMs: 60_000, intervalMs: 60_000 },
).then(
	() => process.stdout.write("settled\\n"),
	() => process.stdout.write("settled\\n"),
);
`;
async function captureDrains(file: string, stall: "record" | "herdr") {
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			"--input-type=module",
			"-e",
			DRAINING_CAPTURE_CHILD,
			"--",
			new URL("../../maestro/adapters/pi/launch-operations.ts", import.meta.url)
				.href,
			file,
			stall,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	const held = setTimeout(() => child.kill("SIGKILL"), 5_000);
	try {
		const [code, signal] = await once(child, "exit");
		return { code, signal, output };
	} finally {
		clearTimeout(held);
	}
}

// A real process records its identity through the child-extension hook, then
// rewrites its title exactly as Pi's CLI setup does.
const IDENTITY_CHILD = `
const [extension, file, id, sessionFile] = process.argv.slice(1);
const { recordProcessIdentity } = await import(extension);
recordProcessIdentity(id, sessionFile, file);
process.title = "pi";
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;
async function spawnRecorded(file: string, id: string, sessionFile: string) {
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			"--input-type=module",
			"-e",
			IDENTITY_CHILD,
			"--",
			new URL(
				"../../maestro/adapters/pi/child/subagent-done.ts",
				import.meta.url,
			).href,
			file,
			id,
			sessionFile,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	let output = "";
	for await (const chunk of child.stdout) {
		output += String(chunk);
		if (output.includes("ready\n")) return child;
	}
	throw new Error("identity child exited before it was ready");
}
const paneOf = (shellPid: number | undefined) => ({
	getProcessInfo: () => ({ shellPid, pids: [], foregroundProcesses: [] }),
});

type PaneInfo = ReturnType<ReturnType<typeof paneOf>["getProcessInfo"]>;

describe("process identity", () => {
	it("parses /proc stat after the last parenthesis of an arbitrary comm", () => {
		const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
		fields[0] = "T";
		fields[1] = "77";
		fields[19] = "123456";
		assert.deepEqual(parseProcessStat(`42 (a) b (c) ${fields.join(" ")}`), {
			state: "T",
			ppid: 77,
			startTime: "123456",
		});
		assert.throws(() => parseProcessStat("42 (x) S"), /unparseable/);
	});

	it("judges only THAT identity: absent or zombie exited; reuse, read errors, other boot or namespace unknown", () => {
		const judge = (entry: Entry, recorded = identity) =>
			judgeProcessIdentity(recorded, fakeProbe([[20, entry]]).probe);
		assert.deepEqual(judge(stat()), { kind: "alive" });
		assert.deepEqual(judge(stat("5000", "T")), { kind: "alive" });
		assert.deepEqual(judge(undefined), { kind: "exited" });
		assert.deepEqual(judge(stat("5000", "Z")), { kind: "exited" });
		assert.match(
			JSON.stringify(judge(stat("9"))),
			/unknown.*now names a different process/,
		);
		assert.match(
			JSON.stringify(judge(errno("EACCES"))),
			/unknown.*unreadable: EACCES/,
		);
		assert.match(
			JSON.stringify(judge(stat(), { ...identity, bootId: "boot-b" })),
			/unknown.*another boot/,
		);
		assert.match(
			JSON.stringify(judge(stat(), { ...identity, pidNamespace: "pid:[9]" })),
			/unknown.*another PID namespace/,
		);
		const hostless: ProcessIdentityProbe = {
			...fakeProbe([[20, stat()]]).probe,
			host() {
				throw new Error("process identity is unsupported on darwin");
			},
		};
		assert.match(
			JSON.stringify(judgeProcessIdentity(identity, hostless)),
			/unknown.*unsupported on darwin/,
		);
	});

	it("signals only a re-verified live identity", () => {
		for (const [entry, kind] of [
			[stat("9"), "unknown"],
			[errno("EACCES"), "unknown"],
			[undefined, "exited"],
			[stat("5000", "Z"), "exited"],
		] as const) {
			const { probe, signals } = fakeProbe([[20, entry]]);
			assert.equal(terminateProcessIdentity(identity, probe).kind, kind);
			assert.deepEqual(
				signals,
				[],
				`${JSON.stringify(entry)} is not signalled`,
			);
		}
		const live = fakeProbe([[20, stat()]]);
		assert.deepEqual(terminateProcessIdentity(identity, live.probe), {
			kind: "alive",
		});
		assert.deepEqual(live.signals, [20]);
		const gone = fakeProbe([[20, stat()]], () => {
			throw errno("ESRCH");
		});
		assert.deepEqual(terminateProcessIdentity(identity, gone.probe), {
			kind: "exited",
		});
		const denied = fakeProbe([[20, stat()]], () => {
			throw errno("EPERM");
		});
		assert.match(
			JSON.stringify(terminateProcessIdentity(identity, denied.probe)),
			/unknown.*SIGTERM to process 20 failed: EPERM/,
		);
	});

	it("verifies a record for this run and session, alive, at or under the pane shell", () => {
		const tree = fakeProbe([
			[20, stat("5000", "S", 15)],
			[15, stat("1", "S", 10)],
			[10, stat("1", "S", 1)],
			[1, stat("1", "S", 0)],
		]).probe;
		const expected = { id: "run", sessionFile: "/s.jsonl", shellPid: 10 };
		assert.deepEqual(
			verifyProcessIdentityRecord(record(), expected, tree),
			identity,
		);
		assert.deepEqual(
			verifyProcessIdentityRecord(
				record(),
				{ ...expected, shellPid: 20 },
				tree,
			),
			identity,
			"Pi exec'd in place of the shell is the pane shell",
		);
		for (const [mutated, pattern] of [
			[record({ id: "other" }), /another run/],
			[record({ sessionFile: "/other.jsonl" }), /another run/],
			[record({ startTime: "9" }), /different process/],
			[record({ pidNamespace: "pid:[9]" }), /another PID namespace/],
			[record({ pid: 99 }), /exited before its identity was verified/],
		] as const)
			assert.throws(
				() => verifyProcessIdentityRecord(mutated, expected, tree),
				pattern,
			);
		assert.throws(
			() =>
				verifyProcessIdentityRecord(
					record(),
					{ ...expected, shellPid: 11 },
					tree,
				),
			/not the Herdr pane shell 11 or its descendant/,
		);
	});

	it(
		"publishes a record atomically and only once, and rejects malformed records",
		withDir((dir) => {
			const file = join(dir, "s.jsonl.process.json");
			assert.equal(readProcessIdentityRecord(file), undefined);
			writeProcessIdentityRecord(file, record());
			writeProcessIdentityRecord(file, record({ pid: 99 }));
			assert.deepEqual(readProcessIdentityRecord(file), record());
			assert.deepEqual(readdirSync(dir), ["s.jsonl.process.json"]);
			for (const text of ["{", JSON.stringify({ ...record(), pid: "20" })]) {
				writeFileSync(file, text);
				assert.throws(() => readProcessIdentityRecord(file), /malformed/);
			}
		}),
	);

	it(
		"captures a real child's identity across its title rewrite, SIGSTOP, and exit",
		withDir(async (dir) => {
			if (!linux) return;
			const sessionFile = join(dir, "s.jsonl");
			const file = `${sessionFile}.process.json`;
			const child = await spawnRecorded(file, "real", sessionFile);
			try {
				const pid = child.pid!;
				// The title rewrite removed every launch argument from cmdline.
				assert.doesNotMatch(
					readFileSync(`/proc/${pid}/cmdline`, "utf8"),
					/real|s\.jsonl/,
				);
				// The test process is the child's parent: the pane shell stand-in.
				const captured = await captureSurfacePiProcessIdentity(
					paneOf(process.pid),
					"pane",
					{ file, id: "real", sessionFile },
					{ timeoutMs: 5_000, intervalMs: 20 },
				);
				assert.equal(captured.pid, pid);
				assert.equal(
					captured.startTime,
					parseProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8")).startTime,
				);
				assert.equal(
					captured.pidNamespace,
					linuxProcessProbe.host().pidNamespace,
				);
				assert.deepEqual(judgeProcessIdentity(captured), { kind: "alive" });
				process.kill(pid, "SIGSTOP");
				assert.deepEqual(judgeProcessIdentity(captured), { kind: "alive" });
				process.kill(pid, "SIGCONT");
				const exited = once(child, "exit");
				assert.deepEqual(terminateProcessIdentity(captured), { kind: "alive" });
				await exited;
				assert.deepEqual(judgeProcessIdentity(captured), { kind: "exited" });
			} finally {
				child.kill("SIGKILL");
			}
		}),
	);

	it(
		"refuses a real record outside the pane shell, for another run, or without a Herdr shell",
		withDir(async (dir) => {
			if (!linux) return;
			const sessionFile = join(dir, "s.jsonl");
			const file = `${sessionFile}.process.json`;
			const child = await spawnRecorded(file, "real", sessionFile);
			const sibling = spawn(process.execPath, [
				"-e",
				"setInterval(()=>{},1e3)",
			]);
			try {
				const capture = (shellPid: number | undefined, id = "real") =>
					captureSurfacePiProcessIdentity(
						paneOf(shellPid),
						"pane",
						{ file, id, sessionFile },
						{ timeoutMs: 100, intervalMs: 20 },
					);
				await assert.rejects(
					capture(sibling.pid),
					new RegExp(
						`not the Herdr pane shell ${sibling.pid} or its descendant`,
					),
				);
				await assert.rejects(capture(process.pid, "other"), /another run/);
				await assert.rejects(capture(undefined), /reports no shell/);
				assert.equal((await capture(process.pid)).pid, child.pid);
			} finally {
				child.kill("SIGKILL");
				sibling.kill("SIGKILL");
			}
		}),
	);

	it(
		"times out without a record and never invents one",
		{ timeout: ANCHORED_TEST_TIMEOUT_MS },
		withDir((dir, t) =>
			whileParentLoopAlive(t, async () => {
				await assert.rejects(
					captureSurfacePiProcessIdentity(
						paneOf(process.pid),
						"pane",
						{
							file: join(dir, "none.json"),
							id: "run",
							sessionFile: "/s.jsonl",
						},
						{ timeoutMs: 60, intervalMs: 20 },
					),
					/not captured within 60ms: the child has not recorded its process identity/,
				);
			}),
		),
	);

	it(
		"bounds Herdr process info by the capture deadline and drops a late answer",
		{ timeout: ANCHORED_TEST_TIMEOUT_MS },
		withDir((dir, t) =>
			whileParentLoopAlive(t, async () => {
				const file = join(dir, "s.jsonl.process.json");
				writeProcessIdentityRecord(file, record());
				const { probe } = fakeProbe([
					[20, stat()],
					[10, stat("1", "S", 1)],
				]);
				const expected = { file, id: "run", sessionFile: "/s.jsonl" };
				let calls = 0;
				const release: Array<() => void> = [];
				// Every answer is valid, but only after the test releases it.
				const stalled = {
					getProcessInfo: () => {
						calls++;
						return new Promise<PaneInfo>((resolve) =>
							release.push(() => resolve(paneOf(10).getProcessInfo())),
						);
					},
				};
				const started = Date.now();
				const capture = captureSurfacePiProcessIdentity(
					stalled,
					"pane",
					expected,
					{
						timeoutMs: 40,
						intervalMs: 10,
						probe,
					},
				);
				await assert.rejects(
					capture,
					/not captured within 40ms: Herdr process info for pane pane timed out/,
				);
				assert.ok(Date.now() - started < 1_000, "rejected on time");
				assert.equal(calls, 1, "no further query after the deadline");
				for (const answer of release) answer();
				await new Promise((resolve) => setTimeout(resolve, 10));
				await assert.rejects(capture, /not captured within 40ms/);
				// Negative control: an answer inside the deadline is accepted.
				const prompt = {
					getProcessInfo: async () => {
						await new Promise((resolve) => setTimeout(resolve, 5));
						return paneOf(10).getProcessInfo();
					},
				};
				assert.deepEqual(
					await captureSurfacePiProcessIdentity(prompt, "pane", expected, {
						timeoutMs: 1_000,
						probe,
					}),
					identity,
				);
			}),
		),
	);

	it(
		"never holds the process open while waiting for a record between attempts",
		withDir(async (dir) => {
			const exit = await captureDrains(join(dir, "none.json"), "record");
			assert.deepEqual(exit, { code: 0, signal: null, output: "" });
		}),
	);

	it(
		"never holds the process open while waiting for Herdr process info",
		withDir(async (dir) => {
			const file = join(dir, "s.jsonl.process.json");
			writeProcessIdentityRecord(file, record());
			const exit = await captureDrains(file, "herdr");
			assert.deepEqual(exit, { code: 0, signal: null, output: "" });
		}),
	);

	it(
		"drops an overdue Herdr answer that wins the race before the overdue timer runs",
		withDir(async (dir) => {
			const file = join(dir, "s.jsonl.process.json");
			writeProcessIdentityRecord(file, record());
			const { probe } = fakeProbe([
				[20, stat()],
				[10, stat("1", "S", 1)],
			]);
			const expected = { file, id: "run", sessionFile: "/s.jsonl" };
			// Synchronous work blocks the event loop past the deadline; the answer
			// settles first, before the expired timer can fire.
			const busy = {
				getProcessInfo: () => {
					const until = Date.now() + 30;
					while (Date.now() < until);
					return paneOf(10).getProcessInfo();
				},
			};
			await assert.rejects(
				captureSurfacePiProcessIdentity(busy, "pane", expected, {
					timeoutMs: 5,
					probe,
				}),
				/not captured within 5ms: Herdr process info for pane pane timed out/,
			);
			// Negative control: the same synchronous answer inside its budget is used.
			assert.deepEqual(
				await captureSurfacePiProcessIdentity(busy, "pane", expected, {
					timeoutMs: 1_000,
					probe,
				}),
				identity,
			);
		}),
	);

	it("the /proc reader treats only a missing PID as absence; other read errors throw", () => {
		const probe = (error: Error) =>
			createLinuxProcessProbe(() => {
				throw error;
			});
		for (const code of ["ENOENT", "ESRCH"])
			assert.equal(probe(errno(code)).stat(20), undefined, code);
		for (const code of ["EACCES", "EIO"])
			assert.throws(() => probe(errno(code)).stat(20), new RegExp(code));
		assert.throws(
			() => probe(errno("EACCES")).host(),
			linux ? /EACCES/ : /unsupported/,
		);
		const foreign = createLinuxProcessProbe((path) =>
			path === "/proc/self/stat"
				? `1 (init) S 0 ${Array.from({ length: 48 }, () => "1").join(" ")}`
				: "x",
		);
		if (linux)
			assert.throws(() => foreign.host(), /does not describe this process/);
	});

	it("this host's probe proves /proc describes its own PID namespace", () => {
		if (!linux) {
			assert.throws(() => linuxProcessProbe.host(), /unsupported/);
			return;
		}
		const host = linuxProcessProbe.host();
		assert.match(host.pidNamespace, /^pid:\[\d+\]$/);
		assert.match(host.bootId, /^[0-9a-f-]{36}$/);
		assert.equal(linuxProcessProbe.stat(2 ** 22 + 1), undefined);
	});
});
