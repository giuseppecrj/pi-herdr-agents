import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
	acceptLaunchRefusal,
	buildOutcomeLedgerLine,
	describeAcceptVerdict,
	normalizeAcceptSpec,
} from "../../maestro/core/accept.ts";
import { parseOutcomeLedgerConfig } from "../../maestro/core/config/outcome-ledger-config.ts";
import { SubagentParams } from "../../pi-extension/subagents/catalog.ts";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

describe("accept parameter", () => {
	it("applies defaults and validates bounds", () => {
		assert.deepEqual(normalizeAcceptSpec({ run: "npm test" }), {
			run: "npm test",
			maxRetries: 1,
			timeoutSec: 600,
			paths: [],
		});
		assert.deepEqual(
			normalizeAcceptSpec({
				run: "make check",
				maxRetries: 0,
				timeoutSec: 3600,
				paths: ["./test/", "test", "src/a.test.ts"],
			}),
			{
				run: "make check",
				maxRetries: 0,
				timeoutSec: 3600,
				paths: ["test", "src/a.test.ts"],
			},
		);
		for (const bad of [
			{ run: "" },
			{ run: "  " },
			{ run: "x", maxRetries: 6 },
			{ run: "x", maxRetries: -1 },
			{ run: "x", maxRetries: 1.5 },
			{ run: "x", timeoutSec: 0 },
			{ run: "x", timeoutSec: 3601 },
			{ run: "x", paths: ["/etc/passwd"] },
			{ run: "x", paths: ["../outside"] },
			{ run: "x", paths: [""] },
		])
			assert.throws(() => normalizeAcceptSpec(bad), /Invalid accept check/);
		// A non-schema caller's extra key is refused too.
		assert.throws(
			() => normalizeAcceptSpec(JSON.parse('{"run":"x","extra":true}')),
			/unsupported key\(s\): extra/,
		);
	});

	it("is an optional schema field with the documented bounds", () => {
		const ok = { name: "n", task: "t", accept: { run: "true" } };
		assert.equal(Value.Check(SubagentParams, ok), true);
		assert.equal(Value.Check(SubagentParams, { name: "n", task: "t" }), true);
		for (const accept of [
			{},
			{ run: "" },
			{ run: "x", maxRetries: 6 },
			{ run: "x", timeoutSec: 3601 },
		])
			assert.equal(
				Value.Check(SubagentParams, { name: "n", task: "t", accept }),
				false,
				JSON.stringify(accept),
			);
	});

	it("refuses persistent and non-auto-exit children", () => {
		assert.match(
			acceptLaunchRefusal({ persistent: true, autoExit: false })!,
			/persistent/,
		);
		assert.match(
			acceptLaunchRefusal({ persistent: false, autoExit: false })!,
			/auto-exit/,
		);
		assert.equal(
			acceptLaunchRefusal({ persistent: false, autoExit: true }),
			undefined,
		);
	});

	async function launch(params: Partial<typeof SubagentParams.static>) {
		const previous = process.env.HERDR_ENV;
		// Without Herdr, a launch that passes the refusal stops at a later check.
		delete process.env.HERDR_ENV;
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);
			const tool = registeredTools.find((entry) => entry.name === "subagent");
			return await tool.execute(
				"call-1",
				{ name: "checked", task: "work", ...params },
				new AbortController().signal,
				() => {},
				{},
			);
		} finally {
			if (previous === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previous;
		}
	}

	it("the public tool refuses accept before launch for persistent or interactive runs", async () => {
		for (const extra of [{ persistent: true }, { interactive: true }]) {
			const result = await launch({ accept: { run: "true" }, ...extra });
			assert.equal(result.details.error, "accept-unsupported");
			assert.match(result.content[0].text, /^Error: accept /);
		}
		// An auto-exit bare launch passes the refusal and stops at Herdr.
		const passed = await launch({ accept: { run: "true" } });
		assert.equal(passed.details.error, "herdr not available");
		await assert.rejects(
			launch({ accept: { run: "x", paths: ["../escape"] } }),
			/Invalid accept check/,
		);
	});
});

describe("outcome ledger config", () => {
	it("is on by default and accepts only a boolean", () => {
		assert.deepEqual(parseOutcomeLedgerConfig({}), { enabled: true });
		assert.deepEqual(parseOutcomeLedgerConfig({ outcomeLedger: false }), {
			enabled: false,
		});
		assert.deepEqual(parseOutcomeLedgerConfig({ outcomeLedger: true }), {
			enabled: true,
		});
		for (const value of ["false", 0, null, {}])
			assert.throws(
				() => parseOutcomeLedgerConfig({ outcomeLedger: value }, "cfg"),
				/Invalid outcomeLedger config in cfg: outcomeLedger must be true or false/,
			);
	});
});

describe("verdict model", () => {
	it("describes each verdict in one closed form", () => {
		assert.equal(describeAcceptVerdict(undefined), "none");
		assert.equal(describeAcceptVerdict({ verdict: "none" }), "none");
		assert.equal(
			describeAcceptVerdict({ verdict: "accepted", tries: 2 }),
			"accepted (2 tries)",
		);
		assert.equal(
			describeAcceptVerdict({ verdict: "accepted", tries: 1 }),
			"accepted (1 try)",
		);
		assert.equal(
			describeAcceptVerdict({
				verdict: "rejected",
				tries: 2,
				childVerdict: "failed",
				exitCode: 1,
			}),
			"rejected after 2 tries (exit 1)",
		);
		assert.equal(
			describeAcceptVerdict({
				verdict: "rejected",
				tries: 1,
				childVerdict: "passed",
				exitCode: 3,
			}),
			"rejected (child reported a pass; parent re-check exit 3)",
		);
		assert.equal(
			describeAcceptVerdict({ verdict: "error", reason: "timed out after 5s" }),
			"error (timed out after 5s)",
		);
		assert.equal(
			describeAcceptVerdict({ verdict: "skipped", reason: "cancelled" }),
			"skipped (cancelled)",
		);
	});

	it("builds a ledger line with only the listed keys", () => {
		const line = buildOutcomeLedgerLine({
			at: Date.UTC(2026, 9, 30),
			runId: "run-1",
			attempt: 1,
			role: "worker",
			requestedModel: "task:Implementation",
			model: "p/m",
			thinking: "medium",
			elapsedSec: 12,
			outcome: "completed",
			accept: {
				verdict: "rejected",
				tries: 2,
				exitCode: 1,
				checkHash: "sha256:abc",
				output: "secret output",
				cwd: "/secret/cwd",
			},
		});
		assert.deepEqual(line, {
			v: 1,
			at: "2026-10-30T00:00:00.000Z",
			runId: "run-1",
			attempt: 1,
			role: "worker",
			requestedModel: "task:Implementation",
			category: "implementation",
			model: "p/m",
			thinking: "medium",
			elapsedSec: 12,
			outcome: "completed",
			checkTries: 2,
			verdict: "rejected",
			checkHash: "sha256:abc",
		});
		assert.doesNotMatch(JSON.stringify(line), /secret/);
	});
});
