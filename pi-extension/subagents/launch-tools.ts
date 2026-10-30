import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PiLaunchInput } from "../../maestro/runtime/index.ts";
import {
	isPlainObject,
	isString,
} from "../../maestro/core/config/type-guards.ts";
import {
	awaitLiveContext,
	bindLiveApi,
	type SubagentRuntime,
} from "./state.ts";
import {
	SubagentParams,
	discoverAgentCatalog,
	missingRoleMessage,
	formatVisibleAgentDefinitions,
	formatAgentDiagnostics,
	resolveEffectivePersistent,
	loadAgentDefaults,
} from "./catalog.ts";
import { getFirstText, launchDiagnosticsText } from "./presentation.ts";
import {
	encodeHostValue,
	HOST_ERROR_CHARS,
	HOST_PATH_CHARS,
} from "../../maestro/core/host-text.ts";
import type { PersistentControls } from "./persistent.ts";
import type { LaunchPlanner } from "./launch.ts";
import type { SpawningConfig } from "../../maestro/core/config/spawning-config.ts";
import {
	DELEGATION_DEPTH_ENV,
	decideDelegation,
	parseDelegationDepth,
} from "../../maestro/core/delegation-depth.ts";

/**
 * Refuse a launch past the host-enforced delegation depth limit. The depth is
 * read from this session's own environment; see maestro/core/delegation-depth.ts.
 */
export function delegationDepthRefusal(
	maxDepth: number,
	env: NodeJS.ProcessEnv = process.env,
): { message: string; code: string } | undefined {
	const decision = decideDelegation(
		parseDelegationDepth(env[DELEGATION_DEPTH_ENV]),
		maxDepth,
	);
	return decision.allowed
		? undefined
		: { message: decision.message, code: `delegation-${decision.reason}` };
}

function muxUnavailableResult(runtime: SubagentRuntime) {
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

interface LaunchToolDeps {
	shouldRegister: (name: string) => boolean;
	runtime: SubagentRuntime;
	updateWidget: () => void;
	subagentRoutingGuidelines: string[];
	persistentCapacityError: PersistentControls["persistentCapacityError"];
	resolveSubagentRuntimePlans: LaunchPlanner["resolveSubagentRuntimePlans"];
	normalizePiAttempt: LaunchPlanner["normalizePiAttempt"];
	spawningConfig: SpawningConfig;
}

/** The subagent launch tool. */
export function registerSubagentTool(
	pi: ExtensionAPI,
	{
		shouldRegister,
		runtime,
		updateWidget,
		subagentRoutingGuidelines,
		persistentCapacityError,
		resolveSubagentRuntimePlans,
		normalizePiAttempt,
		spawningConfig,
	}: LaunchToolDeps,
): void {
	const runningSubagents = runtime.runningSubagents;

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
				const depthRefusal = delegationDepthRefusal(spawningConfig.maxDepth);
				if (depthRefusal) {
					return {
						content: [{ type: "text", text: depthRefusal.message }],
						details: { error: depthRefusal.code },
					};
				}

				// Prevent a named role from spawning another instance of itself unless
				// its definition opted in with `self-spawn: true`. This is a role-design
				// default, not a recursion boundary: role A can still launch role B,
				// which can launch role A.
				const currentAgent = process.env.PI_SUBAGENT_AGENT;
				if (
					params.agent &&
					currentAgent &&
					params.agent === currentAgent &&
					process.env.PI_SUBAGENT_SELF_SPAWN !== "1"
				) {
					return {
						content: [
							{
								type: "text",
								text: `You are the ${encodeHostValue(currentAgent)} agent — do not start another ${encodeHostValue(currentAgent)}. You were spawned to do this work yourself. Complete the task directly.`,
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
							{
								type: "text",
								text: `Error: ${encodeHostValue(roleDiagnostic.message, HOST_ERROR_CHARS)}`,
							},
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
					return muxUnavailableResult(runtime);
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
				// A running tool proves this load's API is live.
				bindLiveApi(runtime, pi);
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
					// In a reload gap, wait for the replacement's context; never fail a candidate.
					prepareAttempt: async () => {
						const live = await awaitLiveContext(runtime, id);
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
								`Sub-agent "${encodeHostValue(params.name)}" launched and is now running in the background` +
								(running.worktree
									? ` in worktree ${encodeHostValue(running.worktree.path, HOST_PATH_CHARS)} on branch ${encodeHostValue(running.worktree.branch)}. `
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
}

/** The subagent_resume tool. */
export function registerResumeTool(
	pi: ExtensionAPI,
	{
		shouldRegister,
		runtime,
		updateWidget,
		spawningConfig,
	}: Pick<
		LaunchToolDeps,
		"shouldRegister" | "runtime" | "updateWidget" | "spawningConfig"
	>,
): void {
	const runningSubagents = runtime.runningSubagents;

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

				const depthRefusal = delegationDepthRefusal(spawningConfig.maxDepth);
				if (depthRefusal) {
					return {
						content: [{ type: "text", text: depthRefusal.message }],
						details: { error: depthRefusal.code },
					};
				}

				if (!runtime.session!.availability().available) {
					return muxUnavailableResult(runtime);
				}

				if (!existsSync(params.sessionPath)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: session file not found: ${encodeHostValue(params.sessionPath, HOST_PATH_CHARS)}`,
							},
						],
						details: { error: "session not found" },
					};
				}

				runtime.latestCtx = ctx;
				// A running tool proves this load's API is live.
				bindLiveApi(runtime, pi);
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
					content: [
						{
							type: "text",
							text: `Session "${encodeHostValue(name)}" resumed.`,
						},
					],
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
}

/** The /subagent command: launch a named role, or list roles. */
export function registerSubagentCommand(pi: ExtensionAPI): void {
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
					diagnostic
						? encodeHostValue(diagnostic.message, HOST_ERROR_CHARS)
						: missingRoleMessage(agentName),
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
}
