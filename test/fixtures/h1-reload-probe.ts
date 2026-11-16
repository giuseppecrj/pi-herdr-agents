import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLifecycle } from "@nubl/maestro/core/lifecycle";
import {
	readGlobalSlot,
	RUNTIME_KEY,
	WIDGET_INTERVAL_KEY,
	STATUS_INTERVAL_KEY,
	type SubagentRuntime,
} from "@nubl/maestro/pi/subagents/state";

// Run in a fresh process. No daily configuration, authentication or Herdr sockets.
const root = mkdtempSync(join(tmpdir(), "piha-h1-reload-"));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(root, "project");
mkdirSync(join(agentDir, "herdr-agents"), { recursive: true });
mkdirSync(cwd);
const config = join(agentDir, "herdr-agents", "config.json");
const configure = (forcePolling: boolean) =>
	writeFileSync(
		config,
		JSON.stringify({
			status: { enabled: true },
			supervision: { forcePolling },
		}),
	);
configure(false);
const {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const repo = resolve(process.argv[2] ?? join(import.meta.dirname, "../.."));
const settingsManager = SettingsManager.inMemory({});
const loader = new DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	additionalExtensionPaths: [join(repo, "pi-extension/subagents/index.ts")],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({
	cwd,
	agentDir,
	resourceLoader: loader,
	settingsManager,
	sessionManager: SessionManager.inMemory(cwd),
});
const runtime = readGlobalSlot<SubagentRuntime>(RUNTIME_KEY)!;
const original = runtime.session!;
const ownerKey = Symbol.for("pi-herdr-agents/PiRunSession-owner");
const owner = Object.getOwnPropertyDescriptor(original, ownerKey)!.value;
// The terminal entry keeps launching the same child path and reading the same
// example. Before H1 these were fixed inside the engine (no options set).
const legacyChild = join(repo, "maestro/adapters/pi/child/subagent-done.ts");
assert.equal(owner.options.childEntryPath ?? legacyChild, legacyChild);
assert.equal(
	owner.options.configExamplePath,
	join(repo, "config.json.example"),
);
const row = {
	id: "h1-held",
	name: "held",
	task: "fixture",
	surface: "fixture-pane",
	startTime: Date.now(),
	sessionFile: join(root, "child.jsonl"),
	interactive: true,
	runtimePlan: undefined,
	lifecycle: createLifecycle(Date.now()),
};
runtime.runningSubagents.set(row.id, row);
const errors: string[] = [];
const registrations = () =>
	loader.getExtensions().extensions.map((e) => ({
		tools: [...e.tools.keys()],
		commands: [...e.commands.keys()],
		renderers: [...e.messageRenderers.keys()],
		handlers: [...e.handlers].map(([name, handlers]) => [
			name,
			handlers.length,
		]),
	}));
try {
	await session.bindExtensions({ onError: (e) => errors.push(e.error) });
	const before = registrations();
	const timers = [WIDGET_INTERVAL_KEY, STATUS_INTERVAL_KEY].map(
		(key) => readGlobalSlot<NodeJS.Timeout>(key)!,
	);
	assert.ok(
		timers.every(Boolean),
		"real session_start starts both presentation timers",
	);
	const oldApi = runtime.liveApi!;
	let heldReleased = 0;
	configure(true);
	await session.reload({
		beforeSessionStart() {
			assert.equal(
				readGlobalSlot(RUNTIME_KEY),
				runtime,
				"the registry survives the real jiti replacement",
			);
			assert.equal(
				Object.getOwnPropertyDescriptor(runtime.session!, ownerKey)!.value,
				owner,
				"the original owner survives",
			);
			assert.equal(
				runtime.runningSubagents.get(row.id),
				row,
				"rows are not reconstructed",
			);
			assert.equal(
				runtime.liveApi,
				undefined,
				"no API is live in the reload gap",
			);
			for (const timer of timers)
				assert.equal(
					Object.getOwnPropertyDescriptor(timer, "_destroyed")!.value,
					true,
					"old timer is disposed",
				);
			(runtime.heldDeliveries ??= []).push({
				id: row.id,
				release(api) {
					assert.ok(api);
					assert.notEqual(api, oldApi);
					heldReleased++;
				},
			});
		},
	});
	assert.notEqual(
		runtime.session,
		original,
		"the replacement facade adopts rather than recreates the owner",
	);
	assert.equal(
		runtime.session!.diagnostics().mode,
		"polling(forced)",
		"config is re-read on load",
	);
	assert.equal(heldReleased, 1);
	assert.equal(runtime.heldDeliveries!.length, 0);
	assert.deepEqual(
		registrations(),
		before,
		"one unchanged registration per tool/handler",
	);
	assert.deepEqual(errors, []);
	const interrupt = session.getToolDefinition("subagent_interrupt")!;
	// SAFETY: this refusal path reads no context, signal or update callback.
	const result = await interrupt.execute(
		"fixture",
		{ id: "missing" },
		undefined,
		undefined,
		undefined as never,
	);
	console.log(
		JSON.stringify(
			{
				registrations: before,
				result,
				refreshedConfig: true,
				ownerPreserved: true,
				rowsPreserved: true,
				timersDisposed: true,
				heldReleased,
			},
			null,
			2,
		),
	);
} finally {
	runtime.runningSubagents.clear();
	for (const key of [WIDGET_INTERVAL_KEY, STATUS_INTERVAL_KEY]) {
		const timer = readGlobalSlot<NodeJS.Timeout>(key);
		if (timer) clearInterval(timer);
	}
	await runtime.session?.shutdown("quit");
	session.dispose();
	rmSync(root, { recursive: true, force: true });
}
