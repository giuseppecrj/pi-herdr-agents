import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createModelRegistryAdapter,
	scopeModelRegistryAdapter,
	type ModelRegistryAdapter,
	type RoutingModel,
	type RoutingRegistrySource,
} from "../../maestro/core/routing.ts";

export function wrapPiModelRegistry(
	registry: RoutingRegistrySource,
): ModelRegistryAdapter {
	return createModelRegistryAdapter(registry, {
		supportedThinkingLevels: (model) =>
			getSupportedThinkingLevels(asPiModel(model)),
		clampThinkingLevel: (model, level) =>
			clampThinkingLevel(asPiModel(model), level),
	});
}

// Scoped sessions (--models / enabledModels) resolve every model selection —
// task shortlists, exact refs, fallback alternatives — against the session's
// scoped set: out-of-scope models are invisible to spawn-time resolution.
export function sessionModelRegistry(ctx: {
	modelRegistry: RoutingRegistrySource;
	scopedModels?: readonly { model: { provider: string; id: string } }[];
}): ModelRegistryAdapter {
	const registry = wrapPiModelRegistry(ctx.modelRegistry);
	const scopedModels = (ctx.scopedModels ?? []).map((entry) => entry.model);
	if (scopedModels.length === 0) return registry;
	return scopeModelRegistryAdapter(
		registry,
		new Set(scopedModels.map((model) => `${model.provider}/${model.id}`)),
	);
}

function asPiModel(model: RoutingModel): Model<any> {
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
}
