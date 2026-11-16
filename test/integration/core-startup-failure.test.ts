/** #149 on the public tool path: real parent and child Pi processes, private Core. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { isRecord, isString } from "@nubl/maestro/core/config/type-guards";
import { CoreLab, findLabBinary } from "./herdr-core-lab.ts";
import {
	captureCoreEvidence,
	coreResults,
	prepareCorePi,
	startCoreParent,
	waitForCoreSession,
} from "./core-parent.ts";
import { TEST_MODEL, resetProviderRequests } from "./fake-provider.ts";

const CORE_BIN = process.env.HERDR_CORE_BIN ?? findLabBinary("herdr-core");
const PI_BIN = process.env.PI_BIN ?? findLabBinary("pi");
const options = {
	skip: !CORE_BIN || !PI_BIN ? "herdr-core and pi are required" : false,
	timeout: 120_000,
};

/**
 * The parent loads the extension with no config.json; the file then changes
 * under it, as shep-app's did at 03:46, before the parent launches one child.
 */
async function launchAfterConfigChange(
	t: TestContext,
	config: string,
	name: string,
) {
	resetProviderRequests();
	const lab = new CoreLab(CORE_BIN, PI_BIN);
	const evidence = mkdtempSync(join("/tmp", "piha-core-evidence-"));
	t.diagnostic(`Core #149 evidence: ${evidence}`);
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
	const parent = await startCoreParent(
		lab,
		PI_BIN,
		project,
		"parent",
		"Reply with one word.",
	);
	await waitForCoreSession(parent, (rows) =>
		rows.some(
			(row) => isRecord(row.message) && row.message.role === "assistant",
		),
	);
	const path = join(
		lab.env.PI_CODING_AGENT_DIR!,
		"herdr-agents",
		"config.json",
	);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, config, { mode: 0o600 });
	await lab.call("terminal.send", {
		terminal: parent.terminal,
		text: [
			`Call subagent once with name: "${name}".`,
			'agent: "test-echo".',
			`model: "${TEST_MODEL}".`,
			`task: "Return exactly CORE_149_${name}".`,
		].join(" "),
		force: true,
		wait: false,
	});
	const entries = await waitForCoreSession(
		parent,
		(rows) => coreResults(rows).length === 1,
	);
	const [result] = coreResults(entries);
	// Record removal follows delivery; settle it before capturing evidence.
	const deadline = performance.now() + 15_000;
	for (;;) {
		const listing = await lab.call("terminal.list", { all: true });
		assert.ok(Array.isArray(listing.terminals));
		if (listing.terminals.length === 1) break;
		assert.ok(performance.now() < deadline, JSON.stringify(listing));
		await delay(50);
	}
	assert.ok(isString(result.content));
	assert.ok(isRecord(result.details), JSON.stringify(result));
	return { content: result.content, details: result.details };
}

test(
	"Core child loads the extension when config.json holds only models",
	options,
	async (t) => {
		const result = await launchAfterConfigChange(
			t,
			JSON.stringify({
				models: {
					tasks: { recon: [TEST_MODEL] },
					tasksThinking: { recon: "off" },
					tasksMeta: {
						generatedAt: "2026-11-16T03:46:28Z",
						method: "registry-only",
					},
				},
			}),
			"ModelsOnly",
		);
		assert.equal(result.details.exitCode, 0, result.content);
		assert.match(result.content, /CORE_149_ModelsOnly/);
	},
);

test(
	"Core child that fails to load the extension reports why",
	options,
	async (t) => {
		const result = await launchAfterConfigChange(
			t,
			JSON.stringify({ status: "on" }),
			"BadStatus",
		);
		assert.equal(result.details.exitCode, 1, result.content);
		assert.match(result.content, /failed \(exit code 1\)/);
		assert.match(result.content, /before its session started/);
		assert.match(result.content, /status must be an object/);
	},
);
