import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { SupervisionConfig } from "../../maestro/core/config/supervision-config.ts";
import type { SubagentRuntime } from "./state.ts";
import {
	discoverAgentCatalog,
	formatVisibleAgentDefinitions,
	formatAgentDiagnostics,
} from "./catalog.ts";
import { getFirstText } from "./presentation.ts";
import {
	SUBAGENT_CANCEL_DESCRIPTION,
	type SubagentCancelDetails,
	type Controls,
} from "./controls.ts";
import type { PersistentControls } from "./persistent.ts";

function formatSupervisionDiagnostics(
	runtime: SubagentRuntime,
	supervisionConfig: SupervisionConfig,
): string[] {
	const diagnostics = runtime.session?.diagnostics() ?? {
		mode: supervisionConfig.forcePolling ? "polling(forced)" : "wake+batch",
		watcherCount: 0,
	};
	return [
		`Supervision: ${diagnostics.mode}; ${diagnostics.watcherCount} watcher${diagnostics.watcherCount === 1 ? "" : "s"}`,
	];
}

interface ControlToolDeps {
	shouldRegister: (name: string) => boolean;
	runtime: SubagentRuntime;
	supervisionConfig: SupervisionConfig;
	resolvePersistentTarget: PersistentControls["resolvePersistentTarget"];
	handleSubagentInterrupt: Controls["handleSubagentInterrupt"];
	handleSubagentCancel: Controls["handleSubagentCancel"];
	formatLivePersistentSpecialists: PersistentControls["formatLivePersistentSpecialists"];
}

/** Persistent send/stop, interrupt, cancel, and the role listing tools. */
export function registerControlTools(
	pi: ExtensionAPI,
	{
		shouldRegister,
		runtime,
		supervisionConfig,
		resolvePersistentTarget,
		handleSubagentInterrupt,
		handleSubagentCancel,
		formatLivePersistentSpecialists,
	}: ControlToolDeps,
): void {
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
					...formatSupervisionDiagnostics(runtime, supervisionConfig),
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
}
