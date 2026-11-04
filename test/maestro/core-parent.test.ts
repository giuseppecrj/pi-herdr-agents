import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CoreLab } from "../integration/herdr-core-lab.ts";
import {
	captureCoreEvidence,
	coreResults,
	coreSession,
	coreToolResults,
} from "../integration/core-parent.ts";

const unix = { skip: process.platform === "win32" };

test(
	"Core parent evidence ignores only an incomplete final append",
	unix,
	() => {
		const lab = new CoreLab("/bin/false", "/bin/false");
		try {
			const file = join(lab.root, "session.jsonl");
			assert.deepEqual(coreSession(file), []);
			writeFileSync(file, '{"type":"session"}\n{"type":');
			assert.deepEqual(coreSession(file), [{ type: "session" }]);
			writeFileSync(file, '{"type":"session"}\nmalformed\n');
			assert.throws(() => coreSession(file));
			writeFileSync(file, "null\n");
			assert.throws(() => coreSession(file), /Invalid session entry/);
		} finally {
			lab.remove();
		}
	},
);

test("Core parent evidence distinguishes model-visible reports from lookalike text", () => {
	const report = {
		type: "custom_message",
		customType: "subagent_result",
		content: "result",
	};
	const result = { role: "toolResult", toolName: "subagent", content: [] };
	const entries = [
		report,
		{ type: "message", message: result },
		{
			type: "message",
			message: { role: "assistant", content: "subagent_result" },
		},
		{ type: "custom_message", customType: "subagent_ping", content: "help" },
		{
			type: "message",
			message: { role: "toolResult", toolName: "subagent_cancel", content: [] },
		},
	];
	assert.deepEqual(coreResults(entries), [report]);
	assert.deepEqual(coreToolResults(entries, "subagent"), [result]);
});

test(
	"Core evidence refuses both the checkout root and its descendants before I/O",
	unix,
	async () => {
		const lab = new CoreLab("/bin/false", "/bin/false");
		try {
			const root = fileURLToPath(new URL("../../", import.meta.url));
			for (const path of [root, join(root, "should-not-exist")])
				await assert.rejects(
					captureCoreEvidence(lab, path),
					/outside the checkout/,
				);
		} finally {
			lab.remove();
		}
	},
);
