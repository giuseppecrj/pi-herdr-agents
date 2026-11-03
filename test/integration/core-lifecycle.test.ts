/** Public tool path: real parent and child Pi processes, private Core, local provider. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
	isRecord,
	isString,
	type JsonObject,
} from "../../maestro/core/config/type-guards.ts";
import { CoreLab, findLabBinary } from "./herdr-core-lab.ts";
import {
	captureCoreEvidence,
	coreResults,
	coreSession,
	coreToolResults,
	prepareCorePi,
	startCoreParent,
	waitForCoreSession,
	type CoreParent,
} from "./core-parent.ts";
import {
	TEST_MODEL,
	getProviderRequests,
	resetProviderRequests,
} from "./fake-provider.ts";

const CORE_BIN = process.env.HERDR_CORE_BIN ?? findLabBinary("herdr-core");
const PI_BIN = process.env.PI_BIN ?? findLabBinary("pi");
const options = {
	skip: !CORE_BIN || !PI_BIN ? "herdr-core and pi are required" : false,
	timeout: 120_000,
};

async function fixture(t: TestContext) {
	resetProviderRequests();
	const lab = new CoreLab(CORE_BIN, PI_BIN);
	const evidence = mkdtempSync(join("/tmp", "piha-core-evidence-"));
	t.diagnostic(`Core lifecycle evidence: ${evidence}`);
	t.after(async () => {
		try {
			await captureCoreEvidence(lab, evidence);
		} finally {
			await lab.stop();
			lab.remove();
		}
	});
	const project = prepareCorePi(lab);
	await lab.start();
	return {
		lab,
		async parent(prompt: string) {
			return startCoreParent(lab, PI_BIN, project, "parent", prompt);
		},
	};
}

async function launched(parent: CoreParent): Promise<JsonObject> {
	const entries = await waitForCoreSession(
		parent,
		(rows) => coreToolResults(rows, "subagent").length > 0,
	);
	const [reply] = coreToolResults(entries, "subagent");
	assert.notEqual(reply.isError, true, JSON.stringify(reply));
	assert.match(JSON.stringify(reply.content), /launched and is now running/);
	return reply;
}

async function onlyParentRemains(
	lab: CoreLab,
	parent: CoreParent,
): Promise<void> {
	const deadline = performance.now() + 15_000;
	for (;;) {
		const listing = await lab.call("terminal.list", { all: true });
		assert.ok(Array.isArray(listing.terminals));
		const ids = listing.terminals.map((terminal) => {
			assert.ok(isRecord(terminal));
			return terminal.address;
		});
		if (ids.length === 1 && ids[0] === parent.terminal) return;
		assert.ok(
			performance.now() < deadline,
			`records not removed after delivery: ${JSON.stringify(listing)}`,
		);
		await delay(50);
	}
}

function details(result: JsonObject): JsonObject {
	assert.ok(isRecord(result.details), JSON.stringify(result));
	return result.details;
}

for (const fork of [false, true]) {
	test(
		`Core subagent ${fork ? "fork" : "fresh"}: one automatic result, then native record cleanup`,
		options,
		async (t) => {
			const f = await fixture(t);
			const marker = fork ? "CORE_FORK_RESULT" : "CORE_FRESH_RESULT";
			const parent = await f.parent(
				[
					'Call subagent once with name: "Core-child".',
					'agent: "test-echo".',
					`model: "${TEST_MODEL}".`,
					`fork: ${fork}.`,
					`task: "Return exactly ${marker}".`,
					"After the automatic child result, say CORE_PARENT_CONTINUED.",
				].join("\n"),
			);
			await launched(parent);
			const entries = await waitForCoreSession(parent, (rows) => {
				const index = rows.findIndex(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result",
				);
				return (
					index >= 0 &&
					rows
						.slice(index + 1)
						.some(
							(entry) =>
								isRecord(entry.message) &&
								entry.message.role === "assistant" &&
								JSON.stringify(entry.message.content).includes(
									"CORE_PARENT_CONTINUED",
								),
						)
				);
			});
			const results = coreResults(entries);
			assert.equal(results.length, 1);
			assert.ok(isString(results[0].content));
			assert.match(results[0].content, new RegExp(marker));
			assert.match(results[0].content, /<subagent_report/);
			assert.match(results[0].content, /Check: none/);
			const result = details(results[0]);
			assert.ok(isString(result.sessionFile));
			assert.ok(existsSync(result.sessionFile));
			assert.equal(result.errorMessage, undefined);
			await onlyParentRemains(f.lab, parent);
			assert.equal(coreResults(coreSession(parent.session)).length, 1);
		},
	);
}

test(
	"Core resume preserves the saved tool policy and delivers a second result",
	options,
	async (t) => {
		const f = await fixture(t);
		const id = "coreresume";
		const parent = await f.parent(
			`INTEGRATION_RESUME_RESTRICTIONS:${id}\nExercise restricted launch and resume.`,
		);
		await launched(parent);
		const entries = await waitForCoreSession(
			parent,
			(rows) => coreResults(rows).length === 2,
		);
		const results = coreResults(entries);
		assert.match(String(results[0].content), /RESTRICTED_FIRST_coreresume/);
		assert.match(String(results[1].content), /RESTRICTED_RESUME_coreresume/);
		assert.doesNotMatch(JSON.stringify(entries), /RESTRICTED_TOOL_LEAK/);
		const resumes = coreToolResults(entries, "subagent_resume");
		assert.equal(resumes.length, 1);
		assert.notEqual(resumes[0].isError, true, JSON.stringify(resumes[0]));
		assert.equal(
			details(results[0]).sessionFile,
			details(results[1]).sessionFile,
		);
		await onlyParentRemains(f.lab, parent);
	},
);

test(
	"Core persistent specialist retains its live terminal across two tasks, rejects busy and stops",
	options,
	async (t) => {
		const f = await fixture(t);
		const id = "corepersistent";
		const marker = join(f.lab.root, "persistent-start");
		const parent = await f.parent(
			`INTEGRATION_PERSISTENT_SPECIALIST:${id}\nPERSISTENT_START_FILE: ${marker}\nExercise the scripted persistent lifecycle.`,
		);
		await launched(parent);
		const first = await waitForCoreSession(
			parent,
			(rows) => coreResults(rows).length === 1,
		);
		const one = details(coreResults(first)[0]);
		assert.ok(isString(one.sessionFile));
		assert.equal(existsSync(`${one.sessionFile}.exit`), false);
		const listing = await f.lab.call("terminal.list", { all: true });
		assert.ok(Array.isArray(listing.terminals));
		assert.equal(
			listing.terminals.filter(
				(terminal) => isRecord(terminal) && terminal.state === "live",
			).length,
			2,
		);
		const entries = await waitForCoreSession(
			parent,
			(rows) =>
				coreResults(rows).length === 2 &&
				coreToolResults(rows, "subagent_stop").length === 1,
		);
		const results = coreResults(entries);
		assert.notDeepEqual(details(results[0]).task, details(results[1]).task);
		const stop = coreToolResults(entries, "subagent_stop")[0];
		assert.notEqual(stop.isError, true, JSON.stringify(stop));
		assert.match(JSON.stringify(first), /rejected-busy/);
		const childSession = readFileSync(one.sessionFile, "utf8");
		assert.doesNotMatch(childSession, /REJECTED_TASK_corepersistent/);
		assert.match(childSession, /PERSISTENT_TASK_2_RESULT_corepersistent/);
		await onlyParentRemains(f.lab, parent);
		assert.equal(coreResults(coreSession(parent.session)).length, 2);
	},
);

test(
	"Core cancellation confirms termination and delivers exactly once without fallback",
	options,
	async (t) => {
		const f = await fixture(t);
		const id = "corecancel";
		const marker = join(f.lab.root, "cancel-start");
		const gate = join(f.lab.root, "cancel-gate");
		const parent = await f.parent(
			[
				`INTEGRATION_CANCEL:${id}:basic`,
				`CANCEL_START_FILE: ${marker}`,
				`CANCEL_GATE_FILE: ${gate}`,
				"CANCEL_SLEEP: 30",
				"CANCEL_MODELS: pi-integration/test,pi-integration/fallback-secondary",
			].join("\n"),
		);
		await launched(parent);
		const deadline = performance.now() + 30_000;
		while (!existsSync(marker)) {
			assert.ok(
				performance.now() < deadline,
				"child never began its controlled task",
			);
			await delay(50);
		}
		assert.match(readFileSync(marker, "utf8"), /START_corecancel/);
		writeFileSync(gate, "cancel now\n");
		const entries = await waitForCoreSession(
			parent,
			(rows) =>
				coreResults(rows).length === 1 &&
				coreToolResults(rows, "subagent_cancel").length === 1,
		);
		const result = details(coreResults(entries)[0]);
		assert.equal(result.error, "cancelled");
		assert.ok(isRecord(result.cancellation));
		assert.equal(result.cancellation.termination, "confirmed");
		assert.deepEqual(result.fallbackAttempts ?? [TEST_MODEL], [TEST_MODEL]);
		assert.equal(
			getProviderRequests().some(
				(request) => request.model === "fallback-secondary",
			),
			false,
		);
		assert.equal(existsSync(`${marker}.done`), false);
		await onlyParentRemains(f.lab, parent);
		assert.equal(coreResults(coreSession(parent.session)).length, 1);
	},
);

test(
	"Core rejects managed worktrees before acquiring another native terminal",
	options,
	async (t) => {
		const f = await fixture(t);
		const parent = await f.parent(
			[
				'Call subagent once with name: "Core-worktree".',
				'agent: "test-echo".',
				'task: "Return exactly MUST_NOT_RUN".',
				'worktree: { branch: "must-not-be-created" }.',
			].join("\n"),
		);
		const entries = await waitForCoreSession(
			parent,
			(rows) => coreToolResults(rows, "subagent").length === 1,
		);
		const reply = coreToolResults(entries, "subagent")[0];
		assert.equal(reply.isError, true);
		assert.match(JSON.stringify(reply), /Core.*worktree|worktree.*Core/i);
		assert.equal(coreResults(entries).length, 0);
		await onlyParentRemains(f.lab, parent);
	},
);
