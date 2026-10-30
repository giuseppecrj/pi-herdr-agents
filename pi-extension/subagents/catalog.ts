import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
	discoverAgentCatalog as discoverCoreAgentCatalog,
	ROLE_PACK_DISCOVERY_EVENT,
	type AgentCatalog,
	type AgentDefaults,
	type AgentDiagnostic,
	type ListedAgentDefinition,
	type SubagentSessionMode,
} from "../../maestro/core/roles/discovery.ts";
import { THINKING_LEVELS } from "../../maestro/core/routing.ts";
import type { TaskPreferences } from "../../maestro/core/config/task-model-types.ts";
import { getAgentConfigDir } from "./config-path.ts";

const LAUNCH_ROSTER_RULE =
	"After the final launch, print a markdown table with the header row `| name | agent kind | role | model | worktree |`, the separator row `|---|---|---|---|---|`, and one row per child (worktree `none` when there is none), then use each name in prompts, handoffs, and results.";

export function buildSubagentRoutingGuidelines(
	catalog?: string,
	authenticatedTaskPreferences?: TaskPreferences,
	options: { launchRoster?: boolean } = {},
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
		"Before launching a new group of subagents, choose a short task slug and name each new child <task>-<role>[-n], for example login-api or login-test2. Use only plan, research, ui, api, build, test, review, browser, security, perf, or merge as roles; leave existing names unchanged. " +
			(options.launchRoster === false
				? "Use each name in prompts, handoffs, and results."
				: LAUNCH_ROSTER_RULE),
		catalog ??
			"Authenticated subagent model catalog becomes available after session start.",
	];
}

const ThinkingLevelSchema = Type.Union(
	THINKING_LEVELS.map((level) => Type.Literal(level)),
	{
		description:
			"Pi thinking level. Pick the model tier first, then set thinking within that model's range: minimal/low for bounded mechanical work, medium for ordinary implementation or review, high+ for architecture, security, or hard diagnosis. Omitting still inherits the parent level; do not omit on orchestrated child work.",
	},
);

export const SubagentParams = Type.Object({
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
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
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

export function discoverAgentCatalog(
	pi?: Pick<ExtensionAPI, "events">,
): AgentCatalog {
	return discoverCoreAgentCatalog({
		agentConfigDir: getAgentConfigDir(),
		cwd: process.cwd(),
		onRolePackDiscovered: pi?.events
			? (event) => pi.events.emit(ROLE_PACK_DISCOVERY_EVENT, event)
			: undefined,
	});
}

export function missingRoleMessage(agentName: string): string {
	return `Agent "${agentName}" was not found. pi-herdr-agents ships no roles: define it in .pi/agents or the global agents directory, install a role pack that provides it, or omit agent for a bare launch.`;
}

function formatAgentSource(agent: ListedAgentDefinition): string {
	return agent.source === "package" && agent.provider
		? `package:${agent.provider}`
		: agent.source;
}

export function formatVisibleAgentDefinitions(
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

export function formatAgentDiagnostics(
	diagnostics: AgentDiagnostic[],
): string[] {
	return diagnostics.map((diagnostic) => `! ${diagnostic.message}`);
}

export function resolveEffectiveSessionMode(
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

export function resolveLaunchBehavior(
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
export function resolveEffectivePersistent(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	return params.persistent ?? agentDefs?.persistent ?? false;
}

export function resolveEffectiveAutoExit(
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

export function resolveEffectiveInteractive(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	if (params.interactive != null) return params.interactive;
	if (resolveEffectivePersistent(params, agentDefs)) return false;
	if (agentDefs?.interactive != null) return agentDefs.interactive;
	return !resolveEffectiveAutoExit(params, agentDefs);
}

export function loadAgentDefaults(
	agentName: string,
	pi?: Pick<ExtensionAPI, "events">,
): ListedAgentDefinition | null {
	return (
		discoverAgentCatalog(pi).agents.find((agent) => agent.name === agentName) ??
		null
	);
}
