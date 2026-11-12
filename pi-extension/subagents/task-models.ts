import {
	encodeHostValue,
	HOST_ERROR_CHARS,
} from "../../maestro/core/host-text.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	startTaskModelInit,
	type TaskModelInitOutcome,
} from "../../maestro/runtime/index.ts";
import {
	THINKING_LEVELS,
	parseExactModelRef,
} from "../../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "./model-registry.ts";
import {
	MISSING_CONFIG_REVISION,
	prepareTaskModelWrite,
	describeTaskModelWriteFailure,
	type PreparedTaskModelWrite,
	validateTaskModelProposal,
	parseRankingBasis,
	readModelConfigSnapshot,
	writeTaskModelConfig,
	type WriteTaskModelConfigOptions,
} from "../../maestro/core/config/model-config.ts";
import {
	DIRECT_WRITER_TOOL,
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
	type TaskThinkingPreferences,
	type RankingBasis,
} from "../../maestro/core/config/task-model-types.ts";
import {
	getSubagentsConfigDir,
	getSubagentsConfigExamplePath,
	getSubagentsConfigPath,
} from "./config-path.ts";
import { readGlobalSlot, writeGlobalSlot } from "./state.ts";
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

// Keep this init-only schema out of normal requests. A successful write
// always deactivates it, including after reload or explicit user activation.
function releaseWriterAfterInit(pi: ExtensionAPI): void {
	pi.setActiveTools(
		pi.getActiveTools().filter((name) => name !== DIRECT_WRITER_TOOL),
	);
}

// Unlike delivery summaries, approval values must never be abbreviated. JSON
// escaping keeps controls and table separators visible without changing the data.
type TaskApprovalValue =
	| string
	| string[]
	| TaskPreferencesMeta
	| RankingBasis
	| undefined;
function approvalJson(value: TaskApprovalValue): string {
	return JSON.stringify(value ?? null).replace(
		/[|\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu,
		(char) =>
			char
				.split("")
				.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
				.join(""),
	);
}

const TASK_MODEL_APPROVAL_SLOT = Symbol.for(
	"pi-herdr-agents/task-model-approval-open",
);
const DECLINE_TASK_MODELS = "No, keep current";
const SAVE_TASK_MODELS = "Yes, save";

function taskModelApprovalMessage(prepared: PreparedTaskModelWrite): string {
	const { before, after } = prepared;
	const changes: string[] = [];
	for (const category of TASK_CATEGORIES) {
		const previous = `${approvalJson(before.tasks?.[category])} / ${approvalJson(before.tasksThinking?.[category])}`;
		const next = `${approvalJson(after.tasks?.[category])} / ${approvalJson(after.tasksThinking?.[category])}`;
		if (previous !== next) changes.push(`${category}: ${previous} -> ${next}`);
	}
	const lines = [`Save to ${approvalJson(prepared.configPath)}`];
	if (prepared.realConfigPath !== prepared.configPath)
		lines.push(`Real path: ${approvalJson(prepared.realConfigPath)}`);
	if (prepared.newFile)
		lines.push(
			`Create new file; top-level keys: ${prepared.topLevelKeys.join(", ")}. Other settings: {"status":{"enabled":true}}.`,
		);
	lines.push(
		"Models / thinking (null = unset):",
		...changes,
		`${TASK_CATEGORIES.length - changes.length} categories unchanged.`,
	);
	if (JSON.stringify(before.tasksMeta) !== JSON.stringify(after.tasksMeta))
		lines.push(
			`Metadata: ${approvalJson(before.tasksMeta)} -> ${approvalJson(after.tasksMeta)}`,
		);
	return lines.join("\n");
}

/** The subagents_write_task_models tool (parent sessions only). */
export function registerTaskModelTool(
	pi: ExtensionAPI,
	{ shouldRegister }: { shouldRegister: (name: string) => boolean },
): void {
	if (!process.env.PI_SUBAGENT_ID && shouldRegister(DIRECT_WRITER_TOOL))
		pi.registerTool({
			name: DIRECT_WRITER_TOOL,
			label: "Write task model preferences",
			defaultActive: false,
			description: `Validate task preferences, show exact before/after for user approval, then atomically replace models.tasks, models.tasksThinking and models.tasksMeta in the durable Pi agent config, preserving unrelated settings. Every call shows exact before/after for changed categories and requires user approval through a refusal-first selector (60-second timeout), even when another extension already approved it. No-UI, print/JSON and child sessions are refused without writing. Supported categories: ${TASK_CATEGORIES.join(", ")}. Partial nonempty categories are accepted; omitted categories are removed. Rejects duplicate exact refs within a category. Review the active authenticated registry and existing preferences first. Optional expectedConfigRevision also binds the proposal's starting revision: it fails without replacing configuration when the config file no longer matches the revision the proposal was read from. Optional basis records what the ranking rests on; its kind must equal tasksMeta.method, and it is returned but not saved. Concurrent approvals refuse immediately rather than stack. The full replacement bytes and real directory are prepared before approval and rechecked before rename. New files disclose their minimal status/models seed. Cooperating writes use an advisory lock, not a filesystem authorization boundary. Returns normalized saved preferences, missing categories, the configRevision of the written file, and any basis; reload required.`,
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
				tasksThinking: Type.Optional(
					Type.Union([
						Type.Object(
							Object.fromEntries(
								TASK_CATEGORIES.map((category) => [
									category,
									Type.Optional(
										Type.Union(
											THINKING_LEVELS.map((level) => Type.Literal(level)),
										),
									),
								]),
							),
							{
								additionalProperties: false,
								description:
									"Category thinking, clamped per fallback candidate. Replaces the map when supplied ({} clears and removes it); omitted or null preserves thinking for retained categories. Entries require a submitted task category.",
							},
						),
						Type.Null(),
					]),
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
							description: `Revision of the config the proposal was read from: "sha256:" plus 64 lowercase hex digits of the exact file bytes, or "${MISSING_CONFIG_REVISION}" when the file is absent. A mismatch fails without writing; re-read, re-propose, and re-approve. Omit to propose against the current config; user approval still binds the exact snapshot shown.`,
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
			execute: async (_id, params, signal, _update, ctx) => {
				if (process.env.PI_SUBAGENT_ID)
					throw new Error(
						"Task model preferences not written: child sessions cannot approve task-model writes. Use a parent session with a user-facing UI.",
					);
				if (!ctx.hasUI || ctx.mode === "print" || ctx.mode === "json")
					throw new Error(
						"Task model preferences not written: user approval requires a dialog-capable UI; no-UI, print and JSON sessions cannot write.",
					);
				if (signal?.aborted)
					throw new Error(
						"Task model preferences not written: approval cancelled.",
					);
				if (readGlobalSlot<boolean>(TASK_MODEL_APPROVAL_SLOT))
					throw new Error(
						"Task model preferences not written: another approval is already open. Retry after it finishes.",
					);
				writeGlobalSlot(TASK_MODEL_APPROVAL_SLOT, true);
				try {
					const registry = wrapPiModelRegistry(ctx.modelRegistry);
					// SAFETY: TypeBox validates the tool payload; the write seam performs stricter schema validation.
					const tasks = params.tasks as TaskPreferences;
					// SAFETY: TypeBox validates the tool payload; the write seam performs stricter schema validation.
					const tasksMeta = params.tasksMeta as TaskPreferencesMeta;
					// Present-but-invalid values (including null) fail before anything is written.
					const basis = Object.hasOwn(params, "basis")
						? parseRankingBasis(params.basis, tasksMeta.method)
						: undefined;
					const options: WriteTaskModelConfigOptions = {
						// SAFETY: the write seam validates the map's category keys and levels.
						tasksThinking: params.tasksThinking as
							| TaskThinkingPreferences
							| undefined,
					};
					if (Object.hasOwn(params, "expectedConfigRevision"))
						options.expectedConfigRevision = params.expectedConfigRevision;
					const configPath = getSubagentsConfigPath();
					const examplePath = getSubagentsConfigExamplePath();
					const isAuthenticatedCandidate = (candidate: string) => {
						const parsed = parseExactModelRef(candidate);
						const model =
							parsed && registry.find(parsed.provider, parsed.modelId);
						return !!model && registry.hasConfiguredAuth(model);
					};
					const proposal = validateTaskModelProposal(
						configPath,
						tasks,
						tasksMeta,
						isAuthenticatedCandidate,
						options,
					);
					const prepared = prepareTaskModelWrite(
						configPath,
						proposal,
						options.expectedConfigRevision,
					);
					const message = taskModelApprovalMessage(prepared);
					const approved = await ctx.ui.select(
						`Approve task model preferences\n${message}${basis ? `\nRanking basis: ${basis.kind} (submitted, unverified; not saved).` : ""}`,
						[DECLINE_TASK_MODELS, SAVE_TASK_MODELS],
						{ timeout: 60_000, signal },
					);
					if (approved !== SAVE_TASK_MODELS || signal?.aborted)
						throw new Error(
							"Task model preferences not written: approval declined, cancelled or timed out. Obtain fresh approval before retrying.",
						);
					let saved;
					try {
						saved = writeTaskModelConfig(
							configPath,
							examplePath,
							prepared.after.tasks ?? {},
							prepared.after.tasksMeta ?? tasksMeta,
							isAuthenticatedCandidate,
							{
								tasksThinking: prepared.after.tasksThinking ?? {},
								expectedConfigRevision: prepared.configRevision,
								approvedWrite: prepared,
							},
						);
					} catch (error) {
						throw new Error(
							`${error instanceof Error ? error.message : String(error)} ${describeTaskModelWriteFailure(prepared)}`,
							{ cause: error },
						);
					}
					releaseWriterAfterInit(pi);
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
				} finally {
					writeGlobalSlot(TASK_MODEL_APPROVAL_SLOT, false);
				}
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
			if (!ctx.hasUI || ctx.mode === "print" || ctx.mode === "json")
				return {
					kind: "not-started",
					reason: "task-model init requires a dialog-capable UI for approval",
				};
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
			let activatedWriter = false;
			const outcome = startTaskModelInit({
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
				activateTool: (name) => {
					if (name !== DIRECT_WRITER_TOOL) return;
					const active = pi.getActiveTools();
					if (active.includes(name)) return;
					pi.setActiveTools([...active, name]);
					activatedWriter = pi.getActiveTools().includes(name);
				},
				isToolActive: (name) => pi.getActiveTools().includes(name),
				submit: (prompt) => pi.sendUserMessage(prompt),
			});
			if (outcome.kind === "not-started" && activatedWriter)
				releaseWriterAfterInit(pi);
			return outcome;
		};
		pi.registerCommand("subagents-init", {
			description:
				"Draft task-category model preferences from the live registry; optional arguments set ranking preferences",
			handler: async (args, ctx) => {
				const outcome = runTaskModelInit(ctx, args);
				if (outcome.kind === "not-started")
					ctx.ui.notify(
						`Task-model init not started: ${encodeHostValue(outcome.reason, HOST_ERROR_CHARS)}. Nothing was written.`,
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
