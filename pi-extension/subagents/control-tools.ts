import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { PiToolRenderers } from "./presentation-hooks.ts";
import type { SupervisionConfig } from "../../maestro/core/config/supervision-config.ts";
import type { SubagentRuntime } from "./state.ts";
import {
	discoverAgentCatalog,
	formatVisibleAgentDefinitions,
	formatAgentDiagnostics,
} from "./catalog.ts";
import { encodeHostValue } from "../../maestro/core/host-text.ts";
import {
	SUBAGENT_CANCEL_DESCRIPTION,
	SUBAGENT_CANCEL_SNIPPET,
	type Controls,
} from "./controls.ts";
import type { PersistentControls } from "./persistent.ts";
import { ROUTINE_TOOL_EXPOSURE } from "./deferred-tools.ts";

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
	/** Terminal callbacks are supplied by the host, not the tool implementation. */
	renderers?: PiToolRenderers;
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
		renderers,
		handleSubagentInterrupt,
		handleSubagentCancel,
		formatLivePersistentSpecialists,
	}: ControlToolDeps,
): void {
	// ── subagent_send tool ──
	if (shouldRegister("subagent_send"))
		pi.registerTool({
			name: "subagent_send",
			exposure: ROUTINE_TOOL_EXPOSURE,
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
						: `Task ${encodeHostValue(details.task)} dispatched to persistent specialist "${encodeHostValue(target.running.name)}".`;
				return { content: [{ type: "text", text }], details };
			},
		});

	// ── subagent_stop tool ──
	if (shouldRegister("subagent_stop"))
		pi.registerTool({
			name: "subagent_stop",
			exposure: ROUTINE_TOOL_EXPOSURE,
			label: "Stop Persistent Specialist",
			description:
				"Stop a persistent specialist after its active task finishes.",
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
							? `Stop pending for persistent specialist "${encodeHostValue(target.running.name)}"; its active task will settle first.`
							: `Stop requested for persistent specialist "${encodeHostValue(target.running.name)}".`;
				return { content: [{ type: "text", text }], details };
			},
		});

	// ── subagent_interrupt tool ──
	if (shouldRegister("subagent_interrupt"))
		pi.registerTool({
			name: "subagent_interrupt",
			exposure: ROUTINE_TOOL_EXPOSURE,
			label: "Interrupt Subagent",
			description:
				"Send Escape to a running subagent's active turn. The subagent keeps running, and this call delivers no result.",
			promptSnippet:
				"Send Escape to a running subagent's active turn without ending the subagent",
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

			renderCall: renderers?.subagent_interrupt?.renderCall,

			renderResult: renderers?.subagent_interrupt?.renderResult,
		});

	// ── subagent_cancel tool ──
	if (shouldRegister("subagent_cancel"))
		pi.registerTool({
			name: "subagent_cancel",
			exposure: ROUTINE_TOOL_EXPOSURE,
			label: "Cancel Subagent",
			description: SUBAGENT_CANCEL_DESCRIPTION,
			promptSnippet: SUBAGENT_CANCEL_SNIPPET,
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

			renderCall: renderers?.subagent_cancel?.renderCall,

			renderResult: renderers?.subagent_cancel?.renderResult,
		});

	// ── subagents_list tool ──
	if (shouldRegister("subagents_list"))
		pi.registerTool({
			name: "subagents_list",
			exposure: ROUTINE_TOOL_EXPOSURE,
			label: "List Subagents",
			description:
				"List subagent role definitions, live persistent specialists, and the supervision mode.",
			promptSnippet: "List the subagent role definitions available to launch",
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

			renderResult: renderers?.subagents_list?.renderResult,
		});
}
