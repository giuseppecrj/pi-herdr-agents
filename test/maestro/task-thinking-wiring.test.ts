import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLaunchPlanner } from "../../pi-extension/subagents/launch.ts";
import type { SubagentRuntime } from "../../pi-extension/subagents/state.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

const models = [
	{
		provider: "p",
		id: "full",
		reasoning: true,
		thinkingLevelMap: { max: "max", xhigh: "xhigh" },
	},
	{
		provider: "p",
		id: "limited",
		reasoning: true,
		thinkingLevelMap: { max: null, xhigh: null },
	},
	{ provider: "p", id: "plain", reasoning: false },
];
const tasks = { coding: models.map((model) => `p/${model.id}`) };
const modelRegistry = {
	find: (provider: string, id: string) =>
		models.find((model) => model.provider === provider && model.id === id),
	getAvailable: () => models,
	hasConfiguredAuth: () => true,
};

describe("task thinking host wiring", () => {
	it("wires mixed-case category thinking through the launch planner, clamped per candidate", () => {
		const { api } = createMockExtensionApi();
		const planner = createLaunchPlanner({
			// SAFETY: the bare-launch planner uses no runtime fields besides the optional role-discovery API.
			runtime: { pi: api } as SubagentRuntime,
			modelConfig: { agents: {}, tasks, tasksThinking: { coding: "max" } },
			paneConfig: { mode: "grouped", direction: "right", maxPerTab: 4 },
		});
		const resolved = planner.resolveSubagentRuntimePlans(
			{ name: "wire", task: "bounded", model: "task:CoDiNg" },
			{
				cwd: "/test",
				sessionManager: {
					getSessionFile: () => "/test/session.jsonl",
					getSessionId: () => "test",
					getSessionDir: () => "/test",
				},
				model: models[0],
				modelRegistry,
			},
			"medium",
		);
		assert.deepEqual(
			resolved.map((plan) => [plan.model, plan.thinking, plan.thinkingSource]),
			[
				["p/full", "max", "task"],
				["p/limited", "high", "task"],
				["p/plain", "off", "task"],
			],
		);
	});

	for (const scoped of [false, true])
		it(`wires saved thinking into the ${scoped ? "scoped" : "unscoped"} system-prompt catalog`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "piha-catalog-wire-"));
			const previous = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = dir;
			try {
				mkdirSync(join(dir, "herdr-agents"));
				writeFileSync(
					join(dir, "herdr-agents", "config.json"),
					JSON.stringify({
						status: { enabled: false },
						models: { tasks, tasksThinking: { coding: "max" } },
					}),
				);
				const mock = createMockExtensionApi();
				// Configuration is loaded at module initialization; isolate each scoped/unscoped load.
				const { default: subagentsExtension } = await import(
					new URL(
						`../../pi-extension/subagents/index.ts?catalog=${scoped}`,
						import.meta.url,
					).href
				);
				subagentsExtension(mock.api);
				const ctx = {
					hasUI: false,
					scopedModels: scoped
						? models.map((model) => ({ model, thinkingLevel: "medium" }))
						: [],
					modelRegistry,
				};
				for (const handler of mock.eventHandlers.get("session_start") ?? [])
					await handler({}, ctx);
				const guidelines = mock.registeredTools
					.find((tool) => tool.name === "subagent")
					.promptGuidelines.join("\n");
				assert.match(
					guidelines,
					/coding: .*thinking: max \(clamped per candidate\)/,
				);
			} finally {
				if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previous;
				rmSync(dir, { recursive: true, force: true });
			}
		});
});
