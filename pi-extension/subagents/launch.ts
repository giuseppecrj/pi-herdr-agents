import { randomUUID } from "node:crypto";
import type {
	PiLaunchSnapshot,
	PiAttemptSnapshot,
} from "../../maestro/runtime/index.ts";
import {
	resolveRuntimePlans,
	type ResolvedRuntimePlan,
	type ThinkingLevel,
} from "../../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "./model-registry.ts";
import {
	resolveModelDefault,
	type ModelConfig,
} from "../../maestro/core/config/model-config.ts";
import { getAgentConfigDir } from "./config-path.ts";
import type { PaneConfig } from "../../maestro/core/config/pane-config.ts";
import type { SubagentRuntime } from "./state.ts";
import {
	SubagentParams,
	resolveDenyTools,
	discoverAgentCatalog,
	missingRoleMessage,
	resolveEffectiveSessionMode,
	resolveEffectivePersistent,
	resolveEffectiveAutoExit,
	resolveEffectiveInteractive,
	loadAgentDefaults,
} from "./catalog.ts";

interface LaunchPlannerDeps {
	runtime: SubagentRuntime;
	modelConfig: ModelConfig;
	paneConfig: PaneConfig;
}

export type LaunchPlanner = ReturnType<typeof createLaunchPlanner>;

/** Launch snapshots and runtime plans bound to one extension instance. */
export function createLaunchPlanner({
	runtime,
	modelConfig,
	paneConfig,
}: LaunchPlannerDeps) {
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

	return { normalizePiAttempt, resolveSubagentRuntimePlans, launchSnapshot };
}
