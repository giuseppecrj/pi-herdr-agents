import { withEncodedToolErrors } from "./tool-boundary.ts";
import { trackDeferredTools } from "./deferred-tools.ts";
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
import { sessionModelRegistry, sessionScopedModels } from "./model-registry.ts";
import { loadModelConfig } from "../../maestro/core/config/model-config.ts";
import {
	getAgentConfigDir,
	getSubagentsConfigDir,
	getSubagentsConfigExamplePath,
	getSubagentsConfigPath,
} from "./config-path.ts";
import { loadRoleConfig } from "../../maestro/core/config/role-config.ts";
import { loadPersistentConfig } from "../../maestro/core/config/persistent-config.ts";
import { loadSpawningConfig } from "../../maestro/core/config/spawning-config.ts";
import { loadOutcomeLedgerConfig } from "../../maestro/core/config/outcome-ledger-config.ts";
import { loadPaneConfig } from "../../maestro/core/config/pane-config.ts";
import { loadGuidelinesConfig } from "../../maestro/core/config/guidelines-config.ts";
import { loadStatusConfig } from "../../maestro/core/status.ts";
import { markDelivery } from "../../maestro/core/lifecycle.ts";
import type { WorktreeCleanupOperations } from "../../maestro/core/worktree-cleanup.ts";
import {
	CHILD_BUSY_CHANNEL,
	type ChildBusyProbe,
} from "../../maestro/core/child-busy.ts";
import {
	WIDGET_INTERVAL_KEY,
	STATUS_INTERVAL_KEY,
	RUNTIME_KEY,
	readGlobalSlot,
	writeGlobalSlot,
	type SubagentResult,
	type RunningSubagent,
	type SubagentRuntime,
	hasWorkingSubagents,
	shouldDeliverSubagentCompletion,
	selectCompletionApi,
	bindLiveApi,
	releaseHeldDeliveries,
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
	sendSubagentResult,
	resolveResultPresentation,
} from "./presentation.ts";
import type { PiPresentationHooks } from "./presentation-hooks.ts";
import type { HostSurfaceBinding } from "../../maestro/runtime/host-surface-binding.ts";
import {
	createObservation,
	formatNoProgressAdvisoryLine,
	normalizeAdoptedRows,
} from "./observation.ts";
import { createControls } from "./controls.ts";
import {
	persistentSpecialistState,
	createPersistentControls,
} from "./persistent.ts";
import { createDelivery } from "./delivery.ts";
import { createLaunchPlanner } from "./launch.ts";

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

export {
	hasWorkingSubagents,
	shouldDeliverSubagentCompletion,
	selectCompletionApi,
};

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
		agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
		agent.abortController?.abort();
	}
	agents.clear();
}

export function shouldAdvanceToFallback(
	result: Pick<SubagentResult, "errorMessage">,
	remainingPlans: number,
	persistent = false,
): boolean {
	return !persistent && result.errorMessage !== undefined && remainingPlans > 0;
}

function shouldRetainSubagentSurface(
	running: Pick<RunningSubagent, "worktree"> | { worktree?: unknown },
): boolean {
	return !!running.worktree;
}

export interface PiHostOptions {
	hostSurface: HostSurfaceBinding;
	presentation: PiPresentationHooks;
	childEntryPath?: string;
	configAssetRoot?: string;
	configExamplePath?: string;
}

/** Invoked once by the terminal entry on every Pi load, including /reload. */
export function createPiExtension(hostOptions: PiHostOptions) {
	const { presentation } = hostOptions;
	const configExamplePath =
		hostOptions.configExamplePath ??
		getSubagentsConfigExamplePath(hostOptions.configAssetRoot);
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

	const statusConfig = loadStatusConfig(
		getSubagentsConfigPath(),
		configExamplePath,
	);
	const modelConfig = loadModelConfig(getSubagentsConfigDir());
	const roleConfig = loadRoleConfig(getSubagentsConfigDir(), configExamplePath);
	const persistentConfig = loadPersistentConfig(
		getSubagentsConfigDir(),
		configExamplePath,
	);
	const spawningConfig = loadSpawningConfig(
		getSubagentsConfigDir(),
		configExamplePath,
	);
	const outcomeLedgerConfig = loadOutcomeLedgerConfig(
		getSubagentsConfigDir(),
		configExamplePath,
	);
	const supervisionConfig = loadSupervisionConfig(
		getSubagentsConfigDir(),
		configExamplePath,
	);

	const paneConfig = loadPaneConfig(getSubagentsConfigDir(), configExamplePath);
	const guidelinesConfig = loadGuidelinesConfig(
		getSubagentsConfigDir(),
		configExamplePath,
	);

	const subagentRoutingGuidelines = buildSubagentRoutingGuidelines(
		undefined,
		undefined,
		guidelinesConfig,
	);

	/** Presentation rows share the adapter's records; only RunSession owns runs. */
	const runtime: SubagentRuntime = readGlobalSlot<SubagentRuntime>(
		RUNTIME_KEY,
	) ?? {
		runningSubagents: new Map<string, RunningSubagent>(),
	};
	// A slot from a version before lifecycle rows may hold rows without one.
	normalizeAdoptedRows(runtime.runningSubagents.values());
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
	} = presentation.createWidgets({
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

	const __test__ = {
		borderLine: presentation.borderLine,
		renderSubagentWidgetLines,
		updateWidget,
		loadAgentDefaults,
		discoverAgentCatalog,
		resolveEffectiveSessionMode,
		resolveLaunchBehavior,
		resolveEffectiveAutoExit,
		resolveEffectiveInteractive,
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
		shouldAdvanceToFallback,
		deliverPersistentTaskEvent,
		drainPersistentTaskEvents,
		notifyPersistentCrash,
		sendSubagentResult,
		shouldRetainSubagentSurface,
		formatLivePersistentSpecialists,
		runningSubagents,
	};

	function subagentsExtension(
		pi: ExtensionAPI,
		options: {
			cleanupOperations?: (ctx: ExtensionContext) => WorktreeCleanupOperations;
			infrastructure?: PiRunSessionInfrastructure;
			/** Host platform for the Windows support scope; tests inject win32. */
			platform?: NodeJS.Platform;
		} = {},
	) {
		runtime.session = createDefaultRunSession(
			{
				configDir: getAgentConfigDir(),
				configExamplePath,
				hostSurface: hostOptions.hostSurface,
				childEntryPath: hostOptions.childEntryPath,
				roles: [],
				forcePolling: supervisionConfig.forcePolling,
				outcomeLedger: outcomeLedgerConfig.enabled,
				infrastructure: options.infrastructure,
				platform: options.platform,
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
						runtime.persistentReservations?.delete(record.id);
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
						// An unread event retries on a later wake once an API is live again.
						if (runtime.liveApi)
							drainPersistentTaskEvents(record, runtime.liveApi, io);
					},
				},
			},
			runtime.session,
		);
		runtime.pi = pi;
		const parentSession = !process.env.PI_SUBAGENT_ID;
		// Report accepted no-op role settings once per parent extension load, not on
		// every session transition, listing, or child launch.
		let roleConfigDeprecationsReported = !parentSession;
		const cleanupInput = (ctx: ExtensionContext) => {
			// Refuse before injected or default cleanup operations can run.
			const refusal = runtime.session!.managedWorktreeRefusal();
			if (refusal) throw new Error(refusal);
			return {
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
									? [
											{
												path: child.worktree.path,
												persistent: child.persistent,
											},
										]
									: [],
							),
					}),
			};
		};
		// Routine tools are deferred: their schemas and guidelines reach the model
		// only after Pi's tool_search loads them.
		const deferredTools = trackDeferredTools(pi);
		// Capture the UI context for widget updates and restore presentation for
		// subagents whose watchers survived a reload.
		pi.on("session_start", async (_event, ctx) => {
			runtime.latestCtx = ctx;
			// Every extension has registered by now, so Pi's tool_search is known.
			deferredTools.ensureReachable();
			// This load's API is bound now: deliver results held across the gap.
			bindLiveApi(runtime, pi);
			if (!roleConfigDeprecationsReported) {
				roleConfigDeprecationsReported = true;
				for (const message of roleConfig.deprecations)
					ctx.ui.notify(message, "warning");
			}
			// Scoped sessions (--models / enabledModels) advertise only the scoped
			// set: sessionModelRegistry hides out-of-scope models from the catalog
			// and its task shortlists alike.
			const registry = sessionModelRegistry(ctx);
			const scopedModels = sessionScopedModels(ctx, registry);
			const authenticatedTaskPreferences = getAuthenticatedTaskPreferences(
				registry,
				modelConfig.tasks,
			);
			runtime.modelCatalog = scopedModels
				? buildScopedModelCatalog(
						registry,
						scopedModels,
						modelConfig.tasks,
						24,
						modelConfig.tasksThinking,
					)
				: buildAuthenticatedModelCatalog(
						registry,
						24,
						modelConfig.tasks,
						modelConfig.tasksThinking,
					);
			const refreshedGuidelines = buildSubagentRoutingGuidelines(
				runtime.modelCatalog,
				authenticatedTaskPreferences,
				guidelinesConfig,
			);
			subagentRoutingGuidelines.splice(
				0,
				subagentRoutingGuidelines.length,
				...refreshedGuidelines,
			);
			// Pi copies guidelines at registration. Refresh its copy now that the
			// current session's model catalog and task preferences are known.
			registerLaunchTool();
			if (runningSubagents.size > 0) {
				startWidgetRefresh();
				startStatusRefresh(pi);
				updateWidget();
			}
		});

		// A child that is itself waiting on subagents is not asked whether it is done.
		const stopChildBusy = pi.events.on(CHILD_BUSY_CHANNEL, (raw) => {
			// SAFETY: the channel's only emitter, isChildBusy, sends a ChildBusyProbe.
			const probe = raw as ChildBusyProbe | undefined;
			if (probe && hasWorkingSubagents(runningSubagents.values()))
				probe.busy = true;
		});

		// Clean up on session shutdown
		pi.on("session_shutdown", async (event, _ctx) => {
			stopChildBusy();
			stopRefresh();
			// Pi invalidates this context and API once shutdown returns. Watchers that
			// survive a reload must neither read the context nor send through the API;
			// completions that settle, and fallbacks that prepare, before the next
			// session_start are held. A quit ends the gap: nothing will bind again.
			runtime.latestCtx = undefined;
			runtime.liveApi = undefined;
			runtime.reloadGap = shouldPreserveSubagentsOnShutdown(event.reason);

			const session = runtime.session;
			const shutdown = session?.shutdown(event.reason);
			if (!shouldPreserveSubagentsOnShutdown(event.reason)) {
				runtime.persistentReservations?.clear();
				for (const running of runningSubagents.values())
					if (running.stopTimeout) clearTimeout(running.stopTimeout);
				// Also gate/abort legacy rows retained from a pre-composition reload.
				// Do not infer ownership or reconstruct their watchers.
				cleanupSubagentsForShutdown(event.reason, runningSubagents);
				// No replacement session will start: held completions are suppressed and
				// waiting fallback preparations end without launching.
				releaseHeldDeliveries(runtime, undefined);
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

		// Every tool and command registers through one boundary that encodes
		// thrown errors before they reach the parent.
		const host = withEncodedToolErrors(deferredTools.api);

		registerWorktreeTools(host, { parentSession, cleanupInput });

		registerTaskModelTool(host, { shouldRegister, configExamplePath });

		function registerLaunchTool(): void {
			registerSubagentTool(host, {
				renderers: presentation.toolRenderers,
				shouldRegister,
				runtime,
				updateWidget,
				subagentRoutingGuidelines,
				persistentCapacityError,
				resolveSubagentRuntimePlans,
				normalizePiAttempt,
				spawningConfig,
			});
		}
		registerLaunchTool();

		registerControlTools(host, {
			renderers: presentation.toolRenderers,
			shouldRegister,
			runtime,
			supervisionConfig,
			resolvePersistentTarget,
			handleSubagentInterrupt,
			handleSubagentCancel,
			formatLivePersistentSpecialists,
		});

		registerResumeTool(host, {
			renderers: presentation.toolRenderers,
			shouldRegister,
			runtime,
			updateWidget,
			spawningConfig,
		});

		registerTaskModelInit(host);

		registerWorktreeCommand(host, {
			runtime,
			parentSession,
			cleanupInput,
			paneConfig,
		});

		registerSubagentCommand(host);

		presentation.registerMessageRenderers(pi);
	}

	return Object.assign(subagentsExtension, { __test__ });
}
