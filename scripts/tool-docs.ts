import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	isRecord,
	isString,
	type JsonObject,
	type JsonValue,
} from "../maestro/core/config/type-guards.ts";
import type {
	CapturedTool,
	ToolSchemaSnapshot,
} from "../test/helpers/tool-schema-capture.ts";

export const GENERATED_BLOCKS = [
	"tools",
	"child-tools",
	"commands",
	"subagent-params",
	"tool-reference",
] as const;
type GeneratedBlock = (typeof GENERATED_BLOCKS)[number];

const cell = (text: string) =>
	text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|").replace(/</g, "\\<");

const firstSentence = (text: string) => cell(text.split(/(?<=\.)\s/)[0] ?? "");

function table(header: string[], rows: string[][]): string {
	const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
	return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
		"\n",
	);
}

function describeType(node: JsonValue | undefined): string {
	if (!isRecord(node)) return "unknown";
	if (Array.isArray(node.anyOf))
		return node.anyOf.map(describeType).join(" \\| ");
	if (node.const !== undefined) return `\`${JSON.stringify(node.const)}\``;
	if (node.type === "array") return `${describeType(node.items)}[]`;
	return isString(node.type) ? node.type : "unknown";
}

function parameterRows(tool: CapturedTool): string[][] {
	const schema: JsonObject = isRecord(tool.parameters) ? tool.parameters : {};
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter(isString) : [],
	);
	return Object.entries(properties).map(([name, node]) => {
		const description =
			isRecord(node) && isString(node.description) ? node.description : "";
		return [
			`\`${name}\``,
			describeType(node),
			required.has(name) ? "yes" : "no",
			description ? cell(description) : "—",
		];
	});
}

function parameterTable(tool: CapturedTool): string {
	const rows = parameterRows(tool);
	return rows.length === 0
		? "No parameters."
		: table(["Parameter", "Type", "Required", "Description"], rows);
}

const toolTable = (tools: CapturedTool[]) =>
	table(
		["Tool", "Description"],
		tools.map((tool) => [`\`${tool.name}\``, firstSentence(tool.description)]),
	);

/** True for tools registered only in parent sessions. */
const isParentOnly = (tool: CapturedTool) =>
	tool.scopes.length === 1 && tool.scopes[0] === "parent";

const parentToolTable = (tools: CapturedTool[]) =>
	table(
		["Tool", "Sessions", "Description"],
		tools.map((tool) => [
			`\`${tool.name}\``,
			isParentOnly(tool) ? "parent only" : "parent, child",
			firstSentence(tool.description),
		]),
	);

/**
 * Usage forms per command. Registered commands carry no argument grammar, so
 * this table is the source for the docs. `commandUsage` throws when it drifts
 * from the registered commands.
 */
export const COMMAND_USAGE = {
	subagent: ["/subagent <agent> <task>", "/subagent list"],
	"subagents-init": ["/subagents-init [preferences]"],
	worktree: [
		"/worktree <name> [task]",
		"/worktree list",
		"/worktree remove <target>",
	],
} as const satisfies Record<string, readonly string[]>;

function commandUsage(commands: ToolSchemaSnapshot["commands"]) {
	const registered = new Set(commands.map((command) => command.name));
	const usageByName = new Map(Object.entries(COMMAND_USAGE));
	for (const name of registered)
		if (!usageByName.has(name))
			throw new Error(
				`Command /${name} has no usage entry in COMMAND_USAGE (scripts/tool-docs.ts)`,
			);
	for (const name of Object.keys(COMMAND_USAGE))
		if (!registered.has(name))
			throw new Error(
				`COMMAND_USAGE names /${name}, which is not a registered command`,
			);
	return (name: string) =>
		(usageByName.get(name) ?? [])
			.map((form) => `\`${form.replace(/\|/g, "\\|")}\``)
			.join("<br>");
}

function findTool(snapshot: ToolSchemaSnapshot, name: string): CapturedTool {
	const tool = snapshot.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Tool ${name} is not registered`);
	return tool;
}

function renderBlock(
	name: GeneratedBlock,
	snapshot: ToolSchemaSnapshot,
): string {
	const parentTools = snapshot.tools.filter((tool) =>
		tool.scopes.includes("parent"),
	);
	const childOnly = snapshot.tools.filter(
		(tool) => !tool.scopes.includes("parent"),
	);
	const parentCommands = snapshot.commands.filter((command) =>
		command.scopes.includes("parent"),
	);
	switch (name) {
		case "tools":
			return [
				`**Subagents** — ${parentTools.length} parent-session tools + ${parentCommands.length} commands, plus ${childOnly.length} child-only tools:`,
				"",
				parentToolTable(parentTools),
			].join("\n");
		case "child-tools":
			return toolTable(childOnly).replace("| Tool |", "| Pi child-only tool |");
		case "commands": {
			const usage = commandUsage(snapshot.commands);
			return table(
				["Command", "Usage", "Description"],
				parentCommands.map((command) => [
					`\`/${command.name}\``,
					usage(command.name),
					cell(command.description),
				]),
			);
		}
		case "subagent-params":
			return parameterTable(findTool(snapshot, "subagent"));
		case "tool-reference":
			return snapshot.tools
				.map((tool) =>
					[
						`### \`${tool.name}\``,
						"",
						`Registered in: ${tool.scopes.join(", ")} sessions.`,
						"",
						tool.name === "subagent"
							? "See [Parameters](#parameters)."
							: parameterTable(tool),
					].join("\n"),
				)
				.join("\n\n");
		default: {
			const _exhaustive: never = name;
			return _exhaustive;
		}
	}
}

const markers = (name: GeneratedBlock) => ({
	start: `<!-- generated:${name}:start -->`,
	end: `<!-- generated:${name}:end -->`,
});

/** Replaces every generated block in `docs` with output rendered from `snapshot`. */
export function renderToolDocs(
	docs: string,
	snapshot: ToolSchemaSnapshot,
): string {
	let result = docs;
	for (const name of GENERATED_BLOCKS) {
		const { start, end } = markers(name);
		const from = result.indexOf(start);
		const to = result.indexOf(end);
		if (from === -1 || to < from)
			throw new Error(`docs/tools.md is missing the ${start} … ${end} block`);
		result = `${result.slice(0, from + start.length)}\n<!-- Generated by npm run docs:tools; edit the schema, not this block. -->\n\n${renderBlock(name, snapshot)}\n${result.slice(to)}`;
	}
	return result;
}

/** Formatted with the repository formatter so `npm run format:check` stays green. */
export function renderSnapshotJson(snapshot: ToolSchemaSnapshot): string {
	return execFileSync(
		fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url)),
		["format", "--stdin-file-path=current.json"],
		{ input: JSON.stringify(snapshot), encoding: "utf8" },
	);
}
