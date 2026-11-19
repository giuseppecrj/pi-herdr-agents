import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createLifecycle,
	markCompletionDetected,
} from "@nubl/maestro/core/lifecycle";
import { __test__ } from "../../pi-extension/subagents/index.ts";

describe("widget elapsed time", () => {
	const startTime = 100_000;
	const cases = [
		[0, "00:00"],
		[187_000, "03:07"],
		[3_599_999, "59:59"],
		[3_600_000, "1:00:00"],
		[3_725_000, "1:02:05"],
		[43_200_000, "12:00:00"],
		[-1, "00:00"],
		[-2_000, "00:00"],
	] as const;

	for (const completed of [false, true]) {
		for (const [elapsed, expected] of cases) {
			it(`renders ${elapsed}ms as ${expected} (${completed ? "completed" : "running"})`, () => {
				const endTime = startTime + elapsed;
				const lifecycle = completed
					? markCompletionDetected(
							createLifecycle(startTime),
							{ reason: "done", exitCode: 0 },
							endTime,
						)
					: createLifecycle(startTime);
				const originalNow = Date.now;
				try {
					for (const now of completed
						? [endTime + 10_000, endTime + 100_000]
						: [endTime]) {
						Date.now = () => now;
						const lines = __test__.renderSubagentWidgetLines(
							[
								{
									id: "elapsed",
									name: "Worker",
									task: "",
									surface: "s1",
									startTime,
									sessionFile: "unused",
									lifecycle,
									interactive: false,
									runtimePlan: undefined,
								},
							],
							80,
						);
						assert.equal(
							lines[1].trimEnd().split(/\s+/).at(-2),
							expected,
							lines[1],
						);
					}
				} finally {
					Date.now = originalNow;
				}
			});
		}
	}
});
