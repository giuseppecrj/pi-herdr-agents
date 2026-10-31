import assert from "node:assert/strict";
import { test } from "node:test";
import { __herdrTest__ } from "../../maestro/surfaces/herdr/herdr.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import { createRunSession } from "../../maestro/runtime/run-session.ts";
import {
	waitForHerdrShellReady,
	waitForHerdrPaneAbsence,
} from "../../maestro/surfaces/herdr/herdr-pane.ts";

test("readiness queries consume remaining budget and neither late readiness nor late absence is success", async () => {
	let queries = 0;
	await __herdrTest__.withMockHerdrExec(
		async (_args, timeout) => {
			queries++;
			assert.ok(timeout && timeout > 0 && timeout <= 15);
			await new Promise((resolve) => setTimeout(resolve, 30));
			return JSON.stringify({
				result: {
					process_info: {
						pane_id: "p",
						shell_pid: 1,
						foreground_process_group_id: 1,
					},
				},
			});
		},
		async () => {
			await assert.rejects(
				waitForHerdrShellReady("p", { timeoutMs: 15 }),
				/Timed out/,
			);
		},
	);
	assert.equal(queries, 1);
	queries = 0;
	assert.equal(
		await waitForHerdrPaneAbsence("p", {
			timeoutMs: 15,
			inspect: async (_id, timeout) => {
				queries++;
				assert.ok(timeout && timeout <= 15);
				await new Promise((resolve) => setTimeout(resolve, 30));
				return { kind: "missing" };
			},
		}),
		false,
	);
	assert.equal(queries, 1, "no final probe after the budget is exhausted");
});
import type { Role, Task } from "../../maestro/core/types.ts";

const role: Role = {
	name: "worker",
	version: "1",
	description: "test",
	systemPrompt: "",
	allowedTools: [],
};
const task: Task = {
	id: "uncertain",
	name: "uncertain",
	role: "worker",
	prompt: "test",
	cwd: "/repo",
	runtime: {
		model: "p/first",
		thinking: "off",
		fallbacks: [{ model: "p/second", thinking: "off" }],
	},
};

test("an uncertain remote mutation never advances the model shortlist", async () => {
	const adapter = new FakeHarnessAdapter();
	let attempts = 0;
	adapter.spawn = async () => {
		attempts++;
		throw Object.assign(new Error("remote mutation uncertain"), {
			code: "PIHA_ACQUISITION_UNCERTAIN",
			uncertainty: { kind: "surface-create", placement: "tab" },
		});
	};
	const session = createRunSession({ adapter, roles: [role], cwd: "/repo" });
	await assert.rejects(session.spawn(task), /uncertain/);
	assert.equal(attempts, 1);
});

test("explicit-timeout Herdr queries remain asynchronous and let parent timers run", async () => {
	let heartbeat = false;
	await __herdrTest__.withMockHerdrExec(
		async (_args, timeout, mode) => {
			assert.equal(mode, "async");
			assert.equal(timeout, 500);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(heartbeat, true);
			return JSON.stringify({
				result: { process_info: { pane_id: "p", shell_pid: 1 } },
			});
		},
		async () => {
			const provider = new HerdrSurfaceProvider({
				paneConfig: { mode: "grouped", direction: "right", maxPerTab: 2 },
			});
			const timer = setTimeout(() => {
				heartbeat = true;
			}, 0);
			try {
				await provider.getProcessInfo("p", { timeoutMs: 500 });
			} finally {
				clearTimeout(timer);
			}
		},
	);
});
