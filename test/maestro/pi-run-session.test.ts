import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	existsSync,
	realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as runtime from "@nubl/maestro/runtime";
import type {
	DefaultRunSessionOptions,
	PiLaunchInput,
	PiRunRecord,
	PiCompletedMetadata,
} from "@nubl/maestro/runtime/pi-run-session-types";
import { FakeSurfaceProvider } from "@nubl/maestro/testing";
import { launchOperationsFromSurface } from "@nubl/maestro/adapters/pi/launch-operations";
import { FileWakeRegistry } from "@nubl/maestro/core/wake";
import { SupervisionCoordinator } from "@nubl/maestro/core/supervision";
import { runScriptInPane } from "../../maestro/surfaces/herdr/terminal.ts";

async function withoutHerdr<T>(run: () => Promise<T>): Promise<T> {
	const saved = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	try {
		return await run();
	} finally {
		if (saved === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = saved;
	}
}

test("a real script-write failure dispatches nothing, closes its pane, and falls back to the next model", () =>
	fixture(async (f) => {
		const input = f.input("script-write-fallback");
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		// A regular file where the script directory belongs: portable, even as root.
		const scripts = join(
			f.dir,
			"sessions",
			"artifacts",
			"parent",
			"subagent-scripts",
		);
		mkdirSync(dirname(scripts), { recursive: true });
		writeFileSync(scripts, "obstruction\n");
		const fake = f.operations.runScript;
		const failures: unknown[] = [];
		let attempts = 0;
		f.operations.runScript = async (surface, command, options) => {
			if (attempts++ > 0) return fake(surface, command, options);
			assert.equal(dirname(options.scriptPath), scripts);
			try {
				return await runScriptInPane(surface, command, options);
			} catch (error) {
				failures.push(error);
				throw error;
			}
		};
		const handle = await withoutHerdr(() => f.session.spawnPi(input));
		assert.equal(attempts, 2);
		assert.equal(failures.length, 1);
		assert.match(String(failures[0]), /EEXIST|ENOTDIR/);
		assert.equal(f.commands.length, 1, "only the fallback was dispatched");
		assert.equal(handle.launchFailure, undefined);
		const started = f.session.getStarted(input.task.id);
		assert.equal(started?.status, "started");
		assert.equal(started?.model, "test/two");
		assert.deepEqual(
			f.provider.listSurfaces().map((surface) => surface.id),
			[handle.surfaceId],
			"the failed candidate's pane was closed",
		);
	}));

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(
	run: (f: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
) {
	const f = await makeFixture();
	try {
		await run(f);
	} finally {
		await f.session.shutdown("quit");
		await turn();
		rmSync(f.dir, { recursive: true, force: true });
	}
}
async function makeFixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-composition-")));
	const parent = join(dir, "parent.jsonl");
	writeFileSync(
		parent,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) +
			"\n",
	);
	mkdirSync(join(dir, "sessions"));
	const provider = new FakeSurfaceProvider();
	const commands: string[] = [];
	const operations = launchOperationsFromSurface(provider, {
		mode: "tab",
		direction: "right",
		maxPerTab: 4,
	});
	operations.waitForShellReady = async () => {};
	operations.runScript = (_id, command, options) => {
		commands.push(command);
		return options.scriptPath;
	};
	const wake = new FileWakeRegistry();
	const coordinator = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: provider
				.listSurfaces()
				.map((s) => ({ paneId: s.id, workspaceId: "fixture" })),
		}),
		(id) => provider.inspectSurface(id),
		false,
		wake,
	);
	let registrations = 0;
	const register = coordinator.register.bind(coordinator);
	coordinator.register = (...args) => {
		registrations++;
		return register(...args);
	};
	const settled: PiCompletedMetadata[] = [];
	let latest: PiRunRecord | undefined;
	const options: DefaultRunSessionOptions = {
		configDir: dir,
		configExamplePath: fileURLToPath(
			new URL("../../config.json.example", import.meta.url),
		),
		infrastructure: {
			surfaceProvider: provider,
			launchOperations: operations,
			supervision: coordinator,
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
			paneConfig: { mode: "tab", direction: "right", maxPerTab: 4 },
			modelRegistry: {
				find: (p, id) => ({ provider: p, id, reasoning: true }),
				available: () => [],
				hasConfiguredAuth: () => true,
				supportedThinkingLevels: () => [
					"off",
					"minimal",
					"low",
					"medium",
					"high",
				],
				clampThinkingLevel: (_model, level) => level,
			},
		}),
		hooks: {
			onSpawned(record) {
				latest = record;
			},
			onSettled(_record, result) {
				settled.push(result);
			},
		},
		persistent: {
			send() {
				return { error: "test policy" };
			},
			stop() {
				return { error: "test policy" };
			},
			drain() {},
		},
	};
	assert.ok(
		runtime.createDefaultRunSession,
		"typed Pi composition must be exported as an implemented operation",
	);
	const session = runtime.createDefaultRunSession(options);
	function input(id = "control", persistent = false): PiLaunchInput {
		const plan = {
			provider: "test",
			modelId: "one",
			model: "test/one",
			thinking: "high" as const,
			modelSource: "request" as const,
			thinkingSource: "parent" as const,
		};
		return {
			task: {
				id,
				name: "child",
				prompt: "bounded",
				role: "",
				cwd: dir,
				behavior: { autoExit: !persistent, persistent },
			},
			role: {
				name: "",
				version: "1",
				description: "fixture",
				systemPrompt: "",
				allowedTools: [],
			},
			plans: [plan],
			resolved: {},
			identity: {
				id: `public-${id}`,
				logicalId: `logical-${id}`,
				generationId: `generation-${id}`,
				taskId: `inbox-${id}`,
			},
		};
	}
	function complete(
		record: PiRunRecord,
		result: {
			type: "done" | "error" | "ping";
			errorMessage?: string;
			name?: string;
			message?: string;
		} = { type: "done" },
	) {
		// Fake only process startup: emulate the real child's first session header.
		if (!existsSync(record.sessionFile))
			writeFileSync(
				record.sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: record.id,
					cwd: dir,
				}) + "\n",
			);
		writeFileSync(`${record.sessionFile}.exit`, JSON.stringify(result));
	}
	return {
		dir,
		provider,
		operations,
		options,
		session,
		input,
		complete,
		commands,
		settled,
		latest: () => latest,
		registrations: () => registrations,
	};
}
