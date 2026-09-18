import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RuntimeResolutionError,
	buildAuthenticatedModelCatalog,
	getAuthenticatedTaskPreferences,
	resolveRuntimePlan,
	resolveRuntimePlans,
	wrapPiModelRegistry,
	type ParentRuntime,
	type RoutingModel,
	type RuntimeRequest,
} from "../pi-extension/subagents/runtime-routing.ts";

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
	"Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.",
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
