import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	startTaskModelInit,
	type TaskModelInitOutcome,
} from "../../maestro/runtime/index.ts";
import { parseExactModelRef } from "../../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "./model-registry.ts";
import {
	MISSING_CONFIG_REVISION,
	parseRankingBasis,
	readModelConfigSnapshot,
	writeTaskModelConfig,
} from "../../maestro/core/config/model-config.ts";
import {
	type OfferCallback,
	type TaskModelBrief,
	TASK_MODEL_INIT_APPROVAL_EVENT,
	TASK_MODEL_INIT_START_EVENT,
} from "../../maestro/core/config/task-model-init.ts";
import {
	TASK_CATEGORIES,
	TASK_CATEGORY_DESCRIPTIONS,
	type TaskPreferences,
	type TaskPreferencesMeta,
} from "../../maestro/core/config/task-model-types.ts";
import {
	getSubagentsConfigDir,
	getSubagentsConfigExamplePath,
	getSubagentsConfigPath,
} from "./config-path.ts";
import { isFunction, isString } from "../../maestro/core/config/type-guards.ts";

/**
 * Payload of TASK_MODEL_INIT_APPROVAL_EVENT. `context` is the live context of
 * the command that started init. It passes between trusted in-process
 * extensions and is current only while the request is emitted.
 */
interface TaskModelApprovalRequest {
	apiVersion: 1;
	brief: TaskModelBrief;
	context: ExtensionCommandContext;
	offer: OfferCallback;
}

function hasMethods(value: any, names: readonly string[]): boolean {
	return value != null && names.every((name) => isFunction(value[name]));
}

/**
 * Read a TASK_MODEL_INIT_START_EVENT v1 payload. A v1 request whose context or
 * preferences cannot run init still gets an offer, so its emitter reports why
 * instead of concluding that no host is loaded.
 */
function parseInitStartRequest(raw: any):
	| {
			offer: OfferCallback;
			input?: { context: ExtensionCommandContext; preferences: string };
	  }
	| undefined {
	if (raw?.apiVersion !== 1 || !isFunction(raw.offer)) return undefined;
	const { offer, context, preferences } = raw;
	const usable =
		isString(preferences) &&
		hasMethods(context, ["isIdle", "hasPendingMessages"]) &&
		hasMethods(context.modelRegistry, ["getAvailable"]);
	return {
		offer: (value) => offer.call(raw, value),
		// The members init reads were checked above; the rest is the emitting
		// command's own live context.
		input: usable ? { context, preferences } : undefined,
	};
}

/** The subagents_write_task_models tool (parent sessions only). */
export function registerTaskModelTool(
	pi: ExtensionAPI,
	{ shouldRegister }: { shouldRegister: (name: string) => boolean },
): void {
	if (
		!process.env.PI_SUBAGENT_ID &&
		shouldRegister("subagents_write_task_models")
	)
		pi.registerTool({
			name: "subagents_write_task_models",
			label: "Write task model preferences",
			description: `Validate and atomically replace models.tasks and models.tasksMeta in the durable Pi agent config, preserving unrelated settings. Supported categories: ${TASK_CATEGORIES.join(", ")}. Partial nonempty categories are accepted; omitted categories are removed. Rejects duplicate exact refs within a category. Review the active authenticated registry and existing preferences first. Optional expectedConfigRevision makes the write conditional: it fails without replacing configuration when the config file no longer matches the revision the proposal was read from. Optional basis records what the ranking rests on; its kind must equal tasksMeta.method, and it is returned but not saved. Cooperating writes are serialized and fail on contention rather than waiting. Returns normalized saved preferences, missing categories, the configRevision of the written file, and any basis; reload required.`,
			parameters: Type.Object({
				tasks: Type.Object(
					Object.fromEntries(
						TASK_CATEGORIES.map((category) => [
							category,
							Type.Optional(
								Type.Array(Type.String({ minLength: 1 }), {
									minItems: 1,
									description: TASK_CATEGORY_DESCRIPTIONS[category],
								}),
							),
						]),
					),
					{ additionalProperties: false, minProperties: 1 },
				),
				tasksMeta: Type.Object({
					generatedAt: Type.String(),
					method: Type.Union([
						Type.Literal("research"),
						Type.Literal("registry-only"),
					]),
				}),
				expectedConfigRevision: Type.Optional(
					Type.Union(
						[
							Type.Literal(MISSING_CONFIG_REVISION),
							Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
						],
						{
							description: `Revision of the config the proposal was read from: "sha256:" plus 64 lowercase hex digits of the exact file bytes, or "${MISSING_CONFIG_REVISION}" when the file is absent. A mismatch fails without writing; re-read, re-propose, and re-approve. Omit for an unconditional write.`,
						},
					),
				),
				basis: Type.Optional(
					Type.Union(
						[
							Type.Object(
								{ kind: Type.Literal("registry-only") },
								{ additionalProperties: false },
							),
							Type.Object(
								{
									kind: Type.Literal("research"),
									sources: Type.Array(
										Type.Object(
											{
												url: Type.String({ minLength: 1 }),
												influence: Type.String({ minLength: 1 }),
											},
											{ additionalProperties: false },
										),
										{ minItems: 1 },
									),
									uncertainty: Type.String({ minLength: 1 }),
								},
								{ additionalProperties: false },
							),
						],
						{
							description:
								'What the ranking rests on, as submitted by the proposer and not independently verified: {"kind":"registry-only"}, or {"kind":"research"} with the http(s) sources consulted in this run, how each informed the ranking, and the remaining uncertainty. kind must equal tasksMeta.method. Not saved. Omit for a legacy write.',
						},
					),
				),
			}),
			execute: async (_id, params, _signal, _update, ctx) => {
				const registry = wrapPiModelRegistry(ctx.modelRegistry);
				// SAFETY: TypeBox validates the tool payload; the write seam performs stricter schema validation.
				const tasks = params.tasks as TaskPreferences;
				// SAFETY: TypeBox validates the tool payload; the write seam performs stricter schema validation.
				const tasksMeta = params.tasksMeta as TaskPreferencesMeta;
				// Present-but-invalid values (including null) fail before anything is written.
				const basis = Object.hasOwn(params, "basis")
					? parseRankingBasis(params.basis, tasksMeta.method)
					: undefined;
				const saved = writeTaskModelConfig(
					getSubagentsConfigPath(),
					getSubagentsConfigExamplePath(),
					tasks,
					tasksMeta,
					(candidate) => {
						const parsed = parseExactModelRef(candidate);
						const model =
							parsed && registry.find(parsed.provider, parsed.modelId);
						return !!model && registry.hasConfiguredAuth(model);
					},
					// Present-but-invalid values (including null or "") reach the seam and fail closed.
					Object.hasOwn(params, "expectedConfigRevision")
						? { expectedConfigRevision: params.expectedConfigRevision }
						: {},
				);
				const details = basis ? { ...saved, basis } : saved;
				return {
					content: [
						{
							type: "text",
							text: `Wrote task model preferences. Reload required.\n${JSON.stringify(details, null, 2)}`,
						},
					],
					details,
				};
			},
		});
}

/** The /subagents-init command and its cross-extension start event. */
export function registerTaskModelInit(pi: ExtensionAPI): void {
	if (!process.env.PI_SUBAGENT_ID) {
		const runTaskModelInit = (
			ctx: ExtensionCommandContext,
			preferences: string,
		): TaskModelInitOutcome => {
			if (!ctx.isIdle() || ctx.hasPendingMessages())
				return {
					kind: "not-started",
					reason:
						"a turn is in progress or messages are queued. Nothing was queued; retry when idle",
				};
			// Pi refuses a prompt without a model only after submission; refuse first.
			if (!ctx.model)
				return {
					kind: "not-started",
					reason:
						"no model is selected, so Pi cannot run the init prompt. Select a model, then retry",
				};
			return startTaskModelInit({
				preferences,
				readConfig: () => readModelConfigSnapshot(getSubagentsConfigDir()),
				projectActiveRegistry: (project) => project(ctx.modelRegistry),
				emitApprovalRequest: (brief, offer) =>
					pi.events.emit(
						TASK_MODEL_INIT_APPROVAL_EVENT,
						Object.freeze({
							apiVersion: 1,
							brief,
							context: ctx,
							offer,
						} satisfies TaskModelApprovalRequest),
					),
				isToolActive: (name) => pi.getActiveTools().includes(name),
				submit: (prompt) => pi.sendUserMessage(prompt),
			});
		};
		pi.registerCommand("subagents-init", {
			description:
				"Draft task-category model preferences from the live registry; optional arguments set ranking preferences",
			handler: async (args, ctx) => {
				const outcome = runTaskModelInit(ctx, args);
				if (outcome.kind === "not-started")
					ctx.ui.notify(
						`Task-model init not started: ${outcome.reason}. Nothing was written.`,
						"warning",
					);
			},
		});
		// Another extension's command may start the same init; it renders the outcome.
		const stopInitStart = pi.events.on(TASK_MODEL_INIT_START_EVENT, (raw) => {
			const request = parseInitStartRequest(raw);
			if (!request) return;
			const { input } = request;
			request.offer({
				owner: "pi-herdr-agents",
				start: (): TaskModelInitOutcome =>
					input
						? runTaskModelInit(input.context, input.preferences)
						: {
								kind: "not-started",
								reason:
									"the start request lacks a usable command context or preferences text",
							},
			});
		});
		pi.on("session_shutdown", () => stopInitStart());
	}
}
