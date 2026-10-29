import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
	createDefaultRunSession,
	type PiRunSessionInfrastructure,
	type PiLaunchInput,
} from "../../maestro/runtime/index.ts";
import { loadSupervisionConfig } from "../../maestro/core/config/supervision-config.ts";
import {
	buildAuthenticatedModelCatalog,
	getAuthenticatedTaskPreferences,
	isThinkingLevel,
} from "../../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "./model-registry.ts";
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
import {
	isPlainObject,
	isString,
} from "../../maestro/core/config/type-guards.ts";
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
	SubagentParams,
	resolveDenyTools,
	discoverAgentCatalog,
	missingRoleMessage,
	formatVisibleAgentDefinitions,
	formatAgentDiagnostics,
	resolveEffectiveSessionMode,
	resolveLaunchBehavior,
	resolveEffectivePersistent,
	resolveEffectiveAutoExit,
	resolveEffectiveInteractive,
	loadAgentDefaults,
} from "./catalog.ts";
import {
	getFirstText,
	formatChildReport,
	boundChildDelivery,
	resolveUnexpectedErrorPresentation,
	sendSubagentResult,
	launchDiagnosticsText,
	resolveResultPresentation,
} from "./presentation.ts";
import { registerMessageRenderers } from "./renderers.ts";
import {
	createObservation,
	formatNoProgressAdvisoryLine,
} from "./observation.ts";
import {
	SUBAGENT_CANCEL_DESCRIPTION,
	type SubagentCancelDetails,
	createControls,
} from "./controls.ts";
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

export { shouldDeliverSubagentCompletion, selectCompletionApi };

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

function formatSupervisionDiagnostics(): string[] {
	const diagnostics = runtime.session?.diagnostics() ?? {
		mode: supervisionConfig.forcePolling ? "polling(forced)" : "wake+batch",
		watcherCount: 0,
	};
	return [
		`Supervision: ${diagnostics.mode}; ${diagnostics.watcherCount} watcher${diagnostics.watcherCount === 1 ? "" : "s"}`,
	];
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
	resolveInterruptTarget,
	requestSubagentInterrupt,
	handleSubagentInterrupt,
	handleSubagentSend,
	handleSubagentStop,
	persistentSpecialistState,
	persistentCapacityError,
	resolveResultPresentation,
	formatChildReport,
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

	registerTaskModelInit(pi);

	registerWorktreeCommand(pi, {
		runtime,
		parentSession,
		cleanupInput,
		paneConfig,
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

	registerMessageRenderers(pi);
}
