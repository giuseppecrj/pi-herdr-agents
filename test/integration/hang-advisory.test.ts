/** Deterministic component integration for active-child no-progress advisories. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
import {
	createLifecycle,
	observePaneInspection,
	projectLifecycle,
} from "../../pi-extension/subagents/lifecycle.ts";

function activeChild(sessionFile: string, interactive = false) {
	return {
		id: "child",
		name: "Worker",
		task: "",
		surface: "pane",
		startTime: 0,
		sessionFile,
		interactive,
		runtimePlan: undefined,
		lifecycle: observePaneInspection(
			createLifecycle(0),
			{ kind: "present", observedAt: 1, agentStatus: "working" },
			1,
		),
	};
}

describe("hang advisory integration", () => {
	// This drives the evaluator seam directly, rather than startStatusRefresh.
	it("notifies once for a blocked active child, recovers on progress, and suppresses interactive steers", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-hang-advisory-integ-"));
		try {
			const sessionFile = join(root, "child.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call", name: "bash" }],
						stopReason: "toolUse",
					},
				})}\n`,
			);
			utimesSync(sessionFile, 0, 0);
			const now = 120_000;
			const child = activeChild(sessionFile);
			const advisory = subagentsModule.__test__.evaluateNoProgressAdvisory(
				child,
				projectLifecycle(child.lifecycle, now),
				now,
				1,
			);
			assert.equal(advisory?.kind, "warning");
			assert.equal(advisory?.classification, "blocked-tool");
			assert.equal(advisory?.notify, true);
			assert.match(
				subagentsModule.__test__.formatNoProgressAdvisoryLine(child, advisory!),
				/Recovery options: interrupt, or after manual termination use subagent_resume or a new spawn/,
			);
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					child,
					projectLifecycle(child.lifecycle, now + 1_000),
					now + 1_000,
					1,
				),
				undefined,
			);

			utimesSync(sessionFile, 0, (now + 2_000) / 1_000);
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					child,
					projectLifecycle(child.lifecycle, now + 2_000),
					now + 2_000,
					1,
				)?.kind,
				"recovered",
			);

			utimesSync(sessionFile, 0, 0);
			const interactive = activeChild(sessionFile, true);
			const quiet = subagentsModule.__test__.evaluateNoProgressAdvisory(
				interactive,
				projectLifecycle(interactive.lifecycle, now),
				now,
				1,
			);
			assert.equal(quiet?.kind, "warning");
			assert.equal(quiet?.notify, false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
