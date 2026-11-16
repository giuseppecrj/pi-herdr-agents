import "../clean-host-env.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AgentToolResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

// H1 terminal-presentation pin, run in a fresh process against one checkout:
// node --experimental-strip-types h1-presentation-probe.ts [checkout] [child-entry]
// It renders every injected tool callback and the child widget through a
// recording theme, so before/after output proves the moved renderers unchanged.
const repo = resolve(process.argv[2] ?? join(import.meta.dirname, "../.."));
const childEntry =
	process.argv[3] ?? "maestro/adapters/pi/child/subagent-done.ts";
const agentDir = mkdtempSync(join(tmpdir(), "piha-h1-presentation-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_SUBAGENT_ID;
delete process.env.PI_DENY_TOOLS;

const { createMockExtensionApi } = await import(
	pathToFileURL(join(repo, "test/helpers/mock-extension-api.ts")).href
);
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	bold: (text: string) => `*${text}*`,
};
interface SampleArgs {
	name?: string;
	task?: string;
	agent?: string;
	cwd?: string;
	id?: string;
	worktree?: { branch: string } | null;
}
interface SampleRole {
	name: string;
	source: string;
	provider?: string;
	description?: string;
	model?: string;
}
interface SampleDetails {
	status?: string;
	name?: string;
	id?: string;
	model?: string;
	thinking?: string;
	worktree?: { branch: string };
	agents?: SampleRole[];
	diagnostics?: Array<{ message: string }>;
}
interface ToolSamples {
	calls: Array<SampleArgs | null>;
	results: Array<AgentToolResult<SampleDetails | undefined>>;
}
const fallback = {
	content: [{ type: "text" as const, text: "fallback text" }],
};
const samples = new Map<string, ToolSamples>([
	[
		"subagent",
		{
			calls: [
				{},
				null,
				{
					name: "scout",
					task: "\n  first line\nsecond line",
					agent: "reviewer",
					cwd: "/tmp/with space",
					worktree: { branch: "feat/a" },
				},
				{ name: "", task: "x".repeat(150), agent: "", worktree: null },
			],
			results: [
				{ ...fallback, details: {} },
				{
					content: [],
					details: {
						status: "started",
						name: "scout",
						model: "provider/model",
						thinking: "high",
						worktree: { branch: "feat/a" },
					},
				},
				{
					content: [],
					details: { status: "started", model: "provider/model" },
				},
				{ content: [], details: { status: "started" } },
			],
		},
	],
	[
		"subagent_resume",
		{
			calls: [{}, { name: "again" }],
			results: [
				{ content: [], details: { status: "started", name: "again" } },
				{ content: [], details: { status: "started" } },
				{ ...fallback, details: {} },
			],
		},
	],
	[
		"subagent_interrupt",
		{
			calls: [{ id: "id-1" }, { name: "named" }, {}],
			results: [
				{ content: [], details: { status: "interrupt_requested", name: "n" } },
				{ content: [], details: { status: "interrupt_requested", id: "i" } },
				{ content: [], details: { status: "interrupt_requested" } },
				{ ...fallback, details: {} },
			],
		},
	],
	[
		"subagent_cancel",
		{
			calls: [{ id: "id-1" }, { name: "named" }, {}],
			results: [
				{ content: [], details: { status: "cancelled", name: "n" } },
				{ content: [], details: { status: "already_settled", id: "i" } },
				{ content: [], details: { status: "cancelled" } },
				{ ...fallback, details: undefined },
			],
		},
	],
	[
		"subagents_list",
		{
			calls: [{}],
			results: [
				{ content: [], details: {} },
				{
					content: [],
					details: {
						agents: [
							{
								name: "pack-role",
								source: "package",
								provider: "pack",
								description: "line\nbreak \u0007",
								model: "provider/model",
							},
							{ name: "project-role", source: "project" },
						],
						diagnostics: [{ message: "bad role\nfile" }],
					},
				},
			],
		},
	],
]);
const render = (component: Component) => component.render(60);
// SAFETY: renderers read only the fg/bg/bold members this recording theme has.
const recordingTheme = theme as never;

const parent = createMockExtensionApi();
const index = await import(
	`${pathToFileURL(join(repo, "pi-extension/subagents/index.ts")).href}?h1-presentation`
);
index.default(parent.api);
// SAFETY: the mock records exactly the ToolDefinition objects index.ts registers.
const registered = parent.registeredTools as ToolDefinition<any, any>[];
const tools = registered.map((tool) => {
	const sample = samples.get(tool.name);
	// SAFETY: renderers receive only a component-returning context subset here.
	const context = {} as never;
	return {
		name: tool.name,
		renderCall: tool.renderCall
			? (sample?.calls ?? [{}]).map((args) =>
					render(tool.renderCall!(args, recordingTheme, context)),
				)
			: null,
		renderResult: tool.renderResult
			? (sample?.results ?? [{ ...fallback, details: {} }]).map((result) =>
					render(
						tool.renderResult!(
							result,
							{ expanded: false, isPartial: false },
							recordingTheme,
							context,
						),
					),
				)
			: null,
	};
});
for (const handler of parent.eventHandlers.get("session_shutdown") ?? [])
	await handler({ reason: "quit" }, { ui: { setWidget() {} } });

// Child scope: a named role with two denied tools, as a launch would set it.
Object.assign(process.env, {
	PI_SUBAGENT_ID: "h1-child",
	PI_SUBAGENT_NAME: "h1 child",
	PI_SUBAGENT_AGENT: "h1-role",
	PI_DENY_TOOLS: "subagent,subagent_resume",
});
const child = createMockExtensionApi();
const childModule = await import(
	`${pathToFileURL(join(repo, childEntry)).href}?h1-presentation-child`
);
childModule.default(child.api);
const widgets: unknown[] = [];
for (const handler of child.eventHandlers.get("session_start") ?? [])
	await handler(
		{},
		{
			ui: {
				setWidget(
					name: string,
					factory: (tui: TUI, widgetTheme: typeof recordingTheme) => Component,
					options: { placement?: string },
				) {
					// SAFETY: the child widget never reads its TUI argument.
					const tui = {} as TUI;
					widgets.push({
						name,
						options,
						lines: render(factory(tui, recordingTheme)),
					});
				},
			},
		},
	);
process.stdout.write(
	`${JSON.stringify(
		{
			tools,
			child: {
				tools: child.registeredTools.map(
					(tool: {
						name: string;
						description?: string;
						parameters?: unknown;
					}) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					}),
				),
				events: [...child.eventHandlers].map(
					([event, handlers]: [string, unknown[]]) => [event, handlers.length],
				),
				widgets,
			},
		},
		null,
		2,
	)}\n`,
);
rmSync(agentDir, { recursive: true, force: true });
process.exit(0);
