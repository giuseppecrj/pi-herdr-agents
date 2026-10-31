import assert from "node:assert/strict";
import { test } from "node:test";
import { AcquisitionUncertainError } from "../../maestro/core/surface-provider.ts";
import { HerdrClientError } from "../../maestro/surfaces/herdr/herdr-cli.ts";
import {
	__herdrTest__,
	sendHerdrCommand,
} from "../../maestro/surfaces/herdr/herdr.ts";

for (const output of [
	"",
	" \t\r\n",
	JSON.stringify({ result: { ok: true } }),
	JSON.stringify({ result: { type: "pane_run" } }),
]) {
	test(`dispatch accepts successful receipt ${JSON.stringify(output)}`, async () => {
		let calls = 0;
		await __herdrTest__.withMockHerdrExec(
			(args, timeout, mode) => {
				calls++;
				assert.deepEqual(args, ["pane", "run", "owned", "pi"]);
				assert.equal(mode, "async");
				assert.ok(timeout && timeout > 0);
				return output;
			},
			() => sendHerdrCommand("owned", "pi"),
		);
		assert.equal(calls, 1);
	});
}

const failures = [
	"invalid",
	"{}",
	"null",
	JSON.stringify({ result: { ok: false } }),
	JSON.stringify({ result: { ok: true }, error: "dispatch failed" }),
	...(["exit", "timeout", "overflow"] as const).flatMap((kind) =>
		["", " \n", JSON.stringify({ result: { ok: true } })].map(
			(stdout) => new HerdrClientError(kind, kind, stdout, "failure"),
		),
	),
];
for (const [index, failure] of failures.entries()) {
	test(`dispatch preserves uncertainty without retry for failure ${index}`, async () => {
		let calls = 0;
		await __herdrTest__.withMockHerdrExec(
			() => {
				calls++;
				if (failure instanceof Error) throw failure;
				return failure;
			},
			async () => {
				await assert.rejects(sendHerdrCommand("owned", "pi"), (error) => {
					assert.ok(error instanceof AcquisitionUncertainError);
					assert.deepEqual(error.uncertainty, {
						kind: "command-dispatch",
						surfaceId: "owned",
					});
					return true;
				});
			},
		);
		assert.equal(calls, 1);
	});
}
