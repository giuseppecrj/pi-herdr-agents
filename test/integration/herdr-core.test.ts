import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { isRecord, isString } from "../../maestro/core/config/type-guards.ts";
import { CoreLab, coreLabRequest, findLabBinary } from "./herdr-core-lab.ts";
import {
	captureCoreEvidence,
	prepareCorePi,
	startCoreParent,
	waitForCoreSession,
} from "./core-parent.ts";

const CORE_BIN = process.env.HERDR_CORE_BIN ?? findLabBinary("herdr-core");
const PI_BIN = process.env.PI_BIN ?? findLabBinary("pi");
const available = {
	skip: !CORE_BIN || !PI_BIN ? "herdr-core and pi are required" : false,
	timeout: 90_000,
};

test(
	"isolated Core runs a real parent Pi against only the local provider",
	available,
	async (t) => {
		const lab = new CoreLab(CORE_BIN, PI_BIN);
		const evidence = mkdtempSync(join("/tmp", "piha-core-evidence-"));
		t.diagnostic(`parent Pi evidence: ${evidence}`);
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
			"fixture",
			"Reply with only SEED_core_fixture",
		);
		const entries = await waitForCoreSession(parent, (rows) =>
			rows.some(
				(entry) =>
					isRecord(entry.message) &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("SEED_core_fixture"),
			),
		);
		assert.equal(
			entries.some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "subagent_result",
			),
			false,
		);
		const native = await lab.call("terminal.get", {
			terminal: parent.terminal,
		});
		assert.equal(
			native.state,
			"live",
			"parent stays alive for automatic child delivery",
		);
	},
);

test(
	"isolated Core lab owns native execution, exit evidence and record removal",
	available,
	async (t) => {
		const lab = new CoreLab(CORE_BIN, PI_BIN);
		t.diagnostic(`isolated Core lab: ${lab.root}`);
		t.after(async () => {
			await lab.stop();
			lab.remove();
		});
		await lab.start();
		const hello = await lab.call("hello", { generation: 1 });
		assert.equal(hello.generation, 1);
		const identityFile = join(lab.root, "parent-context.json");
		const parent = await lab.call("terminal.run", {
			argv: [
				process.execPath,
				"-e",
				`require('node:fs').writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify({terminal:process.env.HC_TERMINAL_ID,socket:process.env.HC_TERMINAL_SOCKET}));setInterval(()=>{},1000);`,
			],
			cwd: lab.root,
			keep: false,
			rm: false,
			no_notify: true,
		});
		assert.ok(isString(parent.address));
		const contextDeadline = performance.now() + 10_000;
		while (!existsSync(identityFile)) {
			assert.ok(
				performance.now() < contextDeadline,
				"parent native context not written",
			);
			await delay(50);
		}
		const context = JSON.parse(readFileSync(identityFile, "utf8"));
		assert.equal(context.terminal, parent.address);
		assert.ok(isString(context.socket));
		const scopedHello = await coreLabRequest(context.socket, "hello", {
			generation: 1,
		});
		assert.deepEqual(
			scopedHello.core,
			hello.core,
			"native terminal socket routes to the same Core",
		);
		const terminal = await coreLabRequest(context.socket, "terminal.run", {
			parent: parent.address,
			argv: [
				process.execPath,
				"-e",
				`console.log('CORE_LAB_CHILD', JSON.stringify({terminal:process.env.HC_TERMINAL_ID,socket:process.env.HC_TERMINAL_SOCKET,legacy:process.env.HERDR_SOCKET_PATH})); process.exit(7);`,
			],
			cwd: lab.root,
			keep: false,
			rm: false,
			no_notify: true,
			outlive_parent: true,
		});
		assert.ok(isString(terminal.address));
		const deadline = performance.now() + 10_000;
		for (;;) {
			const current = await lab.call("terminal.get", {
				terminal: terminal.address,
			});
			if (current.state === "finished") {
				assert.equal(current.exit_code, 7);
				break;
			}
			assert.ok(performance.now() < deadline, "native child did not exit");
			await delay(50);
		}
		const screen = await lab.call("terminal.read", {
			terminal: terminal.address,
			lines: 100,
		});
		assert.ok(isString(screen.text));
		assert.match(screen.text, /CORE_LAB_CHILD/);
		assert.match(screen.text, new RegExp(`"terminal":"${terminal.address}"`));
		assert.match(screen.text, /"socket":"/);
		assert.doesNotMatch(screen.text, /"legacy":/);
		const removed = await lab.call("terminal.rm", {
			terminal: terminal.address,
		});
		assert.equal(removed.removed, terminal.address);
		const killed = await lab.call("terminal.kill", {
			terminal: parent.address,
		});
		assert.equal(killed.state, "finished");
		assert.equal(
			(await lab.call("terminal.rm", { terminal: parent.address })).removed,
			parent.address,
		);
	},
);
