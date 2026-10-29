import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { captureToolSchemas } from "../helpers/tool-schema-capture.ts";
import type {
	CapturedTool,
	JsonValue,
	ToolSchemaSnapshot,
} from "../helpers/tool-schema-capture.ts";
import { COMMAND_USAGE, renderToolDocs } from "../../scripts/tool-docs.ts";
import { findBreakingChanges } from "../helpers/tool-schema-compat.ts";

const fixture = (name: string): ToolSchemaSnapshot =>
	JSON.parse(
		readFileSync(
			new URL(`../fixtures/tool-schema/${name}.json`, import.meta.url),
			"utf8",
		),
	);

function toolNamed(snapshot: ToolSchemaSnapshot, name: string): CapturedTool {
	const tool = snapshot.tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `${name} is registered`);
	return tool;
}

function snapshotOf(
	parameters: JsonValue,
	scopes: CapturedTool["scopes"] = ["parent"],
): ToolSchemaSnapshot {
	return {
		tools: [{ name: "t", scopes, description: "", parameters }],
		commands: [],
	};
}

const obj = (
	properties: Record<string, JsonValue>,
	required: string[] = [],
): JsonValue => ({ type: "object", properties, required });

const breaking = (before: JsonValue, after: JsonValue) =>
	findBreakingChanges(snapshotOf(before), snapshotOf(after));

describe("public tool schema snapshot", () => {
	it("matches the captured extension registrations", async () => {
		assert.deepEqual(
			await captureToolSchemas(),
			fixture("current"),
			"The public tool schemas changed. Run `npm run docs:tools` to refresh test/fixtures/tool-schema/current.json and docs/tools.md, then review the diff.",
		);
	});

	it("keeps the generated blocks in docs/tools.md up to date", () => {
		const docs = readFileSync(
			new URL("../../docs/tools.md", import.meta.url),
			"utf8",
		);
		assert.equal(
			docs,
			renderToolDocs(docs, fixture("current")),
			"docs/tools.md generated blocks are stale. Run `npm run docs:tools` and commit the result.",
		);
	});

	it("has no breaking change against the last released schema", () => {
		const problems = findBreakingChanges(
			fixture("released"),
			fixture("current"),
		);
		assert.deepEqual(
			problems,
			[],
			`Breaking tool schema change against test/fixtures/tool-schema/released.json:\n${problems.join("\n")}\nDowngrade the change to a compatible one, or ship it as a major version and refresh released.json at release.`,
		);
	});

	it("keeps the contract pstack depends on", () => {
		const current = fixture("current");
		const subagent = JSON.parse(
			JSON.stringify(toolNamed(current, "subagent").parameters),
		);
		assert.ok("systemPrompt" in subagent.properties, "subagent.systemPrompt");
		const writer = toolNamed(current, "subagents_write_task_models");
		const schema = JSON.parse(JSON.stringify(writer.parameters));
		for (const name of ["expectedConfigRevision", "basis"]) {
			assert.ok(name in schema.properties, `${name} exists`);
			assert.ok(!schema.required.includes(name), `${name} stays optional`);
		}
	});

	it("registers the child-only protocol tools in the child scope", () => {
		const current = fixture("current");
		assert.deepEqual(toolNamed(current, "caller_ping").scopes, ["child"]);
		assert.deepEqual(toolNamed(current, "subagent_done").scopes, ["child"]);
	});
});

describe("tool schema compatibility rules", () => {
	const str: JsonValue = { type: "string" };

	it("treats documentation-only and additive changes as compatible", () => {
		assert.deepEqual(
			breaking(
				obj({ a: { type: "string", description: "old" } }, ["a"]),
				obj(
					{
						a: { type: "string", description: "new" },
						b: str,
					},
					["a"],
				),
			),
			[],
		);
		assert.deepEqual(
			findBreakingChanges(snapshotOf(obj({})), {
				tools: [
					...snapshotOf(obj({})).tools,
					{ name: "new", scopes: ["parent"], description: "", parameters: {} },
				],
				commands: [],
			}),
			[],
		);
	});

	it("flags a removed or renamed tool", () => {
		const renamed = snapshotOf(obj({}));
		renamed.tools[0].name = "u";
		assert.match(
			findBreakingChanges(snapshotOf(obj({})), renamed)[0],
			/tool removed or renamed/,
		);
	});

	it("flags a tool no longer registered in a scope", () => {
		assert.match(
			findBreakingChanges(
				snapshotOf(obj({}), ["parent", "child"]),
				snapshotOf(obj({}), ["parent"]),
			)[0],
			/no longer registered in child scope/,
		);
	});

	it("flags a removed property", () => {
		assert.match(
			breaking(obj({ a: str }), obj({}))[0],
			/t\.a: property removed/,
		);
	});

	it("flags a property that became required and a new required property", () => {
		assert.match(
			breaking(obj({ a: str }), obj({ a: str }, ["a"]))[0],
			/became required/,
		);
		assert.match(
			breaking(obj({}), obj({ b: str }, ["b"]))[0],
			/new required property/,
		);
	});

	it("flags a changed type", () => {
		assert.match(
			breaking(obj({ a: str }), obj({ a: { type: "number" } }))[0],
			/type changed/,
		);
	});

	it("flags an anyOf branch with no accepting branch and allows widening", () => {
		const union = (...types: string[]): JsonValue => ({
			anyOf: types.map((type) => ({ type })),
		});
		assert.match(
			breaking(
				obj({ a: union("string", "null") }),
				obj({ a: union("string") }),
			)[0],
			/no accepting branch/,
		);
		assert.deepEqual(
			breaking(
				obj({ a: union("string") }),
				obj({ a: union("string", "null") }),
			),
			[],
		);
		assert.deepEqual(
			breaking(obj({ a: str }), obj({ a: union("string", "null") })),
			[],
		);
		assert.match(
			breaking(obj({ a: union("string", "null") }), obj({ a: str }))[0],
			/type changed/,
		);
	});

	it("flags a removed enum or const value and allows widening", () => {
		const literals = (...values: string[]): JsonValue => ({
			type: "string",
			enum: values,
		});
		assert.match(
			breaking(obj({ a: literals("x", "y") }), obj({ a: literals("x") }))[0],
			/enum\/const value removed: "y"/,
		);
		assert.deepEqual(
			breaking(obj({ a: literals("x") }), obj({ a: literals("x", "y") })),
			[],
		);
		assert.match(
			breaking(
				obj({ a: { type: "string", const: "x" } }),
				obj({ a: { type: "string", const: "y" } }),
			)[0],
			/value removed/,
		);
	});

	it("flags tightened bounds and allows relaxed ones", () => {
		for (const [key, loose, tight] of [
			["minLength", 1, 2],
			["minItems", 1, 2],
			["minimum", 0, 1],
		] as const) {
			const node = (value: number): JsonValue =>
				obj({ a: { type: "string", [key]: value } });
			assert.match(breaking(node(loose), node(tight))[0], /raised/, key);
			assert.deepEqual(breaking(node(tight), node(loose)), [], key);
		}
		for (const [key, loose, tight] of [
			["maxLength", 10, 5],
			["maximum", 10, 5],
		] as const) {
			const node = (value: number): JsonValue =>
				obj({ a: { type: "string", [key]: value } });
			assert.match(breaking(node(loose), node(tight))[0], /lowered/, key);
			assert.deepEqual(breaking(node(tight), node(loose)), [], key);
		}
	});

	it("flags a changed pattern", () => {
		const node = (pattern: string): JsonValue =>
			obj({ a: { type: "string", pattern } });
		assert.match(breaking(node("^a$"), node("^b$"))[0], /pattern changed/);
	});

	it("flags additionalProperties going from true to false", () => {
		const node = (additionalProperties: boolean): JsonValue => ({
			type: "object",
			properties: {},
			additionalProperties,
		});
		assert.match(
			breaking(node(true), node(false))[0],
			/additionalProperties changed from true to false/,
		);
		assert.deepEqual(breaking(node(false), node(true)), []);
	});

	it("counts an unrecognized keyword change as breaking", () => {
		assert.match(
			breaking(
				obj({ a: { type: "string", format: "uri" } }),
				obj({ a: { type: "string", format: "email" } }),
			)[0],
			/unrecognized keyword format/,
		);
	});
});

describe("generated tool docs", () => {
	const docs = () =>
		renderToolDocs(
			["tools", "child-tools", "commands", "subagent-params", "tool-reference"]
				.map(
					(name) =>
						`<!-- generated:${name}:start -->\n<!-- generated:${name}:end -->`,
				)
				.join("\n"),
			fixture("current"),
		);

	it("marks exactly the parent-only tools as parent only", () => {
		const snapshot = fixture("current");
		const parentTools = snapshot.tools.filter((tool) =>
			tool.scopes.includes("parent"),
		);
		const parentOnly = new Set(
			parentTools
				.filter((tool) => tool.scopes.length === 1)
				.map((tool) => tool.name),
		);
		assert.ok(parentOnly.size > 0 && parentOnly.size < parentTools.length);
		const rows = docs()
			.split("\n")
			.filter((line) =>
				/^\| `[a-z_]+` \| (parent only|parent, child) \|/.test(line),
			);
		assert.equal(rows.length, parentTools.length);
		for (const tool of parentTools) {
			const row = rows.find((line) => line.startsWith(`| \`${tool.name}\` |`));
			assert.ok(row, `${tool.name} has a row`);
			assert.equal(
				row.includes("| parent only |"),
				parentOnly.has(tool.name),
				tool.name,
			);
		}
	});

	it("lists every registered command with its usage", () => {
		const snapshot = fixture("current");
		const output = docs();
		for (const command of snapshot.commands) {
			assert.ok(output.includes(`| \`/${command.name}\` |`), command.name);
			for (const form of COMMAND_USAGE[command.name])
				assert.ok(output.includes(`\`${form}\``), form);
		}
		assert.ok(output.includes("`/worktree <name> [task]`"));
	});

	it("fails when a command has no usage entry or usage names an unknown command", () => {
		const snapshot = fixture("current");
		const extra: ToolSchemaSnapshot["commands"][number] = {
			name: "extra",
			scopes: ["parent"],
			description: "x",
		};
		const withExtra: ToolSchemaSnapshot = {
			...snapshot,
			commands: [...snapshot.commands, extra],
		};
		assert.throws(() => renderToolDocs(docsSkeleton(), withExtra), /\/extra/);
		const missing = {
			...snapshot,
			commands: snapshot.commands.slice(1),
		};
		assert.throws(
			() => renderToolDocs(docsSkeleton(), missing),
			/not a registered command/,
		);
	});
});

function docsSkeleton(): string {
	return [
		"tools",
		"child-tools",
		"commands",
		"subagent-params",
		"tool-reference",
	]
		.map(
			(name) =>
				`<!-- generated:${name}:start -->\n<!-- generated:${name}:end -->`,
		)
		.join("\n");
}
