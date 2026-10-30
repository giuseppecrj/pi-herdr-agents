import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createModelRegistryAdapter,
	MODEL_SCOPE_ENV,
	modelScopeOf,
	scopeModelRegistryAdapter,
	sessionModelScope,
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

interface SessionModelContext {
	modelRegistry: RoutingRegistrySource;
	scopedModels?: readonly { model: RoutingModel }[];
}

// Scoped sessions (--models / enabledModels) resolve every model selection —
// task shortlists, exact refs, fallback alternatives — against the session's
// scoped set: out-of-scope models are invisible to spawn-time resolution. A
// child also narrows its scope to the exact allowlist its parent exported, and
// stays scoped to it when its own --models resolved to nothing.
export function sessionModelRegistry(
	ctx: SessionModelContext,
	env: NodeJS.ProcessEnv = process.env,
): ModelRegistryAdapter {
	const registry = wrapPiModelRegistry(ctx.modelRegistry);
	const ownScope = (ctx.scopedModels ?? []).map(
		({ model }) => `${model.provider}/${model.id}`,
	);
	const scope = sessionModelScope(ownScope, env[MODEL_SCOPE_ENV]);
	return scope ? scopeModelRegistryAdapter(registry, new Set(scope)) : registry;
}

/** The models a scoped session's catalog lists, or undefined when unscoped. */
export function sessionScopedModels(
	ctx: SessionModelContext,
	registry: ModelRegistryAdapter,
): RoutingModel[] | undefined {
	const scope = modelScopeOf(registry);
	if (!scope) return undefined;
	const inScope = new Set(scope);
	const own = (ctx.scopedModels ?? [])
		.map(({ model }) => model)
		.filter((model) => inScope.has(`${model.provider}/${model.id}`));
	// Only an inherited allowlist applies: list what the registry resolves.
	return own.length > 0 ? own : registry.available();
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
