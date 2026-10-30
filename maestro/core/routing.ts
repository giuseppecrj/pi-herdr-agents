import type { TaskPreferences } from "./config/task-model-types.ts";
import type { ThinkingLevel } from "./types.ts";
import { isFiniteNumber, isString } from "./config/type-guards.ts";
export type { ThinkingLevel } from "./types.ts";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}

export type RuntimeSource = "request" | "agent" | "parent";

export interface RuntimeRequest {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface ParentRuntime {
	provider: string;
	modelId: string;
	thinking: ThinkingLevel;
}

export interface RoutingModel {
	provider: string;
	id: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export interface ModelRegistryAdapter {
	find(provider: string, modelId: string): RoutingModel | undefined;
	available(): RoutingModel[];
	hasConfiguredAuth(model: { provider: string; id: string }): boolean;
	// pi-herdr-agents extension
	supportedThinkingLevels(model: RoutingModel): ThinkingLevel[];
	// pi-herdr-agents extension
	clampThinkingLevel(model: RoutingModel, level: ThinkingLevel): ThinkingLevel;
	// pi-herdr-agents extension
	/** Exact `provider/model-id` refs of the session's model scope (`--models` /
	 * `enabledModels`, narrowed by an inherited {@link MODEL_SCOPE_ENV}).
	 * Absent means the session is unscoped; empty means no model is in scope. */
	scope?: readonly string[];
}

export interface ResolvedRuntimePlan {
	provider: string;
	modelId: string;
	model: string;
	thinking: ThinkingLevel;
	modelSource: RuntimeSource;
	thinkingSource: RuntimeSource;
	requestedModel?: string;
	requestedThinking?: ThinkingLevel;
	thinkingAdjustment?: {
		from: ThinkingLevel;
		to: ThinkingLevel;
		reason: "non-reasoning" | "inherited-clamp";
	};
	observed?: {
		model?: string;
		thinking?: ThinkingLevel;
	};
	runtimeMismatch?: string;
}

export class RuntimeResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeResolutionError";
	}
}

export function parseExactModelRef(
	reference: string,
): { provider: string; modelId: string } | undefined {
	const trimmed = reference.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const modelId = trimmed.slice(separator + 1).trim();
	return provider && modelId ? { provider, modelId } : undefined;
}

function toRoutingModel(value: any): RoutingModel | undefined {
	if (!value || !isString(value.provider) || !isString(value.id)) {
		return undefined;
	}
	return {
		provider: value.provider,
		id: value.id,
		reasoning: value.reasoning ?? false,
		thinkingLevelMap: value.thinkingLevelMap,
		input: Array.isArray(value.input) ? value.input : undefined,
		contextWindow: isFiniteNumber(value.contextWindow)
			? value.contextWindow
			: undefined,
		maxTokens: isFiniteNumber(value.maxTokens) ? value.maxTokens : undefined,
		cost: value.cost,
	};
}

// pi-herdr-agents extension
export interface RoutingRegistrySource {
	find(provider: string, modelId: string): any;
	getAvailable?: () => any[];
	getAll?: () => any[];
	hasConfiguredAuth?: (model: any) => boolean;
}

// pi-herdr-agents extension
export function createModelRegistryAdapter(
	registry: RoutingRegistrySource,
	capabilities: Pick<
		ModelRegistryAdapter,
		"supportedThinkingLevels" | "clampThinkingLevel"
	>,
): ModelRegistryAdapter {
	return {
		find(provider, modelId) {
			return toRoutingModel(registry.find(provider, modelId));
		},
		available() {
			const direct = registry.getAvailable?.() ?? [];
			const source = direct.length > 0 ? direct : (registry.getAll?.() ?? []);
			const models: RoutingModel[] = [];
			const seen = new Set<string>();
			for (const raw of source) {
				const candidate = toRoutingModel(raw);
				if (!candidate) continue;
				if (
					direct.length === 0 &&
					registry.hasConfiguredAuth &&
					!registry.hasConfiguredAuth(raw)
				) {
					continue;
				}
				const ref = `${candidate.provider}/${candidate.id}`;
				if (seen.has(ref)) continue;
				seen.add(ref);
				models.push(candidate);
			}
			return models;
		},
		hasConfiguredAuth(model) {
			if (!registry.hasConfiguredAuth) {
				return (registry.getAvailable?.() ?? []).some(
					(candidate) =>
						candidate.provider === model.provider && candidate.id === model.id,
				);
			}
			const original = registry.find(model.provider, model.id);
			return !!original && registry.hasConfiguredAuth(original);
		},
		supportedThinkingLevels: (model) =>
			capabilities.supportedThinkingLevels(model),
		clampThinkingLevel: (model, level) =>
			capabilities.clampThinkingLevel(model, level),
	};
}

// pi-herdr-agents extension
// Scoped sessions (--models / enabledModels) can use only their scoped model
// set, so every selection path resolves against it: wrapping the registry
// hides out-of-scope models from task shortlists, exact-ref validation, and
// "Available:" alternative lists, while capability helpers delegate unchanged.
export function scopeModelRegistryAdapter(
	registry: ModelRegistryAdapter,
	scopedRefs: ReadonlySet<string>,
): ModelRegistryAdapter {
	return {
		scope: [...scopedRefs],
		find(provider, modelId) {
			return scopedRefs.has(`${provider}/${modelId}`)
				? registry.find(provider, modelId)
				: undefined;
		},
		available() {
			return registry
				.available()
				.filter((model) => scopedRefs.has(`${model.provider}/${model.id}`));
		},
		hasConfiguredAuth: (model) => registry.hasConfiguredAuth(model),
		supportedThinkingLevels: (model) => registry.supportedThinkingLevels(model),
		clampThinkingLevel: (model, level) =>
			registry.clampThinkingLevel(model, level),
	};
}

// pi-herdr-agents extension
/** The session's model scope, or undefined when the session is unscoped. An
 * empty scope is still a scope: no model passes it. */
export function modelScopeOf(
	registry: Pick<ModelRegistryAdapter, "scope">,
): readonly string[] | undefined {
	return registry.scope;
}

// pi-herdr-agents extension
/**
 * A scoped parent's exact model allowlist, carried to its child as a JSON
 * array of `provider/model-id` refs. Pi reads `--models` as patterns (globs,
 * fuzzy ids, `:thinking` suffixes) and drops the scope entirely when nothing
 * resolves, so `--models` alone can widen a child's scope. The child's routing
 * intersects its own scope with this allowlist instead.
 */
export const MODEL_SCOPE_ENV = "PI_SUBAGENT_MODEL_SCOPE";

// pi-herdr-agents extension
/** The value a launch exports for {@link MODEL_SCOPE_ENV}; empty when unscoped. */
export function formatInheritedModelScope(
	scope: readonly string[] | undefined,
): string {
	return scope ? JSON.stringify(scope) : "";
}

// pi-herdr-agents extension
/**
 * Parse an inherited allowlist. Unset or empty means the parent was unscoped.
 * Anything else that is not a JSON array of strings fails closed: an empty
 * allowlist, under which no model is in scope.
 */
export function parseInheritedModelScope(
	raw: string | undefined,
): readonly string[] | undefined {
	if (raw === undefined || raw === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every(isString)) return parsed;
	} catch {
		// Malformed: fall through to the empty allowlist.
	}
	return [];
}

// pi-herdr-agents extension
/**
 * This session's effective scope: its own resolved scope, narrowed to the
 * allowlist it inherited. An inherited allowlist applies even when the
 * session's own `--models` resolved to nothing, so a child never becomes
 * unscoped because its catalog failed to match the parent's refs.
 */
export function sessionModelScope(
	ownScope: readonly string[],
	rawInherited: string | undefined,
): readonly string[] | undefined {
	const inherited = parseInheritedModelScope(rawInherited);
	if (!inherited) return ownScope.length > 0 ? ownScope : undefined;
	if (ownScope.length === 0) return inherited;
	const allowed = new Set(inherited);
	return ownScope.filter((ref) => allowed.has(ref));
}

function formatScope(scope: readonly string[]): string {
	return scope.length > 0 ? scope.join(", ") : "none";
}

// pi-herdr-agents extension
/** Refuse a model outside a scoped session's model set; unscoped sessions pass. */
export function assertModelInScope(
	model: string,
	registry: Pick<ModelRegistryAdapter, "scope">,
	what = "model",
	hint = "pick an in-scope exact provider/model-id",
): void {
	const scope = modelScopeOf(registry);
	if (!scope || scope.includes(model)) return;
	throw new RuntimeResolutionError(
		`${what} ${JSON.stringify(model)} is outside this session's model scope (--models / enabledModels: ${formatScope(scope)}); ${hint}`,
	);
}

function formatSupported(
	model: RoutingModel,
	registry: ModelRegistryAdapter,
): string {
	const levels = registry.supportedThinkingLevels(model);
	return levels.length > 0 ? levels.join(", ") : "(none)";
}

interface FieldSelection {
	value?: string;
	source: RuntimeSource;
}

function selectField(
	requestValue: string | undefined,
	agentValue: string | undefined,
): FieldSelection {
	if (requestValue != null && requestValue !== "") {
		return { value: requestValue, source: "request" };
	}
	if (agentValue != null && agentValue !== "") {
		return { value: agentValue, source: "agent" };
	}
	return { source: "parent" };
}

export function parseModelFallbacks(reference: string): string[] {
	const candidates = reference.split(",").map((candidate) => candidate.trim());
	if (candidates.some((candidate) => candidate === "")) {
		throw new RuntimeResolutionError(
			`model fallback list ${JSON.stringify(reference)} cannot contain an empty candidate`,
		);
	}
	return candidates;
}

export function resolveRuntimePlan(
	request: RuntimeRequest,
	agentDefaults: RuntimeRequest,
	parent: ParentRuntime,
	registry: ModelRegistryAdapter,
): ResolvedRuntimePlan {
	const modelSelection = selectField(request.model, agentDefaults.model);
	let provider = parent.provider;
	let modelId = parent.modelId;
	let selectedModel = registry.find(provider, modelId);

	const scope = modelScopeOf(registry);
	if (
		!modelSelection.value &&
		scope &&
		!scope.includes(`${provider}/${modelId}`)
	) {
		throw new RuntimeResolutionError(
			`the parent model ${JSON.stringify(`${provider}/${modelId}`)} is outside this session's model scope (--models / enabledModels: ${formatScope(scope)}), so a subagent cannot inherit it. Pass model with an in-scope exact provider/model-id or a task: category, set model in the role definition, or switch the parent to an in-scope model with /model`,
		);
	}

	if (modelSelection.value) {
		const parsed = parseExactModelRef(modelSelection.value);
		if (!parsed) {
			throw new RuntimeResolutionError(
				`model ${JSON.stringify(modelSelection.value)} must be an exact authenticated provider/model-id`,
			);
		}
		const found = registry.find(parsed.provider, parsed.modelId);
		if (!found) {
			const alternatives = registry
				.available()
				.map((model) => `${model.provider}/${model.id}`);
			throw new RuntimeResolutionError(
				`unknown model ${JSON.stringify(modelSelection.value)}; exact registry match required. Available: ${alternatives.join(", ") || "(none)"}`,
			);
		}
		if (!registry.hasConfiguredAuth(found)) {
			throw new RuntimeResolutionError(
				`model ${JSON.stringify(modelSelection.value)} has no configured authentication`,
			);
		}
		provider = found.provider;
		modelId = found.id;
		selectedModel = found;
	}

	const thinkingSelection = selectField(
		request.thinking,
		agentDefaults.thinking,
	);
	const preferredThinking = thinkingSelection.value ?? parent.thinking;
	if (!isThinkingLevel(preferredThinking)) {
		throw new RuntimeResolutionError(
			`thinking ${JSON.stringify(preferredThinking)} must be one of: ${THINKING_LEVELS.join(", ")}`,
		);
	}

	let thinking = preferredThinking;
	let thinkingAdjustment: ResolvedRuntimePlan["thinkingAdjustment"];
	if (thinkingSelection.source !== "parent") {
		if (!selectedModel) {
			throw new RuntimeResolutionError(
				`model capability information is unavailable; cannot validate explicit thinking ${JSON.stringify(preferredThinking)}`,
			);
		}
		const supported = registry.supportedThinkingLevels(selectedModel);
		if (!supported.includes(preferredThinking)) {
			throw new RuntimeResolutionError(
				`thinking ${JSON.stringify(preferredThinking)} is not supported by ${JSON.stringify(`${provider}/${modelId}`)}; supported: ${formatSupported(selectedModel, registry)}`,
			);
		}
	} else if (selectedModel) {
		thinking = registry.clampThinkingLevel(selectedModel, preferredThinking);
		if (thinking !== preferredThinking) {
			thinkingAdjustment = {
				from: preferredThinking,
				to: thinking,
				reason: selectedModel.reasoning ? "inherited-clamp" : "non-reasoning",
			};
		}
	}

	const plan: ResolvedRuntimePlan = {
		provider,
		modelId,
		model: `${provider}/${modelId}`,
		thinking,
		modelSource: modelSelection.source,
		thinkingSource: thinkingSelection.source,
	};
	if (modelSelection.value) plan.requestedModel = modelSelection.value;
	if (thinkingSelection.value) plan.requestedThinking = preferredThinking;
	if (thinkingAdjustment) plan.thinkingAdjustment = thinkingAdjustment;
	return plan;
}

/** Resolve every configured fallback before launching the first child. */
export function resolveRuntimePlans(
	request: RuntimeRequest,
	agentDefaults: RuntimeRequest,
	parent: ParentRuntime,
	registry: ModelRegistryAdapter,
	taskPreferences?: TaskPreferences,
	worktree = false,
): ResolvedRuntimePlan[] {
	const selection = selectField(request.model, agentDefaults.model);
	if (!selection.value)
		return [resolveRuntimePlan(request, agentDefaults, parent, registry)];

	let references: string[];
	const trimmed = selection.value.trim();
	if (
		selection.value
			.split(",")
			.some((candidate) =>
				candidate.trim().toLowerCase().startsWith("task:"),
			) &&
		trimmed.includes(",")
	) {
		throw new RuntimeResolutionError(
			"task: references must be the entire model value, not part of a fallback list",
		);
	}
	if (trimmed.toLowerCase().startsWith("task:")) {
		if (selection.source !== "request") {
			throw new RuntimeResolutionError(
				"task: references are only valid in the subagent tool's model parameter",
			);
		}
		const category = trimmed.slice("task:".length).trim().toLowerCase();
		const configuredCategories = Object.keys(taskPreferences ?? {});
		if (
			!category ||
			!taskPreferences ||
			!Object.hasOwn(taskPreferences, category)
		) {
			throw new RuntimeResolutionError(
				`task category ${JSON.stringify(category)} is not configured; configured categories: ${configuredCategories.join(", ") || "(none)"}`,
			);
		}
		// SAFETY: Object.hasOwn above confirms this lower-cased category is a configured key.
		const candidates = taskPreferences[category as keyof TaskPreferences] ?? [];
		references = candidates.filter((candidate) => {
			const parsed = parseExactModelRef(candidate);
			const model = parsed && registry.find(parsed.provider, parsed.modelId);
			return !!model && registry.hasConfiguredAuth(model);
		});
		if (references.length === 0) {
			const alternatives = registry
				.available()
				.filter((model) => registry.hasConfiguredAuth(model))
				.map((model) => `${model.provider}/${model.id}`);
			throw new RuntimeResolutionError(
				`task category ${JSON.stringify(category)} has no authenticated candidates; authenticated alternatives: ${alternatives.join(", ") || "(none)"}`,
			);
		}
		if (worktree) references = [references[0]];
	} else {
		references = parseModelFallbacks(selection.value);
	}

	return references.map((model) =>
		resolveRuntimePlan(
			selection.source === "request"
				? { ...request, model }
				: { ...request, model: undefined },
			selection.source === "agent"
				? { ...agentDefaults, model }
				: agentDefaults,
			parent,
			registry,
		),
	);
}

function formatTokenCount(value: number | undefined): string | undefined {
	if (!value || value <= 0) return undefined;
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

export function getAuthenticatedTaskPreferences(
	registry: ModelRegistryAdapter,
	taskPreferences?: TaskPreferences,
): TaskPreferences {
	const authenticated: TaskPreferences = {};
	for (const [category, candidates] of Object.entries(taskPreferences ?? {})) {
		const available = candidates.filter((candidate) => {
			const parsed = parseExactModelRef(candidate);
			const model = parsed && registry.find(parsed.provider, parsed.modelId);
			return !!model && registry.hasConfiguredAuth(model);
		});
		if (available.length > 0) {
			// SAFETY: parsed task preferences can only contain supported category keys.
			authenticated[category as keyof TaskPreferences] = available;
		}
	}
	return authenticated;
}

function modelCatalogLine(
	registry: ModelRegistryAdapter,
	model: RoutingModel,
): string {
	const supportedThinking = registry.supportedThinkingLevels(model);
	const facts = [
		model.reasoning
			? `reasoning (${supportedThinking.join("/") || "no thinking levels"})`
			: "non-reasoning",
		model.input?.includes("image") ? "text+image" : "text",
		formatTokenCount(model.contextWindow)
			? `${formatTokenCount(model.contextWindow)} context`
			: undefined,
		formatTokenCount(model.maxTokens)
			? `${formatTokenCount(model.maxTokens)} max output`
			: undefined,
	].filter(Boolean);
	return `- ${model.provider}/${model.id} — ${facts.join(", ")}`;
}

function finishModelCatalog(
	lines: string[],
	modelCount: number,
	registry: ModelRegistryAdapter,
	taskPreferences?: TaskPreferences,
): string {
	if (modelCount === 0)
		lines.push(
			"- none discovered; omitting model still inherits the parent runtime",
		);
	const configured = Object.entries(
		getAuthenticatedTaskPreferences(registry, taskPreferences),
	);
	if (configured.length > 0) {
		lines.push(
			"Task-category shortlists (use task:<category> only as the entire model value):",
		);
		for (const [category, candidates] of configured)
			lines.push(`- ${category}: ${candidates.join(", ")}`);
		lines.push(
			"For ordinary review, prefer a different authenticated model family. Use an exact authenticated provider/model-id from the shortlist when the authoring family is known. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification must not use this fallback. The extension does not enforce this.",
		);
	} else {
		lines.push(
			"For orchestrated children, explicitly select an exact authenticated provider/model-id by task tier first (fast for bounded mechanical work and recon, mid for implementation and review, frontier for architecture, security, hard diagnosis, or adversarial review), then set supported thinking.",
		);
		lines.push(
			"For ordinary review, prefer a different authenticated model family. Use an exact authenticated provider/model-id from the catalog when the authoring family is known. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification must not use this fallback.",
		);
	}
	lines.push(
		"Omitting model and thinking inherits the parent runtime as a discouraged fallback.",
	);
	return lines.join("\n");
}

export function buildAuthenticatedModelCatalog(
	registry: ModelRegistryAdapter,
	limit = 24,
	taskPreferences?: TaskPreferences,
): string {
	const models = registry
		.available()
		.filter((model) => registry.hasConfiguredAuth(model))
		.sort((a, b) =>
			`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
		);
	const visibleModels = models.slice(0, limit);
	const lines = [
		"Authenticated subagent models (use exact provider/model-id only):",
	];
	for (const model of visibleModels)
		lines.push(modelCatalogLine(registry, model));
	if (models.length > visibleModels.length) {
		lines.push(
			`- … ${models.length - visibleModels.length} more authenticated models omitted`,
		);
	}
	return finishModelCatalog(lines, models.length, registry, taskPreferences);
}

// Scoped catalogs replace the truncated authenticated snapshot with the
// session's scoped model set (--models / enabledModels): every listed pick is
// selectable in this session. Pass a registry wrapped by
// scopeModelRegistryAdapter so task-category shortlists also keep only scoped
// candidates. The limit mirrors the authenticated catalog's cap; anything
// beyond it falls behind an explicit omission tail.
export function buildScopedModelCatalog(
	registry: ModelRegistryAdapter,
	scopedModels: readonly RoutingModel[],
	taskPreferences?: TaskPreferences,
	limit = 24,
): string {
	const seen = new Set<string>();
	const models = scopedModels
		.filter((model) => {
			const ref = `${model.provider}/${model.id}`;
			if (seen.has(ref)) return false;
			seen.add(ref);
			return true;
		})
		.sort((a, b) =>
			`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
		);
	const lines = [
		"Authenticated subagent models (use exact provider/model-id only):",
	];
	const visibleModels = models.slice(0, limit);
	for (const model of visibleModels)
		lines.push(modelCatalogLine(registry, model));
	if (models.length > visibleModels.length) {
		lines.push(
			`- … ${models.length - visibleModels.length} more scoped models omitted`,
		);
	}
	return finishModelCatalog(lines, models.length, registry, taskPreferences);
}
