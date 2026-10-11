import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RuntimeResolutionError,
	buildAuthenticatedModelCatalog,
	buildScopedModelCatalog,
	getAuthenticatedTaskPreferences,
	resolveRuntimePlan,
	resolveRuntimePlans,
	createModelRegistryAdapter,
	type ParentRuntime,
	type RoutingModel,
	type RuntimeRequest,
} from "../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "../maestro/adapters/pi/model-registry.ts";
import { wrapPiModelRegistry as wrapHostModelRegistry } from "../pi-extension/subagents/model-registry.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";

const parent: ParentRuntime = {
	provider: "fake",
	modelId: "parent",
	thinking: "medium",
};

function model(
	provider: string,
	id: string,
	overrides: Partial<RoutingModel> = {},
) {
	return {
		provider,
		id,
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

function normalized(value: string) {
	return value.replace(/\s+/g, " ").trim();
}

const ordinaryReviewClauses = [
	"For ordinary review, prefer a different authenticated model family.",
	"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
	"Disclose that this review is context-isolated, not cross-family independent.",
	"Cross-family verification must not use this fallback.",
];

function registry(entries = [model("fake", "parent"), model("other", "fast")]) {
	const byRef = new Map(
		entries.map((entry) => [`${entry.provider}/${entry.id}`, entry]),
	);
	return wrapPiModelRegistry({
		find(provider: string, modelId: string) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return entries;
		},
		getAll() {
			return entries;
		},
		hasConfiguredAuth(candidate: { provider: string; id: string }) {
			return (
				byRef.has(`${candidate.provider}/${candidate.id}`) &&
				candidate.id !== "unauthed"
			);
		},
	});
}

function resolve(request: RuntimeRequest = {}, defaults: RuntimeRequest = {}) {
	return resolveRuntimePlan(request, defaults, parent, registry());
}

const registryFactories = [
	[
		"core",
		(source: import("../maestro/core/routing.ts").RoutingRegistrySource) =>
			createModelRegistryAdapter(source, {
				supportedThinkingLevels: () => ["off", "low"],
				clampThinkingLevel: (_model, level) => level,
			}),
	],
	["adapter", wrapPiModelRegistry],
	["host", wrapHostModelRegistry],
] as const;

for (const [owner, factory] of registryFactories) {
	describe(`Task15 ${owner} registry query contract`, () => {
		it("keeps construction lazy, raw receivers, direct precedence and live source identity", () => {
			const first = model("", "", {
				thinkingLevelMap: { high: null },
				cost: { input: 7 },
			});
			const duplicate = model("", "", { cost: { input: 99 } });
			let current = first;
			const calls: string[] = [];
			const source = {
				find(provider: string, id: string) {
					assert.equal(this, source);
					calls.push(`find:${provider}/${id}`);
					return current;
				},
				getAvailable() {
					assert.equal(this, source);
					calls.push("available");
					return [current, duplicate, { provider: 2 }];
				},
				getAll() {
					assert.fail("direct nonempty must not fall back");
				},
				hasConfiguredAuth(raw: RoutingModel) {
					assert.equal(this, source);
					assert.equal(raw, current);
					calls.push("auth");
					return true;
				},
			};
			const port = factory(source);
			assert.deepEqual(calls, []);
			const [selected] = port.available();
			assert.equal(selected.provider, "");
			assert.equal(selected.id, "");
			assert.equal(selected.cost, first.cost);
			assert.equal(selected.thinkingLevelMap, first.thinkingLevelMap);
			assert.deepEqual(calls, ["available"]);
			assert.equal(port.hasConfiguredAuth(selected), true);
			assert.deepEqual(calls, ["available", "find:/", "auth"]);
			const before = [...calls];
			port.supportedThinkingLevels(selected);
			port.clampThinkingLevel(selected, "medium");
			assert.deepEqual(calls, before, "capabilities must not query raw source");
			current = duplicate;
			assert.equal(port.find("", "")!.cost, duplicate.cost);
			assert.equal(port.hasConfiguredAuth(selected), true);
			assert.deepEqual(calls.slice(-3), ["find:/", "find:/", "auth"]);
		});
		it("does not rescue nonempty invalid direct results with getAll", () => {
			const calls: string[] = [];
			const port = factory({
				find: () => undefined,
				getAvailable() {
					calls.push("available");
					return [null, { id: 3 }];
				},
				getAll() {
					assert.fail("forbidden rescue");
				},
			});
			assert.deepEqual(port.available(), []);
			assert.deepEqual(calls, ["available"]);
		});
		it("authenticates raw fallback duplicates before first-seen deduplication", () => {
			const one = model("p", "one"),
				duplicate = model("p", "one"),
				denied = model("p", "denied"),
				two = model("p", "two");
			const calls: unknown[] = [];
			const source = {
				find() {
					assert.equal(this, source);
					calls.push("find");
					return undefined;
				},
				getAvailable() {
					assert.equal(this, source);
					calls.push("available");
					return [];
				},
				getAll() {
					assert.equal(this, source);
					calls.push("all");
					return [null, one, denied, duplicate, two];
				},
				hasConfiguredAuth(raw: RoutingModel) {
					assert.equal(this, source);
					calls.push(raw);
					return raw !== denied;
				},
			};
			const port = factory(source);
			assert.deepEqual(calls, []);
			assert.deepEqual(
				port.available().map((m) => m.id),
				["one", "two"],
			);
			assert.deepEqual(calls, [
				"available",
				"all",
				one,
				denied,
				duplicate,
				two,
			]);
			assert.equal(port.hasConfiguredAuth(one), false);
			assert.equal(calls.at(-1), "find");
		});
		it("preserves absent methods and exact getAvailable authentication without getAll rescue", () => {
			const bare = factory({ find: () => undefined });
			assert.deepEqual(bare.available(), []);
			assert.equal(bare.hasConfiguredAuth({ provider: "p", id: "one" }), false);
			let direct = [model("p", "one")];
			const calls: string[] = [];
			const port = factory({
				find: () => undefined,
				getAvailable() {
					calls.push("available");
					return direct;
				},
				getAll() {
					assert.fail("auth must not rescue from all");
				},
			});
			assert.equal(port.hasConfiguredAuth({ provider: "p", id: "one" }), true);
			direct = [model("other", "one")];
			assert.equal(port.hasConfiguredAuth({ provider: "p", id: "one" }), false);
			assert.deepEqual(calls, ["available", "available"]);
		});
	});
}

it("Task15 core attaches only capabilities without losing their receiver or eagerly querying", () => {
	const calls: RoutingModel[] = [];
	const capabilities = {
		marker: "private caller property",
		supportedThinkingLevels(
			candidate: RoutingModel,
		): import("../maestro/core/types.ts").ThinkingLevel[] {
			assert.equal(this, capabilities);
			calls.push(candidate);
			return ["max"];
		},
		clampThinkingLevel(
			candidate: RoutingModel,
			level: import("../maestro/core/types.ts").ThinkingLevel,
		) {
			assert.equal(this, capabilities);
			calls.push(candidate);
			return level;
		},
	};
	const port = createModelRegistryAdapter(
		{
			find() {
				assert.fail("no raw query during construction or capabilities");
			},
		},
		capabilities,
	);
	assert.deepEqual(calls, []);
	assert.equal(Object.hasOwn(port, "marker"), false);
	const candidate = model("p", "m");
	assert.deepEqual(port.supportedThinkingLevels(candidate), ["max"]);
	assert.equal(port.clampThinkingLevel(candidate, "low"), "low");
	assert.deepEqual(calls, [candidate, candidate]);
});

describe("Task15 SDK boundary equivalence", () => {
	it("uses real sparse/null SDK levels, upward clamp and nonreasoning off", () => {
		const cases: [
			RoutingModel,
			import("../maestro/core/types.ts").ThinkingLevel[],
			import("../maestro/core/types.ts").ThinkingLevel,
		][] = [
			[
				model("p", "sparse", {
					thinkingLevelMap: {
						minimal: null,
						low: null,
						medium: null,
						high: "high",
						xhigh: "xhigh",
						max: "max",
					},
				}),
				["off", "high", "xhigh", "max"],
				"high",
			],
			[model("p", "plain", { reasoning: false }), ["off"], "off"],
		];
		for (const [candidate, supported, clamped] of cases) {
			const answers = [];
			for (const wrap of [wrapPiModelRegistry, wrapHostModelRegistry]) {
				let queries = 0;
				const port = wrap({
					find() {
						queries++;
						return candidate;
					},
				});
				const selected = port.find(candidate.provider, candidate.id)!;
				answers.push([
					port.supportedThinkingLevels(selected),
					port.clampThinkingLevel(selected, "medium"),
				]);
				assert.equal(queries, 1);
			}
			assert.deepEqual(answers, [
				[supported, clamped],
				[supported, clamped],
			]);
		}
	});
	it("pins both full SDK conversion bodies to the original defaults and filter", () => {
		const original = `function asPiModel(model: RoutingModel): Model<any> {
	return {
		provider: model.provider,
		id: model.id,
		name: model.id,
		api: "openai-completions",
		baseUrl: "",
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input?.filter(
			(entry): entry is "text" | "image" =>
				entry === "text" || entry === "image",
		) ?? ["text"],
		contextWindow: model.contextWindow ?? 0,
		maxTokens: model.maxTokens ?? 0,
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cacheRead ?? 0,
			cacheWrite: model.cost?.cacheWrite ?? 0,
		},
	};
}`;
		function body(source: string) {
			const file = ts.createSourceFile(
				"registry.ts",
				source,
				ts.ScriptTarget.Latest,
				true,
			);
			const declaration = file.statements.find(
				(s) => ts.isFunctionDeclaration(s) && s.name?.text === "asPiModel",
			);
			assert.ok(
				declaration &&
					ts.isFunctionDeclaration(declaration) &&
					declaration.body,
			);
			return ts
				.createPrinter({ removeComments: true })
				.printNode(ts.EmitHint.Unspecified, declaration.body, file);
		}
		for (const path of [
			"../maestro/adapters/pi/model-registry.ts",
			"../pi-extension/subagents/model-registry.ts",
		]) {
			assert.equal(
				body(readFileSync(new URL(path, import.meta.url), "utf8")),
				body(original),
				path,
			);
		}
	});
});

interface CapabilityCalls {
	supported: RoutingModel[];
	clamp: [RoutingModel, string][];
}

describe("injected routing capabilities", () => {
	function injected() {
		const selected = model("fake", "parent");
		const calls: CapabilityCalls = {
			supported: [],
			clamp: [],
		};
		const port = {
			find: (): RoutingModel | undefined => selected,
			available: () => [selected],
			hasConfiguredAuth: () => true,
			supportedThinkingLevels(candidate: RoutingModel): ("max" | "low")[] {
				calls.supported.push(candidate);
				return ["max", "low"];
			},
			clampThinkingLevel(candidate: RoutingModel, level: string): "low" {
				calls.clamp.push([candidate, level]);
				return "low";
			},
		};
		return { selected, calls, port };
	}
	it("accepts injected max rather than SDK defaults with exactly one capability call", () => {
		const f = injected();
		assert.equal(
			resolveRuntimePlan({ thinking: "max" }, {}, parent, f.port).thinking,
			"max",
		);
		assert.deepEqual(f.calls.supported, [f.selected]);
		assert.deepEqual(f.calls.clamp, []);
	});
	it("formats unsupported thinking with a second injected call", () => {
		const f = injected();
		assert.throws(
			() => resolveRuntimePlan({ thinking: "high" }, {}, parent, f.port),
			/supported: max, low$/,
		);
		assert.deepEqual(f.calls.supported, [f.selected, f.selected]);
		assert.deepEqual(f.calls.clamp, []);
	});
	it("clamps inherited medium through only the supplied clamp", () => {
		const f = injected();
		assert.equal(resolveRuntimePlan({}, {}, parent, f.port).thinking, "low");
		assert.deepEqual(f.calls.clamp, [[f.selected, "medium"]]);
		assert.deepEqual(f.calls.supported, []);
		f.port.find = () => undefined;
		assert.equal(resolveRuntimePlan({}, {}, parent, f.port).thinking, "medium");
		assert.equal(f.calls.clamp.length, 1);
	});
	it("uses injected catalog levels, including one call for nonreasoners", () => {
		const f = injected();
		assert.match(
			buildAuthenticatedModelCatalog(f.port),
			/reasoning \(max\/low\)/,
		);
		f.selected.reasoning = false;
		assert.match(buildAuthenticatedModelCatalog(f.port), /non-reasoning/);
		assert.deepEqual(f.calls.supported, [f.selected, f.selected]);
		assert.deepEqual(f.calls.clamp, []);
	});
});

describe("runtime routing", () => {
	it("inherits the parent model and thinking when no override is requested", () => {
		assert.deepEqual(resolve(), {
			provider: "fake",
			modelId: "parent",
			model: "fake/parent",
			thinking: "medium",
			modelSource: "parent",
			thinkingSource: "parent",
		});
	});

	it("resolves tool-call fields over agent defaults independently", () => {
		assert.deepEqual(
			resolve({ thinking: "high" }, { model: "other/fast", thinking: "low" }),
			{
				provider: "other",
				modelId: "fast",
				model: "other/fast",
				thinking: "high",
				modelSource: "agent",
				thinkingSource: "request",
				requestedModel: "other/fast",
				requestedThinking: "high",
			},
		);
	});

	it("parses exact model references at the first slash", () => {
		const nested = model("other", "family/reasoner");
		const plan = resolveRuntimePlan(
			{ model: "other/family/reasoner" },
			{},
			parent,
			registry([model("fake", "parent"), nested]),
		);
		assert.equal(plan.provider, "other");
		assert.equal(plan.modelId, "family/reasoner");
	});

	it("rejects fuzzy, unknown, and unauthenticated explicit models", () => {
		for (const request of [
			{ model: "fast" },
			{ model: "other/missing" },
			{ model: "other/unauthed" },
		]) {
			const entries = [model("fake", "parent"), model("other", "unauthed")];
			assert.throws(
				() => resolveRuntimePlan(request, {}, parent, registry(entries)),
				RuntimeResolutionError,
			);
		}
	});

	it("resolves trimmed fallback candidates in declaration order", () => {
		const plans = resolveRuntimePlans(
			{ model: " other/fast , fake/parent " },
			{},
			parent,
			registry(),
		);
		assert.deepEqual(
			plans.map((plan) => [plan.model, plan.modelSource]),
			[
				["other/fast", "request"],
				["fake/parent", "request"],
			],
		);
	});

	it("validates every fallback before launch", () => {
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "other/fast, other/missing" },
					{},
					parent,
					registry(),
				),
			/unknown model "other\/missing"/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans({ model: "other/fast," }, {}, parent, registry()),
			/cannot contain an empty candidate/,
		);
	});

	it("expands whole-value task references using authenticated configured order", () => {
		const entries = [
			model("fake", "parent"),
			model("other", "worker"),
			model("other", "backup"),
			model("other", "unauthed"),
		];
		const tasks = {
			coding: ["other/worker", "other/unauthed", "other/backup"],
		};
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: " task:CoDiNg " },
				{},
				parent,
				registry(entries),
				tasks,
			).map((plan) => plan.model),
			["other/worker", "other/backup"],
		);
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: "task:coding" },
				{},
				parent,
				registry(entries),
				tasks,
				true,
			).map((plan) => plan.model),
			["other/worker"],
		);
		for (const modelReference of [
			"task:coding, other/backup",
			"other/backup, task:coding",
		]) {
			assert.throws(
				() =>
					resolveRuntimePlans(
						{ model: modelReference },
						{},
						parent,
						registry(entries),
						tasks,
					),
				/must be the entire model value/,
			);
		}
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "task:qa" },
					{},
					parent,
					registry(entries),
					tasks,
				),
			/configured categories: coding/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans(
					{},
					{ model: "task:coding" },
					parent,
					registry(entries),
					tasks,
				),
			/only valid in the subagent tool's model parameter/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "task:coding" },
					{},
					parent,
					registry([model("fake", "parent"), model("other", "unauthed")]),
					{ coding: ["other/unauthed"] },
				),
			/task category "coding" has no authenticated candidates; authenticated alternatives: fake\/parent/,
		);
	});

	it("keeps the selected source when agent defaults provide fallbacks", () => {
		const plans = resolveRuntimePlans(
			{},
			{ model: "other/fast, fake/parent" },
			parent,
			registry(),
		);
		assert.deepEqual(
			plans.map((plan) => plan.modelSource),
			["agent", "agent"],
		);
	});

	it("rejects unsupported explicit thinking with supported alternatives", () => {
		const plain = model("other", "plain", { reasoning: false });
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ model: "other/plain", thinking: "high" },
					{},
					parent,
					registry([model("fake", "parent"), plain]),
				),
			/thinking "high" is not supported.*supported: off/,
		);
	});

	it("uses agent-default thinking when the request omits it", () => {
		const plan = resolveRuntimePlan(
			{},
			{ thinking: "low" },
			parent,
			registry(),
		);
		assert.equal(plan.thinking, "low");
		assert.equal(plan.thinkingSource, "agent");
		assert.equal(plan.requestedThinking, "low");
	});

	it("clamps inherited thinking for a reasoning model with a sparse level map", () => {
		const sparse = model("other", "sparse", {
			thinkingLevelMap: {
				off: "off",
				minimal: "minimal",
				low: "low",
				medium: null,
				high: "high",
			},
		});
		const plan = resolveRuntimePlan(
			{ model: "other/sparse" },
			{},
			parent,
			registry([model("fake", "parent"), sparse]),
		);
		assert.equal(plan.thinking, "high");
		assert.deepEqual(plan.thinkingAdjustment, {
			from: "medium",
			to: "high",
			reason: "inherited-clamp",
		});
	});

	it("clamps inherited thinking for a non-reasoning selected model", () => {
		const plain = model("other", "plain", { reasoning: false });
		const plan = resolveRuntimePlan(
			{ model: "other/plain" },
			{},
			parent,
			registry([model("fake", "parent"), plain]),
		);
		assert.equal(plan.thinking, "off");
		assert.equal(plan.thinkingSource, "parent");
		assert.deepEqual(plan.thinkingAdjustment, {
			from: "medium",
			to: "off",
			reason: "non-reasoning",
		});
	});
});

describe("authenticated model catalog", () => {
	it("lists exact authenticated IDs with concise capability facts", () => {
		const available = [
			model("fake", "parent", {
				input: ["text", "image"],
				contextWindow: 200_000,
			}),
			model("other", "plain", {
				reasoning: false,
				cost: { input: 0, output: 0 },
			}),
		];
		const catalog = buildAuthenticatedModelCatalog(registry(available));
		assert.match(catalog, /fake\/parent/);
		assert.match(catalog, /reasoning \(off\/minimal\/low\/medium\/high\)/);
		assert.match(catalog, /text\+image/);
		assert.match(catalog, /200k context/);
		assert.match(catalog, /other\/plain/);
		assert.match(catalog, /non-reasoning/);
		assert.match(
			catalog,
			/explicitly select an exact authenticated provider\/model-id by task tier first/,
		);
		assert.match(
			catalog,
			/For ordinary review, prefer a different authenticated model family/,
		);
		assert.match(
			catalog,
			/context-isolated/,
			"generic catalog must describe context-isolated same-family fallback",
		);
		assert.match(
			catalog,
			/inherits the parent runtime as a discouraged fallback/,
		);
	});

	it("renders authenticated configured shortlists in order with review guidance", () => {
		const entries = [
			model("fake", "parent"),
			model("other", "first"),
			model("other", "second"),
			model("other", "unauthed"),
		];
		const tasks = {
			coding: ["other/second", "other/unauthed", "other/first"],
			review: ["fake/parent"],
		};
		assert.deepEqual(
			getAuthenticatedTaskPreferences(registry(entries), tasks),
			{
				coding: ["other/second", "other/first"],
				review: ["fake/parent"],
			},
		);
		const catalog = buildAuthenticatedModelCatalog(
			registry(entries),
			24,
			tasks,
		);
		assert.match(catalog, /- coding: other\/second, other\/first/);
		assert.match(catalog, /- review: fake\/parent/);
		assert.doesNotMatch(catalog, /other\/unauthed/);
		assert.match(catalog, /The extension does not enforce this/);
		assert.match(
			catalog,
			/context-isolated/,
			"shortlist catalog must describe context-isolated same-family fallback",
		);
	});

	it("keeps generic tier guidance when shortlists are empty or unconfigured", () => {
		for (const tasks of [undefined, {}]) {
			const catalog = buildAuthenticatedModelCatalog(registry(), 24, tasks);
			assert.match(
				catalog,
				/explicitly select an exact authenticated provider\/model-id by task tier first/,
			);
			assert.doesNotMatch(catalog, /Task-category shortlists/);
		}
	});

	it("caps large catalogs and reports omitted models", () => {
		const available = Array.from({ length: 30 }, (_, index) =>
			model("fake", `model-${index}`),
		);
		const catalog = buildAuthenticatedModelCatalog(registry(available), 5);
		assert.equal((catalog.match(/^- fake\//gm) ?? []).length, 5);
		assert.match(catalog, /25 more authenticated models omitted/);
	});

	it("builds an untruncated catalog from the scoped model set", () => {
		const available = [
			...Array.from({ length: 30 }, (_, index) =>
				model("fake", `model-${index}`),
			),
			model("zai", "glm-5.3"),
			model("zai", "glm-5.3-flash"),
		];
		const catalog = buildScopedModelCatalog(registry(available), [
			model("zai", "glm-5.3-flash"),
			model("zai", "glm-5.3"),
			model("zai", "glm-5.3-flash"),
		]);
		assert.match(catalog, /- zai\/glm-5.3 — /);
		assert.match(catalog, /- zai\/glm-5.3-flash — /);
		assert.equal(
			(catalog.match(/^- /gm) ?? []).length,
			2,
			"scoped catalogs dedupe refs and list the whole scoped set",
		);
		assert.doesNotMatch(catalog, /fake\//);
		assert.doesNotMatch(catalog, /more authenticated models omitted/);
	});

	it("keeps an upper bound on scoped catalogs behind an explicit tail", () => {
		const available = Array.from({ length: 30 }, (_, index) =>
			model("zai", `glm-${index}`),
		);
		const catalog = buildScopedModelCatalog(
			registry(available),
			available,
			undefined,
			5,
		);
		assert.equal((catalog.match(/^- zai\//gm) ?? []).length, 5);
		assert.match(catalog, /- … 25 more scoped models omitted/);
	});

	it("keeps only scoped shortlist candidates and drops emptied categories", () => {
		const entries = [
			model("zai", "glm-5.3"),
			model("zai", "glm-5.3-flash"),
			model("other", "fast"),
		];
		const tasks = {
			coding: ["zai/glm-5.3", "other/fast"],
			review: ["zai/glm-5.3-flash"],
			qa: ["other/fast"],
		};
		assert.deepEqual(
			getAuthenticatedTaskPreferences(
				registry(entries),
				tasks,
				new Set(["zai/glm-5.3", "zai/glm-5.3-flash"]),
			),
			{ coding: ["zai/glm-5.3"], review: ["zai/glm-5.3-flash"] },
		);
		const catalog = buildScopedModelCatalog(
			registry(entries),
			[model("zai", "glm-5.3"), model("zai", "glm-5.3-flash")],
			tasks,
		);
		assert.match(catalog, /- coding: zai\/glm-5.3$/m);
		assert.match(catalog, /- review: zai\/glm-5.3-flash$/m);
		assert.doesNotMatch(catalog, /- qa:/);
		assert.doesNotMatch(catalog, /other\/fast/);
	});

	it("keeps the none-discovered shape for an empty scoped set", () => {
		const catalog = buildScopedModelCatalog(registry(), []);
		assert.match(catalog, /- none discovered; omitting model still inherits/);
	});

	it("keeps ordinary fallback separate from strict orchestration guidance in both catalog branches", () => {
		const catalogs = [
			[
				"shortlist",
				buildAuthenticatedModelCatalog(registry(), 24, {
					coding: ["other/fast"],
				}),
			],
			["generic", buildAuthenticatedModelCatalog(registry())],
		] as const;
		for (const [label, catalog] of catalogs) {
			const compact = normalized(catalog);
			for (const clause of ordinaryReviewClauses)
				assert.ok(
					compact.includes(clause),
					`${label} catalog must include: ${clause}`,
				);
			assert.match(
				compact,
				/exact authenticated provider\/model-id/,
				`${label} catalog must require an exact authenticated provider/model-id`,
			);
		}

		const genericLines = catalogs[1][1].split("\n");
		const orchestratedLine = genericLines.find((line) =>
			line.startsWith("For orchestrated children"),
		);
		assert.ok(
			orchestratedLine,
			"generic catalog must include an orchestrated line",
		);
		assert.doesNotMatch(
			orchestratedLine,
			/ordinary|same-family|context-isolated/i,
			"generic catalog's orchestrated line must not embed ordinary-review fallback",
		);
		assert.ok(
			genericLines.some((line) => line.startsWith("For ordinary review")),
			"generic catalog must put ordinary-review guidance on a separate line",
		);
	});
});
