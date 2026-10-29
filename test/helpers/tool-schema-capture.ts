import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockExtensionApi } from "./mock-extension-api.ts";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type ToolScope = "child" | "parent";

export interface CapturedTool {
	name: string;
	scopes: ToolScope[];
	description: string;
	parameters: JsonValue;
}

export interface CapturedCommand {
	name: string;
	scopes: ToolScope[];
	description: string;
}

export interface ToolSchemaSnapshot {
	tools: CapturedTool[];
	commands: CapturedCommand[];
}

interface RegisteredTool {
	name: string;
	description?: string;
	parameters?: unknown;
}

interface RegisteredCommand {
	name: string;
	description?: string;
}

// Registration depends on these; the capture pins them so it is reproducible.
const PINNED_ENV = [
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_ID",
	"PI_DENY_TOOLS",
	"PI_SUBAGENT_AUTO_EXIT",
	"PI_SUBAGENT_PERSISTENT",
	"PI_SUBAGENT_PROCESS_FILE",
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_ACTIVITY_FILE",
	"PI_SUBAGENT_TASK_ID",
	"PI_SUBAGENT_GENERATION_ID",
] as const;

const REPO_ROOT = new URL("../../", import.meta.url);

type ExtensionFactory = (api: ExtensionAPI) => void;

async function importFresh(path: string): Promise<ExtensionFactory> {
	const url = new URL(path, REPO_ROOT);
	const module: { default: ExtensionFactory } = await import(
		`${url.href}?tool-schema-capture-${Date.now()}-${Math.random()}`
	);
	return module.default;
}

async function captureScope(scope: ToolScope) {
	if (scope === "child") process.env.PI_SUBAGENT_ID = "tool-schema-capture";
	else delete process.env.PI_SUBAGENT_ID;

	const mock = createMockExtensionApi();
	const factories = [
		await importFresh("pi-extension/subagents/index.ts"),
		...(scope === "child"
			? [await importFresh("maestro/adapters/pi/child/subagent-done.ts")]
			: []),
	];
	for (const factory of factories) factory(mock.api);
	try {
		const tools: RegisteredTool[] = mock.registeredTools;
		const commands: RegisteredCommand[] = mock.registeredCommands;
		return { tools, commands };
	} finally {
		for (const handler of mock.eventHandlers.get("session_shutdown") ?? [])
			await handler({ reason: "quit" }, { ui: { setWidget() {} } });
	}
}

function merge<T extends { name: string; scopes: ToolScope[] }>(
	entries: Array<[ToolScope, T]>,
): T[] {
	const byContent = new Map<string, T>();
	for (const [scope, entry] of entries) {
		const { scopes: _scopes, ...content } = entry;
		const key = JSON.stringify(content);
		const existing = byContent.get(key);
		if (existing) existing.scopes.push(scope);
		else byContent.set(key, { ...entry, scopes: [scope] });
	}
	return [...byContent.values()].sort(
		(a, b) =>
			a.name.localeCompare(b.name) ||
			a.scopes.join().localeCompare(b.scopes.join()),
	);
}

/**
 * Loads the real extensions against a recording Pi API in an isolated agent
 * directory, once per scope, and returns the public tool and command surface.
 */
export async function captureToolSchemas(): Promise<ToolSchemaSnapshot> {
	const saved = new Map(PINNED_ENV.map((key) => [key, process.env[key]]));
	const agentDir = mkdtempSync(join(tmpdir(), "tool-schema-agent-"));
	const tools: Array<[ToolScope, CapturedTool]> = [];
	const commands: Array<[ToolScope, CapturedCommand]> = [];
	try {
		for (const key of PINNED_ENV) delete process.env[key];
		process.env.PI_CODING_AGENT_DIR = agentDir;
		for (const scope of ["parent", "child"] as const) {
			const captured = await captureScope(scope);
			for (const tool of captured.tools)
				tools.push([
					scope,
					{
						name: tool.name,
						scopes: [],
						description: tool.description ?? "",
						parameters: JSON.parse(JSON.stringify(tool.parameters)),
					},
				]);
			for (const command of captured.commands)
				commands.push([
					scope,
					{
						name: command.name,
						scopes: [],
						description: command.description ?? "",
					},
				]);
		}
	} finally {
		for (const [key, value] of saved)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		rmSync(agentDir, { recursive: true, force: true });
	}
	return { tools: merge(tools), commands: merge(commands) };
}
