import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	parseModelConfig,
	readConfigRevision,
	writeTaskModelConfig,
} from "../../maestro/core/config/model-config.ts";
import type { TaskThinkingPreferences } from "../../maestro/core/config/task-model-types.ts";
import {
	THINKING_LEVELS,
	buildAuthenticatedModelCatalog,
	buildScopedModelCatalog,
	resolveRuntimePlans,
	type RuntimeRequest,
} from "../../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "../../pi-extension/subagents/model-registry.ts";

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
		thinkingLevelMap: { xhigh: null, max: null },
	},
	{ provider: "p", id: "plain", reasoning: false },
];
const registry = wrapPiModelRegistry({
	find: (provider, id) =>
		models.find((model) => model.provider === provider && model.id === id),
	getAvailable: () => models,
	hasConfiguredAuth: () => true,
});
const parent = { provider: "p", modelId: "full", thinking: "medium" as const };
const tasks = { coding: models.map((model) => `p/${model.id}`) };
const tasksMeta = {
	generatedAt: "2026-11-12T00:00:00Z",
	method: "registry-only" as const,
};

function plans(
	request: RuntimeRequest = { model: "task:coding" },
	role: RuntimeRequest = { thinking: "low" },
	thinking: TaskThinkingPreferences = { coding: "max" },
) {
	return resolveRuntimePlans(
		request,
		role,
		parent,
		registry,
		tasks,
		false,
		thinking,
	);
}

describe("task-category thinking", () => {
	it("parses every Pi level and leaves absent thinking absent", () => {
		for (const level of THINKING_LEVELS)
			assert.deepEqual(
				parseModelConfig({ models: { tasksThinking: { coding: level } } })
					.tasksThinking,
				{ coding: level },
			);
		assert.deepEqual(parseModelConfig({ models: { tasks } }), {
			agents: {},
			tasks,
		});
		assert.deepEqual(
			parseModelConfig({ models: { tasksThinking: {} } }).tasksThinking,
			{},
		);
	});

	it("rejects invalid levels, maps and categories", () => {
		for (const tasksThinking of [
			null,
			[],
			"high",
			{ coding: "ultra" },
			{ coding: null },
			{ coding: 1 },
			{ coding: " high " },
			{ other: "high" },
		])
			assert.throws(
				() => parseModelConfig({ models: { tasksThinking } }),
				/models.tasksThinking/,
			);
	});

	it("clamps category thinking independently for every candidate and records the source", () => {
		assert.deepEqual(
			plans().map((plan) => [
				plan.model,
				plan.thinking,
				plan.thinkingSource,
				plan.requestedThinking,
				plan.thinkingAdjustment,
			]),
			[
				["p/full", "max", "task", "max", undefined],
				[
					"p/limited",
					"high",
					"task",
					"max",
					{ from: "max", to: "high", reason: "task-clamp" },
				],
				[
					"p/plain",
					"off",
					"task",
					"max",
					{ from: "max", to: "off", reason: "task-clamp" },
				],
			],
		);
	});

	it("resolves explicit before category, category before role, and role before parent", () => {
		const explicit = plans({ model: "task:coding", thinking: "off" });
		assert.ok(
			explicit.every(
				(plan) => plan.thinking === "off" && plan.thinkingSource === "request",
			),
		);
		const role = plans(undefined, { thinking: "off" }, {});
		assert.ok(
			role.every(
				(plan) => plan.thinking === "off" && plan.thinkingSource === "agent",
			),
		);
		const inherited = plans(undefined, {}, {});
		assert.deepEqual(
			inherited.map((plan) => [plan.thinking, plan.thinkingSource]),
			[
				["medium", "parent"],
				["medium", "parent"],
				["off", "parent"],
			],
		);
		assert.throws(
			() => plans({ model: "task:coding", thinking: "max" }),
			/not supported/,
		);
		assert.throws(
			() => plans(undefined, { thinking: "max" }, {}),
			/not supported/,
		);
	});

	it("does not apply category thinking to exact refs and respects worktree selection", () => {
		const [exact] = plans({ model: "p/full" });
		assert.equal(exact.thinking, "low");
		assert.equal(exact.thinkingSource, "agent");
		const worktree = resolveRuntimePlans(
			{ model: "task:coding" },
			{},
			parent,
			registry,
			tasks,
			true,
			{ coding: "max" },
		);
		assert.equal(worktree.length, 1);
		assert.equal(worktree[0].thinking, "max");
	});

	it("shows category thinking in both authenticated and scoped catalogs", () => {
		assert.match(
			buildAuthenticatedModelCatalog(registry, 24, tasks, { coding: "max" }),
			/coding: .*thinking: max \(clamped per candidate\)/,
		);
		assert.match(
			buildScopedModelCatalog(registry, models, tasks, 24, { coding: "high" }),
			/coding: .*thinking: high \(clamped per candidate\)/,
		);
	});

	it("writes models and thinking under one revision, preserves legacy thinking, and clears explicitly", () => {
		const dir = mkdtempSync(join(tmpdir(), "piha-thinking-"));
		try {
			const config = join(dir, "config.json");
			const example = join(dir, "example.json");
			writeFileSync(
				example,
				JSON.stringify({ status: { enabled: false }, models: { agents: {} } }),
			);
			const save = (tasksThinking?: TaskThinkingPreferences) =>
				writeTaskModelConfig(config, example, tasks, tasksMeta, () => true, {
					tasksThinking,
					expectedConfigRevision: readConfigRevision(config),
				});
			const saved = save({ coding: "max" });
			assert.deepEqual(saved.tasksThinking, { coding: "max" });
			assert.equal(saved.configRevision, readConfigRevision(config));
			assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), {
				status: { enabled: false },
				models: {
					agents: {},
					tasks,
					tasksThinking: { coding: "max" },
					tasksMeta,
				},
			});
			assert.deepEqual(save().tasksThinking, { coding: "max" });
			const before = readFileSync(config);
			assert.throws(
				() =>
					writeTaskModelConfig(config, example, tasks, tasksMeta, () => true, {
						expectedConfigRevision: "missing",
						tasksThinking: { coding: "low" },
					}),
				/Stale/,
			);
			assert.deepEqual(readFileSync(config), before);
			assert.deepEqual(save({}).tasksThinking, {});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
