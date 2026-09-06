// THROWAWAY experiment. All Herdr resources below belong to a scratch server.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
	createLab,
	startProvider,
	fixture,
	disposeFixture,
	cpuSnapshot,
	run,
	now,
	until,
} from "./lab.mjs";
import { EventStream, monitor } from "./wake.mjs";

assert.equal(
	process.platform,
	"linux",
	"This CPU-measurement prototype currently validates Linux only",
);
const modesArg = process.argv.find((value) => value.startsWith("--modes="));
const modes = modesArg
	? modesArg.split("=")[1].split(",")
	: ["baseline", "files", "events"];
assert.ok(
	modes.every((mode) =>
		["baseline", "files", "events", "files-batch", "events-batch"].includes(
			mode,
		),
	),
);
const command = process.argv[2] ?? "smoke";
const secondsArg = process.argv.find((value) => value.startsWith("--seconds="));
const seconds = secondsArg
	? Number(secondsArg.split("=")[1])
	: command === "smoke"
		? 2
		: 20;
assert.ok(Number.isFinite(seconds) && seconds >= 2 && seconds <= 60);
const sizesArg = process.argv.find((value) => value.startsWith("--sizes="));
const sizes = sizesArg
	? sizesArg.split("=")[1].split(",").map(Number)
	: command === "smoke"
		? [1]
		: [1, 5, 10];
assert.ok(sizes.every((n) => [1, 5, 10].includes(n)));
const out = join(tmpdir(), `issue29-results-${Date.now()}`);
await mkdir(out, { recursive: true });
const results = [];
const lab = await createLab();
const hz = Number((await run("getconf", ["CLK_TCK"], lab.env)).trim());
const meta = {
	command,
	seconds,
	sizes,
	modes,
	root: lab.root,
	resultsDirectory: out,
	node: process.version,
	platform: process.platform,
	herdr: (await run("herdr", ["--version"], lab.env)).trim(),
	pi: (await run("pi", ["--version"], lab.env)).trim(),
	cpuTicksPerSecond: hz,
	measurement:
		"Linux /proc CPU ticks: supervisor + reaped CLI children and isolated Herdr tree including live Pi fixtures. Parent TUI is not included. Completion latency is timestamp immediately before semantic sidecar publication to resolver return, not parent-model response latency.",
};
await writeFile(join(out, "metadata.json"), JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ stage: "started", ...meta }));
await startProvider(lab);
let sequence = 0;
const activeStreams = new Set();
async function streamFor(mode) {
	if (!mode.startsWith("events")) return undefined;
	const stream = new EventStream(lab.socketPath);
	activeStreams.add(stream);
	stream.start();
	await until(() => stream.online, 5000, "event subscription");
	return stream;
}
async function record(value) {
	results.push(value);
	await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(value));
}
async function quiet(states, period) {
	await until(
		() =>
			lab.inFlight === 0 &&
			states.every((state) => {
				const last = state.cycleTimes.at(-1);
				return last !== undefined && now() - last < period - 150;
			}),
		7000,
		"quiet measurement boundary",
	);
}
async function trial(mode, count, round) {
	const children = await Promise.all(
		Array.from({ length: count }, () => fixture(lab, `bench-${sequence++}`)),
	);
	const stream = await streamFor(mode);
	const states = children.map((child) => monitor(lab, child, mode, stream));
	const statusTimer = setInterval(() => {
		for (const child of children) {
			try {
				JSON.parse(readFileSync(join(child.dir, "activity.json"), "utf8"));
			} catch {}
		}
	}, 1000);
	try {
		await until(
			() => states.every((state) => state.probeDone > 0),
			15000,
			"initial reconciliation",
		);
		await delay([270, 1610, 3370][round % 3]);
		await quiet(states, states[0].periodMs);
		const before = await cpuSnapshot(lab.serverPid);
		lab.calls = [];
		lab.measuring = true;
		const started = now();
		await delay(seconds * 1000);
		await quiet(states, states[0].periodMs);
		const after = await cpuSnapshot(lab.serverPid);
		const elapsed = now() - started;
		lab.measuring = false;
		assert.ok(
			states.every((state) => state.result === null),
			"A held Pi fixture ended during steady-state measurement",
		);
		const calls = [...lab.calls];
		const cpuStable = lab.inFlight === 0;
		const supervisorMs =
			((after.supervisorTicks - before.supervisorTicks) * 1000) / hz;
		const herdrMs =
			((after.herdrTreeTicks - before.herdrTreeTicks) * 1000) / hz;
		// Release at the same offsets for every mode; do not align with a polling tick.
		await Promise.all(
			children.map(async (child, index) => {
				await delay(137 + ((index * 173) % 900));
				child.release("done");
			}),
		);
		await until(
			() => states.every((state) => state.result !== null),
			15000,
			"all completion results",
		);
		const latencies = [];
		const outcomes = [];
		for (const state of states) {
			assert.equal(state.result.exitCode, 0);
			assert.equal(state.deliveryCount, 1);
			outcomes.push({
				reason: state.result.reason,
				retainedSidecar: existsSync(state.child.session + ".exit"),
			});
			const timing = JSON.parse(
				await until(
					async () => {
						try {
							return await readFile(
								state.child.session + ".timing.json",
								"utf8",
							);
						} catch {
							return false;
						}
					},
					3000,
					"measurement timestamp",
				),
			);
			latencies.push(state.completedAt - timing.evidenceAt);
		}
		const gaps = states.flatMap((state) =>
			state.cycleTimes
				.slice(1)
				.map((time, index) => time - state.cycleTimes[index]),
		);
		await record({
			kind: "benchmark",
			mode,
			count,
			round,
			windowMs: elapsed,
			cliCalls: calls.length,
			cliPerSecond: (calls.length * 1000) / elapsed,
			supervisorCpuMs: supervisorMs,
			herdrTreeCpuMs: herdrMs,
			totalCpuMsPerSecond: ((supervisorMs + herdrMs) * 1000) / elapsed,
			cpuStable,
			detectionLatencyMs: latencies,
			semanticEvidencePreserved: outcomes.every(
				(outcome) => outcome.reason === "done",
			),
			outcomes,
			largestProbeStartGapMs: Math.max(0, ...gaps),
			eventConnections: stream?.connects ?? 0,
			events: stream?.events ?? [],
			calls,
			sourcePidsAtStart: before.herdrPids,
		});
	} finally {
		lab.measuring = false;
		clearInterval(statusTimer);
		await Promise.all(states.map((state) => state.stop()));
		stream?.close();
		activeStreams.delete(stream);
		await Promise.all(children.map((child) => disposeFixture(lab, child)));
	}
}

async function caseWithChild(name, body) {
	const child = await fixture(lab, `fault-${sequence++}`);
	const stream = await streamFor("events");
	const state = monitor(lab, child, "events", stream);
	try {
		await until(() => state.probeDone > 0, 10000, "fault initial check");
		await body(child, state, stream);
		await record({
			kind: "fault",
			name,
			passed: true,
			outcome: state.result,
			deliveries: state.deliveryCount,
			connectionCount: stream.connects,
			events: stream.events,
		});
	} finally {
		await state.stop();
		stream.close();
		activeStreams.delete(stream);
		await disposeFixture(lab, child);
	}
}

async function faults() {
	for (const mode of ["done", "error", "ping"]) {
		await caseWithChild(`real Pi ${mode}`, async (child, state) => {
			child.release(mode);
			await until(() => state.result, 10000, mode);
			assert.equal(state.result.reason, mode);
			assert.equal(state.deliveryCount, 1);
			for (let i = 0; i < 20; i++) state.signal();
			await delay(50);
			assert.equal(state.deliveryCount, 1);
			assert.ok(
				(await lab.cli(["pane", "get", child.pane])).result.pane,
				"Surrounding shell should remain",
			);
		});
	}
	await caseWithChild(
		"missed file and event signals reconcile",
		async (child, state, stream) => {
			state.dropFiles = true;
			stream.silence = true;
			const before = now();
			child.release("done");
			await until(() => state.result, 7000, "lost-signal reconciliation");
			assert.equal(state.result.reason, "done");
			assert.ok(
				now() - before <= 5500,
				"5s target plus bounded test scheduling margin",
			);
		},
	);
	await caseWithChild(
		"disconnect falls back; reconnect does not finish live Pi",
		async (child, state, stream) => {
			stream.disconnect();
			await until(() => !stream.online, 1000);
			const count = state.readCount;
			await delay(1250);
			assert.ok(state.readCount > count, "Fallback should use current cadence");
			assert.equal(state.result, null);
			stream.start();
			await until(() => stream.online, 3000);
			await delay(200);
			assert.equal(state.result, null);
			child.release("done");
			await until(() => state.result, 5000);
			assert.equal(state.result.reason, "done");
		},
	);
	await caseWithChild(
		"controller rebind keeps one owner (reload model)",
		async (child, state, stream) => {
			assert.equal(monitor(lab, child, "events", stream), state);
			state.rebind();
			state.rebind();
			await delay(200);
			assert.equal(stream.connects, 1);
			assert.equal(stream.listeners.get(child.pane).size, 1);
			child.release("done");
			await until(() => state.result, 5000);
			assert.equal(state.deliveryCount, 1);
		},
	);
	await caseWithChild(
		"actual Escape leaves interactive Pi open; continuation completes",
		async (child, state) => {
			const request = lab.pending.get(child.id);
			await lab.cli(["pane", "send-keys", child.pane, "esc"]);
			await delay(500);
			assert.equal(state.result, null);
			assert.equal(existsSync(child.session + ".exit"), false);
			await lab.cli([
				"pane",
				"run",
				child.pane,
				`PROTOTYPE_CHILD_${child.id} Continue`,
			]);
			await until(
				() => lab.pending.get(child.id) !== request,
				10000,
				"continued Pi request",
			);
			child.release("done");
			await until(() => state.result, 5000);
			assert.equal(state.result.reason, "done");
		},
	);
	await caseWithChild(
		"Pi SIGKILL while shell survives uses exit evidence",
		async (child, state, stream) => {
			const owned = (await cpuSnapshot(lab.serverPid)).herdrPids;
			let pid;
			for (const candidate of owned) {
				try {
					const args = readFileSync(`/proc/${candidate}/cmdline`, "utf8").split(
						"\0",
					);
					if (args.includes(child.session)) pid = candidate;
				} catch {}
			}
			assert.ok(pid && owned.includes(pid));
			assert.notEqual(pid, lab.serverPid);
			assert.notEqual(pid, process.pid);
			process.kill(pid, "SIGKILL");
			await until(() => state.result, 7000, "killed Pi sentinel");
			assert.equal(state.result.reason, "sentinel");
			assert.equal(state.result.exitCode, 137);
			assert.ok((await lab.cli(["pane", "get", child.pane])).result.pane);
			assert.equal(
				stream.events.some(
					(event) => event.pane === child.pane && event.type === "pane_exited",
				),
				false,
			);
		},
	);
	await caseWithChild(
		"pane closure without artifact cannot claim success",
		async (child, state) => {
			await lab.cli(["pane", "close", child.pane]);
			await until(() => state.result, 7000);
			assert.notEqual(state.result.exitCode, 0);
		},
	);
	await caseWithChild(
		"late authoritative evidence after pane-close signal",
		async (child, state) => {
			const close = lab.cli(["pane", "close", child.pane]);
			await delay(100);
			await writeFile(
				child.session + ".exit",
				JSON.stringify({
					type: "ping",
					name: child.id,
					message: "late help evidence",
				}),
			);
			await close;
			await until(() => state.result, 5000);
			assert.equal(state.result.reason, "ping");
		},
	);
	await caseWithChild(
		"watcher abort cleans listeners without inventing completion",
		async (_child, state, stream) => {
			await state.stop();
			assert.equal(state.deliveryCount, 0);
			assert.equal(stream.listeners.size, 0);
		},
	);
	await caseWithChild(
		"owned Herdr server restart never fabricates successful child result",
		async (_child, state, stream) => {
			await lab.restart();
			await until(() => stream.online, 5000, "reconnect after owned restart");
			await delay(250);
			assert.ok(state.result === null || state.result.exitCode !== 0);
		},
	);
}

async function closeLatency(mode, round) {
	const child = await fixture(lab, `close-${sequence++}`);
	const stream = await streamFor(mode);
	const state = monitor(lab, child, mode, stream);
	try {
		await until(() => state.probeDone > 0, 10000);
		await delay([137, 683][round]);
		const started = now();
		await lab.cli(["pane", "close", child.pane]);
		await until(() => state.result, 7000, "closed-pane resolution");
		assert.notEqual(state.result.exitCode, 0);
		await record({
			kind: "closed-pane-latency",
			mode,
			round,
			elapsedMs: now() - started,
			outcome: state.result,
			deliveries: state.deliveryCount,
			events: stream?.events ?? [],
		});
	} finally {
		await state.stop();
		stream?.close();
		activeStreams.delete(stream);
		await disposeFixture(lab, child);
	}
}

try {
	if (command === "faults") await faults();
	else if (command === "close-latency") {
		for (let round = 0; round < 2; round++)
			for (const mode of modes) await closeLatency(mode, round);
	} else {
		for (const count of sizes) {
			const rounds = command === "bench" && count === 10 ? 3 : 1;
			for (let round = 0; round < rounds; round++) {
				const order = modes.map(
					(_mode, index) => modes[(index + round) % modes.length],
				);
				for (const mode of order) await trial(mode, count, round);
			}
		}
	}
	await writeFile(
		join(out, "complete.json"),
		JSON.stringify(
			{
				completed: true,
				cases: results.length,
				source: "isolated real Herdr / deterministic interactive Pi",
				limitations: [
					"Parent reload is a controller-rebind model, not a full Pi parent /reload integration.",
					"Watcher abort is not a full workflow-cancel integration.",
					"Latency ends at resolver return, before parent rendering/model invocation.",
					"CPU snapshots use Linux ticks and finite samples; small differences may be noise.",
					"Windows and macOS were not exercised.",
				],
			},
			null,
			2,
		),
	);
	console.log(
		JSON.stringify({ completed: true, cases: results.length, artifacts: out }),
	);
} catch (error) {
	await writeFile(
		join(out, "failure.json"),
		JSON.stringify(
			{
				error: error.message,
				stack: error.stack,
				completedCases: results.length,
				labRoot: lab.root,
			},
			null,
			2,
		),
	);
	console.error(error);
	process.exitCode = 1;
} finally {
	for (const state of [...(lab.monitors?.values() ?? [])]) await state.stop();
	for (const stream of activeStreams) stream.close();
	await lab.stop();
	await writeFile(
		join(out, "cleanup.json"),
		JSON.stringify(
			{
				serverExitCode: lab.server.exitCode,
				serverSignal: lab.server.signalCode,
				socketStillExists: existsSync(lab.socketPath),
				activeMonitors: lab.monitors?.size ?? 0,
			},
			null,
			2,
		),
	);
}
