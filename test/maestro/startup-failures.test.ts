import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDefaultRunSession } from "@nubl/maestro/runtime/pi-run-session";
import type {
	PiCompletedMetadata,
	PiLaunchInput,
	PiRunRecord,
} from "@nubl/maestro/runtime/pi-run-session-types";
import { FakeSurfaceProvider } from "@nubl/maestro/testing";
import { launchOperationsFromSurface } from "@nubl/maestro/adapters/pi/launch-operations";
import { SupervisionCoordinator } from "@nubl/maestro/core/supervision";
import {
	renderParentMessage,
	resolveResultPresentation,
} from "@nubl/maestro/pi/subagents/presentation";
import type { JsonObject } from "@nubl/maestro/core/config/type-guards";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

// #149: on shep-app, config.json held only `models`, every child failed to load
// this extension, and the parent saw only "exit code 1".

const repo = fileURLToPath(new URL("../../", import.meta.url));
const example = JSON.parse(
	readFileSync(join(repo, "config.json.example"), "utf8"),
);
const tasksMeta = {
	generatedAt: "2026-11-16T03:46:28Z",
	method: "registry-only",
};
/** The file shep-app held after its 03:46 rewrite. */
const modelsOnly: JsonObject = {
	models: {
		tasks: { recon: ["p/recon"] },
		tasksThinking: { recon: "off" },
		tasksMeta,
	},
};

function writeConfig(agentDir: string, config: JsonObject, mode = 0o600) {
	const path = join(agentDir, "herdr-agents", "config.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
	chmodSync(path, mode);
	return path;
}

/** Load the host's real entry fresh, as a newly started child Pi does. */
async function loadHostEntry() {
	const url = new URL("../../pi-extension/subagents/index.ts", import.meta.url);
	url.search = `?load=${Math.random()}`;
	const { default: extension } = await import(url.href);
	const mock = createMockExtensionApi();
	extension(mock.api);
	return mock;
}

test("a child loads the host extension when config.json holds only models", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const path = writeConfig(agentDir, modelsOnly);
	try {
		const mock = await loadHostEntry();
		assert.ok(mock.registeredTools.some((tool) => tool.name === "subagent"));
	} finally {
		rmSync(path, { force: true });
	}
});

test("a present but malformed status section still stops the load with its reason", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const path = writeConfig(agentDir, { status: "on" });
	try {
		await assert.rejects(
			loadHostEntry(),
			/Invalid subagent status config in .*config\.json: status must be an object/,
		);
	} finally {
		rmSync(path, { force: true });
	}
});

test("the task-model writer keeps every other key of config.json and leaves it mode 0600", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "piha-149-writer-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const existing = {
			...example,
			status: { enabled: false },
			models: { default: "p/default", agents: { scout: "p/scout" } },
			sidebar: { enabled: true },
		};
		const path = writeConfig(agentDir, existing, 0o644);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const mock = await loadHostEntry();
		const writer = mock.registeredTools.find(
			(tool) => tool.name === "subagents_write_task_models",
		);
		assert.ok(writer);
		mock.api.setActiveTools([...mock.api.getActiveTools(), writer.name]);
		const result = await writer.execute(
			"write",
			{
				tasks: { recon: ["p/new"] },
				tasksThinking: { recon: "off" },
				tasksMeta,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				modelRegistry: {
					find: (provider: string, id: string) => ({
						provider,
						id,
						reasoning: false,
					}),
					getAvailable: () => [{ provider: "p", id: "new", reasoning: false }],
					hasConfiguredAuth: () => true,
				},
				ui: { select: async () => "Yes, save" },
			},
		);
		assert.match(
			JSON.stringify(result.content),
			/Wrote task model preferences/,
		);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		const { models, ...rest } = saved;
		const { models: before, ...unchanged } = existing;
		assert.deepEqual(rest, unchanged);
		assert.equal(models.default, before.default);
		assert.deepEqual(models.agents, before.agents);
		assert.deepEqual(models.tasks, { recon: ["p/new"] });
		if (process.platform !== "win32")
			assert.equal(statSync(path).mode & 0o777, 0o600);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a child that exits before its session starts reports its last terminal lines", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "piha-149-exit-")));
	const parent = join(dir, "parent.jsonl");
	writeFileSync(
		parent,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) +
			"\n",
	);
	mkdirSync(join(dir, "sessions"));
	const surface = new FakeSurfaceProvider();
	const paneConfig = { mode: "tab", direction: "right", maxPerTab: 4 } as const;
	const operations = launchOperationsFromSurface(surface, paneConfig);
	operations.waitForShellReady = async () => {};
	operations.runScript = (_id, _command, options) => options.scriptPath;
	const supervision = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: surface
				.listSurfaces()
				.map((s) => ({ paneId: s.id, workspaceId: "fixture" })),
		}),
		(id) => surface.inspectSurface(id),
	);
	const settled: PiCompletedMetadata[] = [];
	let record: PiRunRecord | undefined;
	const session = createDefaultRunSession({
		configDir: dir,
		configExamplePath: join(repo, "config.json.example"),
		infrastructure: {
			surfaceProvider: surface,
			launchOperations: operations,
			supervision,
		},
		forcePolling: false,
		roles: [],
		getLaunchSnapshot: () => ({
			parent: {
				cwd: dir,
				invocationCwd: dir,
				sessionFile: parent,
				sessionId: "parent",
				sessionDir: join(dir, "sessions"),
				agentDir: dir,
			},
			parentRuntime: { provider: "test", modelId: "one", thinking: "high" },
			paneConfig,
			modelRegistry: {
				find: (p, id) => ({ provider: p, id, reasoning: true }),
				available: () => [],
				hasConfiguredAuth: () => true,
				supportedThinkingLevels: () => ["off", "high"],
				clampThinkingLevel: (_model, level) => level,
			},
		}),
		hooks: {
			onSpawned: (spawned) => void (record = spawned),
			onSettled: (_record, result) => void settled.push(result),
		},
		persistent: {
			send: () => ({ error: "unused" }),
			stop: () => ({ error: "unused" }),
			drain() {},
		},
	});
	const input: PiLaunchInput = {
		task: {
			id: "early-exit",
			name: "Echo",
			prompt: "bounded",
			role: "",
			cwd: dir,
			behavior: { autoExit: true, persistent: false },
		},
		role: {
			name: "",
			version: "1",
			description: "fixture",
			systemPrompt: "",
			allowedTools: [],
		},
		plans: [
			{
				provider: "test",
				modelId: "one",
				model: "test/one",
				thinking: "high",
				modelSource: "request",
				thinkingSource: "parent",
			},
		],
		resolved: {},
		identity: {
			id: "public-early-exit",
			logicalId: "logical-early-exit",
			generationId: "generation-early-exit",
			taskId: "inbox-early-exit",
		},
	};
	const error =
		'Error: Failed to load extension "/x/index.ts": Failed to load extension: Invalid subagent status config in /h/.pi/agent/herdr-agents/config.json: status must be an object';
	try {
		const handle = await session.spawnPi(input);
		const wait = session.supervise(handle, input.task);
		assert.ok(record);
		surface.appendScreen(
			record.surface,
			`$ bash '${record.launchScriptFile}'\n${error}\nOPENAI_API_KEY=sk-proj-AbCdEf0123456789AbCdEf0123456789\n__SUBAGENT_DONE_1__\n`,
		);
		await wait;
		assert.equal(settled.length, 1);
		const text = renderParentMessage(
			resolveResultPresentation(settled[0], settled[0].name),
		);
		assert.match(text, /Sub-agent "Echo" failed \(exit code 1\)\./);
		assert.match(text, /before its session started/);
		// The error's prefix survives. Its last word may not: @nubl/maestro
		// documents that the relay, which cannot learn the terminal width, joins
		// this full-width line to the credential line, and masks an ordinary word
		// glued to the credential-shaped run ("status must be an [redacted]").
		assert.ok(text.includes("Invalid subagent status config in"), text);
		assert.ok(!text.includes("sk-proj-AbCdEf0123456789"), text);
	} finally {
		await session.shutdown("quit");
		supervision.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
