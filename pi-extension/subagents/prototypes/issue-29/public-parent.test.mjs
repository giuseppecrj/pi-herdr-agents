// THROWAWAY: real parent Pi + real public subagent tool + deterministic model transport.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createScenario, releaseScenario } from "./prototype-provider.mjs";
import { cpuSnapshot, until, now } from "./lab.mjs";
import {
	createTestEnv,
	cleanupTestEnv,
	createTrackedSurface,
	waitForPaneReady,
	startPi,
	runInPane,
	shellQuote,
	uniqueId,
} from "./results/runtime-parent/test/integration/harness.ts";
const output = process.env.PI_ISSUE29_OUTPUT;
assert.ok(output);
mkdirSync(output, { recursive: true });
const sizes = (process.env.PI_ISSUE29_SIZES ?? "1,5,10").split(",").map(Number);
const modes = (
	process.env.PI_ISSUE29_MODES ?? "baseline,files-batch,events-batch"
).split(",");
const seconds = Number(process.env.PI_ISSUE29_SECONDS ?? 20);
const roundsAtTen = Number(process.env.PI_ISSUE29_ROUNDS ?? 3);
const results = [];
const entries = (path) => {
	try {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
};
async function sample(surface, trace, phase, label) {
	runInPane(surface, `/prototype-sample ${phase} ${label}`);
	return until(
		() => {
			try {
				return JSON.parse(readFileSync(`${trace}.${label}.json`, "utf8"));
			} catch {
				return false;
			}
		},
		10000,
		"parent telemetry checkpoint",
	);
}
describe("prototype real parent", { concurrency: false }, () => {
	for (const count of sizes)
		for (let round = 0; round < (count === 10 ? roundsAtTen : 1); round++) {
			const order = modes.map(
				(_, index) => modes[(index + round) % modes.length],
			);
			for (const mode of order)
				it(`${mode}: ${count} children, round ${round}`, {
					timeout: 90000,
				}, async () => {
					const env = createTestEnv("herdr");
					const id = uniqueId();
					const scenario = createScenario(id, count);
					const trace = join(output, `${id}.trace.jsonl`);
					writeFileSync(trace, "");
					process.env.PI_ISSUE29_MODE = mode;
					process.env.PI_ISSUE29_TRACE = trace;
					const parentSession = join(env.dir, "parent.jsonl");
					try {
						const surface = createTrackedSurface(env, `parent-${id}`);
						await waitForPaneReady(surface);
						startPi(surface, env.dir, `PROTOTYPE_PARENT_${id}`, {
							extraArgs: `--session ${shellQuote(parentSession)}`,
						});
						await until(
							() => scenario.children.every((child) => child.ready),
							45000,
							"all real public children at provider",
						);
						await until(
							() =>
								entries(parentSession).some((entry) =>
									JSON.stringify(entry).includes(`PROTOTYPE_PARENT_IDLE_${id}`),
								),
							10000,
							"parent idle",
						);
						const cpuBefore = await cpuSnapshot(
							Number(process.env.PI_ISSUE29_SERVER_PID),
						);
						const windowStart = now();
						const begin = await sample(surface, trace, "begin", `begin-${id}`);
						if (mode !== "baseline")
							assert.equal(
								begin.contexts.reduce((sum, value) => sum + value.owners, 0),
								count,
							);
						await delay(seconds * 1000);
						const end = await sample(surface, trace, "end", `end-${id}`);
						const cpuAfter = await cpuSnapshot(
							Number(process.env.PI_ISSUE29_SERVER_PID),
						);
						const cpuWindow = now() - windowStart;
						const window = end.at - begin.at;
						assert.equal(
							end.events.filter((event) => event.type === "provider-request")
								.length,
							0,
							"held children must not trigger parent model turns",
						);
						const traceEvents = entries(trace);
						const started = traceEvents.filter(
							(event) =>
								event.type ===
								(mode === "baseline" ? "watch-baseline" : "watch-candidate"),
						);
						assert.equal(
							started.length,
							count,
							"actual intended watcher path must be used",
						);
						let quietFallback;
						if (mode === "events-batch" && count === 1 && round === 0) {
							const requests = scenario.requests.length;
							runInPane(surface, "/prototype-transport drop");
							await delay(1300);
							const disconnected = await sample(
								surface,
								trace,
								"peek",
								`down-${id}`,
							);
							assert.equal(disconnected.contexts[0].online, false);
							assert.equal(
								scenario.requests.length,
								requests,
								"disconnect must not wake the parent model",
							);
							runInPane(surface, "/prototype-transport reconnect");
							await delay(300);
							runInPane(surface, "/prototype-transport bad-list");
							await delay(1300);
							const bad = await sample(surface, trace, "peek", `bad-${id}`);
							assert.ok(bad.contexts[0].batchFallbacks > 0);
							assert.equal(bad.contexts[0].batchHealthy, false);
							assert.equal(
								scenario.requests.length,
								requests,
								"bad snapshot must not imply task completion or wake the model",
							);
							runInPane(surface, "/prototype-transport restore-list");
							await delay(300);
							const recovered = await sample(
								surface,
								trace,
								"peek",
								`up-${id}`,
							);
							assert.equal(recovered.contexts[0].batchHealthy, true);
							assert.equal(recovered.contexts[0].connections, 2);
							quietFallback = true;
						}
						await Promise.all(
							scenario.children.map(async (child, index) => {
								await delay(137 + ((index * 173) % 900));
								child.release();
							}),
						);
						const receipts = await until(
							() => {
								const list = entries(parentSession).filter(
									(entry) =>
										entry.type === "custom_message" &&
										entry.customType === "subagent_result",
								);
								return list.length === count &&
									scenario.children.every((child) =>
										scenario.requests.some((request) =>
											request.received.includes(`PROTOTYPE_RESULT_${child.id}`),
										),
									)
									? list
									: false;
							},
							15000,
							"parent receipts and actual provider context",
						);
						assert.equal(
							new Set(receipts.map((entry) => entry.details.name)).size,
							count,
						);
						const latencies = [];
						for (const receipt of receipts) {
							assert.equal(receipt.details.exitCode, 0);
							const timing = JSON.parse(
								readFileSync(
									receipt.details.sessionFile + ".timing.json",
									"utf8",
								),
							);
							const childId = receipt.details.name.replace(/^Prototype-/, "");
							const request = scenario.requests.find((value) =>
								value.received.includes(`PROTOTYPE_RESULT_${childId}`),
							);
							assert.ok(request);
							latencies.push({
								child: childId,
								receiptMs: Date.parse(receipt.timestamp) - timing.evidenceAt,
								modelContextMs: request.at - timing.evidenceAt,
							});
						}
						const after = await sample(surface, trace, "peek", `final-${id}`);
						assert.equal(
							after.contexts.reduce((sum, value) => sum + value.owners, 0),
							0,
							"no watcher owners after result delivery",
						);
						const cpuTicks =
							cpuAfter.supervisorTicks -
							cpuBefore.supervisorTicks +
							cpuAfter.herdrTreeTicks -
							cpuBefore.herdrTreeTicks;
						const result = {
							mode,
							count,
							round,
							cliCalls: end.cli.length,
							cliPerSecond: (end.cli.length * 1000) / window,
							windowMs: window,
							totalCpuMsPerSecond: (cpuTicks * 10 * 1000) / cpuWindow,
							cpuWindowMs: cpuWindow,
							parentRequestsDuringSteady: 0,
							quietFallback,
							latencies,
							finalContexts: after.contexts,
							measurement:
								"Real parent/children/Herdr CPU plus test-driver control work; CLI window comes from parent telemetry. Actual session receipt and actual local model-provider receipt times.",
						};
						results.push(result);
						writeFileSync(
							join(output, "measurements.json"),
							JSON.stringify(results, null, 2),
						);
						writeFileSync(
							join(output, `${id}.parent.jsonl`),
							readFileSync(parentSession),
						);
						console.log(JSON.stringify({ prototypeMeasurement: result }));
					} finally {
						releaseScenario(id);
						cleanupTestEnv(env);
					}
				});
		}
});
