// THROWAWAY demonstration of a baseline race, not a production patch.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitForCompletion as baseline } from "../../completion.ts";
import { waitForCompletion as candidate } from "./completion-prototype.ts";
const records = [];
for (const payload of [
	{ type: "ping", name: "fixture", message: "help needed" },
	{ type: "error", errorMessage: "model rejected" },
]) {
	for (const [name, resolve] of [
		["baseline", baseline],
		["candidate", candidate],
	]) {
		const dir = mkdtempSync(join(tmpdir(), "issue29-zero-exit-"));
		const sessionFile = join(dir, "fixture.jsonl");
		try {
			const result = await resolve(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => {
					await Promise.resolve();
					writeFileSync(sessionFile + ".exit", JSON.stringify(payload));
					return "__SUBAGENT_DONE_0__\n";
				},
			});
			records.push({
				variant: name,
				authoritativeType: payload.type,
				result,
				sidecarLeftBehind: existsSync(sessionFile + ".exit"),
			});
			if (name === "baseline")
				assert.equal(
					result.reason,
					"sentinel",
					"baseline defect no longer reproduces; re-evaluate prototype",
				);
			else {
				assert.equal(result.reason, payload.type);
				assert.equal(existsSync(sessionFile + ".exit"), false);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}
console.log(
	JSON.stringify(
		{ baselineDefectReproduced: true, experimentalGuardPasses: true, records },
		null,
		2,
	),
);
