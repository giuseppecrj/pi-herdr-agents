import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
	Box,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { RunCancellation, Task } from "../../maestro/core/types.ts";
import {
	createDefaultRunSession,
	startTaskModelInit,
	observePiActivity,
	type TaskModelInitOutcome,
	type PiRunSession,
	type PiRunSessionInfrastructure,
	type PiRunRecord,
	type PiLaunchSnapshot,
	type PiLaunchInput,
	type PiAttemptSnapshot,
	type PiCompletedMetadata,
	type PiPersistentIO,
	type PiSettlementIO,
	type PiPersistentEvent,
	type PiLedgerEntry,
	type PiProgressEvidence,
	type CancelReport,
} from "../../maestro/runtime/index.ts";
import { loadSupervisionConfig } from "../../maestro/core/config/supervision-config.ts";
import { loadSidebarConfig } from "../../maestro/core/config/sidebar-config.ts";
import {
	discoverAgentCatalog as discoverCoreAgentCatalog,
	ROLE_PACK_DISCOVERY_EVENT,
	type AgentCatalog,
	type AgentDefaults,
	type AgentDiagnostic,
	type ListedAgentDefinition,
	type SubagentSessionMode,
} from "../../maestro/core/roles/discovery.ts";
import {
	buildAuthenticatedModelCatalog,
	getAuthenticatedTaskPreferences,
	parseExactModelRef,
	resolveRuntimePlan,
	resolveRuntimePlans,
	THINKING_LEVELS,
	isThinkingLevel,
	type ResolvedRuntimePlan,
	type ThinkingLevel,
} from "../../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "./model-registry.ts";
import {
	loadModelConfig,
	MISSING_CONFIG_REVISION,
	parseRankingBasis,
	readModelConfigSnapshot,
	resolveModelDefault,
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
	getAgentConfigDir,
	getSubagentsConfigDir,
	getSubagentsConfigExamplePath,
	getSubagentsConfigPath,
} from "./config-path.ts";
import { loadRoleConfig } from "../../maestro/core/config/role-config.ts";
import {
	loadPersistentConfig,
	type PersistentConfig,
} from "../../maestro/core/config/persistent-config.ts";
import { loadPaneConfig } from "../../maestro/core/config/pane-config.ts";
type NoProgressClassification = PiProgressEvidence["classification"];
type NoProgressSessionTail = Pick<
	PiProgressEvidence,
	"classification" | "lastEntryKind"
>;
import {
	type SubagentStatusState,
	capStatusLines,
	formatElapsedDuration,
	formatStatusAggregate,
	normalizeStatusName,
	loadStatusConfig,
} from "../../maestro/core/status.ts";
import { isSubagentActivityScope } from "../../maestro/core/activity.ts";
import type { SubagentActivityState } from "../../maestro/core/types.ts";
import {
	isFiniteNumber,
	isFunction,
	isPlainObject,
	isString,
} from "../../maestro/core/config/type-guards.ts";
import {
	createLifecycle,
	formatLifecycleTransitionLine,
	lifecycleTransition,
	markDelivery,
	markInterruptRequested,
	markProcessRunning,
	observeActivity,
	observePaneInspection,
	projectLifecycle,
	type LifecycleProjection,
	type SubagentLifecycle,
} from "../../maestro/core/lifecycle.ts";
import {
	listContainedWorktrees,
	removeContainedWorktree,
	formatWorktreeInventory,
	type WorktreeCleanupOperations,
} from "../../maestro/core/worktree-cleanup.ts";
import type {
	WorktreeHandoff,
	WorktreeLaunch,
} from "../../maestro/core/worktree.ts";

// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");

function readGlobalSlot<T>(key: symbol): T | undefined {
	// SAFETY: `globalThis` has no index signature for our extension-private
	// symbol keys; only this module ever writes the values read back here.
	return (globalThis as Record<symbol, T | undefined>)[key];
}

function writeGlobalSlot<T>(key: symbol, value: T): void {
	// SAFETY: see readGlobalSlot above; this module is the sole writer.
	(globalThis as Record<symbol, T | undefined>)[key] = value;
}

function getFirstText(
	content: readonly { type: string; text?: string }[],
): string {
	const first = content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

{
	const prevInterval =
		readGlobalSlot<ReturnType<typeof setInterval>>(WIDGET_INTERVAL_KEY);
	if (prevInterval) {
		clearInterval(prevInterval);
		writeGlobalSlot<ReturnType<typeof setInterval> | null>(
			WIDGET_INTERVAL_KEY,
			null,
		);
	}
	const prevStatusInterval =
		readGlobalSlot<ReturnType<typeof setInterval>>(STATUS_INTERVAL_KEY);
	if (prevStatusInterval) {
		clearInterval(prevStatusInterval);
		writeGlobalSlot<ReturnType<typeof setInterval> | null>(
			STATUS_INTERVAL_KEY,
			null,
		);
	}
}

function buildSubagentRoutingGuidelines(
	catalog?: string,
	authenticatedTaskPreferences?: TaskPreferences,
): string[] {
	return [
		"Act as the coordinator: decompose the work, give each child one bounded outcome — goal, allowed files, verification, and whether to commit — and keep dependent writes sequential; parallelize only independent tasks.",
		"Children are leaves by default: they do not push, merge, deploy, or orchestrate further agents unless their task explicitly authorizes it. The parent inspects each result or worktree handoff (diff against the reported base, run relevant tests) and owns integration, verification, and cleanup.",
		...(Object.keys(authenticatedTaskPreferences ?? {}).length > 0
			? [
					"For non-review work, prefer the configured task-category shortlists below and use task:<category> only as the entire model value. Use exact IDs for reviews when the authoring family is known.",
				]
			: [
					"For orchestrated subagent work, explicitly set both model and thinking for every child: first choose a fast, mid, or frontier provider-family tier matched to task complexity, then set thinking within that model's supported range.",
					"Use fast tier for bounded mechanical work and recon, mid tier for ordinary implementation or review, and frontier tier for architecture, security, hard diagnosis, or adversarial review. Use minimal/low thinking for mechanical work, medium for ordinary work, and high+ for hard work.",
				]),
		"For ordinary review, prefer a different authenticated model family. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification must not use this fallback. Use an exact authenticated provider/model-id from the live catalog below, never an alias or fuzzy name.",
		"Omitting model and thinking still inherits the parent runtime, but this is a discouraged fallback for orchestrated children.",
		"Before launching a new group of subagents, choose a short task slug and name each new child <task>-<role>[-n], for example login-api or login-test2. Use only plan, research, ui, api, build, test, review, browser, security, perf, or merge as roles; leave existing names unchanged. After the final launch, print name | agent kind | role | model | worktree (if any), then use each name in prompts, handoffs, and results.",
		catalog ??
			"Authenticated subagent model catalog becomes available after session start.",
	];
}

const subagentRoutingGuidelines = buildSubagentRoutingGuidelines();

const ThinkingLevelSchema = Type.Union(
	THINKING_LEVELS.map((level) => Type.Literal(level)),
	{
		description:
			"Pi thinking level. Pick the model tier first, then set thinking within that model's range: minimal/low for bounded mechanical work, medium for ordinary implementation or review, high+ for architecture, security, or hard diagnosis. Omitting still inherits the parent level; do not omit on orchestrated child work.",
	},
);

const SubagentParams = Type.Object({
	name: Type.String({
		description:
			"Short stable label for the subagent; for a new coordinated group use <task>-<role>[-n] (shown in the widget and pane title)",
	}),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	agent: Type.Optional(
		Type.String({
			description:
				"Role definition name to load defaults from. Discovery precedence is project .pi/agents, global ~/.pi/agent/agents, then installed role packs; this extension ships no roles. A missing name fails before launch. Omit for a bare agent.",
		}),
	),
	systemPrompt: Type.Optional(
		Type.String({
			description:
				"Role/system-prompt text for a bare spawn. Named agents keep their definition body.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Explicitly pick an exact authenticated provider/model-id, an ordered comma-separated fallback list, or task:<category> as the entire value. task: categories are case-insensitive and expand configured authenticated candidates; worktrees use only the first. For ordinary review, prefer a different authenticated model family. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification must not use this fallback. Omitting still inherits the parent model; do not omit for orchestrated children. Fallback lists cannot be used with worktrees.",
		}),
	),
	thinking: Type.Optional(ThinkingLevelSchema),
	skills: Type.Optional(
		Type.String({
			description: "Comma-separated skills (overrides agent default)",
		}),
	),
	tools: Type.Optional(
		Type.String({
			description: "Comma-separated tools (overrides agent default)",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the sub-agent. Without worktree, the agent starts in this folder. With worktree, this selects the source Git repository and the agent starts at the created worktree root.",
		}),
	),
	worktree: Type.Optional(
		Type.Union(
			[
				Type.Object({
					branch: Type.String({
						minLength: 1,
						description:
							"New branch name for an isolated Herdr-managed Git worktree",
					}),
					base: Type.Optional(
						Type.String({
							description:
								"Git revision to branch from. Defaults to the source checkout's committed HEAD.",
						}),
					),
				}),
				Type.Null(),
			],
			{
				description:
					"Optional isolated Herdr-managed Git worktree. Omit or pass null to use an ordinary pane in cwd.",
			},
		),
	),
	fork: Type.Optional(
		Type.Boolean({
			description:
				"Override the child session mode for this spawn. `true` forces full-context fork; `false` forces standalone. Omit to inherit the agent frontmatter session-mode.",
		}),
	),
	persistent: Type.Optional(
		Type.Boolean({
			description:
				"Keep this stable specialist session alive between turn-based tasks. Persistent agents accept follow-up work only through subagent_send.",
		}),
	),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
		}),
	),
});

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
	"subagent",
	"subagent_interrupt",
	"subagent_cancel",
	"subagents_list",
	"subagent_resume",
	"subagent_send",
	"subagent_stop",
	"subagents_write_task_models",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
	const denied = new Set<string>();
	if (!agentDefs) return denied;

	// spawning: false → deny all spawning tools
	if (agentDefs.spawning === false) {
		for (const t of SPAWNING_TOOLS) denied.add(t);
	}

	// deny-tools: explicit list
	if (agentDefs.denyTools) {
		for (const t of agentDefs.denyTools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			denied.add(t);
		}
	}

	return denied;
}

function discoverAgentCatalog(pi?: Pick<ExtensionAPI, "events">): AgentCatalog {
	return discoverCoreAgentCatalog({
		agentConfigDir: getAgentConfigDir(),
		cwd: process.cwd(),
		onRolePackDiscovered: pi?.events
			? (event) => pi.events.emit(ROLE_PACK_DISCOVERY_EVENT, event)
			: undefined,
	});
}

function discoverAgentDefinitions(
	pi?: Pick<ExtensionAPI, "events">,
): ListedAgentDefinition[] {
	return discoverAgentCatalog(pi).agents;
}

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

function missingRoleMessage(agentName: string): string {
	return `Agent "${agentName}" was not found. pi-herdr-agents ships no roles: define it in .pi/agents or the global agents directory, install a role pack that provides it, or omit agent for a bare launch.`;
}

function formatAgentSource(agent: ListedAgentDefinition): string {
	return agent.source === "package" && agent.provider
		? `package:${agent.provider}`
		: agent.source;
}

function formatVisibleAgentDefinitions(
	agents: ListedAgentDefinition[],
): string[] {
	return agents
		.filter((agent) => !agent.disableModelInvocation)
		.map((agent) => {
			const badge = ` (${formatAgentSource(agent)})`;
			const desc = agent.description ? ` — ${agent.description}` : "";
			const model = agent.model ? ` [${agent.model}]` : "";
			return `• ${agent.name}${badge}${model}${desc}`;
		});
}

function formatLivePersistentSpecialists(): string[] {
	const specialists = Array.from(runningSubagents.values()).filter(
		(running) => running.persistent,
	);
	if (specialists.length === 0) return [];
	return [
		"Live persistent specialists:",
		...specialists.map((running) => {
			const allowlist = running.policyTools?.join(",") ?? "unrestricted";
			return `• ${running.name} | ${running.logicalId} | ${running.generationId} | ${running.agent ?? "bare"} | ${persistentSpecialistState(running)} | ${running.tasksCompleted ?? 0} completed | tools: ${allowlist}; denied: ${running.policyDeniedTools?.join(",") || "none"}; persistent: true`;
		}),
	];
}

function formatSupervisionDiagnostics(): string[] {
	const diagnostics = runtime.session?.diagnostics() ?? {
		mode: supervisionConfig.forcePolling ? "polling(forced)" : "wake+batch",
		watcherCount: 0,
	};
	return [
		`Supervision: ${diagnostics.mode}; ${diagnostics.watcherCount} watcher${diagnostics.watcherCount === 1 ? "" : "s"}`,
	];
}

function formatAgentDiagnostics(diagnostics: AgentDiagnostic[]): string[] {
	return diagnostics.map((diagnostic) => `! ${diagnostic.message}`);
}

function resolveEffectiveSessionMode(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	if (params.fork === true) return "fork";
	if (params.fork === false) return "standalone";
	return agentDefs?.sessionMode ?? "standalone";
}

interface LaunchBehavior {
	sessionMode: SubagentSessionMode;
	seededSessionMode: "lineage-only" | "fork" | null;
	inheritsConversationContext: boolean;
	taskDelivery: "direct" | "artifact";
}

function resolveLaunchBehavior(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): LaunchBehavior {
	const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
	const inheritsConversationContext = sessionMode === "fork";
	return {
		sessionMode,
		seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
		inheritsConversationContext,
		taskDelivery: inheritsConversationContext ? "direct" : "artifact",
	};
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous and the parent session should be woken on stall/recovery
 *      transitions. Agents that don't auto-exit are driven by the user in
 *      their own pane, and stall pings are noise.
 *
 * Bare `subagent({ name, task })` calls have no agent defs; they auto-exit
 * unless the caller passes `interactive: true`.
 */
function resolveEffectivePersistent(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	return params.persistent ?? agentDefs?.persistent ?? false;
}

function resolveEffectiveAutoExit(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	if (resolveEffectivePersistent(params, agentDefs)) return false;
	// Named agents preserve their declared behavior. Bare tool calls are
	// autonomous by default, including full-context forks: `fork` controls
	// context inheritance, not whether the child should remain open. Interactive
	// bare launches opt out explicitly with `interactive: true`.
	if (agentDefs) return agentDefs.autoExit ?? false;
	return params.interactive !== true;
}

function resolveEffectiveInteractive(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	if (params.interactive != null) return params.interactive;
	if (resolveEffectivePersistent(params, agentDefs)) return false;
	if (agentDefs?.interactive != null) return agentDefs.interactive;
	return !resolveEffectiveAutoExit(params, agentDefs);
}

function loadAgentDefaults(
	agentName: string,
	pi?: Pick<ExtensionAPI, "events">,
): ListedAgentDefinition | null {
	return (
		discoverAgentCatalog(pi).agents.find((agent) => agent.name === agentName) ??
		null
	);
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}

function muxUnavailableResult() {
	return {
		content: [
			{
				type: "text" as const,
				text: `Subagents require herdr. ${runtime.session!.availability().setupHint}`,
			},
		],
		details: { error: "herdr not available" },
	};
}

function shouldRetainSubagentSurface(
	running: Pick<RunningSubagent, "worktree"> | { worktree?: unknown },
): boolean {
	return !!running.worktree;
}

const statusConfig = loadStatusConfig(
	getSubagentsConfigPath(),
	getSubagentsConfigExamplePath(),
);
const modelConfig = loadModelConfig(getSubagentsConfigDir());
const roleConfig = loadRoleConfig(
	getSubagentsConfigDir(),
	getSubagentsConfigExamplePath(),
);
const persistentConfig = loadPersistentConfig(
	getSubagentsConfigDir(),
	getSubagentsConfigExamplePath(),
);
const supervisionConfig = loadSupervisionConfig(
	getSubagentsConfigDir(),
	getSubagentsConfigExamplePath(),
);
const sidebarConfig = loadSidebarConfig(
	getSubagentsConfigDir(),
	getSubagentsConfigExamplePath(),
);

const MAX_RESULT_PRESENTATION_CHARS = 16_000;
const MAX_SESSION_REFERENCE_CHARS = 10_000;
const RESULT_CONTINUATION_PROMPT =
	"Parent action: Continue the parent task using this result; do not return an empty response.";

function abbreviateMiddle(
	value: string,
	maxChars: number,
	marker: string,
): string {
	if (value.length <= maxChars) return value;

	const retainedChars = maxChars - marker.length;
	const headChars = Math.ceil(retainedChars / 2);
	const tailChars = Math.floor(retainedChars / 2);
	return (
		value.slice(0, headChars) +
		marker +
		(tailChars ? value.slice(-tailChars) : "")
	);
}

function boundResultPresentation(body: string, sessionRef: string): string {
	const boundedSessionRef = abbreviateMiddle(
		sessionRef,
		MAX_SESSION_REFERENCE_CHARS,
		"\n[... session reference abbreviated ...]\n",
	);
	if (body.length + boundedSessionRef.length <= MAX_RESULT_PRESENTATION_CHARS) {
		return body + boundedSessionRef;
	}

	const marker = boundedSessionRef
		? "\n\n[... result abbreviated; full output remains in the child session below ...]\n\n"
		: "\n\n[... result abbreviated ...]\n\n";
	const retainedChars =
		MAX_RESULT_PRESENTATION_CHARS - marker.length - boundedSessionRef.length;
	return (
		abbreviateMiddle(body, retainedChars + marker.length, marker) +
		boundedSessionRef
	);
}

function formatSessionReference(sessionFile?: string): string {
	return sessionFile
		? `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}`
		: "";
}

function resolveUnexpectedErrorPresentation(
	prefix: string,
	error: any,
	sessionFile?: string,
): string {
	const message = error instanceof Error ? error.message : String(error);
	return boundResultPresentation(
		`${prefix}: ${message}`,
		formatSessionReference(sessionFile),
	);
}

interface ModelFailure {
	model: string;
	error: string;
}

interface SubagentResultDetails {
	name: string;
	task?: string;
	agent?: string;
	exitCode?: number;
	elapsed?: number;
	sessionFile?: string;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
	error?: string;
	errorMessage?: string;
	fallbackAttempts?: string[];
	fallbackFailures?: ModelFailure[];
	worktree?: WorktreeHandoff;
	runtimePlan?: ResolvedRuntimePlan;
	cancellation?: RunCancellation;
}

interface SubagentPingDetails {
	name: string;
	message: string;
	agent?: string;
	sessionFile: string;
	worktree?: WorktreeHandoff;
}

interface PartialWorktreeArgs {
	branch?: unknown;
}

interface PartialSubagentArgs {
	name?: unknown;
	task?: unknown;
	agent?: unknown;
	cwd?: unknown;
	worktree?: PartialWorktreeArgs | null;
}

function sendSubagentResult(
	api: Pick<ExtensionAPI, "sendMessage">,
	content: string,
	details: SubagentResultDetails,
): void {
	const resultContent = boundResultPresentation(content, "");
	const promptContent = boundResultPresentation(
		`${resultContent}\n\n${RESULT_CONTINUATION_PROMPT}`,
		"",
	);
	api.sendMessage(
		{
			customType: "subagent_result",
			content: promptContent,
			display: true,
			details: { ...details, resultContent },
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function formatWorktreeHandoff(worktree: WorktreeHandoff): string {
	const state = worktree.gitError
		? "inspection unknown"
		: worktree.conflicted
			? "conflicted"
			: worktree.clean
				? "clean"
				: "dirty";
	const ahead =
		worktree.commitsAhead == null
			? "commits ahead unknown"
			: `${worktree.commitsAhead} commit${worktree.commitsAhead === 1 ? "" : "s"} ahead`;
	const lines = [
		"Worktree result retained for review:",
		`Worktree: ${worktree.path}`,
		`Workspace: ${worktree.workspaceId}`,
		`Branch: ${worktree.branch}`,
		`Base/head: ${worktree.baseSha} -> ${worktree.headSha ?? "unknown"}`,
		`State: ${state} · ${ahead}`,
	];
	if (worktree.changedFiles?.length)
		lines.push(`Changed: ${worktree.changedFiles.join(", ")}`);
	if (worktree.untrackedFiles?.length)
		lines.push(`Untracked: ${worktree.untrackedFiles.join(", ")}`);
	if (worktree.gitError)
		lines.push(`Git inspection warning: ${worktree.gitError}`);
	lines.push(
		"After review and preservation, explicitly remove (branch retained):",
		`  /worktree remove ${worktree.workspaceId}`,
		`  worktree_remove({ target: ${JSON.stringify(worktree.path)} })`,
		"Operator override after independent safety checks:",
		`  herdr worktree remove --workspace ${worktree.workspaceId}`,
	);
	return lines.join("\n");
}

function launchDiagnosticsText(
	diagnostics: readonly string[] | undefined,
	prefix: string,
	suffix: string,
): string {
	return diagnostics?.length
		? `${prefix}Launch diagnostics: ${diagnostics.join("; ")}.${suffix}`
		: "";
}

function resolveResultPresentation(
	result: Pick<
		SubagentResult,
		| "exitCode"
		| "elapsed"
		| "summary"
		| "sessionFile"
		| "errorMessage"
		| "fallbackAttempts"
		| "fallbackFailures"
		| "runtimePlan"
		| "worktree"
	>,
	name: string,
	runtimeMismatch?: string,
): string {
	const sessionRef = formatSessionReference(result.sessionFile);
	let body: string;
	const attempted = result.fallbackAttempts ?? [];
	const requestedModel =
		attempted[0] ??
		result.runtimePlan?.requestedModel ??
		result.runtimePlan?.model;
	const usedModel =
		result.runtimePlan?.observed?.model ?? result.runtimePlan?.model;

	if (result.errorMessage) {
		// Pi owns provider retry policy and exposes the settled error as text. Do
		// not infer retry counts or permanence from that text; preserve it as-is.
		body =
			`Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
			`(provider/agent error).\n\n` +
			`Error: ${result.errorMessage}\n\n` +
			`The subagent did not produce a result. Next action: check the raw ` +
			`provider reason and verify model access for this account. Spawn a new ` +
			`subagent with a supported model or configured fallback; use ` +
			`subagent_resume only after resolving access for this session's stored ` +
			`model because resume does not select a model.`;
	} else {
		body =
			result.exitCode === 0
				? `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}`
				: `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}`;
	}

	if (requestedModel) body += `\n\nRequested model: ${requestedModel}`;
	if (attempted.length > 1)
		body += `\nModels attempted: ${attempted.join(", ")}`;
	if (usedModel) body += `\nModel used: ${usedModel}`;
	if (result.fallbackFailures?.length) {
		body +=
			"\nModel failures (raw errors, in attempt order):" +
			result.fallbackFailures
				.map(({ model, error }) => `\n- ${model}: ${error}`)
				.join("");
	}
	if (result.worktree) body += `\n\n${formatWorktreeHandoff(result.worktree)}`;
	const runtimeWarning = runtimeMismatch
		? `\n\nRuntime warning: ${runtimeMismatch}`
		: "";
	return boundResultPresentation(body, sessionRef + runtimeWarning);
}

function resolveCancelledPresentation(
	result: Pick<
		SubagentResult,
		"elapsed" | "sessionFile" | "fallbackAttempts" | "worktree"
	>,
	name: string,
	cancellation: RunCancellation,
): string {
	let body =
		`Sub-agent "${name}" was cancelled by the parent after ${formatElapsed(result.elapsed)}. ` +
		(cancellation.termination === "confirmed"
			? "Termination was confirmed before this result"
			: `Termination is unconfirmed (${cancellation.error ?? "unknown"})`) +
		"; no model fallback, retry, or recovery was started.";
	if (result.fallbackAttempts?.length)
		body += `\n\nModels attempted: ${result.fallbackAttempts.join(", ")}`;
	if (result.worktree) body += `\n\n${formatWorktreeHandoff(result.worktree)}`;
	return boundResultPresentation(
		body,
		formatSessionReference(result.sessionFile),
	);
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	error?: string;
	/** Settled provider/agent error text from the child, preserved verbatim. */
	errorMessage?: string;
	/** Ordered models launched for this run, including failed fallback attempts. */
	fallbackAttempts?: string[];
	/** Ordered raw errors associated with failed model attempts. */
	fallbackFailures?: ModelFailure[];
	ping?: { name: string; message: string };
	worktree?: WorktreeHandoff;
	runtimePlan?: ResolvedRuntimePlan;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile?: string;
	activityFile?: string;
	activity?: SubagentActivityState;
	activityRead?: {
		ok: boolean;
		reason?: "missing" | "invalid" | "wrong-id";
		error?: string;
	};
	abortController?: AbortController;
	/**
	 * Optional legacy status snapshot retained only for hydrating pre-lifecycle
	 * runtime entries after /reload. Live observation uses `lifecycle` only.
	 */
	statusState?: SubagentStatusState;
	lifecycle: SubagentLifecycle;
	/** Last projected kind used to detect stalled/recovered transitions. */
	lastProjectedKind?: LifecycleProjection["kind"];
	/** One active no-progress warning episode, reset when durable progress resumes. */
	noProgressEpisode?: {
		active: true;
		progressAt: number;
		idleMs: number;
		classification: NoProgressClassification;
		lastEntryKind: NoProgressSessionTail["lastEntryKind"];
	};
	/**
	 * When true, status transitions (stalled/recovered) do not wake the parent
	 * session via a steer message. The widget still updates locally. Used for
	 * long-running agents where the user drives the conversation in the
	 * subagent's pane.
	 */
	interactive: boolean;
	/** Parent-resolved model/thinking selection and provenance. */
	runtimePlan: ResolvedRuntimePlan | undefined;
	worktree?: WorktreeLaunch;
	persistent?: boolean;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
	policyTools?: string[] | null;
	policyDeniedTools?: string[];
	tasksCompleted?: number;
	taskId?: string;
	inboxSequence?: number;
	observedTaskEvents?: number;
	stopState?: "requested" | "pending" | "failed";
	stopFailure?: string;
	stopTimeout?: ReturnType<typeof setTimeout>;
	stopTimeoutMs?: number;
	crashNotified?: boolean;
	cancelState?: "requested" | "confirmed" | "unconfirmed";
}

const paneConfig = loadPaneConfig(
	getSubagentsConfigDir(),
	getSubagentsConfigExamplePath(),
);

interface SubagentRuntime {
	runningSubagents: Map<string, RunningSubagent>;
	session?: PiRunSession;
	pi?: ExtensionAPI;
	latestCtx?: ExtensionContext;
	modelCatalog?: string;
}

/** Presentation rows share the adapter's records; only RunSession owns runs. */
const runtime: SubagentRuntime = readGlobalSlot<SubagentRuntime>(
	RUNTIME_KEY,
) ?? {
	runningSubagents: new Map<string, RunningSubagent>(),
};
writeGlobalSlot(RUNTIME_KEY, runtime);
const runningSubagents = runtime.runningSubagents;

export function shouldPreserveSubagentsOnShutdown(
	reason: SessionShutdownEvent["reason"] | undefined,
): boolean {
	return (
		reason === "reload" ||
		reason === "new" ||
		reason === "resume" ||
		reason === "fork"
	);
}

export function cleanupSubagentsForShutdown(
	reason: SessionShutdownEvent["reason"] | undefined,
	agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle">>,
): void {
	if (shouldPreserveSubagentsOnShutdown(reason)) return;

	for (const agent of agents.values()) {
		if (agent.lifecycle) {
			agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
		}
		agent.abortController?.abort();
	}
	agents.clear();
}

export function shouldDeliverSubagentCompletion(
	running: Pick<RunningSubagent, "lifecycle">,
): boolean {
	// Authoritative gate: only pending deliveries may be sent.
	// Missing lifecycle (pre-migration fixtures) defaults to pending/true.
	return (running.lifecycle?.delivery ?? "pending") === "pending";
}

export function selectCompletionApi<T>(previous: T, current: T | undefined): T {
	return current ?? previous;
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
	const seconds = Math.floor((endTime - startTime) / 1000);
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(
	left: string,
	right: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}│${RST}`;

	// width = total visible chars for the whole line including │ and │
	const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
	const rightVis = visibleWidth(right);

	// If the status chunk alone is too wide, prefer preserving it in compact form
	// rather than overflowing the terminal.
	if (rightVis >= contentWidth) {
		const truncRight = truncateToWidth(right, contentWidth);
		const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
		return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
	}

	const maxLeft = Math.max(0, contentWidth - rightVis);
	const truncLeft = truncateToWidth(left, maxLeft);
	const leftVis = visibleWidth(truncLeft);
	const pad = Math.max(0, contentWidth - leftVis - rightVis);
	return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(
	title: string,
	info: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╭${RST}`;

	// ╭─ Title ───...─── info ─╮
	// overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
	const inner = Math.max(0, width - 2); // inside ╭ and ╮
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`
		.slice(0, inner)
		.padEnd(inner, "─");
	return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╰${RST}`;

	const inner = Math.max(0, width - 2);
	return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
	projection: ReturnType<typeof projectLifecycle>,
	now: number,
): string {
	const duration =
		projection.stateDurationSince == null
			? ""
			: ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
	if (projection.kind === "active")
		return projection.label
			? ` active · ${projection.label}${duration} `
			: ` active${duration} `;
	if (projection.kind === "blocked") return ` blocked${duration} `;
	if (projection.kind === "running") return " running… ";
	if (projection.kind === "waiting") return ` waiting${duration} `;
	if (projection.kind === "interrupted") return ` interrupted${duration} `;
	if (projection.kind === "stalled") return ` stalled${duration} `;
	// completed/failed exist as lifecycle projections for delivery bookkeeping,
	// but the row is removed immediately after result delivery — so the only
	// visible terminal handoff label is finalizing.
	if (
		projection.kind === "finalizing" ||
		projection.kind === "completed" ||
		projection.kind === "failed"
	) {
		return " finalizing… ";
	}
	return " starting… ";
}

function renderSubagentWidgetLines(
	agents: RunningSubagent[],
	width: number,
): string[] {
	const now = Date.now();
	const rendered = agents.map((agent) => ({
		agent,
		projection: projectLifecycle(ensureLifecycle(agent), now),
	}));
	const activeCount = rendered.filter(
		({ projection }) =>
			projection.kind === "active" ||
			projection.kind === "starting" ||
			projection.kind === "running" ||
			projection.kind === "blocked",
	).length;
	const openCount = agents.length - activeCount;
	const info =
		activeCount > 0
			? openCount > 0
				? `${activeCount} active · ${openCount} open`
				: `${activeCount} active`
			: `${openCount} open`;
	const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

	const lines: string[] = [borderTop("Subagents", info, width, accent)];

	for (const { agent, projection } of rendered) {
		const elapsed = formatElapsedMMSS(
			agent.startTime,
			projection.runtimeEndedAt ?? now,
		);
		const agentTag = agent.agent ? ` (${agent.agent})` : "";
		const left = ` ${elapsed}  ${agent.name}${agentTag} `;
		const runtimeTag = agent.runtimePlan
			? `${agent.runtimePlan.modelId}|${agent.runtimePlan.thinking} · `
			: "";
		const label =
			agent.cancelState === "unconfirmed"
				? "cancel unconfirmed"
				: agent.cancelState
					? "cancelling…"
					: undefined;
		const right = label
			? ` ${runtimeTag}${label} `
			: statusConfig.enabled
				? ` ${runtimeTag}${formatLifecycleWidgetLabel(projection, now).trim()} `
				: ` ${runtimeTag}starting… `;

		lines.push(borderLine(left, right, width, accent));
	}

	lines.push(borderBottom(width, accent));
	return lines;
}

function updateWidget() {
	const latestCtx = runtime.latestCtx;
	if (!latestCtx?.hasUI) return;

	if (runningSubagents.size === 0) {
		latestCtx.ui.setWidget("subagent-status", undefined);
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				WIDGET_INTERVAL_KEY,
				null,
			);
		}
		return;
	}

	latestCtx.ui.setWidget(
		"subagent-status",
		(_tui: any, _theme: any) => {
			return {
				invalidate() {},
				render(width: number) {
					return renderSubagentWidgetLines(
						Array.from(runningSubagents.values()),
						width,
					);
				},
			};
		},
		{ placement: "aboveEditor" },
	);
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
function buildPiPromptArgs(params: {
	effectiveSkills?: string;
	taskDelivery: "direct" | "artifact";
	taskArg: string;
}): string[] {
	const skillPrompts = (params.effectiveSkills ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((skill) => `/skill:${skill}`);

	const needsSeparator =
		params.taskDelivery === "artifact" && skillPrompts.length > 0;

	return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
	if (running.lifecycle) return running.lifecycle;
	let lifecycle = createLifecycle(running.startTime);
	const state = running.statusState;
	if (
		state?.activityLabel === "interrupted" &&
		state.localOverrideAtMs != null
	) {
		lifecycle = markInterruptRequested(lifecycle, state.localOverrideAtMs);
	} else if (state?.phase === "done") {
		// Legacy activity "done" means the turn ended, not that completion
		// evidence was recorded. Hydrate as Herdr-style waiting and let the
		// preserved watcher consume sidecar/sentinel evidence.
		const observedAt = state.lastActivityAtMs ?? running.startTime;
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt, agentStatus: "done" },
			observedAt,
		);
	} else if (
		state?.phase === "active" ||
		state?.phase === "waiting" ||
		state?.phase === "starting"
	) {
		const activity: SubagentActivityState = {
			version: 1,
			runningChildId: running.id,
			createdAt: running.startTime,
			updatedAt: state.lastActivityAtMs ?? running.startTime,
			sequence: state.lastActivitySequence ?? 0,
			latestEvent:
				state.latestEvent === "agent_end" ? "agent_end" : "agent_start",
			phase: state.phase,
			agentActive: state.phase === "active",
			turnActive: state.phase === "active",
			providerActive: false,
			toolActive: state.activeScope === "tool",
		};
		if (isSubagentActivityScope(state.activeScope)) {
			activity.activeScope = state.activeScope;
		}
		if (state.activeSinceMs != null) activity.activeSince = state.activeSinceMs;
		if (state.waitingSinceMs != null)
			activity.waitingSince = state.waitingSinceMs;
		if (state.activityLabel && state.activeScope === "tool") {
			activity.toolName = state.activityLabel;
		}
		lifecycle = observeActivity(
			lifecycle,
			{ ok: true, activity },
			state.lastActivityAtMs ?? running.startTime,
		);
	} else if (running.startTime) {
		// Pre-lifecycle Pi agents without a known phase still get a running process.
		lifecycle = markProcessRunning(lifecycle, running.startTime);
	}
	running.lifecycle = lifecycle;
	return lifecycle;
}

function observeRunningSubagent(
	running: RunningSubagent,
	observedAt = Date.now(),
) {
	const control = runtime.session?.getControlTaskId(running.id);
	if (control) {
		runtime.session!.observe(control, observedAt);
		return;
	}
	const observation = observePiActivity(
		{
			id: running.id,
			activityFile: running.activityFile,
			lifecycle: ensureLifecycle(running),
		},
		observedAt,
	);
	const read = observation.activityRead;

	running.activityRead = read.ok
		? { ok: true }
		: { ok: false, reason: read.reason, error: read.error };

	if (read.ok) running.activity = read.activity;
	running.lifecycle = observation.lifecycle;
}

type NoProgressAdvisoryEvent =
	| {
			kind: "warning";
			idleMs: number;
			classification: NoProgressClassification;
			lastEntryKind: NoProgressSessionTail["lastEntryKind"];
			notify: boolean;
	  }
	| {
			kind: "recovered";
			idleMs: number;
			classification: NoProgressClassification;
			lastEntryKind: NoProgressSessionTail["lastEntryKind"];
			notify: boolean;
	  };

function evaluateNoProgressAdvisory(
	running: RunningSubagent,
	projection: LifecycleProjection,
	now: number,
	hangWarningMinutes: number,
	inspectProgress: (running: RunningSubagent) => NoProgressSessionTail = (
		running,
	) => {
		const control = runtime.session?.getControlTaskId(running.id);
		return control
			? runtime.session!.inspectProgress(control)
			: { classification: "generic-no-progress", lastEntryKind: "other" };
	},
): NoProgressAdvisoryEvent | undefined {
	if (hangWarningMinutes === 0) {
		delete running.noProgressEpisode;
		return;
	}
	if (projection.kind !== "active" && projection.kind !== "blocked") {
		delete running.noProgressEpisode;
		return;
	}

	let sessionMtime: number;
	try {
		sessionMtime = statSync(running.sessionFile).mtimeMs;
	} catch {
		// Session evidence is unavailable; do not turn that I/O problem into a hang.
		return;
	}
	const progressAt = Math.min(
		now,
		Math.max(
			sessionMtime,
			running.activity?.updatedAt ?? Number.NEGATIVE_INFINITY,
		),
	);
	const idleMs = Math.max(0, now - progressAt);
	if (idleMs <= hangWarningMinutes * 60_000) {
		const previous = running.noProgressEpisode;
		delete running.noProgressEpisode;
		return previous
			? {
					kind: "recovered",
					idleMs: Math.max(0, now - previous.progressAt),
					classification: previous.classification,
					lastEntryKind: previous.lastEntryKind,
					notify: !running.interactive,
				}
			: undefined;
	}
	if (running.noProgressEpisode) return;

	let tail: NoProgressSessionTail = {
		classification: "generic-no-progress",
		lastEntryKind: "other",
	};
	try {
		// The bounded reader is deliberately cold-path only: mtime/snapshot checks
		// above run on every refresh, but JSONL parsing happens once per episode.
		tail = inspectProgress(running);
	} catch {
		// A session can disappear between stat and read; preserve a facts-only
		// generic advisory rather than failing the status loop.
	}
	running.noProgressEpisode = { active: true, progressAt, idleMs, ...tail };
	return { kind: "warning", idleMs, ...tail, notify: !running.interactive };
}

function formatNoProgressAdvisoryLine(
	running: RunningSubagent,
	event: NoProgressAdvisoryEvent,
): string {
	const name = normalizeStatusName(running.name);
	const persistentIds = running.persistent
		? ` Logical ID: ${running.logicalId ?? "unknown"}; generation ID: ${running.generationId ?? "unknown"}.`
		: "";
	if (event.kind === "recovered") {
		return `${name} no-progress advisory recovered after ${formatElapsedDuration(event.idleMs)}.${persistentIds}`;
	}
	const classification =
		event.classification === "blocked-tool"
			? "blocked-tool; the outstanding tool may still complete"
			: event.classification === "truncated-turn"
				? "truncated-turn; observed toolUse stop with no tool call; cause unknown"
				: "generic no-progress";
	const options = running.worktree
		? "interrupt, or retain the workspace and continue there after confirming the previous process exited"
		: running.persistent
			? "interrupt, or use subagent_stop then replace with a new persistent specialist"
			: "interrupt, or after manual termination use subagent_resume or a new spawn";
	return `${name} no-progress advisory: ${formatElapsedDuration(event.idleMs)} idle while active. Classification: ${classification}. Last entry: ${event.lastEntryKind}. Session: ${running.sessionFile}. Recovery options: ${options}.${persistentIds}`;
}

function resolveInterruptTarget(params: {
	id?: string;
	name?: string;
}): { running: RunningSubagent } | { error: string } {
	const requestedId = params.id?.trim();
	if (requestedId) {
		const running = runningSubagents.get(requestedId);
		return running
			? { running }
			: { error: `No running subagent with id "${requestedId}".` };
	}

	const requestedName = params.name?.trim();
	if (!requestedName) {
		return { error: "Provide a running subagent id or exact display name." };
	}

	const matches = Array.from(runningSubagents.values()).filter(
		(running) => running.name === requestedName,
	);
	if (matches.length === 1) return { running: matches[0] };
	if (matches.length === 0) {
		return { error: `No running subagent named "${requestedName}".` };
	}

	const candidates = matches
		.map((running) => `${running.name} [${running.id}]`)
		.join(", ");
	return {
		error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
	};
}

function resolvePersistentTarget(params: { id?: string; name?: string }) {
	const resolved = resolveInterruptTarget(params);
	if ("error" in resolved) return resolved;
	if (!resolved.running.persistent) {
		return { error: `Subagent "${resolved.running.name}" is not persistent.` };
	}
	return resolved;
}

function asPiRecord(running: RunningSubagent): PiRunRecord {
	// SAFETY: live rows are the adapter's actual records. Legacy presentation
	// fixtures omit script/activity paths, which persistent I/O never consumes.
	return running as PiRunRecord;
}

function persistentSpecialistState(
	running: RunningSubagent,
): "idle" | "working" | "stalled" | "stopped" {
	const projection = projectLifecycle(
		ensureLifecycle(running),
		Date.now(),
	).kind;
	if (running.stopState === "failed") return "stalled";
	if (running.stopState)
		return projection === "stalled" ? "stalled" : "working";
	if (running.taskId) return projection === "stalled" ? "stalled" : "working";
	// Persistent task completion is authoritative for logical specialist state.
	// Herdr can continue reporting the long-lived Pi pane as working while the
	// process remains open between turns.
	if (running.persistent && running.tasksCompleted != null) return "idle";
	if (projection === "stalled") return "stalled";
	if (
		projection === "active" ||
		projection === "blocked" ||
		projection === "starting" ||
		projection === "running"
	)
		return "working";
	if (
		projection === "completed" ||
		projection === "failed" ||
		projection === "finalizing"
	)
		return "stopped";
	return "idle";
}

interface SubagentSendDetails {
	error?: string;
	id?: string;
	task?: string;
	inbox?: string;
	outcome?: "dispatched" | "rejected-busy";
}

interface PersistentSpecialistFacts {
	logicalId: string;
	generationId: string;
	policyHash: string;
	tasks: Array<{ task: string; outcome: string }>;
	sessionFile: string;
	worktree?: WorktreeHandoff;
	lastObservedPhase: string;
}

function persistentSpecialistFacts(
	running: RunningSubagent,
	io: PiPersistentIO,
	worktree?: WorktreeHandoff,
): PersistentSpecialistFacts {
	const facts: PersistentSpecialistFacts = {
		logicalId: running.logicalId!,
		generationId: running.generationId!,
		policyHash: running.policyHash!,
		tasks: io.readLedger(asPiRecord(running)).map((entry) => ({
			task: entry.task,
			outcome: entry.outcome,
		})),
		sessionFile: running.sessionFile,
		lastObservedPhase: projectLifecycle(ensureLifecycle(running), Date.now())
			.kind,
	};
	if (worktree) facts.worktree = worktree;
	return facts;
}

function formatPersistentSpecialistFacts(
	facts: PersistentSpecialistFacts,
): string {
	const lines = [
		`Logical ID: ${facts.logicalId}`,
		`Generation ID: ${facts.generationId}`,
		`Policy hash: ${facts.policyHash}`,
		`Task outcomes: ${facts.tasks.map((task) => `${task.task}=${task.outcome}`).join(", ") || "none"}`,
		`Session: ${facts.sessionFile}`,
		`Last observed phase: ${facts.lastObservedPhase}`,
	];
	if (facts.worktree)
		lines.push(
			`Worktree Git state: ${facts.worktree.gitError ? "unknown" : facts.worktree.conflicted ? "conflicted" : facts.worktree.clean ? "clean" : "dirty"}`,
		);
	return lines.join("\n");
}

function persistentCapacityError(
	config: PersistentConfig = persistentConfig,
): string | undefined {
	const specialists = Array.from(runningSubagents.values()).filter(
		(running) => running.persistent,
	);
	if (specialists.length < config.maxAgents) return undefined;
	return `Persistent specialist cap (${config.maxAgents}) reached. Current specialists: ${specialists.map((running) => `${running.name} (${persistentSpecialistState(running)}, ${running.tasksCompleted ?? 0} completed)`).join(", ")}.`;
}

function sendPersistentStopFailure(
	api: Pick<ExtensionAPI, "sendMessage">,
	running: RunningSubagent,
	io: PiPersistentIO,
): void {
	const facts = persistentSpecialistFacts(
		running,
		io,
		io.inspectWorktree(asPiRecord(running)),
	);
	api.sendMessage(
		{
			customType: "subagent_stop",
			content: `Persistent specialist stop failed: process exit was not confirmed. Evidence is retained.\n\n${formatPersistentSpecialistFacts(facts)}`,
			display: true,
			details: { status: "failed", facts },
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function startPersistentStopTimeout(
	running: RunningSubagent,
	api: Pick<ExtensionAPI, "sendMessage">,
	stopTimeoutMs = 15_000,
	io: PiPersistentIO,
): void {
	if (
		running.stopTimeout ||
		(running.stopState !== "requested" && running.stopState !== "pending")
	)
		return;
	running.stopTimeout = setTimeout(() => {
		running.stopTimeout = undefined;
		if (!runningSubagents.has(running.id)) return;
		if (running.stopState === "requested" || running.stopState === "pending") {
			running.stopState = "failed";
			running.stopFailure =
				"process exit was not confirmed within the bounded stop wait";
			const completionApi = runtime.session?.getControlTaskId(running.id)
				? selectCompletionApi(api, runtime.pi)
				: api;
			sendPersistentStopFailure(completionApi, running, io);
		}
	}, stopTimeoutMs);
	running.stopTimeout.unref();
}

interface SubagentStopDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: "stop_requested" | "stop_pending";
}

function handleSubagentStop(
	params: { id?: string; name?: string },
	api: Pick<ExtensionAPI, "sendMessage">,
	stopTimeoutMs = 15_000,
	io: PiPersistentIO,
): AgentToolResult<SubagentStopDetails> {
	const resolved = resolvePersistentTarget(params);
	if ("error" in resolved) {
		return {
			content: [{ type: "text", text: resolved.error }],
			details: { error: resolved.error },
		};
	}
	const running = resolved.running;
	if (running.stopState === "requested" || running.stopState === "pending") {
		const error = `Stop is already requested for persistent specialist "${running.name}".`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, id: running.id, name: running.name },
		};
	}
	const state = persistentSpecialistState(running);
	if (state === "stopped") {
		const error = `Persistent specialist "${running.name}" is already stopped.`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, id: running.id, name: running.name },
		};
	}
	const pending = running.taskId != null;
	running.stopState = pending ? "pending" : "requested";
	running.stopTimeoutMs = stopTimeoutMs;
	io.requestStop(asPiRecord(running));
	if (!pending) startPersistentStopTimeout(running, api, stopTimeoutMs, io);
	return {
		content: [
			{
				type: "text",
				text: pending
					? `Stop pending for persistent specialist "${running.name}"; its active task will settle first.`
					: `Stop requested for persistent specialist "${running.name}".`,
			},
		],
		details: {
			id: running.id,
			name: running.name,
			status: pending ? "stop_pending" : "stop_requested",
		},
	};
}

function handleSubagentSend(
	params: {
		id?: string;
		name?: string;
		message: string;
	},
	io: PiPersistentIO,
): AgentToolResult<SubagentSendDetails> {
	const resolved = resolvePersistentTarget(params);
	if ("error" in resolved)
		return {
			content: [{ type: "text", text: resolved.error }],
			details: { error: resolved.error },
		};
	const running = resolved.running;
	const task = randomUUID();
	if (running.stopState === "failed") {
		io.rejectBusy(asPiRecord(running), task);
		const error = `Persistent specialist "${running.name}" is in an unconfirmed-stop state; task ${task} was rejected-busy. Process exit is unconfirmed and evidence is retained at session ${running.sessionFile}. Request subagent_stop again or spawn a new specialist.`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, task, outcome: "rejected-busy" },
		};
	}
	const state = persistentSpecialistState(running);
	if (state !== "idle") {
		io.rejectBusy(asPiRecord(running), task);
		const error = `Persistent specialist "${running.name}" is ${state}; task ${task} was rejected-busy. Resend after the pending result.`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, task, outcome: "rejected-busy" },
		};
	}
	const inbox = io.dispatch(asPiRecord(running), task, params.message);
	return {
		content: [
			{
				type: "text",
				text: `Task ${task} dispatched to persistent specialist "${running.name}".`,
			},
		],
		details: { id: running.id, task, inbox, outcome: "dispatched" },
	};
}

async function requestSubagentInterrupt(
	running: RunningSubagent,
	interruptPaneKey: (surface: string) => void | Promise<void> = () =>
		runtime.session!.interrupt(runtime.session!.getControlTaskId(running.id)!),
): Promise<{ ok: true } | { error: string }> {
	try {
		await interruptPaneKey(running.surface);
		return { ok: true };
	} catch (error: any) {
		return {
			error:
				`Failed to send Escape to subagent "${running.name}" via herdr: ` +
				`${error?.message ?? String(error)}`,
		};
	}
}

interface SubagentInterruptDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: "interrupt_requested";
}

async function handleSubagentInterrupt(
	params: { id?: string; name?: string },
	interruptPaneKey?: (surface: string) => void | Promise<void>,
): Promise<AgentToolResult<SubagentInterruptDetails>> {
	const resolved = resolveInterruptTarget(params);
	if ("error" in resolved) {
		return {
			content: [{ type: "text" as const, text: resolved.error }],
			details: { error: resolved.error },
		};
	}

	const running = resolved.running;
	const now = Date.now();
	observeRunningSubagent(running, now);

	const interruption = await requestSubagentInterrupt(
		running,
		interruptPaneKey,
	);
	if ("error" in interruption) {
		return {
			content: [{ type: "text" as const, text: interruption.error }],
			details: {
				error: interruption.error,
				id: running.id,
				name: running.name,
			},
		};
	}

	running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
	updateWidget();

	return {
		content: [
			{
				type: "text" as const,
				text: `Interrupt requested for subagent "${running.name}".`,
			},
		],
		details: {
			id: running.id,
			name: running.name,
			status: "interrupt_requested",
		},
	};
}

const SUBAGENT_CANCEL_DESCRIPTION =
	"Cancel a running ordinary (non-persistent) Pi-backed subagent, including an interrupted one: " +
	"records terminal intent first, terminates its owned process, and delivers exactly one cancelled result. " +
	"No model fallback, retry, or recovery starts after a cancel. " +
	"An ordinary pane is closed; a managed-worktree child stops only its Pi process and keeps the workspace, checkout, commits, and manifest. " +
	"Returns confirmed, requested (launch still in flight), unconfirmed (the run stays live; call again to retry), or already-terminal. " +
	"Persistent specialists are rejected; use subagent_stop. Do not poll: the cancelled result arrives automatically.";

interface SubagentCancelDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: CancelReport["status"];
	requestedAt?: number;
	repeated?: boolean;
}

function cancelStatusText(
	name: string,
	report: CancelReport,
	worktree: boolean,
): string {
	const noRetry = "No model fallback, retry, or recovery will start.";
	switch (report.status) {
		case "confirmed":
			return worktree
				? `Cancelled subagent "${name}": its Pi process exit is confirmed; the worktree workspace, checkout, commits, and manifest are retained. ${noRetry} One cancelled result will be delivered automatically.`
				: `Cancelled subagent "${name}": its pane was closed and Herdr confirmed it is gone. ${noRetry} One cancelled result will be delivered automatically.`;
		case "requested":
			return `Cancel recorded for subagent "${name}"; its in-flight launch is terminated as soon as it is acquired. ${noRetry} One cancelled result will be delivered after termination is confirmed.`;
		case "unconfirmed":
			return `Cancel recorded for subagent "${name}", but termination is unconfirmed: ${report.error ?? "unknown error"}. The run stays live and owned. ${noRetry} Call subagent_cancel again to retry termination.`;
		case "already-terminal":
			return `Subagent "${name}" already reached a terminal result; nothing was cancelled.`;
	}
}

async function handleSubagentCancel(
	params: { id?: string; name?: string },
	session: Pick<PiRunSession, "cancel" | "getControlTaskId"> = runtime.session!,
): Promise<AgentToolResult<SubagentCancelDetails>> {
	const fail = (error: string, extra: SubagentCancelDetails = {}) => ({
		content: [{ type: "text" as const, text: error }],
		details: { error, ...extra },
	});
	const resolved = resolveInterruptTarget(params);
	if ("error" in resolved) {
		// No live row: a retired run keeps only its consumed control ID, and a run
		// still in its initial launch has no row yet. Report the kernel's answer.
		const id = params.id?.trim();
		const report = id
			? await session.cancel(id).catch(() => undefined)
			: undefined;
		if (!id || !report) return fail(resolved.error);
		updateWidget();
		return {
			content: [
				{ type: "text" as const, text: cancelStatusText(id, report, false) },
			],
			details: { id, status: report.status },
		};
	}
	const running = resolved.running;
	const target = { id: running.id, name: running.name };
	if (running.persistent)
		return fail(
			`Subagent "${running.name}" is a persistent specialist; subagent_cancel does not stop it. Use subagent_stop({ id: "${running.id}" }) for the graceful v1 stop.`,
			target,
		);
	const control = session.getControlTaskId(running.id);
	if (!control)
		return fail(
			`Subagent "${running.name}" has no live owner in this session; nothing was cancelled.`,
			target,
		);
	let report: CancelReport;
	try {
		report = await session.cancel(control);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), target);
	} finally {
		updateWidget();
	}
	const details: SubagentCancelDetails = { ...target, status: report.status };
	if (report.requestedAt !== undefined)
		details.requestedAt = report.requestedAt;
	if (report.error) details.error = report.error;
	if (report.repeated) details.repeated = true;
	return {
		content: [
			{
				type: "text" as const,
				text: cancelStatusText(running.name, report, !!running.worktree),
			},
		],
		details,
	};
}

function startStatusRefresh(pi: ExtensionAPI) {
	if (!statusConfig.enabled || statusInterval) return;

	statusInterval = setInterval(() => {
		if (runningSubagents.size === 0) {
			if (statusInterval) {
				clearInterval(statusInterval);
				statusInterval = null;
				writeGlobalSlot<ReturnType<typeof setInterval> | null>(
					STATUS_INTERVAL_KEY,
					null,
				);
			}
			return;
		}

		const transitionLines: string[] = [];
		const now = Date.now();
		let shouldRefreshWidget = false;

		for (const running of runningSubagents.values()) {
			// Dual-writes lifecycle + statusState for reload hydration; steers use lifecycle only.
			observeRunningSubagent(running, now);
			const projection = projectLifecycle(ensureLifecycle(running), now);
			const transition = lifecycleTransition(
				running.lastProjectedKind,
				projection.kind,
			);
			if (running.lastProjectedKind !== projection.kind) {
				shouldRefreshWidget = true;
			}
			running.lastProjectedKind = projection.kind;

			// Interactive subagents (long-running, user-driven) intentionally don't
			// wake the parent session on stalled/recovered transitions — the user is
			// working in the subagent's pane, and a steer message here would burn an
			// orchestrator turn on a no-op "still waiting" ping. Widget still updates.
			if (transition && !running.interactive) {
				transitionLines.push(
					formatLifecycleTransitionLine(
						normalizeStatusName(running.name),
						projection,
						transition,
						now,
						running.startTime,
						formatElapsedDuration,
					),
				);
			}

			const noProgress = evaluateNoProgressAdvisory(
				running,
				projection,
				now,
				supervisionConfig.hangWarningMinutes,
			);
			if (noProgress?.notify) {
				transitionLines.push(formatNoProgressAdvisoryLine(running, noProgress));
			}
		}

		if (shouldRefreshWidget) updateWidget();

		if (transitionLines.length > 0) {
			const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
			pi.sendMessage(
				{
					customType: "subagent_status",
					content: formatStatusAggregate(
						transitionLines,
						statusConfig.lineLimit,
					),
					display: true,
					details: { lines: capped.visibleLines, overflow: capped.overflow },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		}
	}, 1000);

	writeGlobalSlot(STATUS_INTERVAL_KEY, statusInterval);
}

export const __test__ = {
	borderLine,
	renderSubagentWidgetLines,
	loadAgentDefaults,
	discoverAgentDefinitions,
	discoverAgentCatalog,
	resolveEffectiveSessionMode,
	resolveLaunchBehavior,
	resolveEffectiveAutoExit,
	resolveEffectiveInteractive,
	buildPiPromptArgs,
	resolveEffectivePersistent,
	observeRunningSubagent,
	evaluateNoProgressAdvisory,
	formatNoProgressAdvisoryLine,
	resolveDenyTools,
	buildSubagentRoutingGuidelines,
	resolveInterruptTarget,
	requestSubagentInterrupt,
	handleSubagentInterrupt,
	handleSubagentCancel,
	handleSubagentSend,
	handleSubagentStop,
	persistentSpecialistState,
	persistentCapacityError,
	resolveResultPresentation,
	resolveUnexpectedErrorPresentation,
	shouldAdvanceToFallback,
	deliverPersistentTaskEvent,
	drainPersistentTaskEvents,
	notifyPersistentCrash,
	sendSubagentResult,
	shouldRetainSubagentSurface,
	formatLivePersistentSpecialists,
	runningSubagents,
	formatElapsed,
};

function startWidgetRefresh() {
	if (widgetInterval) return;
	updateWidget(); // immediate first render
	widgetInterval = setInterval(() => {
		updateWidget();
	}, 1000);
	writeGlobalSlot(WIDGET_INTERVAL_KEY, widgetInterval);
}

function normalizePiAttempt(
	params: typeof SubagentParams.static,
	ctx: {
		sessionManager: {
			getSessionFile(): string | null | undefined;
			getSessionId(): string;
			getSessionDir(): string;
		};
		cwd: string;
		model?: { provider: string; id: string };
		modelRegistry: {
			find(provider: string, modelId: string): any;
			getAvailable?: () => any[];
			getAll?: () => any[];
			hasConfiguredAuth?: (model: any) => boolean;
		};
	},
	parentThinking: ThinkingLevel,
	options: {
		id: string;
		controlTaskId: string;
		origin: Pick<PiLaunchSnapshot["parent"], "cwd" | "invocationCwd">;
	},
): PiAttemptSnapshot {
	const agentDefs = params.agent
		? loadAgentDefaults(params.agent, runtime.pi)
		: null;
	if (params.agent && !agentDefs) {
		const diagnostic = discoverAgentCatalog(runtime.pi).diagnostics.find(
			(candidate) => candidate.agentName === params.agent,
		);
		throw new Error(diagnostic?.message ?? missingRoleMessage(params.agent));
	}
	if (!ctx.model)
		throw new Error("Subagent launch requires a resolved parent model");

	const effectiveTools = params.tools ?? agentDefs?.tools;
	const effectiveSkills = params.skills ?? agentDefs?.skills;
	const persistent = resolveEffectivePersistent(params, agentDefs);
	const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
	const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
	const logicalId = options.id;
	const generationId = randomUUID();
	const taskId = randomUUID();
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) throw new Error("No session file");
	const snapshot = launchSnapshot(ctx, parentThinking);

	return {
		snapshot: {
			...snapshot,
			parent: { ...snapshot.parent, ...options.origin },
		},
		task: {
			id: options.controlTaskId,
			name: params.name,
			prompt: params.task,
			role: params.agent ?? "",
			cwd: options.origin.cwd,
			worktree: params.worktree ?? undefined,
			session: { mode: resolveEffectiveSessionMode(params, agentDefs) },
			behavior: {
				skills: effectiveSkills
					?.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				denyTools: [...resolveDenyTools(agentDefs)],
				autoExit: effectiveAutoExit,
				interactive: effectiveInteractive,
				persistent,
				systemPromptMode: agentDefs?.systemPromptMode,
			},
			systemPrompt: params.agent ? undefined : params.systemPrompt,
		},
		role: agentDefs
			? {
					...agentDefs.role,
					systemPrompt: agentDefs.body ?? params.systemPrompt ?? "",
				}
			: {
					name: "",
					version: "1",
					description: "Pi host-resolved role",
					systemPrompt: params.systemPrompt ?? "",
					allowedTools: [],
				},
		resolved: {
			agent: params.agent,
			cwd: params.cwd,
			roleCwd: agentDefs?.cwd,
			tools: effectiveTools,
		},
		identity: { id: logicalId, logicalId, generationId, taskId },
	};
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file. Temporary panes close only after parent
 * delivery; worktree workspaces remain retained for review.
 */
function resolveSubagentRuntimePlans(
	params: typeof SubagentParams.static,
	ctx: Parameters<typeof normalizePiAttempt>[1],
	parentThinking: ThinkingLevel,
): ResolvedRuntimePlan[] {
	const agentDefs = params.agent
		? loadAgentDefaults(params.agent, runtime.pi)
		: null;
	if (params.agent && !agentDefs) {
		const diagnostic = discoverAgentCatalog(runtime.pi).diagnostics.find(
			(candidate) => candidate.agentName === params.agent,
		);
		throw new Error(diagnostic?.message ?? missingRoleMessage(params.agent));
	}
	if (!ctx.model)
		throw new Error("Subagent launch requires a resolved parent model");
	const plans = resolveRuntimePlans(
		{ model: params.model, thinking: params.thinking },
		{
			model: resolveModelDefault(params.agent, agentDefs?.model, modelConfig),
			thinking: agentDefs?.thinking,
		},
		{
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinking: parentThinking,
		},
		wrapPiModelRegistry(ctx.modelRegistry),
		modelConfig.tasks,
		!!params.worktree,
	);
	if (params.worktree && plans.length > 1) {
		throw new Error(
			"Model fallbacks are not supported for worktree subagents.",
		);
	}
	return plans;
}

function launchSnapshot(
	ctx: Parameters<typeof normalizePiAttempt>[1],
	thinking?: ThinkingLevel,
): PiLaunchSnapshot {
	return {
		parent: {
			cwd: ctx.cwd,
			invocationCwd: process.cwd(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? "",
			sessionId: ctx.sessionManager.getSessionId(),
			sessionDir: ctx.sessionManager.getSessionDir(),
			agentDir: getAgentConfigDir(),
		},
		parentRuntime:
			ctx.model && thinking
				? { provider: ctx.model.provider, modelId: ctx.model.id, thinking }
				: undefined,
		modelRegistry: wrapPiModelRegistry(ctx.modelRegistry),
		paneConfig,
	};
}

const inFlightPersistentTaskDeliveries = new Set<string>();

function deliverPersistentTaskEvent(
	running: RunningSubagent,
	event: PiPersistentEvent,
	api: Pick<ExtensionAPI, "sendMessage">,
	io: PiPersistentIO,
	ledgerSnapshot?: PiLedgerEntry[],
): void {
	if (
		!shouldDeliverSubagentCompletion(running) ||
		!running.persistent ||
		event.generation !== running.generationId
	)
		return;
	const deliveryKey = `${running.id}:${event.type}:${event.task}`;
	if (inFlightPersistentTaskDeliveries.has(deliveryKey)) return;
	const ledger = ledgerSnapshot ?? io.readLedger(asPiRecord(running));
	if (event.type === "help-request") {
		if (
			ledger.some(
				(entry) =>
					entry.task === event.task && entry.outcome === "help-requested",
			)
		)
			return;
		inFlightPersistentTaskDeliveries.add(deliveryKey);
		try {
			api.sendMessage(
				{
					customType: "subagent_ping",
					content: `Persistent specialist "${running.name}" requests help for task ${event.task}:\n\n${event.message ?? ""}\n\nReply with subagent_send to ${running.name}.`,
					display: true,
					details: {
						name: running.name,
						task: event.task,
						sessionFile: running.sessionFile,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			ledger.push(io.acknowledge(asPiRecord(running), event));
		} finally {
			inFlightPersistentTaskDeliveries.delete(deliveryKey);
		}
		return;
	}
	if (
		ledger.some(
			(entry) => entry.task === event.task && entry.outcome === "delivered",
		)
	)
		return;
	inFlightPersistentTaskDeliveries.add(deliveryKey);
	try {
		const completed = (running.tasksCompleted ?? 0) + 1;
		const summary = io.readTaskSummary(asPiRecord(running));
		sendSubagentResult(
			api,
			`Persistent specialist "${running.name}" completed task ${event.task} (${completed} tasks completed) and is idle and accepting subagent_send.\n\n${summary}`,
			{
				name: running.name,
				task: event.task,
				agent: running.agent,
				sessionFile: running.sessionFile,
				logicalId: running.logicalId!,
				generationId: running.generationId!,
				policyHash: running.policyHash!,
			},
		);
		ledger.push(io.acknowledge(asPiRecord(running), event));
		if (running.stopState === "pending")
			startPersistentStopTimeout(running, api, running.stopTimeoutMs, io);
	} finally {
		inFlightPersistentTaskDeliveries.delete(deliveryKey);
	}
}

function drainPersistentTaskEvents(
	running: RunningSubagent,
	api: Pick<ExtensionAPI, "sendMessage">,
	io: PiPersistentIO,
): void {
	if (!shouldDeliverSubagentCompletion(running)) return;
	const events = io.readEvents(asPiRecord(running));
	let ledger: PiLedgerEntry[] | undefined;
	for (const event of events.slice(running.observedTaskEvents ?? 0)) {
		if (!running.persistent || event.generation !== running.generationId)
			continue;
		if (
			inFlightPersistentTaskDeliveries.has(
				`${running.id}:${event.type}:${event.task}`,
			)
		)
			continue;
		ledger ??= io.readLedger(asPiRecord(running));
		deliverPersistentTaskEvent(
			running,
			event,
			selectCompletionApi(api, runtime.pi),
			io,
			ledger,
		);
	}
	running.observedTaskEvents = events.length;
}

function notifyPersistentCrash(
	running: RunningSubagent,
	api: Pick<ExtensionAPI, "sendMessage">,
	io: PiPersistentIO,
	worktree?: WorktreeHandoff,
): void {
	drainPersistentTaskEvents(running, api, io);
	if (running.crashNotified) return;
	running.crashNotified = true;
	const facts = persistentSpecialistFacts(running, io, worktree);
	api.sendMessage(
		{
			customType: "subagent_result",
			content: `Persistent specialist crashed. Evidence is retained. Persistent sessions cannot be resumed in v1; spawn a new specialist.\n\n${formatPersistentSpecialistFacts(facts)}`,
			display: true,
			details: { error: "persistent-crash", facts },
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function deliverPiCompletion(
	record: PiRunRecord,
	result: PiCompletedMetadata,
	task: Task,
	io: PiSettlementIO,
): "delivered" | "suppressed" {
	const running: RunningSubagent = record;
	if (running.stopTimeout) clearTimeout(running.stopTimeout);
	if (!shouldDeliverSubagentCompletion(running)) {
		running.lifecycle = markDelivery(running.lifecycle, "suppressed");
		runningSubagents.delete(running.id);
		updateWidget();
		return "suppressed";
	}
	const api = runtime.pi!;
	if (running.persistent) {
		// Task sends remain retryable while the process is live. This is the distinct
		// terminal PROCESS handoff; failed terminal delivery retires runtime ownership.
		drainPersistentTaskEvents(running, api, io);
		running.lifecycle = markDelivery(running.lifecycle, "delivered");
		if (running.stopState === "requested" || running.stopState === "pending") {
			io.recordStopped(record);
			const facts = persistentSpecialistFacts(running, io, result.worktree);
			api.sendMessage(
				{
					customType: "subagent_stop",
					content: `Persistent specialist stopped.\n\n${formatPersistentSpecialistFacts(facts)}`,
					display: true,
					details: { status: "stopped", facts },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} else if (running.stopState !== "failed")
			notifyPersistentCrash(running, api, io, result.worktree);
		runningSubagents.delete(running.id);
		updateWidget();
		return "delivered";
	}
	// Preserve ordinary mark-delivered/delete-before-send and failed-send retention.
	running.lifecycle = markDelivery(running.lifecycle, "delivered");
	runningSubagents.delete(running.id);
	updateWidget();
	const cancellation = result.run.cancellation;
	if (cancellation) {
		const details: SubagentResultDetails = {
			name: running.name,
			task: task.prompt,
			exitCode: result.exitCode,
			elapsed: result.elapsed,
			sessionFile: result.sessionFile,
			error: "cancelled",
			cancellation,
		};
		if (!io.readResumeResult) details.agent = running.agent;
		if (result.fallbackAttempts)
			details.fallbackAttempts = result.fallbackAttempts;
		if (result.fallbackFailures)
			details.fallbackFailures = result.fallbackFailures;
		if (result.worktree) details.worktree = result.worktree;
		if (running.runtimePlan) details.runtimePlan = running.runtimePlan;
		sendSubagentResult(
			api,
			resolveCancelledPresentation(result, running.name, cancellation),
			details,
		);
		return "delivered";
	}
	if (result.ping) {
		const worktreeRef = result.worktree
			? `\n\n${formatWorktreeHandoff(result.worktree)}`
			: "";
		const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
		const details: SubagentPingDetails = {
			name: result.ping.name,
			message: result.ping.message,
			sessionFile: result.sessionFile!,
		};
		if (task.role) details.agent = running.agent;
		if (result.worktree) details.worktree = result.worktree;
		api.sendMessage(
			{
				customType: "subagent_ping",
				content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${worktreeRef}${sessionRef}`,
				display: true,
				details,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} else {
		// Resume's second read belongs after the absorbing delivery mark/map delete
		// and ping branch. A real read rejection retains the manual pane via the
		// existing rejected-settlement path; do not suppress, resend or close it.
		const presentationResult = io.readResumeResult
			? { ...result, ...io.readResumeResult() }
			: result;
		const details: SubagentResultDetails = {
			name: running.name,
			task: task.prompt,
			exitCode: result.exitCode,
			elapsed: result.elapsed,
			sessionFile: presentationResult.sessionFile,
		};
		if (!io.readResumeResult) details.agent = running.agent;
		if (result.errorMessage) details.errorMessage = result.errorMessage;
		if (result.fallbackAttempts)
			details.fallbackAttempts = result.fallbackAttempts;
		if (result.fallbackFailures)
			details.fallbackFailures = result.fallbackFailures;
		if (result.worktree) details.worktree = result.worktree;
		if (running.runtimePlan) details.runtimePlan = running.runtimePlan;
		sendSubagentResult(
			api,
			resolveResultPresentation(
				presentationResult,
				running.name,
				running.runtimePlan?.runtimeMismatch,
			),
			details,
		);
	}
	return "delivered";
}

export function shouldAdvanceToFallback(
	result: Pick<SubagentResult, "errorMessage">,
	remainingPlans: number,
	persistent = false,
): boolean {
	return !persistent && result.errorMessage !== undefined && remainingPlans > 0;
}

export default function subagentsExtension(
	pi: ExtensionAPI,
	options: {
		cleanupOperations?: (ctx: ExtensionContext) => WorktreeCleanupOperations;
		infrastructure?: PiRunSessionInfrastructure;
	} = {},
) {
	runtime.pi = pi;
	runtime.session = createDefaultRunSession(
		{
			configDir: getAgentConfigDir(),
			configExamplePath: getSubagentsConfigExamplePath(),
			roles: [],
			forcePolling: supervisionConfig.forcePolling,
			sidebarMarkers: sidebarConfig.enabled,
			infrastructure: options.infrastructure,
			getLaunchSnapshot() {
				const ctx = runtime.latestCtx;
				if (!ctx) throw new Error("No parent launch context");
				const thinking = runtime.pi!.getThinkingLevel();
				if (!isThinkingLevel(thinking))
					throw new Error(`Unsupported parent thinking level: ${thinking}`);
				return launchSnapshot(ctx, thinking);
			},
			hooks: {
				onSpawned(record) {
					runningSubagents.set(record.id, record);
					startWidgetRefresh();
					startStatusRefresh(runtime.pi!);
				},
				onObserved(record, observation) {
					const running: RunningSubagent = record;
					if (observation.activityRead) {
						const read = observation.activityRead;
						running.activityRead = read.ok
							? { ok: true }
							: { ok: false, reason: read.reason, error: read.error };
					}
					if (observation.activity) running.activity = observation.activity;
					if (
						observation.kind !== "local-evidence" &&
						observation.kind !== "tick" &&
						observation.kind !== "refresh"
					)
						updateWidget();
				},
				onSettled: deliverPiCompletion,
			},
			persistent: {
				send(record, text, io) {
					const details = handleSubagentSend(
						{ id: record.id, message: text },
						io,
					).details;
					if (details.error)
						return {
							error: details.error,
							task: details.task,
							outcome:
								details.outcome === "rejected-busy"
									? details.outcome
									: undefined,
						};
					return {
						id: record.id,
						task: details.task!,
						inbox: details.inbox!,
						outcome: "dispatched",
					};
				},
				stop(record, timeout, io) {
					const details = handleSubagentStop(
						{ id: record.id },
						runtime.pi!,
						timeout,
						io,
					).details;
					return details.error
						? { error: details.error, id: details.id, name: details.name }
						: { id: record.id, name: record.name, status: details.status! };
				},
				drain(record, io) {
					if (runtime.pi) drainPersistentTaskEvents(record, runtime.pi, io);
				},
			},
		},
		runtime.session,
	);
	const parentSession = !process.env.PI_SUBAGENT_ID;
	// Report accepted no-op role settings once per parent extension load, not on
	// every session transition, listing, or child launch.
	let roleConfigDeprecationsReported = !parentSession;
	const cleanupInput = (ctx: ExtensionContext) => ({
		cwd: ctx.cwd,
		operations:
			options.cleanupOperations?.(ctx) ??
			runtime.session!.createWorktreeCleanupOperations({
				manifestDir: join(
					ctx.sessionManager.getSessionDir(),
					"artifacts",
					ctx.sessionManager.getSessionId(),
					"worktree-runs",
				),
				liveHolders: () =>
					[...runningSubagents.values()].flatMap((child) =>
						child.worktree
							? [{ path: child.worktree.path, persistent: child.persistent }]
							: [],
					),
			}),
	});
	// Capture the UI context for widget updates and restore presentation for
	// subagents whose watchers survived a reload.
	pi.on("session_start", async (_event, ctx) => {
		runtime.latestCtx = ctx;
		if (!roleConfigDeprecationsReported) {
			roleConfigDeprecationsReported = true;
			for (const message of roleConfig.deprecations)
				ctx.ui.notify(message, "warning");
		}
		const registry = wrapPiModelRegistry(ctx.modelRegistry);
		const authenticatedTaskPreferences = getAuthenticatedTaskPreferences(
			registry,
			modelConfig.tasks,
		);
		runtime.modelCatalog = buildAuthenticatedModelCatalog(
			registry,
			24,
			modelConfig.tasks,
		);
		const refreshedGuidelines = buildSubagentRoutingGuidelines(
			runtime.modelCatalog,
			authenticatedTaskPreferences,
		);
		subagentRoutingGuidelines.splice(
			0,
			subagentRoutingGuidelines.length,
			...refreshedGuidelines,
		);
		if (runningSubagents.size > 0) {
			startWidgetRefresh();
			startStatusRefresh(pi);
			updateWidget();
		}
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async (event, _ctx) => {
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				WIDGET_INTERVAL_KEY,
				null,
			);
		}
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				STATUS_INTERVAL_KEY,
				null,
			);
		}

		const session = runtime.session;
		const shutdown = session?.shutdown(event.reason);
		if (!shouldPreserveSubagentsOnShutdown(event.reason)) {
			for (const running of runningSubagents.values())
				if (running.stopTimeout) clearTimeout(running.stopTimeout);
			// Also gate/abort legacy rows retained from a pre-composition reload.
			// Do not infer ownership or reconstruct their watchers.
			cleanupSubagentsForShutdown(event.reason, runningSubagents);
			// The coordinator is already closed synchronously. Clear only this owner
			// before the shutdown await so another in-process host cannot adopt it.
			if (runtime.session === session) runtime.session = undefined;
		}
		await shutdown;
	});

	// Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
	const deniedTools = new Set(
		(process.env.PI_SUBAGENT_ID ? (process.env.PI_DENY_TOOLS ?? "") : "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const shouldRegister = (name: string) => !deniedTools.has(name);

	if (parentSession) {
		pi.registerTool({
			name: "worktree_list",
			label: "Worktree inventory",
			description:
				"Inspect managed worktrees, including cross-session orphans. Only source repositories inside cwd are eligible for explicit removal. This tool never removes anything.",
			parameters: Type.Object({}),
			execute: async (_id, _params, _signal, _update, ctx) => {
				const entries = await listContainedWorktrees(cleanupInput(ctx));
				return {
					content: [{ type: "text", text: formatWorktreeInventory(entries) }],
					details: { entries },
				};
			},
		});
		pi.registerTool({
			name: "worktree_remove",
			label: "Remove worktree",
			description:
				"Explicitly remove one managed worktree by exact path, branch, or workspace ID. Rechecks cwd containment, live children/leases, and Git state. Branches and commits are retained. Dirty work requires explicit preserve: true to make a WIP commit first.",
			parameters: Type.Object({
				target: Type.String({ minLength: 1 }),
				preserve: Type.Optional(Type.Boolean()),
			}),
			execute: async (_id, params, _signal, _update, ctx) => {
				const result = await removeContainedWorktree({
					...cleanupInput(ctx),
					...params,
				});
				if (result.status === "blocked" || result.status === "failed")
					throw new Error(result.message);
				return {
					content: [{ type: "text", text: result.message }],
					details: result,
				};
			},
		});
	}

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

	// ── subagent tool ──
	if (shouldRegister("subagent"))
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Spawn a sub-agent in a dedicated terminal herdr pane, or in an isolated Herdr-managed Git worktree when worktree is provided. " +
				"Use ordinary panes for read-only tasks; a single or sequential writer can work in the parent checkout without a worktree. " +
				"Reserve unique worktree branches for parallel independent writers starting from committed state — the worktree base is committed HEAD, so uncommitted parent changes are not copied. " +
				"Worktree runs retain their workspace after completion for parent review; they are not pushed, merged, or removed automatically. " +
				"To inspect a retained worktree result, spawn read-only agents in an ordinary pane with cwd set to that worktree path — do not create a new worktree for them. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate, assume, or summarize results after calling this tool. " +
				"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
			promptSnippet:
				"Spawn a sub-agent in a dedicated terminal herdr pane, or in an isolated Herdr-managed Git worktree when worktree is provided. " +
				"Use ordinary panes for read-only tasks; a single or sequential writer can work in the parent checkout without a worktree. " +
				"Reserve unique worktree branches for parallel independent writers starting from committed state — the worktree base is committed HEAD, so uncommitted parent changes are not copied. " +
				"Worktree runs retain their workspace after completion for parent review; they are not pushed, merged, or removed automatically. " +
				"To inspect a retained worktree result, spawn read-only agents in an ordinary pane with cwd set to that worktree path — do not create a new worktree for them. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate, assume, or summarize results after calling this tool. " +
				"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
			promptGuidelines: subagentRoutingGuidelines,
			parameters: SubagentParams,

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				// Prevent a named role from spawning another instance of itself
				const currentAgent = process.env.PI_SUBAGENT_AGENT;
				if (params.agent && currentAgent && params.agent === currentAgent) {
					return {
						content: [
							{
								type: "text",
								text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
							},
						],
						details: { error: "self-spawn blocked" },
					};
				}

				const catalog = params.agent
					? discoverAgentCatalog(runtime.pi)
					: undefined;
				const roleDiagnostic =
					catalog &&
					!catalog.agents.some((agent) => agent.name === params.agent)
						? catalog.diagnostics.find(
								(candidate) =>
									candidate.agentName === params.agent &&
									(candidate.code === "external-cli-unsupported" ||
										candidate.code === "invalid-capability-declaration"),
							)
						: undefined;
				if (roleDiagnostic) {
					return {
						content: [
							{ type: "text", text: `Error: ${roleDiagnostic.message}` },
						],
						details: { error: roleDiagnostic.code },
					};
				}

				const persistent = resolveEffectivePersistent(
					params,
					params.agent ? loadAgentDefaults(params.agent, runtime.pi) : null,
				);
				const capError = persistent ? persistentCapacityError() : undefined;
				if (capError) {
					return {
						content: [{ type: "text", text: capError }],
						details: { error: "persistent-cap" },
					};
				}

				// Validate prerequisites
				if (!runtime.session!.availability().available) {
					return muxUnavailableResult();
				}

				if (!ctx.sessionManager.getSessionFile()) {
					return {
						content: [
							{
								type: "text",
								text: "Error: no session file. Start pi with a persistent session to use subagents.",
							},
						],
						details: { error: "no session file" },
					};
				}

				// Launch the subagent (creates pane, sends command)
				const parentThinking = pi.getThinkingLevel();
				if (
					parentThinking !== "off" &&
					parentThinking !== "minimal" &&
					parentThinking !== "low" &&
					parentThinking !== "medium" &&
					parentThinking !== "high" &&
					parentThinking !== "xhigh" &&
					parentThinking !== "max"
				) {
					throw new Error(
						`Unsupported parent thinking level: ${parentThinking}`,
					);
				}
				const runtimePlans = resolveSubagentRuntimePlans(
					params,
					ctx,
					parentThinking,
				);
				runtime.latestCtx = ctx;
				const id = randomUUID();
				const attempt = {
					id,
					controlTaskId: id,
					origin: { cwd: ctx.cwd, invocationCwd: process.cwd() },
				};
				const first = normalizePiAttempt(params, ctx, parentThinking, attempt);
				const [plan, ...fallbacks] = runtimePlans;
				if (!plan) throw new Error("No resolved runtime plans");
				const input: PiLaunchInput = {
					...first,
					plans: [plan, ...fallbacks],
					// Fallbacks outlive this tool call; session replacement invalidates ctx.
					prepareAttempt: () => {
						const live = runtime.latestCtx;
						if (!live)
							throw new Error("No live parent context for the fallback launch");
						return normalizePiAttempt(params, live, parentThinking, attempt);
					},
				};
				const session = runtime.session!;
				const handle = await session.spawnPi(input);
				const running = session.getRecord(id)!;
				const startedDetails = session.getStarted(id)!;
				// The tool's signal is not a producer signal. Delivery belongs to RunSession.
				void session.supervise(handle, session.getTask(id)!).catch(() => {
					// Delivery failure retains manual panes; no second send or cleanup producer.
					if (!session.getTask(id)) {
						runningSubagents.delete(running.id);
						updateWidget();
					}
				});
				return {
					content: [
						{
							type: "text",
							text:
								`Sub-agent "${params.name}" launched and is now running in the background` +
								(running.worktree
									? ` in worktree ${running.worktree.path} on branch ${running.worktree.branch}. `
									: ". ") +
								launchDiagnosticsText(running.worktree?.diagnostics, "", " ") +
								`Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
								`The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
								`Until then, move on to other work or tell the user you're waiting.`,
						},
					],
					details: startedDetails,
				};
			},

			renderCall(args, theme) {
				const partialArgs: PartialSubagentArgs = isPlainObject(args)
					? args
					: {};
				const name =
					isString(partialArgs.name) && partialArgs.name
						? partialArgs.name
						: "(unnamed)";
				const task = isString(partialArgs.task) ? partialArgs.task : "";
				const agent =
					isString(partialArgs.agent) && partialArgs.agent
						? theme.fg("dim", ` (${partialArgs.agent})`)
						: "";
				const cwdHint =
					isString(partialArgs.cwd) && partialArgs.cwd
						? theme.fg("dim", ` in ${partialArgs.cwd}`)
						: "";
				const worktree = isPlainObject(partialArgs.worktree)
					? partialArgs.worktree
					: undefined;
				const worktreeHint = isString(worktree?.branch)
					? theme.fg("dim", ` on ${worktree.branch} (worktree)`)
					: "";
				let text =
					"▸ " +
					theme.fg("toolTitle", theme.bold(name)) +
					agent +
					cwdHint +
					worktreeHint;

				// Show a one-line task preview. renderCall is called repeatedly as the
				// LLM generates tool arguments, so args.task grows token by token.
				// We keep it compact here — Ctrl+O on renderResult expands the full content.
				if (task) {
					const firstLine =
						task.split("\n").find((l: string) => l.trim()) ?? "";
					const preview =
						firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
					if (preview) {
						text += "\n" + theme.fg("toolOutput", preview);
					}
					const totalLines = task.split("\n").length;
					if (totalLines > 1) {
						text += theme.fg("muted", ` (${totalLines} lines)`);
					}
				}

				return new Text(text, 0, 0);
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as any;
				const name = details?.name ?? "(unnamed)";

				// "Started" result — tool returned immediately
				if (details?.status === "started") {
					const runtime = details?.model
						? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
						: " — started";
					const worktree = details?.worktree?.branch
						? ` · ${details.worktree.branch}`
						: "";
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							theme.fg("dim", runtime + worktree),
						0,
						0,
					);
				}

				// Fallback (shouldn't happen)
				return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
			},
		});

	// ── subagent_send tool ──
	if (shouldRegister("subagent_send"))
		pi.registerTool({
			name: "subagent_send",
			label: "Send Persistent Task",
			description:
				"Deliver one follow-up task to an idle persistent specialist. Busy specialists reject tasks; no queue is kept.",
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({
						description: "Exact persistent specialist logical ID",
					}),
				),
				name: Type.Optional(
					Type.String({
						description: "Exact unambiguous persistent specialist name",
					}),
				),
				message: Type.String({ description: "The next task" }),
			}),
			async execute(_toolCallId, params) {
				const target = resolvePersistentTarget(params);
				if ("error" in target)
					return {
						content: [{ type: "text", text: target.error }],
						details: { error: target.error },
					};
				const details = await runtime.session!.sendPersistent(
					runtime.session!.getControlTaskId(target.running.id)!,
					params.message,
				);
				const text =
					"error" in details
						? details.error
						: `Task ${details.task} dispatched to persistent specialist "${target.running.name}".`;
				return { content: [{ type: "text", text }], details };
			},
		});

	// ── subagent_stop tool ──
	if (shouldRegister("subagent_stop"))
		pi.registerTool({
			name: "subagent_stop",
			label: "Stop Persistent Specialist",
			description:
				"Gracefully stop a persistent specialist after its active task settles. Exit is confirmed before the specialist is removed.",
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({
						description: "Exact persistent specialist logical ID",
					}),
				),
				name: Type.Optional(
					Type.String({
						description: "Exact unambiguous persistent specialist name",
					}),
				),
			}),
			async execute(_toolCallId, params) {
				const target = resolvePersistentTarget(params);
				if ("error" in target)
					return {
						content: [{ type: "text", text: target.error }],
						details: { error: target.error },
					};
				const details = await runtime.session!.stopPersistent(
					runtime.session!.getControlTaskId(target.running.id)!,
				);
				const text =
					"error" in details
						? details.error
						: details.status === "stop_pending"
							? `Stop pending for persistent specialist "${target.running.name}"; its active task will settle first.`
							: `Stop requested for persistent specialist "${target.running.name}".`;
				return { content: [{ type: "text", text }], details };
			},
		});

	// ── subagent_interrupt tool ──
	if (shouldRegister("subagent_interrupt"))
		pi.registerTool({
			name: "subagent_interrupt",
			label: "Interrupt Subagent",
			description:
				"Send Escape to the active turn of a currently running Pi-backed subagent. " +
				"The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
				"and does not emit a subagent_result solely because of this request.",
			promptSnippet:
				"Send Escape to the active turn of a currently running Pi-backed subagent. " +
				"The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
				"and does not emit a subagent_result solely because of this request.",
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({ description: "Exact running subagent id" }),
				),
				name: Type.Optional(
					Type.String({ description: "Exact running subagent display name" }),
				),
			}),

			async execute(_toolCallId, params) {
				return handleSubagentInterrupt(params);
			},

			renderCall(args, theme) {
				const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(target)) +
						theme.fg("dim", " — interrupt turn"),
					0,
					0,
				);
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as any;
				if (details?.status === "interrupt_requested") {
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg(
								"toolTitle",
								theme.bold(details.name ?? details.id ?? "subagent"),
							) +
							theme.fg("dim", " — interrupt requested"),
						0,
						0,
					);
				}

				return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
			},
		});

	// ── subagent_cancel tool ──
	if (shouldRegister("subagent_cancel"))
		pi.registerTool({
			name: "subagent_cancel",
			label: "Cancel Subagent",
			description: SUBAGENT_CANCEL_DESCRIPTION,
			promptSnippet: SUBAGENT_CANCEL_DESCRIPTION,
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({ description: "Exact running subagent id" }),
				),
				name: Type.Optional(
					Type.String({
						description: "Exact unambiguous running subagent display name",
					}),
				),
			}),

			async execute(_toolCallId, params) {
				return handleSubagentCancel(params);
			},

			renderCall(args, theme) {
				const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(target)) +
						theme.fg("dim", " — cancel run"),
					0,
					0,
				);
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as SubagentCancelDetails | undefined;
				if (details?.status)
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg(
								"toolTitle",
								theme.bold(details.name ?? details.id ?? "subagent"),
							) +
							theme.fg("dim", ` — cancel ${details.status}`),
						0,
						0,
					);
				return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
			},
		});

	// ── subagents_list tool ──
	if (shouldRegister("subagents_list"))
		pi.registerTool({
			name: "subagents_list",
			label: "List Subagents",
			description:
				"List all available package, global, and project subagent definitions. " +
				"Project agents override global definitions, which override package definitions.",
			promptSnippet:
				"List all available package, global, and project subagent definitions. " +
				"Project agents override global definitions, which override package definitions.",
			parameters: Type.Object({}),

			async execute() {
				const catalog = discoverAgentCatalog(pi);
				const list = catalog.agents.filter(
					(agent) => !agent.disableModelInvocation,
				);
				const lines = [
					...formatVisibleAgentDefinitions(list),
					...formatLivePersistentSpecialists(),
					...formatSupervisionDiagnostics(),
					...formatAgentDiagnostics(catalog.diagnostics),
				];

				return {
					content: [
						{
							type: "text",
							text: lines.join("\n") || "No subagent definitions found.",
						},
					],
					details: {
						agents: list.map(({ role: _role, ...definition }) => definition),
						diagnostics: catalog.diagnostics,
					},
				};
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as any;
				const agents = details?.agents ?? [];
				const diagnostics = details?.diagnostics ?? [];
				if (agents.length === 0 && diagnostics.length === 0) {
					return new Text(
						theme.fg("dim", "No subagent definitions found."),
						0,
						0,
					);
				}
				const lines = agents.map((a: any) => {
					const source =
						a.source === "package" && a.provider
							? `package:${a.provider}`
							: a.source;
					const badge = theme.fg("accent", ` (${source})`);
					const desc = a.description
						? theme.fg("dim", ` — ${a.description}`)
						: "";
					const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
					return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
				});
				for (const diagnostic of diagnostics) {
					lines.push(theme.fg("warning", `  ! ${diagnostic.message}`));
				}
				return new Text(lines.join("\n"), 0, 0);
			},
		});

	// ── subagent_resume tool ──
	if (shouldRegister("subagent_resume"))
		pi.registerTool({
			name: "subagent_resume",
			label: "Resume Subagent",
			description:
				"Resume a previous Pi-backed sub-agent session in a new herdr pane. " +
				"This does not reattach a retained managed worktree; continue worktree-bound follow-up in its existing workspace. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			promptSnippet:
				"Resume a previous Pi-backed sub-agent session in a new herdr pane. " +
				"This does not reattach a retained managed worktree; continue worktree-bound follow-up in its existing workspace. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			parameters: Type.Object({
				sessionPath: Type.String({
					description: "Path to the session .jsonl file to resume",
				}),
				name: Type.Optional(
					Type.String({
						description: "Display name for the terminal tab. Default: 'Resume'",
					}),
				),
				message: Type.Optional(
					Type.String({
						description:
							"Optional message to send after resuming (e.g. follow-up instructions)",
					}),
				),
				autoExit: Type.Optional(
					Type.Boolean({
						description:
							"Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
					}),
				),
			}),

			renderCall(args, theme) {
				const name = args.name ?? "Resume";
				const text =
					"▸ " +
					theme.fg("toolTitle", theme.bold(name)) +
					theme.fg("dim", " — resuming session");
				return new Text(text, 0, 0);
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as any;
				const name = details?.name ?? "Resume";

				if (details?.status === "started") {
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							theme.fg("dim", " — resumed"),
						0,
						0,
					);
				}

				// Fallback
				return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
			},

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const name = params.name ?? "Resume";

				if (!runtime.session!.availability().available) {
					return muxUnavailableResult();
				}

				if (!existsSync(params.sessionPath)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: session file not found: ${params.sessionPath}`,
							},
						],
						details: { error: "session not found" },
					};
				}

				runtime.latestCtx = ctx;
				const controlTaskId = randomUUID();
				const session = runtime.session!;
				const handle = await session.resumePi({
					taskId: controlTaskId,
					name,
					sessionPath: params.sessionPath,
					message: params.message,
					autoExit: params.autoExit,
				});
				const started = session.getStarted(controlTaskId)!;
				const id = started.id;
				void session
					.supervise(handle, session.getTask(controlTaskId)!)
					.catch(() => {
						if (!session.getTask(controlTaskId)) {
							runningSubagents.delete(id);
							updateWidget();
						}
					});

				return {
					content: [{ type: "text", text: `Session "${name}" resumed.` }],
					details: {
						id,
						name,
						sessionPath: params.sessionPath,
						launchScriptFile: started.launchScriptFile,
						status: "started",
					},
				};
			},
		});

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

	pi.registerCommand("worktree", {
		description: parentSession
			? "Fork into a worktree, list retained worktrees, or explicitly remove one"
			: "Fork this session into a worktree; use /worktree list to inspect them",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (trimmed === "list") {
				if (!runtime.session!.availability().available) {
					ctx.ui.notify(runtime.session!.availability().setupHint, "error");
					return;
				}
				try {
					ctx.ui.notify(
						parentSession
							? formatWorktreeInventory(
									await listContainedWorktrees(cleanupInput(ctx)),
								)
							: (await runtime.session!.listWorktreeSurfaces({ cwd: ctx.cwd }))
									.map(
										(worktree) =>
											`${worktree.branch || "(detached HEAD)"} — ${worktree.path}${worktree.workspaceId ? ` (${worktree.workspaceId})` : ""}`,
									)
									.join("\n") || "No worktrees found.",
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`Worktree list failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}

			if (parts[0] === "remove") {
				if (!parentSession) {
					ctx.ui.notify("Worktree removal is parent-only.", "warning");
					return;
				}
				const preserve = parts.at(-1) === "--preserve";
				const target = trimmed
					.slice("remove".length)
					.trim()
					.replace(/\s+--preserve$/, "");
				if (!target || target === "--preserve") {
					ctx.ui.notify(
						"Usage: /worktree remove <path|branch|workspace-id> [--preserve]",
						"warning",
					);
					return;
				}
				const result = await removeContainedWorktree({
					...cleanupInput(ctx),
					target,
					preserve,
				});
				ctx.ui.notify(
					result.message,
					result.status === "removed" || result.status === "already-removed"
						? "info"
						: "warning",
				);
				return;
			}
			const branch = parts.shift();
			if (!branch || branch === "list") {
				ctx.ui.notify(
					parentSession
						? "Usage: /worktree <name> [task] | /worktree list | /worktree remove <target> [--preserve]"
						: "Usage: /worktree <name> [task] | /worktree list",
					"warning",
				);
				return;
			}
			if (!runtime.session!.availability().available) {
				ctx.ui.notify(runtime.session!.availability().setupHint, "error");
				return;
			}

			try {
				await ctx.waitForIdle();
				const sessionFile = ctx.sessionManager.getSessionFile();
				const leafId = ctx.sessionManager.getLeafId();
				if (!sessionFile || !leafId) {
					throw new Error(
						"Start pi with a completed persistent session before handing off",
					);
				}
				if (!ctx.model) throw new Error("No parent model is selected");
				const thinking = pi.getThinkingLevel();
				if (!isThinkingLevel(thinking)) {
					throw new Error(`Unsupported parent thinking level: ${thinking}`);
				}
				const task =
					parts.join(" ") || "Continue the current work in the new worktree.";
				const runtimePlan = resolveRuntimePlan(
					{},
					{},
					{
						provider: ctx.model.provider,
						modelId: ctx.model.id,
						thinking,
					},
					wrapPiModelRegistry(ctx.modelRegistry),
				);
				const result = await runtime.session!.handoffWorktree({
					name: `wt: ${branch}`,
					task,
					branch,
					leafId,
					runtimePlan,
					snapshot: {
						parent: {
							cwd: ctx.cwd,
							invocationCwd: process.cwd(),
							sessionFile,
							sessionId: ctx.sessionManager.getSessionId(),
							sessionDir: ctx.sessionManager.getSessionDir(),
							agentDir: getAgentConfigDir(),
						},
						paneConfig,
						modelRegistry: wrapPiModelRegistry(ctx.modelRegistry),
					},
				});
				const worktree = result.record.worktree;
				if (!worktree) {
					throw new Error("Worktree handoff did not return worktree metadata");
				}
				ctx.ui.notify(
					(result.focusError
						? `Worktree launched, but workspace focus failed: ${result.focusError}\nWorktree: ${worktree.path}`
						: `Worktree launched in ${worktree.path} (workspace ${worktree.workspaceId}).`) +
						launchDiagnosticsText(worktree.diagnostics, "\n", ""),
					result.focusError || worktree.diagnostics?.length
						? "warning"
						: "info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Worktree launch failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	// /subagent command — spawn a subagent by name, or list available agents
	pi.registerCommand("subagent", {
		description:
			"Spawn a subagent: /subagent <agent> <task>; list agents: /subagent list",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "list") {
				const catalog = discoverAgentCatalog(pi);
				const lines = [
					...formatVisibleAgentDefinitions(catalog.agents),
					...formatAgentDiagnostics(catalog.diagnostics),
				];
				ctx.ui.notify(
					lines.join("\n") || "No subagent definitions found.",
					"info",
				);
				return;
			}
			if (!trimmed) {
				ctx.ui.notify(
					"Usage: /subagent <agent> [task] | /subagent list",
					"warning",
				);
				return;
			}

			const spaceIdx = trimmed.indexOf(" ");
			const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

			const catalog = discoverAgentCatalog(pi);
			const defs = catalog.agents.find((agent) => agent.name === agentName);
			if (!defs) {
				const diagnostic = catalog.diagnostics.find(
					(candidate) => candidate.agentName === agentName,
				);
				ctx.ui.notify(
					diagnostic?.message ?? missingRoleMessage(agentName),
					"error",
				);
				return;
			}

			const taskText =
				task || `You are the ${agentName} agent. Wait for instructions.`;
			const displayName = agentName[0].toUpperCase() + agentName.slice(1);
			const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
			pi.sendUserMessage(toolCall);
		},
	});

	// ── subagent_result message renderer ──
	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_result"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const exitCode = details.exitCode ?? 0;
				const errorMessage = isString(details.errorMessage)
					? details.errorMessage
					: "";
				const failed = exitCode !== 0 || !!errorMessage;
				const elapsed =
					details.elapsed == null ? "?" : formatElapsed(details.elapsed);
				const bgFn = failed
					? (text: string) => theme.bg("toolErrorBg", text)
					: (text: string) => theme.bg("toolSuccessBg", text);
				const cancelled = details.error === "cancelled";
				const icon = cancelled
					? theme.fg("warning", "■")
					: failed
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const status = cancelled
					? "cancelled"
					: errorMessage
						? "failed (provider/agent error)"
						: failed
							? `failed (exit ${exitCode})`
							: "completed";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";

				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
				const rawContent = isString(details.resultContent)
					? details.resultContent
					: isString(message.content)
						? message.content
						: "";

				// Clean summary (remove session ref and leading label for display)
				const summary = rawContent
					.replace(/\n\nSession: .+\nResume: .+$/, "")
					.replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
					.replace(
						`Sub-agent "${name}" was cancelled by the parent after ${elapsed}. `,
						"",
					)
					.replace(
						`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`,
						"",
					)
					.replace(
						new RegExp(
							`^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error\\)\\.\\n\\n`,
						),
						"",
					);

				// Build content for the box
				const contentLines = [header];

				if (options.expanded) {
					// Full view: complete summary + session info
					if (summary) {
						for (const line of summary.split("\n")) {
							contentLines.push(line.slice(0, width - 6));
						}
					}
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(
							theme.fg("dim", `Session: ${details.sessionFile}`),
						);
						contentLines.push(
							theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`),
						);
					}
				} else {
					// Collapsed: preview + expand hint
					if (summary) {
						const previewLines = summary.split("\n").slice(0, 5);
						for (const line of previewLines) {
							contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
						}
						const totalLines = summary.split("\n").length;
						if (totalLines > 5) {
							contentLines.push(
								theme.fg("muted", `… ${totalLines - 5} more lines`),
							);
						}
					}
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				// Render via Box for background + padding, with blank line above for separation
				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_status message renderer ──
	pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_status"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		const lines = Array.isArray(details?.lines) ? details.lines : [];
		const overflow = isFiniteNumber(details?.overflow) ? details.overflow : 0;
		if (lines.length === 0 && overflow === 0) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const lineWidth = Math.max(0, width - 6);
				const contentLines = [
					`${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
					...lines.map((line: string) =>
						theme.fg("dim", truncateToWidth(line, lineWidth)),
					),
				];

				if (overflow > 0) {
					contentLines.push(theme.fg("muted", `+${overflow} more running.`));
				}
				if (!options.expanded) {
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				const box = new Box(1, 1, (text: string) =>
					theme.bg("customMessageBg", text),
				);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_ping message renderer ──
	pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_ping"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";
				const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

				const icon = theme.fg("accent", "?");
				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

				const contentLines = [header];

				if (options.expanded) {
					contentLines.push("");
					contentLines.push(details.message ?? "");
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(
							theme.fg("dim", `Session: ${details.sessionFile}`),
						);
					}
				} else {
					const preview = (details.message ?? "")
						.split("\n")[0]
						.slice(0, width - 10);
					contentLines.push(theme.fg("dim", preview));
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});
}
