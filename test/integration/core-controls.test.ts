import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { isRecord, isString } from "../../maestro/core/config/type-guards.ts";
import { CoreLab, findLabBinary } from "./herdr-core-lab.ts";
import {
	captureCoreEvidence,
	coreResults,
	coreSession,
	coreToolResults,
	prepareCorePi,
	startCoreParent,
	waitForCoreSession,
} from "./core-parent.ts";
import { resetProviderRequests } from "./fake-provider.ts";

const core = process.env.HERDR_CORE_BIN ?? findLabBinary("herdr-core");
const pi = process.env.PI_BIN ?? findLabBinary("pi");
const options = {
	skip: !core || !pi ? "herdr-core and pi are required" : false,
	timeout: 120_000,
};

async function fixture(t: TestContext) {
	resetProviderRequests();
	const lab = new CoreLab(core, pi);
	const evidence = mkdtempSync(join("/tmp", "piha-core-evidence-"));
	t.diagnostic(`Core control evidence: ${evidence}`);
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
		parent: (prompt: string) =>
			startCoreParent(lab, pi, project, "parent", prompt),
	};
}

async function markerExists(path: string) {
	const deadline = performance.now() + 30_000;
	while (!existsSync(path)) {
		assert.ok(performance.now() < deadline, `marker missing: ${path}`);
		await delay(50);
	}
}

async function childOf(lab: CoreLab, parent: string) {
	const listing = await lab.call("terminal.list", { all: true });
	assert.ok(Array.isArray(listing.terminals));
	const children = listing.terminals.filter(
		(value) => isRecord(value) && value.parent === parent,
	);
	assert.equal(children.length, 1, JSON.stringify(listing));
	const child = children[0];
	assert.ok(isRecord(child));
	assert.ok(isString(child.address));
	assert.equal(child.state, "live");
	return child.address;
}

async function removed(lab: CoreLab, parent: string) {
	const deadline = performance.now() + 15_000;
	for (;;) {
		const listing = await lab.call("terminal.list", { all: true });
		assert.ok(Array.isArray(listing.terminals));
		if (
			listing.terminals.length === 1 &&
			isRecord(listing.terminals[0]) &&
			listing.terminals[0].address === parent
		)
			return;
		assert.ok(performance.now() < deadline, JSON.stringify(listing));
		await delay(50);
	}
}

test(
	"Core interactive child: public interrupt preserves the terminal and cancel delivers once",
	options,
	async (t) => {
		const f = await fixture(t);
		const start = join(f.lab.root, "control-start");
		const interruptGate = join(f.lab.root, "interrupt-gate");
		const cancelGate = join(f.lab.root, "cancel-gate");
		try {
			const parent = await f.parent(
				`INTEGRATION_CORE_CONTROL:coreturn\nCORE_START: ${start}\nCORE_INTERRUPT_GATE: ${interruptGate}\nCORE_CANCEL_GATE: ${cancelGate}`,
			);
			await markerExists(start);
			const child = await childOf(f.lab, parent.terminal);
			writeFileSync(interruptGate, "interrupt\n");
			const interrupted = await waitForCoreSession(
				parent,
				(rows) => coreToolResults(rows, "subagent_interrupt").length === 1,
			);
			const reply = coreToolResults(interrupted, "subagent_interrupt")[0];
			assert.match(JSON.stringify(reply.content), /Interrupt requested/);
			assert.equal(coreResults(interrupted).length, 0);
			assert.equal(
				(await f.lab.call("terminal.get", { terminal: child })).state,
				"live",
			);
			assert.equal(existsSync(`${start}.done`), false);
			writeFileSync(cancelGate, "cancel\n");
			const done = await waitForCoreSession(
				parent,
				(rows) => coreResults(rows).length === 1,
			);
			assert.match(
				String(coreResults(done)[0].content),
				/cancelled by the parent/,
			);
			await removed(f.lab, parent.terminal);
			assert.equal(coreResults(coreSession(parent.session)).length, 1);
		} finally {
			// Release provider-side gates even after a failed assertion, before lab teardown.
			writeFileSync(interruptGate, "release\n");
			writeFileSync(cancelGate, "release\n");
		}
	},
);

test(
	"Core reload keeps the original child owner and delivers into the reloaded parent",
	options,
	async (t) => {
		const f = await fixture(t);
		const start = join(f.lab.root, "reload-start");
		const gate = join(f.lab.root, "reload-gate");
		const done = join(f.lab.root, "reload-done");
		try {
			const task = `Run this bash command: echo 'START_CORE_RELOAD' > '${start}'; while [ ! -f '${gate}' ]; do sleep 0.1; done; echo 'CORE_RELOAD_DONE' > '${done}'`;
			const parent = await f.parent(
				`Call subagent once with name: "Reload-child".\nagent: "test-echo".\ntask: ${JSON.stringify(task)}.\nAfter the automatic result, say CORE_RELOAD_PARENT_CONTINUED.`,
			);
			await markerExists(start);
			const child = await childOf(f.lab, parent.terminal);
			await waitForCoreSession(
				parent,
				(rows) =>
					coreToolResults(rows, "subagent").length === 1 &&
					rows.some(
						(row) =>
							isRecord(row.message) &&
							row.message.role === "assistant" &&
							JSON.stringify(row.message.content).includes("completed"),
					),
			);
			await f.lab.call("terminal.send", {
				terminal: parent.terminal,
				text: "/reload",
				force: true,
				wait: false,
			});
			const deadline = performance.now() + 30_000;
			for (;;) {
				const screen = await f.lab.call("terminal.read", {
					terminal: parent.terminal,
					lines: 500,
				});
				if (isString(screen.text) && /Reloaded keybindings/.test(screen.text))
					break;
				assert.ok(performance.now() < deadline, JSON.stringify(screen));
				await delay(50);
			}
			assert.equal(
				(await f.lab.call("terminal.get", { terminal: child })).state,
				"live",
			);
			writeFileSync(gate, "finish after reload\n");
			await markerExists(done);
			assert.match(readFileSync(done, "utf8"), /CORE_RELOAD_DONE/);
			const entries = await waitForCoreSession(
				parent,
				(rows) => coreResults(rows).length === 1,
			);
			const result = coreResults(entries)[0];
			assert.ok(isRecord(result.details));
			assert.equal(result.details.errorMessage, undefined);
			await removed(f.lab, parent.terminal);
			assert.equal(coreResults(coreSession(parent.session)).length, 1);
		} finally {
			writeFileSync(gate, "release\n");
		}
	},
);
