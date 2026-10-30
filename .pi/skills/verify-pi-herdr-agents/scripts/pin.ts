#!/usr/bin/env -S node --experimental-strip-types
/**
 * Refactor behavior pin: loads a checkout's extension against the recording API in
 * test/helpers/mock-extension-api.ts, once in parent scope and once in child scope
 * (PI_SUBAGENT_ID + PI_DENY_TOOLS set), and prints the registration order, tool
 * schemas, renderers, event handlers and module exports as JSON. Run it before and
 * after a refactor and diff the two files; any difference is a behavior change.
 *
 *   node --experimental-strip-types pin.ts [checkout] > pin.json
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../../../.."));
const agentDir = mkdtempSync(join(tmpdir(), "piha-pin-agent-"));
const SCOPE_ENV = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_DENY_TOOLS"] as const;
const saved = new Map(SCOPE_ENV.map((key) => [key, process.env[key]]));

const { createMockExtensionApi } = await import(pathToFileURL(join(repo, "test/helpers/mock-extension-api.ts")).href);

async function capture(scope: "parent" | "child") {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (scope === "child") {
		process.env.PI_SUBAGENT_ID = "pin-child";
		process.env.PI_DENY_TOOLS = "subagent,subagent_resume";
	} else {
		delete process.env.PI_SUBAGENT_ID;
		delete process.env.PI_DENY_TOOLS;
	}
	const url = pathToFileURL(join(repo, "pi-extension/subagents/index.ts")).href;
	const module = await import(`${url}?pin-${scope}-${Date.now()}`);
	const mock = createMockExtensionApi();
	module.default(mock.api);
	const result = {
		exports: Object.keys(module).sort(),
		testSurface: module.__test__ ? Object.keys(module.__test__).sort() : [],
		tools: mock.registeredTools.map((t: { name: string; description?: string; parameters?: unknown }) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		})),
		commands: mock.registeredCommands.map((c: { name: string; description?: string }) => ({ name: c.name, description: c.description })),
		renderers: mock.registeredMessageRenderers.map((r: { name: string }) => r.name),
		shortcuts: mock.registeredShortcuts.map((s: { key: string }) => s.key),
		events: [...mock.eventHandlers].map(([event, handlers]: [string, unknown[]]) => [event, handlers.length]),
	};
	for (const handler of mock.eventHandlers.get("session_shutdown") ?? [])
		await handler({ reason: "quit" }, { ui: { setWidget() {} } });
	return result;
}

try {
	const parent = await capture("parent");
	const child = await capture("child");
	process.stdout.write(`${JSON.stringify({ repo, parent, child }, null, 2)}\n`);
} finally {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(agentDir, { recursive: true, force: true });
}
process.exit(0);
