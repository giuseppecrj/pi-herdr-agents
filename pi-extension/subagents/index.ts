import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
	createDefaultRunSession,
	type PiRunSessionInfrastructure,
} from "../../maestro/runtime/index.ts";
import { loadSupervisionConfig } from "../../maestro/core/config/supervision-config.ts";
import {
	buildAuthenticatedModelCatalog,
	buildScopedModelCatalog,
	getAuthenticatedTaskPreferences,
	isThinkingLevel,
} from "../../maestro/core/routing.ts";
import { sessionModelRegistry } from "./model-registry.ts";
import { loadModelConfig } from "../../maestro/core/config/model-config.ts";
import {
	getAgentConfigDir,
	getSubagentsConfigDir,
	getSubagentsConfigExamplePath,
	getSubagentsConfigPath,
} from "./config-path.ts";
import { loadRoleConfig } from "../../maestro/core/config/role-config.ts";
import { loadPersistentConfig } from "../../maestro/core/config/persistent-config.ts";
import { loadPaneConfig } from "../../maestro/core/config/pane-config.ts";
import { loadStatusConfig } from "../../maestro/core/status.ts";
import { markDelivery } from "../../maestro/core/lifecycle.ts";
import type { WorktreeCleanupOperations } from "../../maestro/core/worktree-cleanup.ts";
import {
	WIDGET_INTERVAL_KEY,
	STATUS_INTERVAL_KEY,
	RUNTIME_KEY,
	readGlobalSlot,
	writeGlobalSlot,
	type SubagentResult,
	type RunningSubagent,
	type SubagentRuntime,
	shouldDeliverSubagentCompletion,
	selectCompletionApi,
} from "./state.ts";
import {
	buildSubagentRoutingGuidelines,
	resolveDenyTools,
	discoverAgentCatalog,
	resolveEffectiveSessionMode,
	resolveLaunchBehavior,
	resolveEffectiveAutoExit,
	resolveEffectiveInteractive,
	loadAgentDefaults,
} from "./catalog.ts";
import {
	boundChildDelivery,
	resolveUnexpectedErrorPresentation,
	sendSubagentResult,
	resolveResultPresentation,
} from "./presentation.ts";
import { registerMessageRenderers } from "./renderers.ts";
import {
	createObservation,
	formatNoProgressAdvisoryLine,
} from "./observation.ts";
import { createControls } from "./controls.ts";
import {
	persistentSpecialistState,
	createPersistentControls,
} from "./persistent.ts";
import { createDelivery } from "./delivery.ts";
import { buildPiPromptArgs, createLaunchPlanner } from "./launch.ts";
import { borderLine, createWidgetController } from "./widgets.ts";
import {
	registerWorktreeTools,
	registerWorktreeCommand,
} from "./worktree-tools.ts";
import { registerTaskModelTool, registerTaskModelInit } from "./task-models.ts";
import { registerControlTools } from "./control-tools.ts";
import {
	registerSubagentTool,
	registerResumeTool,
	registerSubagentCommand,
} from "./launch-tools.ts";

export { shouldDeliverSubagentCompletion, selectCompletionApi };

// Replace presentation timers left by a previous load (see state.ts).
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

const subagentRoutingGuidelines = buildSubagentRoutingGuidelines();

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

const paneConfig = loadPaneConfig(
	getSubagentsConfigDir(),
	getSubagentsConfigExamplePath(),
);

/** Presentation rows share the adapter's records; only RunSession owns runs. */
const runtime: SubagentRuntime = readGlobalSlot<SubagentRuntime>(
	RUNTIME_KEY,
) ?? {
	runningSubagents: new Map<string, RunningSubagent>(),
};
writeGlobalSlot(RUNTIME_KEY, runtime);
const runningSubagents = runtime.runningSubagents;
const { observeRunningSubagent, evaluateNoProgressAdvisory } =
	createObservation(runtime);
const {
	renderSubagentWidgetLines,
	updateWidget,
	startStatusRefresh,
	startWidgetRefresh,
	stopRefresh,
} = createWidgetController({
	runtime,
	statusConfig,
	supervisionConfig,
	observeRunningSubagent,
	evaluateNoProgressAdvisory,
});
const {
	resolveInterruptTarget,
	requestSubagentInterrupt,
	handleSubagentInterrupt,
	handleSubagentCancel,
} = createControls({ runtime, updateWidget, observeRunningSubagent });
const {
	formatLivePersistentSpecialists,
	resolvePersistentTarget,
	persistentCapacityError,
	startPersistentStopTimeout,
	handleSubagentStop,
	handleSubagentSend,
} = createPersistentControls({
	runtime,
	persistentConfig,
	resolveInterruptTarget,
});
const {
	deliverPersistentTaskEvent,
	drainPersistentTaskEvents,
	notifyPersistentCrash,
	deliverPiCompletion,
} = createDelivery({ runtime, updateWidget, startPersistentStopTimeout });
const { normalizePiAttempt, resolveSubagentRuntimePlans, launchSnapshot } =
	createLaunchPlanner({ runtime, modelConfig, paneConfig });

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

export const __test__ = {
	borderLine,
	renderSubagentWidgetLines,
	loadAgentDefaults,
	discoverAgentCatalog,
	resolveEffectiveSessionMode,
	resolveLaunchBehavior,
	resolveEffectiveAutoExit,
	resolveEffectiveInteractive,
	buildPiPromptArgs,
	observeRunningSubagent,
	evaluateNoProgressAdvisory,
	formatNoProgressAdvisoryLine,
	resolveDenyTools,
	buildSubagentRoutingGuidelines,
	sessionModelRegistry,
	resolveInterruptTarget,
	requestSubagentInterrupt,
	handleSubagentInterrupt,
	handleSubagentSend,
	handleSubagentStop,
	persistentSpecialistState,
	persistentCapacityError,
	resolveResultPresentation,
	boundChildDelivery,
	resolveUnexpectedErrorPresentation,
	shouldAdvanceToFallback,
	deliverPersistentTaskEvent,
	drainPersistentTaskEvents,
	notifyPersistentCrash,
	sendSubagentResult,
	shouldRetainSubagentSurface,
	formatLivePersistentSpecialists,
	runningSubagents,
};

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
		// Scoped sessions (--models / enabledModels) advertise only the scoped
		// set: sessionModelRegistry hides out-of-scope models from the catalog
		// and its task shortlists alike.
		const registry = sessionModelRegistry(ctx);
		const scopedModels = (ctx.scopedModels ?? []).map((entry) => entry.model);
		const authenticatedTaskPreferences = getAuthenticatedTaskPreferences(
			registry,
			modelConfig.tasks,
		);
		runtime.modelCatalog =
			scopedModels.length > 0
				? buildScopedModelCatalog(registry, scopedModels, modelConfig.tasks)
				: buildAuthenticatedModelCatalog(registry, 24, modelConfig.tasks);
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
		stopRefresh();

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

	registerWorktreeTools(pi, { parentSession, cleanupInput });

	registerTaskModelTool(pi, { shouldRegister });

	registerSubagentTool(pi, {
		shouldRegister,
		runtime,
		updateWidget,
		subagentRoutingGuidelines,
		persistentCapacityError,
		resolveSubagentRuntimePlans,
		normalizePiAttempt,
	});

	registerControlTools(pi, {
		shouldRegister,
		runtime,
		supervisionConfig,
		resolvePersistentTarget,
		handleSubagentInterrupt,
		handleSubagentCancel,
		formatLivePersistentSpecialists,
	});

	registerResumeTool(pi, { shouldRegister, runtime, updateWidget });

	registerTaskModelInit(pi);

	registerWorktreeCommand(pi, {
		runtime,
		parentSession,
		cleanupInput,
		paneConfig,
	});

	registerSubagentCommand(pi);

	registerMessageRenderers(pi);
}
