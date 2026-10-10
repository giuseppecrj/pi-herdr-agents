import {
	captureWorktreeHandoff,
	writeWorktreeManifest,
	createWorktreeOperations,
} from "../maestro/runtime/worktree-operations.ts";
import { buildSubagentToolAllowlist } from "../maestro/adapters/pi/launch.ts";
import "./isolated-agent-dir.ts";
import { describe, it, before, after } from "node:test";
import { cleanupFixture } from "./worktree-cleanup-fixture.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	getSubagentsConfigPath,
	getSubagentsConfigExamplePath,
	getSubagentsPackageRoot,
} from "../pi-extension/subagents/config-path.ts";
import { hostname, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
	createEventBus,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "@sinclair/typebox/value";
import * as hostModule from "../pi-extension/subagents/index.ts";
import {
	isPlainObject,
	isRecord,
	isString,
} from "../maestro/core/config/type-guards.ts";
import rolePackExample from "../examples/role-pack/extension.ts";
import {
	cleanupSubagentsForShutdown,
	selectCompletionApi,
	shouldDeliverSubagentCompletion,
	shouldPreserveSubagentsOnShutdown,
} from "../pi-extension/subagents/index.ts";

import {
	getLeafId,
	getNewEntries,
	findLastAssistantMessage,
	inspectFinalAssistantMessage,
	inspectNoProgressSessionTail,
	findObservedSessionRuntime,
	appendBranchSummary,
	copySessionFile,
	mergeNewEntries,
	seedSubagentSessionFile,
	createWorktreeSessionFork,
	getSubagentSessionPolicyFile,
	readSubagentSessionPolicy,
	writeSubagentSessionPolicy,
	appendPersistentTaskEvent,
	readPersistentTaskEvents,
	appendPersistentDeliveryLedger,
	readPersistentDeliveryLedger,
	getPersistentDeliveryLedgerFile,
	writePersistentTaskInbox,
	consumePersistentTaskInbox,
	type SessionEntry,
} from "../maestro/adapters/pi/session.ts";

import {
	isHerdrAvailable,
	waitForProcessesExit,
	__herdrTest__,
} from "../maestro/surfaces/herdr/herdr.ts";
import {
	computeConfigRevision,
	getConfigWriteLockPath,
	loadModelConfig,
	parseModelConfig,
	readConfigRevision,
	resolveModelDefault,
	TaskModelConfigWriteError,
	writeTaskModelConfig,
} from "../maestro/core/config/model-config.ts";
import {
	TASK_MODEL_INIT_APPROVAL_EVENT,
	TASK_MODEL_INIT_START_EVENT,
} from "../maestro/core/config/task-model-init.ts";
import {
	loadRoleConfig,
	parseRoleConfig,
} from "../maestro/core/config/role-config.ts";
import {
	createSubagentPaneFactory,
	loadPaneConfig,
	parsePaneConfig,
} from "../maestro/core/config/pane-config.ts";
import {
	loadPersistentConfig,
	parsePersistentConfig,
} from "../maestro/core/config/persistent-config.ts";
import {
	loadSupervisionConfig,
	parseSupervisionConfig,
} from "../maestro/core/config/supervision-config.ts";
import { FileWakeRegistry } from "../maestro/core/wake.ts";
import {
	POLLING_INTERVAL_MS,
	SupervisionCoordinator,
} from "../maestro/core/supervision.ts";
import {
	advanceStatusState,
	capStatusLines,
	classifyStatus,
	createStatusState,
	forceStatusAfterInterrupt,
	formatStatusAggregate,
	formatStatusLine,
	formatTransitionLine,
	observeStatus,
	loadStatusConfig,
	parseStatusConfig,
} from "../maestro/core/status.ts";
import {
	createSubagentActivityRecorder,
	getSubagentActivityFile,
	readSubagentActivityFile,
} from "../maestro/adapters/pi/activity-file.ts";
import type { SubagentActivityState } from "../maestro/core/types.ts";
import { projectActivity } from "../maestro/core/activity.ts";
import subagentDoneExtension, {
	shouldMarkUserTookOver,
	shouldAutoExitOnAgentEnd,
	findLatestAssistantError,
	buildCompletionSidecar,
	buildPersistentTaskEvent,
	isPersistentStopDirective,
} from "../maestro/adapters/pi/child/subagent-done.ts";
import {
	interpretExitSidecar,
	waitForCompletion,
} from "../maestro/adapters/pi/completion.ts";
import {
	createLifecycle,
	lifecycleTransition,
	markCompleted,
	markCompletionDetected,
	markFailed,
	markInterruptRequested,
	observeActivity as observeLifecycleActivity,
	observePaneInspection,
	projectLifecycle,
	type SubagentLifecycle,
} from "../maestro/core/lifecycle.ts";
import {
	launchPiSubagent,
	launchOperationsFromSurface,
} from "../maestro/adapters/pi/launch.ts";
import { HerdrSurfaceProvider } from "../maestro/surfaces/herdr/herdr-surface-provider.ts";
import {
	createDefaultRunSession,
	type PiPersistentIO,
	type PiRunSession,
	type PiRunRecord,
} from "../maestro/runtime/index.ts";
import { buildAuthenticatedModelCatalog } from "../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "../maestro/adapters/pi/model-registry.ts";
import { FakeSurfaceProvider } from "../maestro/surfaces/fake/fake-surface-provider.ts";

// Tool-registration behavior is environment-sensitive for child subagents.
// Isolate the unit suite from inherited parent/child capability variables.
const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
const inheritedDenyTools = process.env.PI_DENY_TOOLS;
before(() => {
	delete process.env.PI_SUBAGENT_ID;
	delete process.env.PI_DENY_TOOLS;
});
after(() => {
	if (inheritedSubagentId == null) delete process.env.PI_SUBAGENT_ID;
	else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
	if (inheritedDenyTools == null) delete process.env.PI_DENY_TOOLS;
	else process.env.PI_DENY_TOOLS = inheritedDenyTools;
});

// --- Helpers ---

function createTestDir(): string {
	return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
	const file = join(dir, "test-session.jsonl");
	const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(file, content);
	return file;
}

function withTempDir(run: (dir: string) => void) {
	const dir = createTestDir();
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function createMockExtensionApi(extensionEvents = createEventBus()) {
	const registeredTools: Array<any> = [];
	const registeredCommands: Array<any> = [];
	const registeredShortcuts: Array<any> = [];
	const registeredMessageRenderers: Array<any> = [];
	const eventHandlers = new Map<string, Array<Function>>();
	const sentUserMessages: string[] = [];
	const sentMessages: Array<any> = [];
	return {
		registeredTools,
		registeredCommands,
		registeredShortcuts,
		registeredMessageRenderers,
		eventHandlers,
		sentUserMessages,
		sentMessages,
		// SAFETY: this fixture implements only the ExtensionAPI members these
		// tests exercise; TypeScript cannot verify partial-mock compatibility
		// without also declaring every unused SDK method.
		api: {
			events: extensionEvents,
			on(event: string, handler: Function) {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
			registerTool(tool: any) {
				registeredTools.push(tool);
			},
			registerCommand(name: string, command: any) {
				registeredCommands.push({ name, ...command });
			},
			registerMessageRenderer(name: string, renderer: any) {
				registeredMessageRenderers.push({ name, renderer });
			},
			registerShortcut(key: string, shortcut: any) {
				registeredShortcuts.push({ key, ...shortcut });
			},
			sendUserMessage(message: string) {
				sentUserMessages.push(message);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			getAllTools() {
				return [];
			},
			// Pi activates registered tools by default.
			getActiveTools() {
				return registeredTools.map((tool) => tool.name);
			},
		} as any,
	};
}

function restoreEnvVar(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

async function withMockedNowAsync<T>(
	now: number,
	fn: () => Promise<T>,
): Promise<T> {
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		return await fn();
	} finally {
		Date.now = originalNow;
	}
}

function writeAgentFile(
	agentsDir: string,
	name: string,
	frontmatter: string,
	body = "You are a test agent.",
) {
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\n${frontmatter}\n---\n\n${body}\n`,
	);
}

async function withIsolatedAgentEnv(
	fn: (paths: {
		projectDir: string;
		projectAgentsDir: string;
		globalDir: string;
		globalAgentsDir: string;
	}) => Promise<void> | void,
) {
	const root = createTestDir();
	const previousCwd = process.cwd();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const projectDir = join(root, "project");
	const projectAgentsDir = join(projectDir, ".pi", "agents");
	const globalDir = join(root, "global");
	const globalAgentsDir = join(globalDir, "agents");

	mkdirSync(projectAgentsDir, { recursive: true });
	mkdirSync(globalAgentsDir, { recursive: true });
	process.chdir(projectDir);
	process.env.PI_CODING_AGENT_DIR = globalDir;

	try {
		await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
	} finally {
		process.chdir(previousCwd);
		restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
		rmSync(root, { recursive: true, force: true });
	}
}
const SESSION_HEADER: SessionEntry = {
	type: "session",
	id: "sess-001",
	version: 3,
};
const MODEL_CHANGE: SessionEntry = {
	type: "model_change",
	id: "mc-001",
	parentId: null,
};
const USER_MSG: SessionEntry = {
	type: "message",
	id: "user-001",
	parentId: "mc-001",
	message: {
		role: "user",
		content: [{ type: "text", text: "Hello, plan something" }],
	},
};
const ASSISTANT_MSG: SessionEntry = {
	type: "message",
	id: "asst-001",
	parentId: "user-001",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Here is my plan..." }],
	},
};
const ASSISTANT_MSG_2: SessionEntry = {
	type: "message",
	id: "asst-002",
	parentId: "asst-001",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me think..." },
			{ type: "text", text: "Updated plan with details." },
		],
	},
};
const TOOL_RESULT: SessionEntry = {
	type: "message",
	id: "tool-001",
	parentId: "asst-001",
	message: {
		role: "toolResult",
		toolCallId: "tc-001",
		toolName: "bash",
		content: [{ type: "text", text: "output here" }],
	},
};

// Persistent policy fixtures inject the production I/O implementation, obtained
// through an actual Pi composition acquisition. No session helper is laundered
// through the host or runtime barrel just for these tests.
async function persistentFixtureIO(): Promise<PiPersistentIO> {
	const dir = createTestDir();
	const surface = new FakeSurfaceProvider();
	const ops = launchOperationsFromSurface(surface, {
		mode: "tab",
		direction: "right",
		maxPerTab: 4,
	});
	ops.waitForShellReady = async () => {};
	ops.runScript = (_id, _command, options) => options.scriptPath;
	const supervision = new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		(id) => surface.inspectSurface(id),
	);
	let captured!: PiPersistentIO;
	const session = createDefaultRunSession({
		configDir: dir,
		configExamplePath: getSubagentsConfigExamplePath(),
		roles: [],
		forcePolling: false,
		infrastructure: {
			surfaceProvider: surface,
			launchOperations: ops,
			supervision,
		},
		getLaunchSnapshot: () => ({
			parent: {
				cwd: dir,
				sessionFile: "",
				sessionId: "fixture",
				sessionDir: dir,
				agentDir: dir,
			},
			modelRegistry: {
				find: (provider, id) => ({ provider, id, reasoning: true }),
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
			paneConfig: { mode: "tab", direction: "right", maxPerTab: 4 },
		}),
		hooks: { onSettled() {} },
		persistent: {
			send(_r, _text, io) {
				captured = io;
				return { error: "fixture captures I/O only" };
			},
			stop() {
				return { error: "unused" };
			},
			drain() {},
		},
	});
	try {
		await session.spawnPi({
			task: {
				id: "io-fixture",
				name: "fixture",
				prompt: "first",
				role: "",
				cwd: dir,
				behavior: { persistent: true },
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
					provider: "fake",
					modelId: "fixture",
					model: "fake/fixture",
					thinking: "off",
					modelSource: "request",
					thinkingSource: "request",
				},
			],
			resolved: {},
			identity: {
				id: "public-io",
				logicalId: "logical-io",
				generationId: "generation-io",
				taskId: "task-io",
			},
		});
		await session.sendPersistent("io-fixture", "capture");
		return captured;
	} finally {
		await session.shutdown("quit");
		rmSync(dir, { recursive: true, force: true });
	}
}
const testIO = await persistentFixtureIO();
const subagentsModule = {
	...hostModule,
	__test__: {
		...hostModule.__test__,
		handleSubagentSend: (
			params: Parameters<typeof hostModule.__test__.handleSubagentSend>[0],
		) => hostModule.__test__.handleSubagentSend(params, testIO),
		handleSubagentStop: (
			params: Parameters<typeof hostModule.__test__.handleSubagentStop>[0],
			api: Parameters<typeof hostModule.__test__.handleSubagentStop>[1],
			timeout = 15_000,
		) => hostModule.__test__.handleSubagentStop(params, api, timeout, testIO),
		deliverPersistentTaskEvent: (
			record: Parameters<
				typeof hostModule.__test__.deliverPersistentTaskEvent
			>[0],
			event: Parameters<
				typeof hostModule.__test__.deliverPersistentTaskEvent
			>[1],
			api: Parameters<typeof hostModule.__test__.deliverPersistentTaskEvent>[2],
			ledger?: ReturnType<PiPersistentIO["readLedger"]>,
		) =>
			hostModule.__test__.deliverPersistentTaskEvent(
				record,
				event,
				api,
				testIO,
				ledger,
			),
		drainPersistentTaskEvents: (
			record: Parameters<
				typeof hostModule.__test__.drainPersistentTaskEvents
			>[0],
			api: Parameters<typeof hostModule.__test__.drainPersistentTaskEvents>[1],
			readLedger = readPersistentDeliveryLedger,
		) =>
			hostModule.__test__.drainPersistentTaskEvents(record, api, {
				...testIO,
				readLedger: (r) => readLedger(r.sessionFile),
			}),
		notifyPersistentCrash: (
			record: Parameters<typeof hostModule.__test__.notifyPersistentCrash>[0],
			api: Parameters<typeof hostModule.__test__.notifyPersistentCrash>[1],
		) => hostModule.__test__.notifyPersistentCrash(record, api, testIO),
		evaluateNoProgressAdvisory: (
			...args: [
				Parameters<typeof hostModule.__test__.evaluateNoProgressAdvisory>[0],
				Parameters<typeof hostModule.__test__.evaluateNoProgressAdvisory>[1],
				number,
				number,
			]
		) =>
			hostModule.__test__.evaluateNoProgressAdvisory(...args, (r) =>
				inspectNoProgressSessionTail(r.sessionFile),
			),
	},
};

// --- Tests ---

// Keep the real host/adapter/launch/sidecar path; fake only Herdr and starting Pi.
async function withAdapterHost(run: (f: any) => Promise<void>) {
	await withIsolatedAgentEnv(async (paths) => {
		// SAFETY: this process-local extension runtime is owned by index.ts.
		const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
		const previous = {
			pi: runtime.pi,
			latestCtx: runtime.latestCtx,
			session: runtime.session,
		};
		runtime.session = undefined;
		const surface = new FakeSurfaceProvider();
		const restorers: Array<() => void> = [];
		const commands: string[] = [];
		const closed: string[] = [];
		let registrations = 0;
		const wake = new FileWakeRegistry();
		const supervision = new SupervisionCoordinator(
			async () => ({
				complete: true,
				panes: surface
					.listSurfaces()
					.map((s) => ({ paneId: s.id, workspaceId: "fixture" })),
			}),
			(id) => surface.inspectSurface(id),
			false,
			wake,
		);
		const register = supervision.register.bind(supervision);
		supervision.register = (...args) => {
			registrations++;
			return register(...args);
		};
		const launchOperations = launchOperationsFromSurface(surface, {
			mode: "tab",
			direction: "right",
			maxPerTab: 4,
		});
		const infrastructure = {
			surfaceProvider: surface,
			launchOperations,
			supervision,
		};
		function patch(target: any, name: string, value: any) {
			const original = target[name];
			target[name] = value;
			restorers.push(() => {
				target[name] = original;
			});
		}
		function patchTransport() {
			patch(surface, "isAvailable", () => true);
			const close = surface.closeSurface.bind(surface);
			patch(surface, "closeSurface", async (id: string) => {
				closed.push(id);
				await close(id);
			});
			patch(launchOperations, "createPane", (name: string, cwd?: string) =>
				surface.createSurface({
					name,
					cwd: cwd ?? paths.projectDir,
					placement: { kind: "tab" },
				}),
			);
			patch(launchOperations, "waitForShellReady", async () => {});
			patch(surface, "waitForShellReady", async () => {});
			patch(
				surface,
				"runScript",
				(_id: string, command: string, opts: { scriptPath: string }) => {
					commands.push(command);
					mkdirSync(dirname(opts.scriptPath), { recursive: true });
					writeFileSync(opts.scriptPath, command);
					return opts.scriptPath;
				},
			);
			patch(
				launchOperations,
				"runScript",
				(_id: string, command: string, opts: any) => {
					commands.push(command);
					return opts.scriptPath;
				},
			);
		}
		patchTransport();
		const mock = createMockExtensionApi();
		const apis = [mock];
		mock.api.getThinkingLevel = () => "high";
		subagentsModule.default(mock.api, { infrastructure });
		const sessionDir = join(paths.projectDir, "parent-sessions");
		mkdirSync(sessionDir);
		const sessionFile = createSessionFile(sessionDir, [
			{ type: "session", version: 3, id: "parent", cwd: paths.projectDir },
		]);
		const ctx = {
			cwd: paths.projectDir,
			model: { provider: "fake", id: "parent" },
			modelRegistry: {
				find: (provider: string, id: string) => ({
					provider,
					id,
					reasoning: id !== "plain",
				}),
				hasConfiguredAuth: () => true,
			},
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionId: () => "parent",
				getSessionDir: () => sessionDir,
			},
		};
		const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
		async function launch(params: any, api = mock, context: any = ctx) {
			const signal = new AbortController();
			const result = await api.registeredTools
				.find((t: any) => t.name === "subagent")
				.execute("call", params, signal.signal, undefined, context);
			signal.abort(); // Tool cancellation must not cancel the independent watcher.
			return runtime.runningSubagents.get(result.details.id);
		}
		async function finish(
			child: any,
			result: {
				type: "done" | "error" | "ping";
				errorMessage?: string;
				name?: string;
				message?: string;
			} = { type: "done" },
		) {
			writeFileSync(`${child.sessionFile}.exit`, JSON.stringify(result));
			// Observe this actual attempt, not the logical producer that may continue
			// through another candidate. The real adapter/coordinator still reads it.
			const deadline = Date.now() + 3_000;
			while (
				child.lifecycle.process.kind !== "completed" &&
				child.lifecycle.process.kind !== "failed"
			) {
				assert.ok(Date.now() < deadline, "actual Pi attempt did not settle");
				await turn();
			}
			await turn();
		}
		try {
			await run({
				...paths,
				runtime,
				mock,
				ctx,
				surface,
				commands,
				closed,
				launch,
				finish,
				turn,
				patchTransport,
				patch,
				apis,
				launchOperations,
				infrastructure,
				handle: (child: any) =>
					runtime.session.getHandle(runtime.session.getControlTaskId(child.id)),
				registrations: () => registrations,
			});
		} finally {
			for (const child of runtime.runningSubagents.values()) {
				runtime.session.suppress(runtime.session.getControlTaskId(child.id));
				if (child.stopTimeout) clearTimeout(child.stopTimeout);
			}
			await turn();
			for (const api of apis)
				for (const handler of api.eventHandlers.get("session_shutdown") ?? [])
					await handler({ reason: "quit" }, { ui: { setWidget() {} } });
			supervision.close();
			wake.close();
			runtime.runningSubagents.clear();
			for (const restore of restorers.reverse()) restore();
			Object.assign(runtime, previous);
		}
	});
}

async function until(f: any, predicate: () => boolean, what: string) {
	const deadline = Date.now() + 8_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
		await f.turn();
	}
}

/** Mirrors Pi: a context throws on every read once its session is replaced. */
function invalidatableContext<
	T extends {
		cwd: string;
		model: object;
		modelRegistry: object;
		sessionManager: object;
	},
>(ctx: T) {
	let stale = false;
	const assertLive = () => {
		if (stale)
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
	};
	return {
		ctx: {
			get hasUI() {
				assertLive();
				return false;
			},
			get cwd() {
				assertLive();
				return ctx.cwd;
			},
			get model() {
				assertLive();
				return ctx.model;
			},
			get modelRegistry() {
				assertLive();
				return ctx.modelRegistry;
			},
			get sessionManager() {
				assertLive();
				return ctx.sessionManager;
			},
		},
		invalidate() {
			stale = true;
		},
	};
}

describe("host adapter migration", () => {
	it("quit then a second host load creates a healthy coordinator without resetting the global session", async () =>
		withAdapterHost(async (f) => {
			const first = f.runtime.session;
			let finishShutdown!: () => void;
			const shutdownGate = new Promise<void>((resolve) => {
				finishShutdown = resolve;
			});
			const closeFirst = first.shutdown.bind(first);
			// Hold the old owner's asynchronous shutdown open across a second load.
			f.patch(first, "shutdown", async (reason: any) => {
				await closeFirst(reason);
				await shutdownGate;
			});
			const shutdown = f.mock.eventHandlers.get("session_shutdown")[0];
			const quitting = shutdown({ reason: "quit" }, { ui: { setWidget() {} } });
			const wake = new FileWakeRegistry();
			const supervision = new SupervisionCoordinator(
				async () => ({
					complete: true,
					panes: f.surface
						.listSurfaces()
						.map((s: any) => ({ paneId: s.id, workspaceId: "fixture" })),
				}),
				(id) => f.surface.inspectSurface(id),
				false,
				wake,
			);
			try {
				const next = createMockExtensionApi();
				f.apis.push(next);
				next.api.getThinkingLevel = () => "high";
				// No withAdapterHost reset between quit and this actual second load.
				hostModule.default(next.api, {
					infrastructure: { ...f.infrastructure, supervision },
				});
				const child = await f.launch(
					{ name: "after-quit", task: "bounded" },
					next,
				);
				assert.notEqual(f.runtime.session, first);
				assert.deepEqual(f.runtime.session.diagnostics(), {
					mode: "wake+batch",
					watcherCount: 1,
				});
				assert.deepEqual(supervision.diagnostics(), {
					mode: "wake+batch",
					watcherCount: 1,
				});
				const second = f.runtime.session;
				finishShutdown();
				await quitting;
				assert.equal(
					f.runtime.session,
					second,
					"an old shutdown must not clear the replacement after await",
				);
				await f.finish(child);
				assert.equal(next.sentMessages.length, 1);
			} finally {
				finishShutdown();
				await quitting;
				supervision.close();
				wake.close();
			}
		}));

	it("local evidence keeps the host presentation cold while pane observations still redraw", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({ name: "cold-widget", task: "bounded" });
			let widgets = 0;
			f.ctx.hasUI = true;
			f.ctx.ui = {
				setWidget() {
					widgets++;
				},
			};
			const owner =
				f.runtime.session[Symbol.for("pi-herdr-agents/PiRunSession-owner")];
			const onObserved = owner.options.hooks.onObserved;
			const observation = {
				observedAt: Date.now(),
				lifecycle: child.lifecycle,
				projection: projectLifecycle(child.lifecycle, Date.now()),
			};
			onObserved(child, { ...observation, kind: "local-evidence" });
			assert.equal(widgets, 0);
			onObserved(child, { ...observation, kind: "pane" });
			assert.equal(widgets, 1);
			await f.finish(child);
		}));

	it("final quit suppresses and aborts unowned legacy rows synchronously", async () =>
		withAdapterHost(async (f) => {
			const abortController = new AbortController();
			const legacy = {
				id: "legacy",
				lifecycle: createLifecycle(0),
				abortController,
			};
			f.runtime.runningSubagents.set(legacy.id, legacy);
			let gatedAtAbort = false;
			abortController.signal.addEventListener("abort", () => {
				gatedAtAbort = legacy.lifecycle.delivery === "suppressed";
			});
			const shutdown = f.mock.eventHandlers.get("session_shutdown")[0](
				{ reason: "quit" },
				{ ui: { setWidget() {} } },
			);
			assert.equal(gatedAtAbort, true);
			assert.equal(abortController.signal.aborted, true);
			assert.equal(f.runtime.runningSubagents.size, 0);
			await shutdown;
		}));

	it("public launch owns the four-argument advisory route and keeps duplicate and fresh evaluations cold", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({ name: "advisory", task: "bounded" });
			const session = f.runtime.session;
			const control = session.getControlTaskId(child.id);
			assert.equal(control, session.getTask(control).id);
			assert.equal(session.getRecord(control), child);
			const inspect = session.inspectProgress.bind(session);
			let inspections = 0;
			f.patch(session, "inspectProgress", (id: string) => {
				assert.equal(id, control);
				assert.equal(session.getRecord(id), child);
				inspections++;
				return inspect(id);
			});
			writeFileSync(
				child.sessionFile,
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call", name: "bash" }],
						stopReason: "toolUse",
					},
				}) + "\n",
			);
			utimesSync(child.sessionFile, 0, 0);
			child.lifecycle = observePaneInspection(
				createLifecycle(0),
				{ kind: "present", observedAt: 1, agentStatus: "working" },
				1,
			);
			const now = 120_000;
			const evaluate = (at: number) =>
				hostModule.__test__.evaluateNoProgressAdvisory(
					child,
					projectLifecycle(child.lifecycle, at),
					at,
					1,
				);
			const advisory = evaluate(now)!;
			assert.equal(advisory.classification, "blocked-tool");
			assert.equal(advisory.lastEntryKind, "assistant");
			assert.equal(advisory.notify, true);
			assert.equal(inspections, 1);
			assert.equal(evaluate(now + 1000), undefined);
			utimesSync(child.sessionFile, 0, (now + 2000) / 1000);
			assert.equal(evaluate(now + 2000)?.kind, "recovered");
			assert.equal(evaluate(now + 3000), undefined);
			assert.equal(inspections, 1);
			await f.finish(child);
		}));

	for (const boundary of ["adapter", "finalizer"])
		for (const accepted of [true, false])
			it(`ordinary ${boundary} transcript failure preserves Stage3 payload and ${accepted ? "nonblocking close" : "rejected-send manual retention"}`, async () =>
				withAdapterHost(async (f) => {
					writeAgentFile(
						f.projectAgentsDir,
						"error-role",
						"spawning: false\nauto-exit: true",
						"Bounded identity",
					);
					const child = await f.launch({
						name: "processing",
						agent: "error-role",
						task: "bounded",
						model: "fake/first, fake/second",
					});
					child.startTime = Date.now() - 12000;
					assert.deepEqual(child.runtimePlan, {
						provider: "fake",
						modelId: "first",
						model: "fake/first",
						thinking: "high",
						modelSource: "request",
						thinkingSource: "parent",
						requestedModel: "fake/first",
					});
					const session = f.runtime.session;
					const controlTaskId = session.getControlTaskId(child.id);
					const owner =
						session[Symbol.for("pi-herdr-agents/PiRunSession-owner")];
					const observed = owner.options.hooks.onObserved;
					const completions: any[] = [];
					owner.options.hooks.onObserved = (record: any, observation: any) => {
						observed(record, observation);
						if (observation.kind !== "completion") return;
						completions.push({
							record,
							process: record.lifecycle.process.kind,
						});
						if (boundary === "finalizer") {
							rmSync(child.sessionFile);
							mkdirSync(child.sessionFile);
						}
					};
					const sends: any[] = [];
					const send = f.mock.api.sendMessage;
					f.mock.api.sendMessage = (...args: any[]) => {
						sends.push({
							message: args[0],
							options: args[1],
							delivery: child.lifecycle.delivery,
							tracked: f.runtime.runningSubagents.has(child.id),
							closes: f.closed.length,
						});
						if (!accepted) throw new Error("ordinary error send rejected");
						send(...args);
					};
					let releaseClose!: () => void;
					const closeWait = new Promise<void>((resolve) => {
						releaseClose = resolve;
					});
					const close = f.surface.closeSurface.bind(f.surface);
					let closeStarted = false;
					f.patch(f.surface, "closeSurface", async (id: string) => {
						closeStarted = true;
						await closeWait;
						await close(id);
					});
					try {
						if (boundary === "adapter") mkdirSync(child.sessionFile);
						else
							writeFileSync(
								child.sessionFile,
								JSON.stringify({
									type: "session",
									version: 3,
									id: child.id,
									cwd: f.projectDir,
								}) + "\n",
							);
						writeFileSync(
							`${child.sessionFile}.exit`,
							JSON.stringify({
								type: "error",
								errorMessage: "real provider evidence",
							}),
						);
						const deadline = Date.now() + 3000;
						while (session.getTask(controlTaskId)) {
							assert.ok(Date.now() < deadline);
							await f.turn();
						}
						await f.turn();
						assert.equal(completions.length, boundary === "finalizer" ? 1 : 0);
						if (boundary === "finalizer") {
							assert.equal(completions[0].record, child);
							assert.equal(completions[0].process, "finalizing");
						}
						assert.equal(sends.length, 1);
						assert.equal(sends[0].delivery, "delivered");
						assert.equal(sends[0].tracked, false);
						assert.equal(sends[0].closes, 0);
						assert.equal(
							owner.entries.size,
							0,
							"retirement must precede close resolution, without Pi getters",
						);
						assert.equal(f.commands.length, 1);
						assert.equal(f.registrations(), 1);
						assert.equal(closeStarted, accepted);
						assert.equal(
							f.closed.length,
							0,
							"ordinary close is still unresolved",
						);
						const { message, options } = sends[0];
						assert.equal(message.customType, "subagent_result");
						assert.equal(message.display, true);
						assert.deepEqual(options, {
							triggerTurn: true,
							deliverAs: "steer",
						});
						assert.ok(Number.isInteger(message.details.elapsed));
						assert.ok(
							message.details.elapsed >= 12 && message.details.elapsed <= 14,
						);
						// Stage3 watchSubagent catch -> fallback wrapper -> ordinary .then:
						// no result runtimePlan/session/errorMessage; details retain the live plan.
						const rawError = `EISDIR: illegal operation on a directory, read`;
						const resultContent = `Sub-agent "processing" failed (exit code 1).\n\nSubagent error: ${rawError}\n\nRequested model: fake/first`;
						assert.deepEqual(message.details, {
							name: "processing",
							task: "bounded",
							agent: "error-role",
							exitCode: 1,
							elapsed: message.details.elapsed,
							sessionFile: undefined,
							fallbackAttempts: ["fake/first"],
							fallbackFailures: [],
							runtimePlan: child.runtimePlan,
							resultContent,
						});
						assert.equal(message.details.resultContent, resultContent);
						assert.equal(
							message.content,
							`${resultContent}\n\nParent action: Continue the parent task using this result; do not return an empty response.`,
						);
						assert.equal(f.mock.sentMessages.length, accepted ? 1 : 0);
					} finally {
						releaseClose();
						await f.turn();
					}
					assert.equal(f.closed.length, accepted ? 1 : 0);
					assert.equal(f.surface.listSurfaces().length, accepted ? 0 : 1);
				}));
	it("preserves clamped runtime provenance, bare identity and omitted cwd configuration", async () =>
		withAdapterHost(async (f) => {
			mkdirSync(join(f.projectDir, ".pi", "agent"), { recursive: true });
			const child = await f.launch({
				name: "bare",
				task: "bounded",
				model: "fake/plain",
				systemPrompt: "Bare identity",
			});
			assert.ok(
				f.handle(child),
				"composition retains the actual handle for completion and reload",
			);
			assert.equal(
				f.runtime.session.getRecord(
					f.runtime.session.getControlTaskId(child.id),
				),
				child,
			);
			assert.equal(f.handle(child).sessionId, child.sessionFile);
			assert.equal(child.agent, undefined);
			assert.equal(child.interactive, false);
			assert.deepEqual(child.runtimePlan, {
				provider: "fake",
				modelId: "plain",
				model: "fake/plain",
				thinking: "off",
				modelSource: "request",
				thinkingSource: "parent",
				requestedModel: "fake/plain",
				thinkingAdjustment: {
					from: "high",
					to: "off",
					reason: "non-reasoning",
				},
			});
			assert.ok(child.sessionFile.startsWith(join(f.globalDir, "sessions")));
			assert.deepEqual(
				readSubagentSessionPolicy(child.sessionFile).tools,
				null,
			);
			assert.ok(f.commands[0].includes("PI_SUBAGENT_AUTO_EXIT=1"));
			assert.ok(
				!f.commands[0].includes(
					`PI_CODING_AGENT_DIR='${join(f.projectDir, ".pi", "agent")}'`,
				),
			);
			await f.finish(child);
			assert.equal(f.registrations(), 1);
			assert.equal(f.closed.length, 1);
			assert.deepEqual(
				f.mock.sentMessages.at(-1).message.details.runtimePlan,
				child.runtimePlan,
			);
		}));
	it("normalizes named identity, full spawning denial, role cwd, tools and skills before spawn", async () =>
		withAdapterHost(async (f) => {
			const roleCwd = join(f.globalDir, "role-folder");
			mkdirSync(join(roleCwd, ".pi", "agent"), { recursive: true });
			writeAgentFile(
				f.projectAgentsDir,
				"host-role",
				"cwd: role-folder\nspawning: false\nskills: role-skill\ntools: read, bash\nsession-mode: lineage-only\nsystem-prompt: replace",
				"Named identity",
			);
			const child = await f.launch({
				name: "named",
				agent: "host-role",
				task: "bounded",
				systemPrompt: "Ignored bare identity",
				skills: "one, two",
				tools: "read",
			});
			assert.ok(f.handle(child));
			assert.equal(child.agent, "host-role");
			assert.equal(child.interactive, true);
			assert.equal(f.handle(child).cwd, roleCwd);
			const policy = readSubagentSessionPolicy(child.sessionFile);
			assert.deepEqual(policy.tools, ["read"]);
			assert.ok(policy.deniedTools.includes("subagents_write_task_models"));
			assert.ok(
				f.commands[0].includes(
					`PI_CODING_AGENT_DIR='${join(roleCwd, ".pi", "agent")}'`,
				),
			);
			assert.match(f.commands[0], /\/skill:one.*\/skill:two/);
			assert.ok(!f.commands[0].includes("PI_SUBAGENT_AUTO_EXIT=1"));
			const identityPath = f.commands[0].match(
				/--system-prompt '([^']+)'/,
			)?.[1];
			assert.ok(identityPath);
			assert.equal(readFileSync(identityPath, "utf8").trim(), "Named identity");
			assert.equal(
				getNewEntries(child.sessionFile, 0)[0].parentSession,
				f.ctx.sessionManager.getSessionFile(),
			);
			await f.finish(child);
			mkdirSync(join(f.projectDir, ".pi", "agent"), { recursive: true });
			const explicit = await f.launch({
				name: "explicit",
				task: "bounded",
				cwd: ".",
			});
			assert.equal(f.handle(explicit).cwd, f.projectDir);
			assert.ok(
				f.commands[1].includes(
					`PI_CODING_AGENT_DIR='${join(f.projectDir, ".pi", "agent")}'`,
				),
			);
			await f.finish(explicit);
		}));
	for (const mode of [undefined, "append", "replace"]) {
		it(`passes caller systemPrompt through a frontmatter-only named role (${mode ?? "task wrapper"})`, async () =>
			withAdapterHost(async (f) => {
				writeAgentFile(
					f.projectAgentsDir,
					"frontmatter-only",
					`auto-exit: true${mode ? `\nsystem-prompt: ${mode}` : ""}`,
					"",
				);
				const child = await f.launch({
					name: "fallback",
					agent: "frontmatter-only",
					task: "bounded",
					systemPrompt: "Caller fallback identity",
				});
				assert.ok(child);
				assert.equal(child.agent, "frontmatter-only");
				const command = f.commands[0];
				const promptPath = mode
					? command.match(
							mode === "replace"
								? /--system-prompt '([^']+)'/
								: /--append-system-prompt '([^']+)'/,
						)?.[1]
					: command.match(/'@([^']+)'/)?.[1];
				assert.ok(
					promptPath,
					"child command must reference the prompt artifact",
				);
				const prompt = readFileSync(promptPath, "utf8");
				if (mode) assert.equal(prompt, "Caller fallback identity");
				else assert.ok(prompt.startsWith("\n\nCaller fallback identity\n\n"));
				await f.finish(child);
			}));
	}
	it("launches a frontmatter-only named role without a caller systemPrompt", async () =>
		withAdapterHost(async (f) => {
			writeAgentFile(
				f.projectAgentsDir,
				"no-identity",
				"auto-exit: true\nsystem-prompt: replace",
				"",
			);
			const child = await f.launch({
				name: "no-fallback",
				agent: "no-identity",
				task: "bounded",
			});
			assert.ok(child);
			assert.doesNotMatch(f.commands[0], /--(?:append-)?system-prompt/);
			const promptPath = f.commands[0].match(/'@([^']+)'/)?.[1];
			assert.ok(promptPath);
			assert.equal(
				readFileSync(promptPath, "utf8"),
				"\n\nComplete your task autonomously.\n\nbounded\n\nYour FINAL assistant message should summarize what you accomplished.",
			);
			await f.finish(child);
		}));
	it("shares persistent task state and the raw generation cursor with one watcher and one initial ledger row", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({
				name: "specialist",
				task: "first",
				persistent: true,
			});
			assert.ok(f.handle(child));
			assert.equal(
				f.runtime.session.getRecord(
					f.runtime.session.getControlTaskId(child.id),
				),
				child,
			);
			assert.equal(readPersistentDeliveryLedger(child.sessionFile).length, 1);
			assert.equal(f.registrations(), 1);
			appendPersistentTaskEvent(child.sessionFile, {
				type: "task-done",
				task: "stale",
				generation: "other-generation",
			});
			appendPersistentTaskEvent(child.sessionFile, {
				type: "task-done",
				task: child.taskId,
				generation: child.generationId,
			});
			let rejected!: () => void;
			let delivered!: () => void;
			const rejection = new Promise<void>((resolve) => {
				rejected = resolve;
			});
			const delivery = new Promise<void>((resolve) => {
				delivered = resolve;
			});
			const send = f.mock.api.sendMessage;
			let attempts = 0;
			let allowDelivery = false;
			f.mock.api.sendMessage = (...args: any[]) => {
				attempts++;
				if (!allowDelivery) {
					rejected();
					throw new Error("transient parent delivery failure");
				}
				send(...args);
				delivered();
			};
			await rejection;
			await f.turn();
			assert.ok(
				child.taskId,
				"failed delivery must keep the assigned task for retry",
			);
			assert.equal(child.observedTaskEvents, 0);
			allowDelivery = true;
			appendPersistentTaskEvent(child.sessionFile, {
				type: "task-done",
				task: "wake-again",
				generation: "other-generation",
			});
			await delivery;
			await f.turn();
			assert.equal(child.taskId, undefined);
			assert.equal(child.tasksCompleted, 1);
			assert.equal(child.observedTaskEvents, 3);
			assert.ok(attempts >= 2);
			assert.equal(f.mock.sentMessages.length, 1);
			assert.equal(readPersistentDeliveryLedger(child.sessionFile).length, 2);
			assert.deepEqual(child.activityRead, {
				ok: false,
				reason: "missing",
				error: undefined,
			});
			assert.equal(
				f.runtime.session.getRecord(
					f.runtime.session.getControlTaskId(child.id),
				).tasksCompleted,
				1,
			);
			child.stopState = "requested";
			await f.finish(child);
			assert.equal(f.registrations(), 1);
			assert.equal(f.closed.length, 1);
		}));
	it("retains each owning adapter and watcher through reload while new launches use the new parent snapshot", async () =>
		withAdapterHost(async (f) => {
			const old = await f.launch({ name: "old", task: "bounded" });
			assert.ok(f.handle(old));
			const owner = f.runtime.session;
			const oldHandle = f.handle(old);
			const reloaded = await import(
				`../pi-extension/subagents/index.ts?task11-${Date.now()}`
			);
			const replacement = createMockExtensionApi();
			f.apis.push(replacement);
			replacement.api.getThinkingLevel = () => "low";
			reloaded.default(replacement.api, { infrastructure: f.infrastructure });
			f.ctx.model = { provider: "fake", id: "replacement" };
			const next = await f.launch(
				{ name: "new", task: "bounded" },
				replacement,
			);
			assert.equal(owner.getRecord(owner.getControlTaskId(old.id)), old);
			assert.equal(f.handle(old), oldHandle);
			assert.notEqual(f.handle(next), oldHandle);
			assert.deepEqual(next.runtimePlan, {
				provider: "fake",
				modelId: "replacement",
				model: "fake/replacement",
				thinking: "low",
				modelSource: "parent",
				thinkingSource: "parent",
			});
			assert.equal(f.registrations(), 2);
			await f.finish(old);
			await f.finish(next);
			assert.equal(replacement.sentMessages.length, 2);
			assert.equal(f.mock.sentMessages.length, 0);
			assert.equal(f.registrations(), 2);
			assert.equal(f.closed.length, 2);
		}));
	it("retains all ordinary retry panes until accepted final delivery with distinct owning adapters", async () =>
		withAdapterHost(async (f) => {
			const first = await f.launch({
				name: "fallback",
				task: "bounded",
				model: "fake/first, fake/second",
			});
			assert.ok(f.handle(first));
			let launched!: () => void;
			const secondLaunch = new Promise<void>((resolve) => {
				launched = resolve;
			});
			const runScript = f.launchOperations.runScript;
			f.patch(f.launchOperations, "runScript", (...args: any[]) => {
				const script = runScript(...args);
				launched();
				return script;
			});
			await f.finish(first, {
				type: "error",
				errorMessage: "first account rejected",
			});
			await secondLaunch;
			await f.turn();
			const second = f.runtime.runningSubagents.get(first.id);
			assert.equal(second.id, first.id);
			assert.notEqual(second.sessionFile, first.sessionFile);
			assert.equal(
				f.runtime.session.getHandle(
					f.runtime.session.getControlTaskId(first.id),
				).sessionId,
				second.sessionFile,
			);
			assert.equal(
				f.runtime.session.getControlTaskId(second.id),
				f.runtime.session.getControlTaskId(first.id),
			);
			assert.equal(f.closed.length, 0);
			assert.equal(f.surface.listSurfaces().length, 2);
			await f.finish(second);
			const details = f.mock.sentMessages.at(-1).message.details;
			assert.deepEqual(details.fallbackAttempts, ["fake/first", "fake/second"]);
			assert.deepEqual(details.fallbackFailures, [
				{ model: "fake/first", error: "first account rejected" },
			]);
			assert.equal(f.closed.length, 2);
			assert.equal(f.registrations(), 2);
		}));
	for (const cwd of [undefined, "work"])
		it(`launches a fallback through the replacement parent after reload in the invocation's ${cwd ? "relative tool cwd" : "parent cwd"}`, async () =>
			withAdapterHost(async (f) => {
				mkdirSync(join(f.projectDir, "work"));
				const invoking = invalidatableContext(f.ctx);
				const first = await f.launch(
					{
						name: "fallback",
						task: "bounded",
						model: "fake/first, fake/second",
						cwd,
					},
					f.mock,
					invoking.ctx,
				);
				const expectedCwd = cwd ? join(f.projectDir, cwd) : f.projectDir;
				assert.equal(f.handle(first).cwd, expectedCwd);

				const reloaded = await import(
					`../pi-extension/subagents/index.ts?reload-fallback-${Date.now()}`
				);
				const elsewhere = join(f.projectDir, "elsewhere");
				mkdirSync(elsewhere);
				const sessionDir = join(f.projectDir, "replacement-sessions");
				mkdirSync(sessionDir);
				const sessionFile = createSessionFile(sessionDir, [
					{ type: "session", version: 3, id: "replacement", cwd: elsewhere },
				]);
				let registryReads = 0;
				const live = {
					cwd: elsewhere,
					model: { provider: "fake", id: "replacement" },
					get modelRegistry() {
						registryReads++;
						return f.ctx.modelRegistry;
					},
					sessionManager: {
						getSessionFile: () => sessionFile,
						getSessionId: () => "replacement",
						getSessionDir: () => sessionDir,
					},
					ui: { notify() {}, setWidget() {} },
				};
				for (const shutdown of f.mock.eventHandlers.get("session_shutdown") ??
					[])
					await shutdown({ reason: "reload" }, {});
				invoking.invalidate();
				process.chdir(elsewhere);
				const replacement = createMockExtensionApi();
				f.apis.push(replacement);
				replacement.api.getThinkingLevel = () => "low";
				reloaded.default(replacement.api, { infrastructure: f.infrastructure });
				for (const start of replacement.eventHandlers.get("session_start") ??
					[])
					await start({ reason: "reload" }, live);
				const registryReadsBeforeFallback = registryReads;

				await f.finish(first, {
					type: "error",
					errorMessage: "first account rejected",
				});
				await until(f, () => f.commands.length === 2, "the fallback launch");
				const second = f.runtime.runningSubagents.get(first.id);
				assert.notEqual(second.sessionFile, first.sessionFile);
				assert.ok(registryReads > registryReadsBeforeFallback);
				assert.ok(
					second.activityFile.startsWith(
						join(sessionDir, "artifacts", "replacement"),
					),
				);
				assert.equal(f.handle(second).cwd, expectedCwd);
				assert.ok(f.commands[1].includes(`cd '${expectedCwd}' && `));
				assert.deepEqual(second.runtimePlan, {
					provider: "fake",
					modelId: "second",
					model: "fake/second",
					thinking: "high",
					modelSource: "request",
					thinkingSource: "parent",
					requestedModel: "fake/second",
				});

				await f.finish(second);
				assert.equal(f.mock.sentMessages.length, 0);
				assert.equal(replacement.sentMessages.length, 1);
				const details = replacement.sentMessages[0].message.details;
				assert.equal(details.errorMessage, undefined);
				assert.deepEqual(details.fallbackAttempts, [
					"fake/first",
					"fake/second",
				]);
				assert.deepEqual(details.fallbackFailures, [
					{ model: "fake/first", error: "first account rejected" },
				]);
				assert.equal(f.closed.length, 2);
				assert.equal(f.surface.listSurfaces().length, 0);
				assert.equal(f.runtime.runningSubagents.size, 0);
			}));
	it("fails a fallback explicitly without launching when no live parent context exists", async () =>
		withAdapterHost(async (f) => {
			const invoking = invalidatableContext(f.ctx);
			const first = await f.launch(
				{ name: "fallback", task: "bounded", model: "fake/first, fake/second" },
				f.mock,
				invoking.ctx,
			);
			invoking.invalidate();
			f.runtime.latestCtx = undefined;
			await f.finish(first, {
				type: "error",
				errorMessage: "first account rejected",
			});
			await until(
				f,
				() => f.mock.sentMessages.length > 0,
				"the failed result delivery",
			);
			await f.turn();
			assert.equal(f.commands.length, 1);
			assert.equal(f.mock.sentMessages.length, 1);
			const details = f.mock.sentMessages[0].message.details;
			assert.deepEqual(details.fallbackAttempts, ["fake/first", "fake/second"]);
			assert.deepEqual(details.fallbackFailures, [
				{ model: "fake/first", error: "first account rejected" },
				{
					model: "fake/second",
					error: "No live parent context for the fallback launch",
				},
			]);
			assert.equal(f.closed.length, 1);
			assert.equal(f.surface.listSurfaces().length, 0);
			assert.equal(f.runtime.runningSubagents.size, 0);
		}));
	for (const accepted of [true, false])
		it(`ordinary completion ${accepted ? "closes only after accepted delivery" : "retains the pane after rejected delivery"}`, async () =>
			withAdapterHost(async (f) => {
				const child = await f.launch({ name: "delivery", task: "bounded" });
				assert.ok(f.handle(child));
				let closesAtDelivery = -1;
				const send = f.mock.api.sendMessage;
				f.mock.api.sendMessage = (...args: any[]) => {
					closesAtDelivery = f.closed.length;
					if (!accepted) throw new Error("parent rejected delivery");
					send(...args);
				};
				await f.finish(child);
				assert.equal(closesAtDelivery, 0);
				assert.equal(f.closed.length, accepted ? 1 : 0);
				assert.equal(f.surface.listSurfaces().length, accepted ? 0 : 1);
			}));
	for (const warning of [false, true])
		it(`finalizes the retained worktree manifest before delivery without closing its root pane${warning ? " and preserves manifest warnings" : ""}`, async () =>
			withAdapterHost(async (f) => {
				execFileSync("git", ["init", "-q"], { cwd: f.projectDir });
				writeFileSync(join(f.projectDir, "tracked"), "base");
				execFileSync("git", ["add", "tracked"], { cwd: f.projectDir });
				execFileSync(
					"git",
					[
						"-c",
						"user.name=Test",
						"-c",
						"user.email=test@example.com",
						"-c",
						"commit.gpgsign=false",
						"commit",
						"-qm",
						"fixture",
					],
					{ cwd: f.projectDir },
				);
				const retained = join(f.globalDir, "retained");
				execFileSync("git", ["clone", "-q", f.projectDir, retained]);
				f.patch(f.launchOperations, "createWorktree", () => ({
					path: retained,
					workspaceId: "owned-workspace",
					paneId: f.surface.createSurface({
						name: "worktree-root",
						cwd: retained,
					}),
					branch: "bounded-worktree",
				}));
				const child = await f.launch({
					name: "worktree",
					task: "bounded",
					worktree: { branch: "bounded-worktree" },
				});
				assert.ok(f.handle(child).worktree);
				if (warning) {
					rmSync(child.worktree.manifestFile);
					mkdirSync(child.worktree.manifestFile);
				}
				const deliveredStates: string[] = [];
				const send = f.mock.api.sendMessage;
				f.mock.api.sendMessage = (...args: any[]) => {
					deliveredStates.push(
						warning
							? args[0].details.worktree.gitError
							: JSON.parse(readFileSync(child.worktree.manifestFile, "utf8"))
									.state,
					);
					send(...args);
				};
				await f.finish(child);
				if (warning) assert.match(deliveredStates[0], /Manifest update failed/);
				else assert.deepEqual(deliveredStates, ["ready_for_review"]);
				const handoff = f.mock.sentMessages.at(-1).message.details.worktree;
				assert.equal(handoff.workspaceId, "owned-workspace");
				assert.equal(handoff.paneId, child.surface);
				assert.equal(f.closed.length, 0);
				assert.equal(f.surface.listSurfaces().length, 1);
				assert.equal(
					f.mock.sentMessages.at(-1).message.details.worktree.clean,
					true,
				);
			}));
	it("fails a missing named role before any pane or worktree and never launches it bare", async () =>
		withAdapterHost(async (f) => {
			let worktrees = 0;
			f.patch(f.launchOperations, "createWorktree", () => {
				worktrees++;
				throw new Error("must not create a worktree");
			});
			for (const worktree of [undefined, { branch: "missing-role" }])
				for (const agent of ["scout", "missing-fixture-role"])
					await assert.rejects(
						f.launch({ name: "missing", task: "bounded", agent, worktree }),
						new RegExp(
							`Agent "${agent}" was not found\\. pi-herdr-agents ships no roles`,
						),
					);
			assert.equal(worktrees, 0);
			assert.equal(f.commands.length, 0);
			assert.equal(f.surface.listSurfaces().length, 0);
			assert.equal(f.runtime.runningSubagents.size, 0);
			assert.equal(f.registrations(), 0);
		}));
	it("public resume prelaunch transcript rejection acquires nothing", async () =>
		withAdapterHost(async (f) => {
			const path = join(f.projectDir, "unreadable.jsonl");
			mkdirSync(path);
			const tool = f.mock.registeredTools.find(
				(t: any) => t.name === "subagent_resume",
			);
			await assert.rejects(
				tool.execute(
					"resume",
					{ sessionPath: path },
					new AbortController().signal,
					undefined,
					f.ctx,
				),
				/EISDIR/,
			);
			const owner =
				f.runtime.session[Symbol.for("pi-herdr-agents/PiRunSession-owner")];
			assert.equal(owner.entries.size, 0);
			assert.equal(f.runtime.runningSubagents.size, 0);
			assert.equal(f.registrations(), 0);
			assert.equal(f.commands.length, 0);
			assert.equal(f.closed.length, 0);
			assert.equal(f.surface.listSurfaces().length, 0);
			assert.equal(f.mock.sentMessages.length, 0);
		}));

	for (const boundary of ["adapter", "finalizer"])
		for (const recover of [false, "output", "empty"])
			it(`public resume ${boundary} failure ${recover ? `recovers at the late read (${recover})` : "silently retains its manual pane"} after delivered/map-delete`, async () =>
				withAdapterHost(async (f) => {
					const path = join(f.projectDir, "saved.jsonl");
					const header =
						JSON.stringify({
							type: "session",
							version: 3,
							id: "saved",
							cwd: f.projectDir,
						}) + "\n";
					writeFileSync(path, header);
					writeSubagentSessionPolicy(path, {
						owner: "public",
						deniedTools: [],
					});
					const tool = f.mock.registeredTools.find(
						(t: any) => t.name === "subagent_resume",
					);
					const started = await tool.execute(
						"resume",
						{ name: "resumed", sessionPath: path, message: "followup" },
						new AbortController().signal,
						undefined,
						f.ctx,
					);
					const child = f.runtime.runningSubagents.get(started.details.id);
					const session = f.runtime.session;
					const control = session.getControlTaskId(child.id);
					const owner =
						session[Symbol.for("pi-herdr-agents/PiRunSession-owner")];
					const corrupt = () => {
						rmSync(path);
						mkdirSync(path);
					};
					let completions = 0;
					const observed = owner.options.hooks.onObserved;
					owner.options.hooks.onObserved = (record: any, observation: any) => {
						observed(record, observation);
						if (observation.kind === "completion") {
							completions++;
							if (boundary === "finalizer") corrupt();
						}
					};
					const late: any[] = [];
					let readError: unknown;
					const settled = owner.options.hooks.onSettled;
					owner.options.hooks.onSettled = (
						record: any,
						result: any,
						task: any,
						io: any,
					) => {
						if (recover) {
							rmSync(path, { recursive: true });
							writeFileSync(
								path,
								recover === "empty"
									? header
									: header +
											JSON.stringify({
												type: "message",
												message: {
													role: "assistant",
													content: [
														{ type: "text", text: "Recovered new output" },
													],
												},
											}) +
											"\n",
							);
						}
						const read = io.readResumeResult;
						const scopedIO = { ...io };
						if (read)
							scopedIO.readResumeResult = () => {
								late.push({
									delivery: child.lifecycle.delivery,
									tracked: f.runtime.runningSubagents.has(child.id),
									sends: f.mock.sentMessages.length,
									closes: f.closed.length,
								});
								try {
									return read();
								} catch (error) {
									readError = error;
									throw error;
								}
							};
						return settled(record, result, task, scopedIO);
					};
					if (boundary === "adapter") corrupt();
					writeFileSync(`${path}.exit`, JSON.stringify({ type: "done" }));
					const deadline = Date.now() + 3000;
					while (session.getTask(control)) {
						assert.ok(Date.now() < deadline);
						await f.turn();
					}
					assert.equal(
						owner.entries.size,
						0,
						"retire without Pi metadata getters",
					);
					assert.deepEqual(late, [
						{ delivery: "delivered", tracked: false, sends: 0, closes: 0 },
					]);
					assert.equal(child.lifecycle.delivery, "delivered");
					assert.equal(completions, boundary === "finalizer" ? 1 : 0);
					assert.equal(f.registrations(), 1);
					assert.equal(f.commands.length, 1);
					assert.equal(f.mock.sentMessages.length, recover ? 1 : 0);
					assert.equal(f.closed.length, recover ? 1 : 0);
					assert.equal(f.surface.listSurfaces().length, recover ? 0 : 1);
					if (recover) {
						assert.equal(readError, undefined);
						assert.deepEqual(f.mock.sentMessages[0].message.details, {
							name: "resumed",
							task: "followup",
							exitCode: 1,
							elapsed: f.mock.sentMessages[0].message.details.elapsed,
							sessionFile: path,
							resultContent: `Sub-agent "resumed" failed (exit code 1).\n\n${recover === "empty" ? "Resumed session exited with code 1" : "Recovered new output"}\n\nSession: ${path}\nResume: pi --session ${path}`,
						});
					} else assert.match(String(readError), /EISDIR/);
				}));

	for (const scenario of [
		"fresh",
		"empty",
		"provider-error",
		"rejected-send",
		"ping",
		"suppressed",
	])
		it(`public resume ${scenario} preserves late-read demand and delivery retention`, async () =>
			withAdapterHost(async (f) => {
				const path = join(f.projectDir, "saved.jsonl");
				const header =
					JSON.stringify({
						type: "session",
						version: 3,
						id: "saved",
						cwd: f.projectDir,
					}) + "\n";
				const old =
					JSON.stringify({
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Old output" }],
						},
					}) + "\n";
				writeFileSync(path, header + old);
				writeSubagentSessionPolicy(path, { owner: "public", deniedTools: [] });
				const started = await f.mock.registeredTools
					.find((t: any) => t.name === "subagent_resume")
					.execute(
						"resume",
						{ name: "resumed", sessionPath: path },
						new AbortController().signal,
						undefined,
						f.ctx,
					);
				const child = f.runtime.runningSubagents.get(started.details.id);
				const session = f.runtime.session;
				const control = session.getControlTaskId(child.id);
				const owner = session[Symbol.for("pi-herdr-agents/PiRunSession-owner")];
				const settled = owner.options.hooks.onSettled;
				const late: any[] = [],
					sends: any[] = [],
					summaries: string[] = [];
				owner.options.hooks.onSettled = (
					record: any,
					result: any,
					task: any,
					io: any,
				) => {
					if (scenario === "ping") {
						rmSync(path);
						mkdirSync(path);
					}
					if (scenario === "fresh" || scenario === "rejected-send")
						writeFileSync(
							path,
							header +
								old +
								JSON.stringify({
									type: "message",
									message: {
										role: "assistant",
										content: [{ type: "text", text: "Late fresh output" }],
									},
								}) +
								"\n",
						);
					const read = io.readResumeResult;
					const scopedIO = { ...io };
					if (read)
						scopedIO.readResumeResult = () => {
							late.push({
								delivery: child.lifecycle.delivery,
								tracked: f.runtime.runningSubagents.has(child.id),
								sends: sends.length,
							});
							const value = read();
							summaries.push(value.summary);
							return value;
						};
					return settled(record, result, task, scopedIO);
				};
				const send = f.mock.api.sendMessage;
				f.mock.api.sendMessage = (...args: any[]) => {
					sends.push(args);
					if (scenario === "rejected-send")
						throw new Error("resume send rejected");
					send(...args);
				};
				let releaseClose!: () => void;
				const closeWait = new Promise<void>((resolve) => {
					releaseClose = resolve;
				});
				const close = f.surface.closeSurface.bind(f.surface);
				let closes = 0;
				f.patch(f.surface, "closeSurface", async (id: string) => {
					closes++;
					await closeWait;
					await close(id);
				});
				try {
					if (scenario === "suppressed") session.suppress(control);
					else
						writeFileSync(
							`${path}.exit`,
							JSON.stringify(
								scenario === "ping"
									? { type: "ping", name: "resumed", message: "help" }
									: scenario === "provider-error"
										? { type: "error", errorMessage: "account rejected" }
										: { type: "done" },
							),
						);
					const deadline = Date.now() + 3000;
					while (session.getTask(control)) {
						assert.ok(Date.now() < deadline);
						await f.turn();
					}
					assert.equal(
						owner.entries.size,
						0,
						"retire even while close is unresolved",
					);
					assert.deepEqual(
						late,
						["ping", "suppressed"].includes(scenario)
							? []
							: [{ delivery: "delivered", tracked: false, sends: 0 }],
					);
					assert.equal(sends.length, scenario === "suppressed" ? 0 : 1);
					assert.equal(closes, scenario === "rejected-send" ? 0 : 1);
					assert.equal(f.closed.length, 0);
					assert.equal(f.registrations(), 1);
					assert.equal(f.commands.length, 1);
					if (scenario !== "suppressed") {
						assert.equal(child.lifecycle.delivery, "delivered");
						const message = sends[0][0];
						assert.deepEqual(sends[0][1], {
							triggerTurn: true,
							deliverAs: "steer",
						});
						assert.equal(message.details.sessionFile, path);
						assert.equal(Object.hasOwn(message.details, "agent"), false);
						assert.doesNotMatch(message.content, /Old output/);
						if (scenario === "ping")
							assert.equal(message.customType, "subagent_ping");
						else {
							assert.deepEqual(summaries, [
								scenario === "empty"
									? "Resumed session exited without new output"
									: scenario === "provider-error"
										? "Subagent error: account rejected"
										: "Late fresh output",
							]);
							assert.match(
								message.content,
								scenario === "empty"
									? /Resumed session exited without new output/
									: scenario === "provider-error"
										? /Error: account rejected/
										: /Late fresh output/,
							);
						}
					}
				} finally {
					releaseClose();
					await f.turn();
				}
				assert.equal(f.closed.length, scenario === "rejected-send" ? 0 : 1);
			}));

	it("public resume retains its actual adapter ID and delivers only post-resume output", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({
				name: "before",
				task: "bounded",
				tools: "read",
			});
			assert.ok(f.handle(child));
			writeFileSync(
				child.sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "saved",
					cwd: f.projectDir,
				}) +
					"\n" +
					JSON.stringify(ASSISTANT_MSG) +
					"\n",
			);
			await f.finish(child);
			rmSync(`${child.sessionFile}.exit`, { force: true });
			const tool = f.mock.registeredTools.find(
				(t: any) => t.name === "subagent_resume",
			);
			const result = await tool.execute(
				"resume",
				{ sessionPath: child.sessionFile, name: "after" },
				new AbortController().signal,
				undefined,
				f.ctx,
			);
			const resumed = f.runtime.runningSubagents.get(result.details.id);
			assert.ok(f.handle(resumed));
			assert.equal(result.details.id, f.handle(resumed).id);
			assert.equal(
				f.runtime.session.getRecord(
					f.runtime.session.getControlTaskId(resumed.id),
				),
				resumed,
			);
			assert.deepEqual(readSubagentSessionPolicy(resumed.sessionFile).tools, [
				"read",
			]);
			await f.finish(resumed);
			assert.match(
				f.mock.sentMessages.at(-1).message.content,
				/without new output/,
			);
			assert.doesNotMatch(
				f.mock.sentMessages.at(-1).message.content,
				/Here is my plan/,
			);
			assert.equal(f.closed.length, 2);
		}));
});

describe("subagent_cancel public tool", { timeout: 20_000 }, () => {
	const cancel = (f: any, params: { id?: string; name?: string }) =>
		f.mock.registeredTools
			.find((tool: any) => tool.name === "subagent_cancel")
			.execute(
				"cancel",
				params,
				new AbortController().signal,
				undefined,
				f.ctx,
			);
	const results = (f: any) =>
		f.mock.sentMessages.filter(
			(sent: any) => sent.message.customType === "subagent_result",
		);
	async function worktreeHost(f: any) {
		const git = (cwd: string, ...args: string[]) =>
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.com",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ cwd, encoding: "utf8" },
			).trim();
		git(f.projectDir, "init", "-q");
		writeFileSync(join(f.projectDir, "tracked"), "base");
		git(f.projectDir, "add", "tracked");
		git(f.projectDir, "commit", "-qm", "fixture");
		const retained = join(f.globalDir, "retained");
		execFileSync("git", ["clone", "-q", f.projectDir, retained]);
		f.patch(f.launchOperations, "createWorktree", () => ({
			path: retained,
			workspaceId: "owned-workspace",
			paneId: f.surface.createSurface({ name: "worktree-root", cwd: retained }),
			branch: "cancel-worktree",
		}));
		return { retained, git };
	}

	// A fake kernel for worktree cancel: launch capture yields pid 4242's
	// identity; SIGTERM removes it from the table.
	function identityKernel(f: any) {
		const host = { bootId: "boot", pidNamespace: "pid:[1]" };
		const table = new Map<number, any>();
		const signals: number[] = [];
		f.patch(f.launchOperations, "captureProcessIdentity", async () => ({
			pid: 4242,
			startTime: "5000",
			...host,
		}));
		f.patch(f.infrastructure, "processProbe", {
			host: () => host,
			stat(pid: number) {
				const entry = table.get(pid);
				if (entry === "EACCES")
					throw Object.assign(new Error("EACCES: permission denied"), {
						code: "EACCES",
					});
				return entry;
			},
			terminate(pid: number) {
				signals.push(pid);
				table.delete(pid);
			},
		});
		return { table, signals };
	}

	it("registers a parent tool, is spawning-gated, and is denied to restricted children", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);
		const tool = registeredTools.find((t) => t.name === "subagent_cancel");
		assert.ok(tool);
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
			"id",
			"name",
		]);
		for (const pattern of [
			/terminal intent first/,
			/exactly one cancelled result/,
			/No model fallback, retry, or recovery/,
			/keeps the workspace, checkout, commits, and manifest/,
			/confirmed, requested .*unconfirmed .*already-terminal/,
			/Persistent specialists are rejected; use subagent_stop/,
			/Do not poll/,
		])
			assert.match(tool.description, pattern);
		assert.equal(tool.promptSnippet, tool.description);
		assert.equal(
			subagentsModule.__test__
				.resolveDenyTools({ spawning: false })
				.has("subagent_cancel"),
			true,
		);
		process.env.PI_SUBAGENT_ID = "child-test";
		process.env.PI_DENY_TOOLS = "subagent_cancel";
		try {
			const child = createMockExtensionApi();
			subagentsModule.default(child.api);
			assert.equal(
				child.registeredTools.some((t) => t.name === "subagent_cancel"),
				false,
			);
			assert.equal(
				child.registeredTools.some((t) => t.name === "subagent_interrupt"),
				true,
			);
		} finally {
			delete process.env.PI_SUBAGENT_ID;
			delete process.env.PI_DENY_TOOLS;
		}
	});

	it("negative control: closing a fallback-routed pane without cancel starts the next model", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({
				name: "uncancelled",
				task: "bounded",
				model: "fake/first, fake/second",
			});
			f.surface.closeSurface(child.surface);
			await until(f, () => f.commands.length === 2, "the fallback launch");
			assert.equal(results(f).length, 0);
		}));

	it("cancels a fallback-routed ordinary child once: no fallback, unrelated panes kept", async () =>
		withAdapterHost(async (f) => {
			const unrelated = f.surface.createSurface({
				name: "user pane",
				cwd: f.projectDir,
			});
			const other = await f.launch({ name: "other", task: "bounded" });
			const child = await f.launch({
				name: "target",
				task: "bounded",
				model: "fake/first, fake/second",
			});
			const response = await cancel(f, { name: "target" });
			assert.equal(response.details.status, "confirmed");
			assert.equal(response.details.id, child.id);
			assert.match(
				response.content[0].text,
				/pane was closed and Herdr confirmed it is gone\. No model fallback, retry, or recovery will start\./,
			);
			await until(f, () => results(f).length === 1, "the cancelled result");
			const [delivered] = results(f);
			const details = delivered.message.details;
			assert.equal(details.name, "target");
			assert.equal(details.error, "cancelled");
			assert.equal(details.errorMessage, undefined);
			assert.equal(details.cancellation.termination, "confirmed");
			assert.deepEqual(details.fallbackAttempts, ["fake/first"]);
			assert.equal(details.sessionFile, child.sessionFile);
			assert.match(
				delivered.message.content,
				/Sub-agent "target" was cancelled by the parent after .*Termination was confirmed before this result; no model fallback, retry, or recovery was started\./,
			);
			assert.deepEqual(delivered.options, {
				triggerTurn: true,
				deliverAs: "steer",
			});
			// Give a late watcher/fallback every chance to misbehave.
			for (let i = 0; i < 20; i++) await f.turn();
			assert.equal(f.commands.length, 2, "no fallback attempt was launched");
			assert.equal(results(f).length, 1);
			assert.deepEqual([...new Set(f.closed)], [child.surface]);
			assert.equal(f.runtime.runningSubagents.has(child.id), false);
			assert.equal(f.runtime.runningSubagents.get(other.id), other);
			const live = f.surface.listSurfaces().map((s: any) => s.id);
			assert.ok(live.includes(unrelated) && live.includes(other.surface));
			// Repeating the cancel by ID reports the retired run; by name it is gone.
			const again = await cancel(f, { id: child.id });
			assert.equal(again.details.status, "already-terminal");
			assert.match(again.content[0].text, /nothing was cancelled/);
			assert.match(
				(await cancel(f, { name: "target" })).details.error,
				/No running subagent named "target"/,
			);
			assert.equal(results(f).length, 1);
			await f.finish(other);
		}));

	it("an unconfirmed termination keeps the run live and quiet until a retry confirms it", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({
				name: "stubborn",
				task: "bounded",
				model: "fake/first, fake/second",
			});
			const close = f.surface.closeSurface;
			f.surface.closeSurface = async () => {
				throw new Error("herdr pane close timed out");
			};
			const first = await cancel(f, { id: child.id });
			assert.equal(first.details.status, "unconfirmed");
			assert.match(first.details.error, /herdr pane close timed out/);
			assert.match(first.content[0].text, /The run stays live and owned/);
			assert.equal(f.runtime.runningSubagents.get(child.id), child);
			assert.equal(child.cancelState, "unconfirmed");
			assert.match(
				subagentsModule.__test__
					.renderSubagentWidgetLines([child], 100)
					.join("\n"),
				/cancel unconfirmed/,
			);
			for (let i = 0; i < 10; i++) await f.turn();
			assert.equal(results(f).length, 0);
			assert.equal(f.commands.length, 1);
			f.surface.closeSurface = close;
			const retry = await cancel(f, { id: child.id });
			assert.equal(retry.details.status, "confirmed");
			assert.equal(retry.details.repeated, true);
			assert.equal(retry.details.requestedAt, first.details.requestedAt);
			await until(f, () => results(f).length === 1, "the cancelled result");
			for (let i = 0; i < 10; i++) await f.turn();
			assert.equal(results(f).length, 1);
			assert.equal(f.commands.length, 1);
		}));

	it("a cancel racing natural delivery is already-terminal and kills nothing", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({
				name: "finisher",
				task: "bounded",
				model: "fake/first, fake/second",
			});
			const control = f.runtime.session.getControlTaskId(child.id);
			let late: Promise<any> | undefined;
			const send = f.mock.api.sendMessage;
			f.mock.api.sendMessage = (...args: any[]) => {
				// The natural result is being delivered; the run is not yet retired.
				late ??= f.runtime.session.cancel(control);
				send(...args);
			};
			await f.finish(child);
			assert.deepEqual(await late, { status: "already-terminal" });
			assert.equal(child.cancelState, undefined);
			assert.equal(results(f).length, 1);
			assert.equal(results(f)[0].message.details.error, undefined);
			assert.equal(results(f)[0].message.details.cancellation, undefined);
			assert.match(results(f)[0].message.content, /completed/);
			assert.equal(f.commands.length, 1);
			assert.deepEqual(
				f.closed,
				[child.surface],
				"only the normal release close",
			);
		}));

	it("cancels an interrupted child", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({ name: "paused", task: "bounded" });
			const interrupted =
				await subagentsModule.__test__.handleSubagentInterrupt({
					id: child.id,
				});
			assert.equal(interrupted.details.status, "interrupt_requested");
			assert.equal(
				(await cancel(f, { id: child.id })).details.status,
				"confirmed",
			);
			await until(f, () => results(f).length === 1, "the cancelled result");
			assert.equal(results(f)[0].message.details.error, "cancelled");
		}));

	it("rejects a persistent specialist with a pointer to subagent_stop and changes nothing", async () =>
		withAdapterHost(async (f) => {
			const child = await f.launch({
				name: "specialist",
				task: "bounded",
				persistent: true,
			});
			const response = await cancel(f, { name: "specialist" });
			assert.match(
				response.details.error,
				new RegExp(
					`persistent specialist; subagent_cancel does not stop it\\. Use subagent_stop\\(\\{ id: "${child.id}" \\}\\)`,
				),
			);
			assert.equal(response.details.status, undefined);
			assert.equal(child.cancelState, undefined);
			assert.equal(child.stopState, undefined);
			assert.deepEqual(f.closed, []);
			assert.equal(f.runtime.runningSubagents.get(child.id), child);
		}));

	it("cancels a worktree child: stops only its process, retains workspace, commits, and handoff", async () =>
		withAdapterHost(async (f) => {
			const { retained, git } = await worktreeHost(f);
			// The launch-verified identity of the child's Pi, and the kernel's view.
			const kernel = identityKernel(f);
			kernel.table.set(4242, "EACCES");
			const child = await f.launch({
				name: "writer",
				task: "bounded",
				worktree: { branch: "cancel-worktree" },
			});
			writeFileSync(join(retained, "work"), "committed work");
			git(retained, "add", "work");
			git(retained, "commit", "-qm", "child work");
			const head = git(retained, "rev-parse", "HEAD");
			// The identity is unreadable: never signal it, never guess it exited.
			const first = await cancel(f, { id: child.id });
			assert.equal(first.details.status, "unconfirmed");
			assert.match(
				first.details.error,
				/process 4242 is unreadable: EACCES.*not signalled/,
			);
			assert.deepEqual(kernel.signals, []);
			assert.equal(
				JSON.parse(readFileSync(child.worktree.manifestFile, "utf8")).state,
				"running",
			);
			assert.equal(results(f).length, 0);
			// The owned process is readable and alive: SIGTERM ends THAT identity.
			kernel.table.set(4242, { state: "S", ppid: 10, startTime: "5000" });
			const retry = await cancel(f, { id: child.id });
			assert.deepEqual(kernel.signals, [4242]);
			assert.equal(retry.details.status, "confirmed");
			assert.match(
				retry.content[0].text,
				/Pi process exit is confirmed; the worktree workspace, checkout, commits, and manifest are retained/,
			);
			await until(f, () => results(f).length === 1, "the cancelled result");
			const delivered = results(f)[0].message;
			assert.equal(delivered.details.error, "cancelled");
			assert.equal(delivered.details.worktree.headSha, head);
			assert.equal(delivered.details.worktree.commitsAhead, 1);
			assert.equal(delivered.details.worktree.workspaceId, "owned-workspace");
			assert.match(delivered.content, /Worktree result retained for review:/);
			assert.equal(
				JSON.parse(readFileSync(child.worktree.manifestFile, "utf8")).state,
				"cancelled",
			);
			assert.deepEqual(f.closed, [], "no surface is closed for a worktree");
			assert.ok(
				f.surface.listSurfaces().some((s: any) => s.id === child.surface),
			);
			assert.equal(git(retained, "rev-parse", "HEAD"), head);
			assert.equal(
				readFileSync(join(retained, "work"), "utf8"),
				"committed work",
			);
		}));

	it("a worktree child without a captured process identity stays unconfirmed; shutdown never records cancelled", async () =>
		withAdapterHost(async (f) => {
			const { retained } = await worktreeHost(f);
			// Herdr's idle shell is never exit evidence: only the identity is.
			const kernel = identityKernel(f);
			f.patch(f.launchOperations, "captureProcessIdentity", async () => {
				throw new Error("Process identity not captured within 15000ms");
			});
			const child = await f.launch({
				name: "uncaptured",
				task: "bounded",
				worktree: { branch: "cancel-worktree" },
			});
			f.patch(f.surface, "getProcessInfo", () => ({
				shellPid: 10,
				foregroundProcessGroupId: 10,
				pids: [10],
				foregroundProcesses: [],
			}));
			const manifest = () =>
				JSON.parse(readFileSync(child.worktree.manifestFile, "utf8")).state;
			const report = await cancel(f, { id: child.id });
			assert.equal(report.details.status, "unconfirmed");
			assert.match(
				report.details.error,
				/identity was not captured .*nothing was signalled: Process identity not captured/,
			);
			assert.deepEqual(kernel.signals, []);
			assert.equal(child.cancelState, "unconfirmed");
			assert.equal(manifest(), "running");
			// Parent shutdown suppresses the unconfirmed run: it is not a cancellation.
			f.runtime.session.suppress(f.runtime.session.getControlTaskId(child.id));
			await until(f, () => manifest() !== "running", "the shutdown manifest");
			assert.equal(manifest(), "failed");
			for (let i = 0; i < 10; i++) await f.turn();
			assert.equal(results(f).length, 0);
			assert.deepEqual(f.closed, []);
			assert.ok(existsSync(retained));
		}));

	it("a fallback owner transferred after the cancel shows its own unconfirmed kill and stays live", async () =>
		withAdapterHost(async (f) => {
			const first = await f.launch({
				name: "transferred",
				task: "bounded",
				model: "fake/first, fake/second, fake/third",
			});
			let launched!: () => void;
			let release!: () => void;
			const launching = new Promise<void>((resolve) => {
				launched = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const runScript = f.launchOperations.runScript;
			f.patch(f.launchOperations, "runScript", async (...args: any[]) => {
				launched();
				await gate;
				return runScript(...args);
			});
			await f.finish(first, {
				type: "error",
				errorMessage: "provider refused",
			});
			await launching;
			const requested = await cancel(f, { id: first.id });
			assert.equal(requested.details.status, "requested");
			assert.equal(first.cancelState, "requested");
			// The transferred owner's automatic kill cannot confirm termination.
			f.patch(f.surface, "closeSurface", async () => {
				throw new Error("herdr pane close timed out");
			});
			release();
			let second: any;
			await until(
				f,
				() => {
					second = f.runtime.runningSubagents.get(first.id);
					return second !== first && second?.cancelState === "unconfirmed";
				},
				"the transferred owner's unconfirmed cancel",
			);
			assert.match(
				subagentsModule.__test__
					.renderSubagentWidgetLines([second], 100)
					.join("\n"),
				/cancel unconfirmed/,
			);
			for (let i = 0; i < 10; i++) await f.turn();
			assert.equal(
				results(f).length,
				0,
				"nothing is delivered while unconfirmed",
			);
			assert.equal(f.commands.length, 2, "the third model is never launched");
			assert.ok(
				f.surface.listSurfaces().some((s: any) => s.id === second.surface),
			);
		}));
});

describe("session.ts", () => {
	let dir: string;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("getLeafId", () => {
		it("returns last entry id", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			assert.equal(getLeafId(file), "asst-001");
		});

		it("returns null for empty file", () => {
			const file = join(dir, "empty.jsonl");
			writeFileSync(file, "");
			assert.equal(getLeafId(file), null);
		});
	});

	describe("getNewEntries", () => {
		it("returns entries after a given line", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 2);
			assert.equal(entries[0].id, "user-001");
			assert.equal(entries[1].id, "asst-001");
		});

		it("returns empty array when no new entries", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 0);
		});
	});

	describe("findLastAssistantMessage", () => {
		it("finds last assistant text", () => {
			const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Updated plan with details.");
		});

		it("skips thinking blocks, gets text only", () => {
			const entries = [ASSISTANT_MSG_2];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Updated plan with details.");
		});

		it("skips tool results", () => {
			const entries = [ASSISTANT_MSG, TOOL_RESULT];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Here is my plan...");
		});

		it("returns null when no assistant messages", () => {
			const entries = [USER_MSG];
			assert.equal(findLastAssistantMessage(entries), null);
		});

		it("returns null for empty array", () => {
			assert.equal(findLastAssistantMessage([]), null);
		});

		it("reports an empty final completion instead of reusing an earlier assistant message", () => {
			const realMsg: SessionEntry = {
				type: "message",
				id: "real",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Real summary content." }],
				},
			};
			const emptyMsg: SessionEntry = {
				type: "message",
				id: "empty",
				message: {
					role: "assistant",
					content: [],
					stopReason: "stop",
				},
			};
			const entries = [realMsg, emptyMsg];
			assert.equal(findLastAssistantMessage(entries), "Real summary content.");
			assert.deepEqual(inspectFinalAssistantMessage(entries), {
				text: null,
				contentLength: 0,
				stopReason: "stop",
			});
		});

		it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
			// Reproduces the overload-exhaustion case: an earlier turn looked
			// normal, then the provider went 529 and auto-retry gave up. Without
			// the errorMessage fallback we'd return the stale earlier summary and
			// the orchestrator would believe the subagent completed.
			const earlierGood: SessionEntry = {
				type: "message",
				id: "earlier-good",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Investigating the bug..." }],
				},
			};
			const overloadError: SessionEntry = {
				type: "message",
				id: "overload-error",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Anthropic 529 Overloaded after 3 retries",
				},
			};
			const entries = [earlierGood, overloadError];
			assert.equal(
				findLastAssistantMessage(entries),
				"Subagent error: Anthropic 529 Overloaded after 3 retries",
			);
		});

		it("prefers text content even when an error stopReason is set", () => {
			// If the model produced text before the error (rare but possible), we
			// prefer the actual content over the synthetic error fallback.
			const msg: SessionEntry = {
				type: "message",
				id: "partial",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Here is partial output." }],
					stopReason: "error",
					errorMessage: "stream interrupted",
				},
			};
			assert.equal(findLastAssistantMessage([msg]), "Here is partial output.");
		});

		it("does not invent a summary for a stop=error message with no errorMessage", () => {
			const msg: SessionEntry = {
				type: "message",
				id: "no-error-message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
				},
			};
			assert.equal(findLastAssistantMessage([msg]), null);
		});

		it("preserves an assistant record that starts exactly at the bounded tail", () => {
			withTempDir((dir) => {
				const session = join(dir, "exact-boundary.jsonl");
				const assistant = JSON.stringify({
					type: "message",
					id: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						stopReason: "toolUse",
					},
				});
				const tail = `${assistant}\n${"x".repeat(
					128 * 1024 - Buffer.byteLength(assistant) - 1,
				)}`;
				writeFileSync(session, `{"type":"session"}\n${tail}`);

				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});
			});
		});

		it("skips a mid-record cut before a multibyte character", () => {
			withTempDir((dir) => {
				const session = join(dir, "mid-record-boundary.jsonl");
				const assistant = JSON.stringify({
					type: "message",
					id: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						stopReason: "toolUse",
					},
				});
				const beforeBoundary = Buffer.from(`partial-${"é"}`);
				const afterBoundary = Buffer.from(`\n${assistant}\n`);
				const tail = Buffer.concat([
					beforeBoundary.subarray(-1),
					afterBoundary,
					Buffer.alloc(128 * 1024 - 1 - afterBoundary.length, "x"),
				]);
				writeFileSync(
					session,
					Buffer.concat([beforeBoundary.subarray(0, -1), tail]),
				);

				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});
			});
		});

		it("classifies bounded JSONL tails without trusting malformed trailing lines", () => {
			withTempDir((dir) => {
				const session = join(dir, "hang.jsonl");
				const writeTail = (entries: unknown[]) =>
					writeFileSync(
						session,
						`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{torn`,
					);
				const assistant = (content: unknown[], stopReason?: string) => ({
					type: "message",
					id: "assistant",
					message: { role: "assistant", content, stopReason },
				});

				writeTail([
					assistant(
						[{ type: "toolCall", id: "call-1", name: "bash" }],
						"toolUse",
					),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});

				writeTail([
					assistant(
						[{ type: "toolCall", id: "call-1", name: "bash" }],
						"toolUse",
					),
					{
						type: "message",
						id: "result",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "toolCall", id: "call-1", name: "bash" },
							{ type: "toolCall", id: "call-2", name: "read" },
						],
						"toolUse",
					),
					{
						type: "message",
						id: "result-1",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "toolCall", id: "call-1", name: "bash" },
							{ type: "toolCall", id: "call-2", name: "read" },
						],
						"toolUse",
					),
					{
						type: "message",
						id: "result-1",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
					{
						type: "message",
						id: "result-2",
						message: {
							role: "toolResult",
							toolCallId: "call-2",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "thinking", thinking: "need a tool" },
							{ type: "text", text: "Running it." },
						],
						"toolUse",
					),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "truncated-turn",
					lastEntryKind: "assistant",
				});

				writeTail([
					assistant([{ type: "text", text: "still working" }], "stop"),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "assistant",
				});
			});
		});
	});

	describe("findObservedSessionRuntime", () => {
		it("extracts the latest model and thinking entries", () => {
			assert.deepEqual(
				findObservedSessionRuntime([
					{ type: "model_change", id: "m1", provider: "fake", modelId: "old" },
					{ type: "thinking_level_change", id: "t1", thinkingLevel: "medium" },
					{ type: "model_change", id: "m2", provider: "other", modelId: "new" },
				]),
				{ provider: "other", modelId: "new", thinking: "medium" },
			);
		});
	});

	describe("appendBranchSummary", () => {
		it("appends valid branch_summary entry", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const id = appendBranchSummary(
				file,
				"user-001",
				"asst-001",
				"The plan was created.",
			);

			assert.ok(id, "should return an id");
			assert.ok(isString(id));

			// Read back and verify
			const lines = readFileSync(file, "utf8").trim().split("\n");
			assert.equal(lines.length, 4); // 3 original + 1 summary

			const summary = JSON.parse(lines[3]);
			assert.equal(summary.type, "branch_summary");
			assert.equal(summary.id, id);
			assert.equal(summary.parentId, "user-001");
			assert.equal(summary.fromId, "asst-001");
			assert.equal(summary.summary, "The plan was created.");
			assert.ok(summary.timestamp);
		});

		it("uses branchPointId as fromId fallback", () => {
			const file = createSessionFile(dir, [SESSION_HEADER]);
			appendBranchSummary(file, "branch-pt", null, "summary");

			const lines = readFileSync(file, "utf8").trim().split("\n");
			const summary = JSON.parse(lines[1]);
			assert.equal(summary.fromId, "branch-pt");
		});
	});

	describe("copySessionFile", () => {
		it("creates a copy with different path", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
			const copyDir = join(dir, "copies");
			mkdirSync(copyDir, { recursive: true });
			const copy = copySessionFile(file, copyDir);

			assert.notEqual(copy, file);
			assert.ok(copy.endsWith(".jsonl"));
			assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
		});
	});

	describe("subagent session policy", () => {
		it("persists an explicit allowlist separately from unrestricted launches", () => {
			const restricted = join(dir, "restricted-policy.jsonl");
			const unrestricted = join(dir, "unrestricted-policy.jsonl");
			writeSubagentSessionPolicy(restricted, {
				owner: "public",
				tools: "read, read, ",
				deniedTools: ["subagent", "subagent"],
			});
			writeSubagentSessionPolicy(unrestricted, {
				owner: "public",
				deniedTools: [],
			});

			const restrictedPolicy = readSubagentSessionPolicy(restricted);
			assert.equal(restrictedPolicy.version, 2);
			assert.equal(restrictedPolicy.owner, "public");
			assert.deepEqual(restrictedPolicy.tools, ["read"]);
			assert.deepEqual(restrictedPolicy.deniedTools, ["subagent"]);
			assert.equal(restrictedPolicy.persistent, false);
			assert.equal(readSubagentSessionPolicy(unrestricted).tools, null);
			assert.equal(existsSync(getSubagentSessionPolicyFile(restricted)), true);
		});

		it("fails closed for missing, malformed, and unsupported policies", () => {
			const sessionFile = join(dir, "policy-errors.jsonl");
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/saved launch policy is missing/,
			);

			const policyFile = getSubagentSessionPolicyFile(sessionFile);
			writeFileSync(policyFile, "not json", "utf8");
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/saved launch policy cannot be read/,
			);

			writeFileSync(
				policyFile,
				JSON.stringify({
					version: 3,
					owner: "public",
					tools: null,
					deniedTools: [],
				}),
				"utf8",
			);
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/launch policy version is unsupported/,
			);
		});
	});

	it("writes v2 persistent policies and reads v1 compatibility", () => {
		const persistent = join(dir, "persistent-policy.jsonl");
		writeSubagentSessionPolicy(persistent, {
			owner: "public",
			tools: ["read"],
			deniedTools: ["subagent"],
			persistent: true,
			logicalId: "logical-1",
			generationId: "generation-1",
		});
		const read = readSubagentSessionPolicy(persistent);
		assert.equal(read.version, 2);
		assert.equal(read.persistent, true);
		assert.equal(read.logicalId, "logical-1");
		assert.match(read.policyHash, /^[a-f0-9]{64}$/);

		const legacy = join(dir, "legacy-policy.jsonl");
		writeFileSync(
			getSubagentSessionPolicyFile(legacy),
			JSON.stringify({
				version: 1,
				owner: "public",
				tools: null,
				deniedTools: [],
			}),
		);
		assert.deepEqual(readSubagentSessionPolicy(legacy), {
			version: 1,
			owner: "public",
			tools: null,
			deniedTools: [],
			persistent: false,
		});
	});

	it("appends task events and ignores a torn tail", () => {
		const sessionFile = join(dir, "tasks.jsonl");
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "task-1",
			generation: "generation-1",
		});
		writeFileSync(`${sessionFile}.tasks`, '{"version":1', { flag: "a" });
		assert.deepEqual(
			readPersistentTaskEvents(sessionFile).map((event) => event.task),
			["task-1"],
		);
	});

	it("preserves invalid inbox claims as evidence and recovers interrupted claims", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "recover-inbox.jsonl");
			const invalid = writePersistentTaskInbox(sessionFile, 1, {
				task: "bad",
				message: "will be corrupted",
			});
			writeFileSync(invalid, "not json");
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			assert.equal(existsSync(`${invalid}.invalid`), true);

			const interrupted = writePersistentTaskInbox(sessionFile, 2, {
				task: "recovered",
				message: "finish this",
			});
			renameSync(interrupted, `${interrupted}.consuming`);
			assert.equal(consumePersistentTaskInbox(sessionFile)?.task, "recovered");
			assert.equal(existsSync(`${interrupted}.consuming`), false);
		});
	});

	it("records delivery outcomes and atomically consumes each inbox task once", () => {
		const sessionFile = join(dir, "inbox.jsonl");
		appendPersistentDeliveryLedger(sessionFile, {
			task: "task-1",
			outcome: "dispatched",
			generation: "generation-1",
			logicalId: "logical-1",
			policyHash: "a".repeat(64),
		});
		assert.equal(
			readPersistentDeliveryLedger(sessionFile)[0].outcome,
			"dispatched",
		);
		const inbox = writePersistentTaskInbox(sessionFile, 1, {
			task: "task-2",
			message: "next task",
		});
		assert.ok(existsSync(inbox));
		assert.equal(consumePersistentTaskInbox(sessionFile)?.task, "task-2");
		assert.equal(consumePersistentTaskInbox(sessionFile), null);
	});

	describe("seedSubagentSessionFile", () => {
		it("creates a lineage-only child session with parent linkage and no copied turns", () => {
			const parentFile = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const childFile = join(dir, "lineage-child.jsonl");

			seedSubagentSessionFile({
				mode: "lineage-only",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/child-cwd",
			});

			const lines = readFileSync(childFile, "utf8").trim().split("\n");
			assert.equal(lines.length, 1);

			const header = JSON.parse(lines[0]);
			assert.equal(header.type, "session");
			assert.equal(header.parentSession, parentFile);
			assert.equal(header.cwd, "/tmp/child-cwd");
		});

		it("creates a forked child session with copied context before the triggering user turn", () => {
			const parentFile = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const childFile = join(dir, "fork-child.jsonl");

			seedSubagentSessionFile({
				mode: "fork",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/fork-child-cwd",
			});

			const entries = readFileSync(childFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(entries.length, 2);
			assert.equal(entries[0].type, "session");
			assert.equal(entries[0].parentSession, parentFile);
			assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
			assert.equal(entries[1].type, "model_change");
			assert.equal(
				entries.some(
					(entry) =>
						entry.type === "session" && entry.parentSession !== parentFile,
				),
				false,
			);
			assert.equal(
				entries.some((entry) => entry.type === "message"),
				false,
			);
		});
	});

	describe("createWorktreeSessionFork", () => {
		it("preserves the active branch, target cwd, and parent immutability", () => {
			const timestamp = "2026-07-31T00:00:00.000Z";
			const parentFile = createSessionFile(dir, [
				{
					type: "session",
					version: 3,
					id: "handoff-parent",
					timestamp,
					cwd: dir,
				},
				{
					type: "message",
					id: "root-user",
					parentId: null,
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "root" }],
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "root-assistant",
					parentId: "root-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "base" }],
						timestamp: 2,
					},
				},
				{
					type: "message",
					id: "abandoned-user",
					parentId: "root-assistant",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "abandoned" }],
						timestamp: 3,
					},
				},
				{
					type: "message",
					id: "active-user",
					parentId: "root-assistant",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "active" }],
						timestamp: 4,
					},
				},
				{
					type: "message",
					id: "active-assistant",
					parentId: "active-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "current" }],
						timestamp: 5,
					},
				},
			]);
			const parentBefore = readFileSync(parentFile, "utf8");
			const childFile = join(dir, "handoff-child.jsonl");

			createWorktreeSessionFork({
				parentSessionFile: parentFile,
				leafId: "active-assistant",
				childSessionFile: childFile,
				childCwd: "/tmp/handoff-worktree",
				handoffMessage: "Continue in the worktree.",
			});

			const child = SessionManager.open(childFile);
			assert.equal(child.getHeader()?.cwd, "/tmp/handoff-worktree");
			assert.equal(child.getHeader()?.parentSession, parentFile);
			assert.deepEqual(
				child
					.getBranch()
					.map((entry) => entry.id)
					.slice(0, 4),
				["root-user", "root-assistant", "active-user", "active-assistant"],
			);
			assert.equal(readFileSync(parentFile, "utf8"), parentBefore);
			const leafEntry = child.getLeafEntry();
			if (leafEntry?.type !== "custom_message") {
				throw new Error("expected a custom_message leaf entry");
			}
			assert.equal(leafEntry.content, "Continue in the worktree.");
		});

		it("preserves compaction entries on the active branch", () => {
			const timestamp = "2026-07-31T00:00:00.000Z";
			const parentFile = createSessionFile(dir, [
				{
					type: "session",
					version: 3,
					id: "compaction-parent",
					timestamp,
					cwd: dir,
				},
				{
					type: "message",
					id: "compaction-user",
					parentId: null,
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "start" }],
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "compaction-assistant",
					parentId: "compaction-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "summary follows" }],
						timestamp: 2,
					},
				},
				{
					type: "compaction",
					id: "compaction-entry",
					parentId: "compaction-assistant",
					timestamp,
					summary: "Earlier context summary",
					firstKeptEntryId: "compaction-assistant",
					tokensBefore: 100,
				},
			]);
			const childFile = join(dir, "compaction-child.jsonl");

			createWorktreeSessionFork({
				parentSessionFile: parentFile,
				leafId: "compaction-entry",
				childSessionFile: childFile,
				childCwd: "/tmp/compaction-worktree",
				handoffMessage: "Continue after compaction.",
			});

			const child = SessionManager.open(childFile);
			assert.equal(child.getEntry("compaction-entry")?.type, "compaction");
			assert.equal(child.getHeader()?.cwd, "/tmp/compaction-worktree");
		});
	});

	describe("mergeNewEntries", () => {
		it("appends new entries from source to target", () => {
			// Source starts with same base (2 entries), then has 1 new entry
			const sourceFile = join(dir, "merge-source.jsonl");
			const targetFile = join(dir, "merge-target.jsonl");
			writeFileSync(
				sourceFile,
				[SESSION_HEADER, USER_MSG, ASSISTANT_MSG]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n",
			);
			writeFileSync(
				targetFile,
				[SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") +
					"\n",
			);

			// Merge entries after line 2 (the shared base)
			const merged = mergeNewEntries(sourceFile, targetFile, 2);
			assert.equal(merged.length, 1);
			assert.equal(merged[0].id, "asst-001");

			// Target should now have 3 entries
			const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
			assert.equal(targetLines.length, 3);
		});
	});
});

describe("subagent resume launch policy", () => {
	function runtimePlan() {
		return {
			provider: "test",
			modelId: "model",
			model: "test/model",
			thinking: "low" as const,
			modelSource: "request" as const,
			thinkingSource: "request" as const,
		};
	}

	function launchOperations(commands: string[], createPane = () => "pane") {
		return {
			createPane,
			createWorktree() {
				throw new Error("worktree creation is not expected");
			},
			async waitForShellReady() {},
			runScript(_surface: string, command: string) {
				commands.push(command);
				return "/tmp/launch.sh";
			},
			closePane() {},
		};
	}

	it("snapshots restricted tools and spawning denial for repeated public resumes", async () => {
		const dir = createTestDir();
		try {
			const commands: string[] = [];
			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify(SESSION_HEADER)}\n`,
				"utf8",
			);
			const fresh = await launchPiSubagent(
				{
					kind: "fresh",
					id: "fresh-id",
					name: "Restricted",
					task: "inspect",
					parent: {
						cwd: dir,
						sessionFile: parentSession,
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
						agentDir: join(dir, "agent"),
					},
					runtimePlan: runtimePlan(),
					behavior: {
						tools: "read",
						deniedTools: ["subagent", "subagent_resume"],
						autoExit: true,
						interactive: false,
						sessionMode: "standalone",
					},
				},
				launchOperations(commands),
			);
			// The mocked launch does not start Pi, which normally writes this header.
			writeFileSync(
				fresh.sessionFile,
				`${JSON.stringify({ ...SESSION_HEADER, cwd: dir })}\n`,
				"utf8",
			);
			const policy = readSubagentSessionPolicy(fresh.sessionFile);
			assert.equal(policy.version, 2);
			assert.equal(policy.owner, "public");
			assert.deepEqual(policy.tools, ["read"]);
			assert.deepEqual(policy.deniedTools, ["subagent", "subagent_resume"]);
			assert.equal(policy.persistent, false);

			await launchPiSubagent(
				{
					kind: "resume",
					name: "Restricted",
					sessionFile: fresh.sessionFile,
					parent: {
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
					},
					behavior: { autoExit: false },
				},
				launchOperations(commands),
			);
			await launchPiSubagent(
				{
					kind: "resume",
					name: "Restricted again",
					sessionFile: fresh.sessionFile,
					parent: {
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
					},
				},
				launchOperations(commands),
			);

			assert.match(
				commands[1],
				/PI_DENY_TOOLS='subagent,subagent_resume'.*--tools 'read,caller_ping,subagent_done'/,
			);
			assert.match(
				commands[2],
				/PI_DENY_TOOLS='subagent,subagent_resume'.*--tools 'read,caller_ping'/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects absent, malformed, unknown-owner, and worktree policies before pane creation", async () => {
		const dir = createTestDir();
		try {
			const sessionFile = join(dir, "resume.jsonl");
			let panes = 0;
			const operations = launchOperations([], () => {
				panes += 1;
				return "unexpected-pane";
			});
			const resume = () =>
				launchPiSubagent(
					{
						kind: "resume",
						name: "Resume",
						sessionFile,
						parent: { sessionId: "parent-id", sessionDir: dir },
					},
					operations,
				);

			await assert.rejects(resume, /saved launch policy is missing/);
			writeFileSync(getSubagentSessionPolicyFile(sessionFile), "{", "utf8");
			await assert.rejects(resume, /saved launch policy cannot be read/);
			for (const tools of [[], ["read,write"], [" read"]]) {
				writeFileSync(
					getSubagentSessionPolicyFile(sessionFile),
					JSON.stringify({
						version: 1,
						owner: "public",
						tools,
						deniedTools: [],
					}),
					"utf8",
				);
				await assert.rejects(resume, /saved launch tool policy is malformed/);
			}
			writeFileSync(
				getSubagentSessionPolicyFile(sessionFile),
				JSON.stringify({
					version: 1,
					owner: "workflow",
					tools: ["read"],
					deniedTools: [],
				}),
				"utf8",
			);
			await assert.rejects(resume, /saved launch policy owner is invalid/);
			writeSubagentSessionPolicy(sessionFile, {
				owner: "managed-worktree",
				tools: ["read"],
				deniedTools: [],
			});
			await assert.rejects(resume, /Cannot resume managed-worktree/);
			assert.equal(panes, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("status.ts", () => {
	it("parses strict config objects", () => {
		const disabled = parseStatusConfig({ status: { enabled: false } });

		assert.deepEqual(disabled, {
			enabled: false,
			lineLimit: 4,
		});
	});

	it("loads a valid config file", () => {
		const examplePath = fileURLToPath(
			new URL("../config.json.example", import.meta.url),
		);
		const config = loadStatusConfig(examplePath, examplePath);

		assert.deepEqual(config, {
			enabled: true,
			lineLimit: 4,
		});
	});

	it("loads the shared example when local config is absent", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				examplePath,
				JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
			);

			const config = loadStatusConfig(join(dir, "config.json"), examplePath);

			assert.deepEqual(config, {
				enabled: true,
				lineLimit: 4,
			});
		});
	});

	it("fails fast for invalid config shapes", () => {
		assert.throws(
			() => parseStatusConfig({ status: { enabled: "false" } }),
			/status\.enabled must be a boolean/,
		);
		assert.throws(
			() =>
				parseStatusConfig({
					status: { enabled: true, defaultCadenceSeconds: 60 },
				}),
			/status has unsupported key\(s\): defaultCadenceSeconds/,
		);
	});

	it("reports when neither local nor shared config exists", () => {
		withTempDir((dir) => {
			assert.throws(
				() =>
					loadStatusConfig(
						join(dir, "config.json"),
						join(dir, "config.json.example"),
					),
				/Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
			);
		});
	});

	it("reports invalid JSON from the shared example path", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(examplePath, "{\n");

			assert.throws(
				() => loadStatusConfig(join(dir, "config.json"), examplePath),
				/Invalid JSON in subagent config .*config\.json\.example/,
			);
		});
	});

	it("fails on invalid local config instead of falling back to the shared example", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const examplePath = join(dir, "config.json.example");
			writeFileSync(configPath, "{\n");
			writeFileSync(
				examplePath,
				JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
			);

			assert.throws(
				() => loadStatusConfig(configPath, examplePath),
				/Invalid JSON in subagent config .*config\.json/,
			);
		});
	});

	it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(state, { snapshot: "missing" }, 1_000);

		assert.equal(classifyStatus(state, 60_999).kind, "starting");
		const stalled = classifyStatus(state, 61_000);
		assert.equal(stalled.kind, "stalled");
		assert.equal(stalled.statusLabel, null);
	});

	it("classifies active snapshots without aging into stalled", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
				latestEvent: "tool_execution_start",
			},
			5_000,
		);

		const snapshot = classifyStatus(state, 240_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.activityLabel, "bash");
		assert.equal(snapshot.activeDurationText, "3m");
	});

	it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 1,
				phase: "waiting",
				waitingSince: 10_000,
				latestEvent: "agent_end",
			},
			10_000,
		);

		const snapshot = classifyStatus(state, 240_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.waitingDurationText, "3m");
	});

	it("detects stalled transitions and recovery", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(state, { snapshot: "missing" }, 1_000);

		let advanced = advanceStatusState(state, 95_000);
		assert.equal(advanced.transition, "stalled");
		assert.equal(advanced.snapshot.kind, "stalled");

		state = observeStatus(
			advanced.nextState,
			{
				snapshot: "present",
				updatedAt: 96_000,
				sequence: 1,
				phase: "waiting",
				waitingSince: 96_000,
				latestEvent: "agent_end",
			},
			96_000,
		);
		advanced = advanceStatusState(state, 97_000);
		assert.equal(advanced.transition, "recovered");
		assert.equal(advanced.snapshot.kind, "waiting");
	});

	it("keeps the last healthy kind during transient snapshot loss", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "streaming",
				activeSince: 5_000,
			},
			5_000,
		);
		state = advanceStatusState(state, 6_000).nextState;
		state = observeStatus(state, { snapshot: "missing" }, 10_000);

		const snapshot = classifyStatus(state, 20_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.statusLabel, null);
	});

	it("forces an active state to waiting after interrupt", () => {
		const now = 20_000;
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);

		assert.equal(classifyStatus(state, now).kind, "active");

		const forced = forceStatusAfterInterrupt(state, now);
		const snapshot = classifyStatus(forced, now);

		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");
		assert.equal(snapshot.waitingDurationText, "0s");
		assert.equal(forced.activeNow, false);
	});

	it("orders same-millisecond snapshots by sequence", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 10_000,
				activityLabel: "bash",
			},
			10_000,
		);

		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 3,
				phase: "waiting",
				waitingSince: 10_000,
				latestEvent: "agent_end",
			},
			10_001,
		);

		const snapshot = classifyStatus(state, 11_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.latestEvent, "agent_end");
	});

	it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);
		state = observeStatus(state, { snapshot: "missing" }, 10_000);
		assert.equal(classifyStatus(state, 10_000).statusLabel, null);

		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			11_000,
		);

		const snapshot = classifyStatus(state, 11_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.statusLabel, null);
	});

	it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);
		state = forceStatusAfterInterrupt(state, 20_000);

		const stale = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			21_000,
		);
		let snapshot = classifyStatus(stale, 21_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");

		const sameTimestamp = observeStatus(
			stale,
			{
				snapshot: "present",
				updatedAt: 20_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 20_000,
				activityLabel: "bash",
			},
			22_000,
		);
		snapshot = classifyStatus(sameTimestamp, 22_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");

		const resumed = observeStatus(
			sameTimestamp,
			{
				snapshot: "present",
				sequence: 2,
				updatedAt: 25_000,
				phase: "active",
				active: true,
				activeScope: "streaming",
				activeSince: 25_000,
				activityLabel: "streaming",
			},
			25_000,
		);
		snapshot = classifyStatus(resumed, 25_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(resumed.activeScope, "streaming");
	});

	it("normalizes and truncates long newline-heavy names", () => {
		const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
		const stalledState = observeStatus(
			createStatusState({ startTimeMs: 0 }),
			{ snapshot: "missing" },
			1_000,
		);
		const activeState = observeStatus(
			createStatusState({ startTimeMs: 0 }),
			{
				snapshot: "present",
				updatedAt: 299_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 299_000,
				activityLabel: "write",
			},
			299_000,
		);
		const line = formatStatusLine(
			longName,
			classifyStatus(stalledState, 240_000),
		);
		const recovered = formatTransitionLine(
			longName,
			classifyStatus(activeState, 300_000),
			"recovered",
		);

		assert.doesNotMatch(line, /\n/);
		assert.doesNotMatch(recovered, /\n/);
		assert.ok(
			line.length <= 120,
			`expected bounded line length, got ${line.length}`,
		);
		assert.ok(
			recovered.length <= 120,
			`expected bounded line length, got ${recovered.length}`,
		);
	});

	it("caps visible status lines and reports overflow consistently", () => {
		const waitingState = observeStatus(
			createStatusState({ startTimeMs: 0 }),
			{
				snapshot: "present",
				updatedAt: 180_000,
				sequence: 1,
				phase: "waiting",
				waitingSince: 180_000,
			},
			180_000,
		);
		const activeState = observeStatus(
			createStatusState({ startTimeMs: 0 }),
			{
				snapshot: "present",
				updatedAt: 419_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 419_000,
				activityLabel: "bash",
			},
			419_000,
		);
		const waitingLine = formatStatusLine(
			"Worker",
			classifyStatus(waitingState, 300_000),
		);
		const recoveredLine = formatTransitionLine(
			"Worker",
			classifyStatus(activeState, 420_000),
			"recovered",
		);
		const lines = [
			waitingLine,
			recoveredLine,
			"Scout running 2m.",
			"Reviewer running 4m.",
			"Planner running 6m.",
		];
		const capped = capStatusLines(lines, 3);
		const aggregate = formatStatusAggregate(lines, 3);

		assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
		assert.equal(
			recoveredLine,
			"Worker running 7m, recovered; active (bash 1s).",
		);
		assert.deepEqual(capped.visibleLines, [
			waitingLine,
			recoveredLine,
			"Scout running 2m.",
		]);
		assert.equal(capped.overflow, 2);
		assert.match(aggregate, /^Subagent status:/);
		assert.match(aggregate, /\+2 more running\./);
		assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
	});
});

describe("shared subagent configuration path", () => {
	it("resolves the user config under PI_CODING_AGENT_DIR and keeps the packaged example separate", () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
		try {
			assert.equal(
				getSubagentsConfigPath(),
				"/tmp/custom-pi-agent/herdr-agents/config.json",
			);
			assert.match(getSubagentsConfigExamplePath(), /config\.json\.example$/);
		} finally {
			restoreEnvVar("PI_CODING_AGENT_DIR", previous);
		}
	});

	it("keeps the packaged example strict JSON without task preferences", () => {
		const example = JSON.parse(
			readFileSync(getSubagentsConfigExamplePath(), "utf8"),
		);
		assert.equal(example.models.tasks, undefined);
	});

	it("ignores a decoy package-root config.json in every reader", () => {
		withTempDir((dir) => {
			const decoyPath = join(getSubagentsPackageRoot(), "config.json");
			const previousDecoy = existsSync(decoyPath)
				? readFileSync(decoyPath, "utf8")
				: undefined;
			const previous = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = dir;
			try {
				writeFileSync(
					decoyPath,
					JSON.stringify({
						status: { enabled: false },
						models: { default: "decoy/model" },
						roles: { bundled: false },
						panes: { mode: "tab" },
						supervision: { forcePolling: true },
						persistent: { maxAgents: 1 },
					}),
				);
				assert.deepEqual(loadModelConfig(dirname(getSubagentsConfigPath())), {
					agents: {},
				});
				assert.deepEqual(
					loadRoleConfig(
						dirname(getSubagentsConfigPath()),
						getSubagentsConfigExamplePath(),
					).deprecations,
					[],
				);
				assert.equal(
					loadPaneConfig(
						dirname(getSubagentsConfigPath()),
						getSubagentsConfigExamplePath(),
					).mode,
					"grouped",
				);
				assert.equal(
					loadSupervisionConfig(
						dirname(getSubagentsConfigPath()),
						getSubagentsConfigExamplePath(),
					).forcePolling,
					false,
				);
				assert.equal(
					loadPersistentConfig(
						dirname(getSubagentsConfigPath()),
						getSubagentsConfigExamplePath(),
					).maxAgents,
					3,
				);
				assert.equal(
					loadStatusConfig(
						getSubagentsConfigPath(),
						getSubagentsConfigExamplePath(),
					).enabled,
					true,
				);
			} finally {
				restoreEnvVar("PI_CODING_AGENT_DIR", previous);
				if (previousDecoy == null) rmSync(decoyPath, { force: true });
				else writeFileSync(decoyPath, previousDecoy);
			}
		});
	});

	it("routes every config reader through the user config path", () => {
		withTempDir((dir) => {
			const previous = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = dir;
			try {
				const configPath = getSubagentsConfigPath();
				mkdirSync(dirname(configPath), { recursive: true });
				writeFileSync(
					configPath,
					JSON.stringify({
						status: { enabled: false },
						models: { default: "fake/default" },
						roles: { bundled: false },
						panes: { mode: "tab" },
						supervision: { forcePolling: true },
						persistent: { maxAgents: 2 },
					}),
				);
				assert.equal(
					loadModelConfig(dirname(getSubagentsConfigPath())).default,
					"fake/default",
				);
				const [deprecation, ...extra] = loadRoleConfig(
					dirname(getSubagentsConfigPath()),
					getSubagentsConfigExamplePath(),
				).deprecations;
				assert.deepEqual(extra, []);
				assert.ok(deprecation.includes(configPath));
				assert.equal(
					loadPaneConfig(
						dirname(getSubagentsConfigPath()),
						getSubagentsConfigExamplePath(),
					).mode,
					"tab",
				);
				assert.equal(
					loadSupervisionConfig(
						dirname(getSubagentsConfigPath()),
						getSubagentsConfigExamplePath(),
					).forcePolling,
					true,
				);
				assert.equal(
					loadPersistentConfig(
						dirname(getSubagentsConfigPath()),
						getSubagentsConfigExamplePath(),
					).maxAgents,
					2,
				);
				assert.equal(
					loadStatusConfig(
						getSubagentsConfigPath(),
						getSubagentsConfigExamplePath(),
					).enabled,
					false,
				);
			} finally {
				restoreEnvVar("PI_CODING_AGENT_DIR", previous);
			}
		});
	});
});

describe("runtime reload configuration", () => {
	const runtimeKey = Symbol.for("pi-subagents/runtime");
	type ReloadRuntime = {
		session?: PiRunSession;
		runningSubagents?: Map<string, object>;
		surfaceProvider?: object;
		launchOperations?: {
			createPane?: (name: string, cwd?: string) => string | Promise<string>;
		};
	};
	type RuntimeSlot = typeof globalThis &
		Record<symbol, ReloadRuntime | undefined>;

	async function importReloadedSubagents() {
		return import(
			`../pi-extension/subagents/index.ts?reload-test-${Date.now()}-${Math.random()}`
		);
	}

	it("refreshes pane-backed launch operations from the reloaded module config while preserving running children", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		// SAFETY: pi-herdr-agents owns this process-local runtime symbol.
		const runtimeSlot = globalThis as RuntimeSlot;
		const beforeRuntime = runtimeSlot[runtimeKey];
		const beforeSurfaceProvider = beforeRuntime?.surfaceProvider;
		const beforeHadSurfaceProvider =
			beforeRuntime !== undefined && "surfaceProvider" in beforeRuntime;
		const beforeLaunchOperations = beforeRuntime?.launchOperations;
		const beforeHadLaunchOperations =
			beforeRuntime !== undefined && "launchOperations" in beforeRuntime;
		const existingRunning = subagentsModule.__test__.runningSubagents;
		existingRunning.set("reload-live", {
			id: "reload-live",
			name: "Reload live",
			task: "still running",
			surface: "pane-live",
			startTime: 0,
			sessionFile: "live.jsonl",
			interactive: false,
			runtimePlan: undefined,
			lifecycle: createLifecycle(0),
		});
		const dir = createTestDir();
		try {
			process.env.PI_CODING_AGENT_DIR = dir;
			const configPath = getSubagentsConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					status: { enabled: true },
					models: { agents: {} },
					roles: { bundled: true },
					persistent: { maxAgents: 3 },
					supervision: { forcePolling: false, hangWarningMinutes: 15 },
					panes: { mode: "tab" },
				}),
			);
			const reloaded = await importReloadedSubagents();
			assert.equal(reloaded.__test__.runningSubagents, existingRunning);
			assert.equal(reloaded.__test__.runningSubagents.has("reload-live"), true);

			const calls: string[][] = [];
			await __herdrTest__.withMockHerdrExec(
				(args) => {
					calls.push(args);
					if (args[0] === "pane" && args[1] === "current") {
						return JSON.stringify({
							result: {
								pane: {
									pane_id: "parent-pane",
									tab_id: "parent-tab",
									workspace_id: "workspace-1",
								},
							},
						});
					}
					if (args[0] === "tab" && args[1] === "create") {
						return JSON.stringify({
							result: {
								tab: { tab_id: "tab-new" },
								root_pane: { pane_id: "pane-new" },
							},
						});
					}
					return JSON.stringify({ result: { ok: true } });
				},
				async () => {
					assert.equal(
						await launchOperationsFromSurface(
							new HerdrSurfaceProvider({
								paneConfig: loadPaneConfig(
									dirname(getSubagentsConfigPath()),
									getSubagentsConfigExamplePath(),
								),
							}),
							loadPaneConfig(
								dirname(getSubagentsConfigPath()),
								getSubagentsConfigExamplePath(),
							),
						).createPane("reload-config", "/repo"),
						"pane-new",
					);
				},
			);
			assert.deepEqual(
				calls.find((args) => args[0] === "tab" && args[1] === "create"),
				[
					"tab",
					"create",
					"--workspace",
					"workspace-1",
					"--label",
					"reload-config",
					"--cwd",
					"/repo",
					"--no-focus",
				],
			);
			assert.equal(
				calls.some((args) => args[0] === "workspace" && args[1] === "list"),
				false,
			);
		} finally {
			existingRunning.delete("reload-live");
			if (beforeRuntime) {
				if (beforeHadSurfaceProvider) {
					beforeRuntime.surfaceProvider = beforeSurfaceProvider;
				} else {
					delete beforeRuntime.surfaceProvider;
				}
				if (beforeHadLaunchOperations) {
					beforeRuntime.launchOperations = beforeLaunchOperations;
				} else {
					delete beforeRuntime.launchOperations;
				}
			}
			runtimeSlot[runtimeKey] = beforeRuntime;
			try {
				assert.equal(
					runtimeSlot[runtimeKey]?.surfaceProvider,
					beforeSurfaceProvider,
				);
				assert.equal(
					runtimeSlot[runtimeKey]?.launchOperations,
					beforeLaunchOperations,
				);
			} finally {
				restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("upgrades a pre-refresh runtime slot that lacks provider fields", async () => {
		// SAFETY: pi-herdr-agents owns this process-local runtime symbol.
		const runtimeSlot = globalThis as RuntimeSlot;
		const beforeRuntime = runtimeSlot[runtimeKey];
		const runningSubagents = new Map<string, object>();
		runningSubagents.set("legacy-live", { id: "legacy-live" });
		try {
			runtimeSlot[runtimeKey] = { runningSubagents };
			const reloaded = await importReloadedSubagents();
			assert.equal(reloaded.__test__.runningSubagents, runningSubagents);
			const mock = createMockExtensionApi();
			reloaded.default(mock.api);
			assert.ok(runtimeSlot[runtimeKey]?.session);
		} finally {
			runtimeSlot[runtimeKey] = beforeRuntime;
		}
	});

	it("reports a legacy roles.bundled value once per parent load without rewriting config", async () => {
		// SAFETY: pi-herdr-agents owns this process-local runtime symbol.
		const runtimeSlot = globalThis as RuntimeSlot;
		const beforeRuntime = runtimeSlot[runtimeKey];
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousId = process.env.PI_SUBAGENT_ID;
		const dir = createTestDir();
		const loaded: ReturnType<typeof createMockExtensionApi>[] = [];
		const startSessions = async (
			mock: ReturnType<typeof createMockExtensionApi>,
			reasons: string[],
		) => {
			const notices: string[] = [];
			const ctx = {
				cwd: dir,
				hasUI: true,
				modelRegistry: { find: () => undefined, getAvailable: () => [] },
				ui: {
					notify: (text: string, level: string) =>
						notices.push(`${level}: ${text}`),
				},
			};
			for (const reason of reasons)
				for (const handler of mock.eventHandlers.get("session_start") ?? [])
					await handler({ reason }, ctx);
			return notices;
		};
		try {
			process.env.PI_CODING_AGENT_DIR = dir;
			const configPath = getSubagentsConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			for (const bundled of [true, false]) {
				const raw = `${JSON.stringify(
					{
						...JSON.parse(
							readFileSync(getSubagentsConfigExamplePath(), "utf8"),
						),
						roles: { bundled },
					},
					null,
					2,
				)}\n`;
				writeFileSync(configPath, raw);

				delete process.env.PI_SUBAGENT_ID;
				const parent = createMockExtensionApi();
				loaded.push(parent);
				(await importReloadedSubagents()).default(parent.api);
				const notices = await startSessions(parent, ["startup", "new"]);
				assert.equal(notices.length, 1, notices.join("\n"));
				assert.match(
					notices[0],
					new RegExp(
						`^warning: Deprecated setting roles\\.bundled \\(${bundled}\\)`,
					),
				);
				assert.ok(notices[0].includes(configPath));
				assert.match(notices[0], /no longer ships bundled roles/);
				assert.match(notices[0], /remove roles\.bundled/);
				assert.equal(readFileSync(configPath, "utf8"), raw);

				process.env.PI_SUBAGENT_ID = "legacy-config-child";
				const child = createMockExtensionApi();
				loaded.push(child);
				(await importReloadedSubagents()).default(child.api);
				assert.deepEqual(await startSessions(child, ["startup"]), []);
			}
		} finally {
			for (const mock of loaded)
				for (const handler of mock.eventHandlers.get("session_shutdown") ?? [])
					await handler({ reason: "quit" }, { ui: { setWidget() {} } });
			restoreEnvVar("PI_SUBAGENT_ID", previousId);
			restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
			runtimeSlot[runtimeKey] = beforeRuntime;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pane configuration", () => {
	it("defaults to four grouped panes when panes are absent", () => {
		assert.deepEqual(parsePaneConfig({}), {
			mode: "grouped",
			maxPerTab: 4,
			direction: "right",
		});
	});

	it("parses split mode and direction", () => {
		assert.deepEqual(
			parsePaneConfig({ panes: { mode: "split", direction: "down" } }),
			{ mode: "split", direction: "down", maxPerTab: 4 },
		);
	});

	it("loads a strict grouped capacity independently of persistent capacity", () => {
		withTempDir((dir) => {
			const config = join(dir, "config.json");
			writeFileSync(
				config,
				JSON.stringify({
					panes: { maxPerTab: 2 },
					persistent: { maxAgents: 9 },
				}),
			);
			assert.deepEqual(
				loadPaneConfig(dirname(config), getSubagentsConfigExamplePath()),
				{
					mode: "grouped",
					direction: "right",
					maxPerTab: 2,
				},
			);
			for (const maxPerTab of [
				0,
				-1,
				1.5,
				"4",
				null,
				true,
				Number.MAX_SAFE_INTEGER + 1,
			]) {
				writeFileSync(config, JSON.stringify({ panes: { maxPerTab } }));
				assert.throws(
					() =>
						loadPaneConfig(dirname(config), getSubagentsConfigExamplePath()),
					/panes.maxPerTab must be a positive safe integer/,
				);
			}
		});
	});

	it("rejects invalid pane settings", () => {
		for (const panes of [null, [], "split"]) {
			assert.throws(
				() => parsePaneConfig({ panes }),
				/panes must be an object/,
			);
		}
		assert.throws(
			() => parsePaneConfig({ panes: { mode: "window" } }),
			/panes\.mode must be "grouped", "tab", or "split"/,
		);
		assert.throws(
			() => parsePaneConfig({ panes: { direction: "left" } }),
			/panes\.direction must be "right" or "down"/,
		);
		assert.throws(
			() => parsePaneConfig({ panes: { mode: "tab", extra: true } }),
			/panes has unsupported key\(s\): extra/,
		);
	});

	it("loads the shared example when local config is absent", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				examplePath,
				JSON.stringify({ panes: { mode: "split", direction: "down" } }),
			);

			assert.deepEqual(loadPaneConfig(dir, examplePath), {
				mode: "split",
				maxPerTab: 4,
				direction: "down",
			});
		});
	});

	it("uses tabs unchanged and passes split direction to the split creator", () => {
		const calls: string[] = [];
		const createTab = (name: string) => {
			calls.push(`tab:${name}`);
			return "tab-pane";
		};
		const createSplit = (name: string, direction: "right" | "down") => {
			calls.push(`split:${name}:${direction}`);
			return "split-pane";
		};

		assert.equal(
			createSubagentPaneFactory(
				{ mode: "tab", direction: "down", maxPerTab: 4 },
				createTab,
				createSplit,
			)("Scout"),
			"tab-pane",
		);
		assert.equal(
			createSubagentPaneFactory(
				{ mode: "split", direction: "right", maxPerTab: 4 },
				createTab,
				createSplit,
			)("Reviewer"),
			"split-pane",
		);
		assert.deepEqual(calls, ["tab:Scout", "split:Reviewer:right"]);
	});
});

describe("model configuration", () => {
	it("parses global and per-agent model defaults", () => {
		assert.deepEqual(
			parseModelConfig({
				models: {
					default: " anthropic/claude-sonnet-4-6 ",
					agents: { scout: " openai/gpt-5-mini " },
				},
			}),
			{
				default: "anthropic/claude-sonnet-4-6",
				agents: { scout: "openai/gpt-5-mini" },
			},
		);
	});

	it("loads no model overrides when config.json is absent", () => {
		const config = loadModelConfig(createTestDir());
		assert.deepEqual(config, { agents: {} });
	});

	it("resolves frontmatter, per-agent, global, and parent fallback precedence", () => {
		const config = parseModelConfig({
			models: {
				default: "fake/global",
				agents: { scout: "fake/scout" },
			},
		});

		assert.equal(
			resolveModelDefault("scout", "fake/frontmatter", config),
			"fake/frontmatter",
		);
		assert.equal(resolveModelDefault("scout", undefined, config), "fake/scout");
		assert.equal(
			resolveModelDefault("reviewer", undefined, config),
			"fake/global",
		);
		assert.equal(
			resolveModelDefault(undefined, undefined, { agents: {} }),
			undefined,
		);
	});

	it("does not read inherited object properties as agent model defaults", () => {
		const config = parseModelConfig({ models: { agents: {} } });
		for (const agent of ["constructor", "toString", "__proto__"]) {
			assert.equal(resolveModelDefault(agent, undefined, config), undefined);
		}
	});

	it("supports reserved property names when explicitly configured", () => {
		const config = parseModelConfig(
			JSON.parse(
				'{"models":{"agents":{"constructor":"fake/constructor","__proto__":"fake/proto"}}}',
			),
		);
		assert.equal(
			resolveModelDefault("constructor", undefined, config),
			"fake/constructor",
		);
		assert.equal(
			resolveModelDefault("__proto__", undefined, config),
			"fake/proto",
		);
	});

	it("parses strict task preferences and metadata", () => {
		assert.deepEqual(
			parseModelConfig({
				models: {
					tasks: { coding: ["fake/worker"] },
					tasksMeta: {
						generatedAt: "2026-09-17T00:00:00Z",
						method: "research",
					},
				},
			}),
			{
				agents: {},
				tasks: { coding: ["fake/worker"] },
				tasksMeta: {
					generatedAt: "2026-09-17T00:00:00Z",
					method: "research",
				},
			},
		);
		for (const config of [
			{ models: { tasks: { debugging: ["fake/worker"] } } },
			{ models: { tasks: { coding: [] } } },
			{ models: { tasks: { coding: [1] } } },
			{ models: { tasksMeta: { generatedAt: "nope", method: "guesswork" } } },
		]) {
			assert.throws(
				() => parseModelConfig(config),
				/models\.tasks|models\.tasksMeta/,
			);
		}
		for (const config of [
			{ models: { default: "task:coding" } },
			{ models: { agents: { worker: "task:coding" } } },
		]) {
			assert.throws(
				() => parseModelConfig(config),
				/only valid in the subagent tool's model parameter/,
			);
		}
		assert.deepEqual(parseModelConfig({ models: { tasks: {} } }), {
			agents: {},
		});
	});

	it("rejects exact duplicate task candidates after trimming without changing case-sensitive IDs", () => {
		assert.throws(
			() =>
				parseModelConfig({
					models: { tasks: { coding: [" fake/Worker ", "fake/Worker"] } },
				}),
			/models\.tasks\.coding.*duplicate.*fake\/Worker/,
		);
		assert.deepEqual(
			parseModelConfig({
				models: {
					tasks: { coding: [" fake/Worker ", "fake/worker", "proxy/Worker"] },
				},
			}).tasks,
			{ coding: ["fake/Worker", "fake/worker", "proxy/Worker"] },
		);
	});

	it("returns normalized saved preferences and missing categories after atomic replacement", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const tasksMeta = {
				generatedAt: "2026-09-18T00:00:00Z",
				method: "registry-only" as const,
			};
			const result = writeTaskModelConfig(
				configPath,
				getSubagentsConfigExamplePath(),
				{ coding: [" fake/worker "] },
				tasksMeta,
				(candidate) => candidate === "fake/worker",
			);
			assert.deepEqual(result, {
				configPath,
				tasks: { coding: ["fake/worker"] },
				tasksMeta,
				missingCategories: ["review", "recon", "qa", "architecture", "docs"],
				configRevision: readConfigRevision(configPath),
			});
			const before = readFileSync(configPath, "utf8");
			assert.throws(
				() =>
					writeTaskModelConfig(
						configPath,
						getSubagentsConfigExamplePath(),
						{ coding: ["fake/worker", " fake/worker "] },
						tasksMeta,
						() => true,
					),
				/duplicate/,
			);
			assert.equal(readFileSync(configPath, "utf8"), before);
		});
	});

	it("seeds from the packaged example and keeps every config section loadable", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "herdr-agents", "config.json");
			const examplePath = getSubagentsConfigExamplePath();
			writeTaskModelConfig(
				configPath,
				examplePath,
				{ coding: ["fake/worker"] },
				{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
				(candidate) => candidate === "fake/worker",
			);
			assert.equal(
				loadModelConfig(dirname(configPath)).tasks?.coding?.[0],
				"fake/worker",
			);
			assert.deepEqual(
				loadRoleConfig(dirname(configPath), examplePath).deprecations,
				[],
			);
			assert.equal(
				loadPaneConfig(dirname(configPath), examplePath).mode,
				"grouped",
			);
			assert.equal(
				loadSupervisionConfig(dirname(configPath), examplePath).forcePolling,
				false,
			);
			assert.equal(
				loadPersistentConfig(dirname(configPath), examplePath).maxAgents,
				3,
			);
			assert.equal(loadStatusConfig(configPath, examplePath).enabled, true);
		});
	});

	it("writes only validated task preferences into a seeded user config", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "herdr-agents", "config.json");
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				examplePath,
				JSON.stringify({
					status: { enabled: true },
					roles: { bundled: false },
					models: { default: "fake/default" },
				}),
			);
			writeTaskModelConfig(
				configPath,
				examplePath,
				{ coding: ["fake/worker"] },
				{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
				(candidate) => candidate === "fake/worker",
			);
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
				status: { enabled: true },
				roles: { bundled: false },
				models: {
					default: "fake/default",
					tasks: { coding: ["fake/worker"] },
					tasksMeta: {
						generatedAt: "2026-09-17T00:00:00Z",
						method: "research",
					},
				},
			});
			const before = readFileSync(configPath, "utf8");
			assert.throws(
				() =>
					writeTaskModelConfig(
						configPath,
						examplePath,
						{ coding: ["missing/model"] },
						{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
						() => false,
					),
				/missing\/model/,
			);
			assert.equal(readFileSync(configPath, "utf8"), before);
		});
	});

	it("repairs invalid existing task preferences without rewriting other model keys", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					status: { enabled: false },
					models: { default: "fake/default", tasks: { coding: null } },
				}),
			);
			writeTaskModelConfig(
				configPath,
				getSubagentsConfigExamplePath(),
				{ coding: ["fake/worker"] },
				{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
				(candidate) => candidate === "fake/worker",
			);
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
				status: { enabled: false },
				models: {
					default: "fake/default",
					tasks: { coding: ["fake/worker"] },
					tasksMeta: {
						generatedAt: "2026-09-17T00:00:00Z",
						method: "research",
					},
				},
			});
		});
	});

	it("writes through an exclusive sibling temporary file before rename", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const writes: Array<{ path: string; options: unknown }> = [];
			const renames: Array<{ from: string; to: string }> = [];
			writeTaskModelConfig(
				configPath,
				getSubagentsConfigExamplePath(),
				{ coding: ["fake/worker"] },
				{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
				(candidate) => candidate === "fake/worker",
				{
					fileOperations: {
						writeFileSync(path, data, options) {
							writes.push({ path: String(path), options });
							writeFileSync(path, data, options);
						},
						renameSync(from, to) {
							renames.push({ from: String(from), to: String(to) });
							renameSync(from, to);
						},
					},
				},
			);
			assert.equal(writes.length, 1);
			assert.equal(dirname(writes[0].path), dirname(configPath));
			assert.match(writes[0].path, /-config\.tmp$/);
			assert.deepEqual(writes[0].options, { flag: "wx" });
			assert.deepEqual(renames, [{ from: writes[0].path, to: configPath }]);
			assert.equal(existsSync(writes[0].path), false);
		});
	});

	it("rejects invalid model configuration", () => {
		assert.throws(
			() => parseModelConfig({ models: { default: "" } }),
			/non-empty string/,
		);
		assert.throws(
			() => parseModelConfig({ models: { agents: [] } }),
			/must be an object/,
		);
		assert.throws(
			() => parseModelConfig({ models: { tasks: { debugging: ["fake/x"] } } }),
			/models\.tasks\.debugging.*supported categories: coding, review, recon, qa, architecture, docs/,
		);
		assert.throws(
			() => parseModelConfig({ models: { tasks: { coding: null } } }),
			/models\.tasks\.coding must be a non-empty list/,
		);
		assert.throws(
			() =>
				parseModelConfig({
					models: {
						tasksMeta: {
							generatedAt: "2026-09-17T00:00:00Z",
							method: "guesswork",
						},
					},
				}),
			/models\.tasksMeta\.method must be "research" or "registry-only"/,
		);
		assert.throws(
			() =>
				parseModelConfig({
					models: {
						tasksMeta: {
							generatedAt: "2026-09-17",
							method: "research",
						},
					},
				}),
			/models\.tasksMeta\.generatedAt must be an ISO-8601 string/,
		);
		assert.throws(
			() =>
				parseModelConfig({
					models: {
						tasksMeta: {
							generatedAt: "2026-09-17T00:00:00Z",
							method: "research",
							extra: true,
						},
					},
				}),
			/models\.tasksMeta has unsupported key\(s\): extra/,
		);
	});
});

describe("conditional task model config writes", () => {
	const tasksMeta = {
		generatedAt: "2026-10-05T00:00:00Z",
		method: "registry-only" as const,
	};
	const anyCandidate = () => true;
	const write = (
		configPath: string,
		tasks: Record<string, string[]>,
		options: Parameters<typeof writeTaskModelConfig>[5] = {},
	) =>
		writeTaskModelConfig(
			configPath,
			getSubagentsConfigExamplePath(),
			tasks,
			tasksMeta,
			anyCandidate,
			options,
		);
	const sha256 = (bytes: string | Buffer) =>
		`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const assertWriteError = (run: () => void, code: string, pattern?: RegExp) =>
		assert.throws(run, (error: Error) => {
			assert.ok(error instanceof TaskModelConfigWriteError);
			assert.equal(error.code, code);
			if (pattern) assert.match(error.message, pattern);
			return true;
		});
	const siblings = (configPath: string) =>
		readdirSync(dirname(configPath)).sort();

	it("computes revisions over exact bytes, including whitespace, unrelated fields, and tasks", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			assert.equal(readConfigRevision(configPath), "missing");
			const base = { keep: 1, models: { tasks: { coding: ["fake/a"] } } };
			const variants = [
				JSON.stringify(base),
				JSON.stringify(base, null, 2),
				JSON.stringify(base) + "\n",
				JSON.stringify({ ...base, keep: 2 }),
				JSON.stringify({ keep: 1, models: { tasks: { coding: ["fake/b"] } } }),
			];
			const revisions = variants.map((bytes) => {
				writeFileSync(configPath, bytes);
				const revision = readConfigRevision(configPath);
				assert.match(revision, /^sha256:[0-9a-f]{64}$/);
				assert.equal(revision, sha256(Buffer.from(bytes, "utf8")));
				assert.equal(revision, computeConfigRevision(readFileSync(configPath)));
				return revision;
			});
			assert.equal(new Set(revisions).size, variants.length);
		});
	});

	it("writes when the exact-byte revision matches and returns the saved file's revision", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(
				configPath,
				'{"keep":{"secret":"unrelated"},  "models":{"default":"fake/default","tasks":{"qa":["fake/qa"]}}}',
			);
			const saved = write(
				configPath,
				{ coding: ["fake/worker"], qa: ["fake/qa"] },
				{ expectedConfigRevision: readConfigRevision(configPath) },
			);
			const bytes = readFileSync(configPath);
			assert.equal(saved.configRevision, sha256(bytes));
			assert.equal(saved.configRevision, readConfigRevision(configPath));
			assert.deepEqual(JSON.parse(bytes.toString("utf8")), {
				keep: { secret: "unrelated" },
				models: {
					default: "fake/default",
					tasks: { coding: ["fake/worker"], qa: ["fake/qa"] },
					tasksMeta,
				},
			});
			assert.deepEqual(siblings(configPath), ["config.json"]);
			// The returned revision is a valid precondition for the next write.
			write(
				configPath,
				{ coding: ["fake/next"] },
				{ expectedConfigRevision: saved.configRevision },
			);
			assert.deepEqual(loadModelConfig(dir).tasks, { coding: ["fake/next"] });
		});
	});

	it("refuses stale revisions after task, unrelated-field, or whitespace-only changes without leaking content", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const original = JSON.stringify({
				keep: "secret-value-1",
				models: { tasks: { coding: ["fake/a"] } },
			});
			for (const changed of [
				JSON.stringify({
					keep: "secret-value-1",
					models: { tasks: { coding: ["fake/a"], qa: ["fake/qa"] } },
				}),
				JSON.stringify({
					keep: "secret-value-2",
					models: { tasks: { coding: ["fake/a"] } },
				}),
				JSON.stringify(JSON.parse(original), null, 2),
				original + "\n",
			]) {
				writeFileSync(configPath, original);
				const proposalRevision = readConfigRevision(configPath);
				writeFileSync(configPath, changed);
				assertWriteError(
					() =>
						write(
							configPath,
							{ coding: ["fake/new"] },
							{ expectedConfigRevision: proposalRevision },
						),
					"stale-revision",
					/bytes changed.*not replaced.*Re-read.*fresh proposal.*fresh approval/,
				);
				assert.throws(
					() =>
						write(
							configPath,
							{ coding: ["fake/new"] },
							{ expectedConfigRevision: proposalRevision },
						),
					(error: Error) => {
						assert.doesNotMatch(
							error.message,
							/secret-value|fake\/qa|fake\/a\b/,
						);
						assert.equal(
							error.message.includes(readConfigRevision(configPath)),
							false,
						);
						return true;
					},
				);
				assert.equal(readFileSync(configPath, "utf8"), changed);
				assert.deepEqual(siblings(configPath), ["config.json"]);
			}
		});
	});

	it("handles created, deleted, and missing config file states", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "nested", "config.json");
			const saved = write(
				configPath,
				{ coding: ["fake/worker"] },
				{ expectedConfigRevision: "missing" },
			);
			// Missing-file writes keep seeding packaged defaults.
			const written = JSON.parse(readFileSync(configPath, "utf8"));
			const example = JSON.parse(
				readFileSync(getSubagentsConfigExamplePath(), "utf8"),
			);
			for (const key of Object.keys(example).filter((key) => key !== "models"))
				assert.deepEqual(written[key], example[key]);
			assert.equal(saved.configRevision, readConfigRevision(configPath));

			const existing = readFileSync(configPath, "utf8");
			assertWriteError(
				() =>
					write(
						configPath,
						{ coding: ["fake/other"] },
						{ expectedConfigRevision: "missing" },
					),
				"stale-revision",
				/expected no config file, but one now exists/,
			);
			assert.equal(readFileSync(configPath, "utf8"), existing);

			rmSync(configPath);
			assertWriteError(
				() =>
					write(
						configPath,
						{ coding: ["fake/other"] },
						{ expectedConfigRevision: saved.configRevision },
					),
				"stale-revision",
				/expected an existing config file, but it is now missing/,
			);
			assert.equal(existsSync(configPath), false);
			assert.deepEqual(readdirSync(dirname(configPath)), []);
		});
	});

	it("rejects invalid revision strings before reading or replacing configuration", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, "{}");
			const valid = readConfigRevision(configPath);
			for (const invalid of [
				"",
				null,
				42,
				"MISSING",
				" missing",
				valid.toUpperCase(),
				valid.replace("sha256:", "SHA256:"),
				valid.slice(0, -1),
				`${valid}0`,
				`${valid} `,
				valid.replace("sha256:", "sha1:"),
				valid.slice("sha256:".length),
			]) {
				assertWriteError(
					() =>
						write(
							configPath,
							{ coding: ["fake/worker"] },
							// SAFETY: deliberately bypasses static typing to test the runtime boundary.
							{ expectedConfigRevision: invalid as string },
						),
					"invalid-revision",
					/Invalid expectedConfigRevision/,
				);
				assert.equal(readFileSync(configPath, "utf8"), "{}");
				assert.deepEqual(siblings(configPath), ["config.json"]);
			}
		});
	});

	it("compares the revision before reporting malformed configuration and never replaces it", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			for (const malformed of ["{not json", "[]", "null"]) {
				writeFileSync(configPath, malformed);
				assert.throws(
					() =>
						write(
							configPath,
							{ coding: ["fake/worker"] },
							{ expectedConfigRevision: readConfigRevision(configPath) },
						),
					/Invalid JSON in subagent config/,
				);
				assertWriteError(
					() =>
						write(
							configPath,
							{ coding: ["fake/worker"] },
							{ expectedConfigRevision: sha256("other") },
						),
					"stale-revision",
				);
				assert.throws(
					() => write(configPath, { coding: ["fake/worker"] }),
					/Invalid JSON in subagent config/,
				);
				assert.equal(readFileSync(configPath, "utf8"), malformed);
				assert.deepEqual(siblings(configPath), ["config.json"]);
			}
		});
	});

	it("keeps omitted revisions unconditional while preserving unrelated fields", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					keep: 1,
					models: {
						agents: { scout: "fake/scout" },
						tasks: { qa: ["fake/qa"] },
					},
				}),
			);
			const saved = write(configPath, { coding: ["fake/worker"] });
			assert.equal(saved.configRevision, readConfigRevision(configPath));
			// Unconditional writes still replace the full task map, as before.
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
				keep: 1,
				models: {
					agents: { scout: "fake/scout" },
					tasks: { coding: ["fake/worker"] },
					tasksMeta,
				},
			});
		});
	});

	it("removes only its own temporary file and lock when publication fails", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, '{"keep":true}');
			const foreign = join(dir, ".foreign-config.tmp");
			writeFileSync(foreign, "not ours");
			for (const fileOperations of [
				{
					writeFileSync() {
						throw new Error("injected write failure");
					},
					renameSync,
				},
				{
					writeFileSync(path: any, data: any, options: any) {
						writeFileSync(path, data, options);
						throw new Error("injected write failure");
					},
					renameSync,
				},
				{
					writeFileSync,
					renameSync() {
						throw new Error("injected write failure");
					},
				},
			]) {
				assert.throws(
					() =>
						write(
							configPath,
							{ coding: ["fake/worker"] },
							{
								expectedConfigRevision: readConfigRevision(configPath),
								// SAFETY: test doubles implement only the injected call shape.
								fileOperations: fileOperations as any,
							},
						),
					/injected write failure/,
				);
				assert.equal(readFileSync(configPath, "utf8"), '{"keep":true}');
				assert.deepEqual(siblings(configPath), [
					".foreign-config.tmp",
					"config.json",
				]);
			}
			write(configPath, { coding: ["fake/worker"] });
			assert.deepEqual(siblings(configPath), [
				".foreign-config.tmp",
				"config.json",
			]);
		});
	});

	it("fails closed on held or stale locks and never removes another owner's lock", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, '{"keep":true}');
			const lockPath = getConfigWriteLockPath(configPath);
			const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
			for (const [contents, pattern] of [
				[
					JSON.stringify({
						pid: deadPid,
						hostname: hostname(),
						token: "other",
						createdAt: "2026-01-01T00:00:00.000Z",
					}),
					new RegExp(`pid ${deadPid}.*no longer running.*appears stale`),
				],
				[
					JSON.stringify({
						pid: process.pid,
						hostname: hostname(),
						token: "other",
					}),
					new RegExp(`pid ${process.pid}`),
				],
				["", /unidentified owner/],
				["{corrupt", /unidentified owner/],
			] as const) {
				writeFileSync(lockPath, contents);
				for (const expectedConfigRevision of [
					undefined,
					readConfigRevision(configPath),
				]) {
					assertWriteError(
						() =>
							write(
								configPath,
								{ coding: ["fake/worker"] },
								{ expectedConfigRevision },
							),
						"busy",
						pattern,
					);
					assertWriteError(
						() => write(configPath, { coding: ["fake/worker"] }),
						"busy",
						/never broken automatically/,
					);
				}
				assert.equal(readFileSync(lockPath, "utf8"), contents);
				assert.equal(readFileSync(configPath, "utf8"), '{"keep":true}');
				assert.deepEqual(siblings(configPath), [
					"config.json",
					"config.json.lock",
				]);
			}
			rmSync(lockPath);
			write(configPath, { coding: ["fake/worker"] });
			assert.deepEqual(siblings(configPath), ["config.json"]);
		});
	});

	it("serializes cooperating writers across processes and rejects the loser's stale revision", async () => {
		const dir = createTestDir();
		try {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, '{"keep":true}');
			const proposalRevision = readConfigRevision(configPath);
			const readyPath = join(dir, "ready");
			const releasePath = join(dir, "release");
			const moduleUrl = new URL(
				"../maestro/core/config/model-config.ts",
				import.meta.url,
			).href;
			const script = `
				import { existsSync, renameSync, writeFileSync } from "node:fs";
				import { writeTaskModelConfig } from ${JSON.stringify(moduleUrl)};
				const env = process.env;
				const sleeper = new Int32Array(new SharedArrayBuffer(4));
				const saved = writeTaskModelConfig(
					env.W2_CONFIG,
					env.W2_EXAMPLE,
					{ coding: ["fake/child"] },
					${JSON.stringify(tasksMeta)},
					() => true,
					{
						expectedConfigRevision: env.W2_REVISION,
						fileOperations: {
							renameSync,
							writeFileSync(path, data, options) {
								writeFileSync(env.W2_READY, "");
								const deadline = Date.now() + 20000;
								while (!existsSync(env.W2_RELEASE)) {
									if (Date.now() > deadline) throw new Error("release timeout");
									Atomics.wait(sleeper, 0, 0, 10);
								}
								writeFileSync(path, data, options);
							},
						},
					},
				);
				process.stdout.write(JSON.stringify(saved));
			`;
			const child = childProcess.spawn(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "-e", script],
				{
					env: {
						...process.env,
						W2_CONFIG: configPath,
						W2_EXAMPLE: getSubagentsConfigExamplePath(),
						W2_REVISION: proposalRevision,
						W2_READY: readyPath,
						W2_RELEASE: releasePath,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			const exited = new Promise<number | null>((resolve) =>
				child.on("close", resolve),
			);
			const readyDeadline = Date.now() + 20_000;
			while (!existsSync(readyPath)) {
				assert.ok(Date.now() < readyDeadline, `child never locked: ${stderr}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			// The child holds the lock mid-publication: both kinds of parent write fail fast.
			for (const options of [{}, { expectedConfigRevision: proposalRevision }])
				assertWriteError(
					() => write(configPath, { qa: ["fake/parent"] }, options),
					"busy",
					new RegExp(`pid ${child.pid}`),
				);
			assert.equal(readFileSync(configPath, "utf8"), '{"keep":true}');
			writeFileSync(releasePath, "");
			assert.equal(await exited, 0, stderr);
			const saved = JSON.parse(stdout);
			assert.equal(saved.configRevision, readConfigRevision(configPath));
			assert.deepEqual(loadModelConfig(dir).tasks, { coding: ["fake/child"] });
			// The parent's proposal was read before the child's write; retrying it is stale.
			assertWriteError(
				() =>
					write(
						configPath,
						{ qa: ["fake/parent"] },
						{ expectedConfigRevision: proposalRevision },
					),
				"stale-revision",
			);
			assert.deepEqual(loadModelConfig(dir).tasks, { coding: ["fake/child"] });
			assert.deepEqual(readdirSync(dir).sort(), [
				"config.json",
				"ready",
				"release",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("persistent specialist configuration", () => {
	it("defaults absent configuration to three specialists and rejects unknown keys", () => {
		assert.deepEqual(parsePersistentConfig({}), { maxAgents: 3 });
		assert.throws(
			() =>
				parsePersistentConfig({ persistent: { maxAgents: 3, extra: true } }),
			/persistent has unsupported key\(s\): extra/,
		);
		assert.throws(
			() => parsePersistentConfig({ persistent: { maxAgents: 0 } }),
			/persistent\.maxAgents must be a positive integer/,
		);
	});

	it("loads the shared example when local configuration is absent", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				examplePath,
				JSON.stringify({ persistent: { maxAgents: 2 } }),
			);
			assert.deepEqual(loadPersistentConfig(dir, examplePath), {
				maxAgents: 2,
			});
		});
	});
});

describe("supervision", () => {
	it("parses hang warning configuration strictly and loads the shared example", () => {
		assert.deepEqual(parseSupervisionConfig({}), {
			forcePolling: false,
			hangWarningMinutes: 15,
		});
		assert.deepEqual(
			parseSupervisionConfig({
				supervision: { forcePolling: true, hangWarningMinutes: 20 },
			}),
			{ forcePolling: true, hangWarningMinutes: 20 },
		);
		assert.deepEqual(
			parseSupervisionConfig({ supervision: { hangWarningMinutes: 0 } }),
			{ forcePolling: false, hangWarningMinutes: 0 },
		);
		for (const value of [-1, 1.5, "15"]) {
			assert.throws(
				() =>
					parseSupervisionConfig({
						supervision: { hangWarningMinutes: value },
					}),
				/supervision\.hangWarningMinutes must be a non-negative integer/,
			);
		}
		assert.throws(
			() => parseSupervisionConfig({ supervision: { extra: true } }),
			/supervision has unsupported key\(s\): extra/,
		);
		withTempDir((dir) => {
			const example = join(dir, "config.json.example");
			writeFileSync(
				example,
				JSON.stringify({ supervision: { hangWarningMinutes: 20 } }),
			);
			assert.deepEqual(loadSupervisionConfig(dir, example), {
				forcePolling: false,
				hangWarningMinutes: 20,
			});
		});
	});

	it("wakes every directory entry when fs.watch omits a filename", () => {
		let listener:
			| ((event: string, filename: string | Buffer | null) => void)
			| undefined;
		const watcher = {
			on() {
				return this;
			},
			close() {},
			unref() {
				return this;
			},
		};
		// SAFETY: The fake implements the fs.watch behavior used by FileWakeRegistry.
		const registry = new FileWakeRegistry(((
			_directory: string,
			callback: (event: string, filename: string | Buffer | null) => void,
		) => {
			listener = callback;
			return watcher;
		}) as any);
		let wakes = 0;
		const registration = registry.register(
			"/tmp/child.jsonl",
			() => {
				wakes += 1;
			},
			() => assert.fail("watcher unexpectedly fell back"),
		);
		listener?.("change", null);
		assert.equal(wakes, 1);
		registration.unregister();
		registry.close();
	});

	it("wakes on sidecar rename and releases registrations", async () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		let wakes = 0;
		const registry = new FileWakeRegistry();
		const registration = registry.register(
			sessionFile,
			() => {
				wakes += 1;
			},
			() => assert.fail("watcher unexpectedly fell back"),
		);
		try {
			const temporary = `${sessionFile}.exit.tmp`;
			writeFileSync(temporary, "{}");
			renameSync(temporary, `${sessionFile}.exit`);
			const deadline = Date.now() + 500;
			while (wakes === 0 && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(wakes, 1);
			registration.unregister();
			assert.equal(registry.watcherCount, 0);
		} finally {
			registry.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not apply an in-flight snapshot to a child registered after it began", async () => {
		let resolveList:
			| ((snapshot: {
					complete: boolean;
					panes: Array<{
						paneId: string;
						workspaceId: string;
					}>;
			  }) => void)
			| undefined;
		let fallbackInspections = 0;
		const supervisor = new SupervisionCoordinator(
			() =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
			async () => {
				fallbackInspections += 1;
				return { kind: "present", agentStatus: "idle", observedAt: Date.now() };
			},
		);
		const dir = createTestDir();
		try {
			const one = supervisor.register(join(dir, "one.jsonl"), "one");
			const two = supervisor.register(join(dir, "two.jsonl"), "two");
			resolveList?.({
				complete: true,
				panes: [{ paneId: "one", workspaceId: "workspace" }],
			});
			await Promise.all([
				one.wait(new AbortController().signal),
				two.wait(new AbortController().signal),
			]);
			assert.equal((await two.inspectPane()).kind, "present");
			assert.equal(fallbackInspections, 1);
			one.unregister();
			two.unregister();
		} finally {
			supervisor.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("confirms empty complete-list absence with a pane inspection", async () => {
		let fallbackInspections = 0;
		const supervisor = new SupervisionCoordinator(
			async () => ({ complete: true, panes: [] }),
			async () => {
				fallbackInspections += 1;
				return { kind: "present", agentStatus: "idle", observedAt: Date.now() };
			},
		);
		const dir = createTestDir();
		try {
			const registration = supervisor.register(
				join(dir, "child.jsonl"),
				"child",
			);
			await registration.wait(new AbortController().signal);
			assert.equal((await registration.inspectPane()).kind, "present");
			assert.equal(fallbackInspections, 1);
			registration.unregister();
		} finally {
			supervisor.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps watcherless entries on the legacy polling cadence", async () => {
		let fallbackInspections = 0;
		// SAFETY: This fake fs.watch always throws to model an unavailable watcher.
		const registry = new FileWakeRegistry((() => {
			throw new Error("watch unavailable");
		}) as any);
		const supervisor = new SupervisionCoordinator(
			async () => ({
				complete: true,
				panes: [{ paneId: "child", workspaceId: "workspace" }],
			}),
			async () => {
				fallbackInspections += 1;
				return { kind: "present", agentStatus: "idle", observedAt: Date.now() };
			},
			false,
			registry,
		);
		const dir = createTestDir();
		try {
			const registration = supervisor.register(
				join(dir, "child.jsonl"),
				"child",
			);
			await registration.wait(new AbortController().signal);
			assert.equal(supervisor.diagnostics().mode, "polling(fallback)");
			assert.equal((await registration.inspectPane()).kind, "present");
			await new Promise((resolve) => setImmediate(resolve));
			await registration.wait(new AbortController().signal);
			assert.equal((await registration.inspectPane()).kind, "present");
			const startedAt = Date.now();
			await registration.wait(new AbortController().signal);
			assert.ok(Date.now() - startedAt >= POLLING_INTERVAL_MS - 100);
			assert.equal((await registration.inspectPane()).kind, "present");
			assert.equal(fallbackInspections, 3);
			registration.unregister();
		} finally {
			supervisor.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears the unhealthy batch retry when closed", async () => {
		const timeouts: Array<() => void> = [];
		const cleared: Array<() => void> = [];
		const timers = {
			setTimeout(callback: () => void) {
				timeouts.push(callback);
				// SAFETY: clearTimeout receives this opaque token only in this test.
				return callback as any;
			},
			clearTimeout(timer: () => void) {
				cleared.push(timer);
			},
		};
		const supervisor = new SupervisionCoordinator(
			async () => {
				throw new Error("pane list unavailable");
			},
			async () => ({ kind: "unavailable" }),
			false,
			new FileWakeRegistry(),
			timers,
		);
		const registration = supervisor.register("/tmp/child.jsonl", "child");
		await new Promise((resolve) => setImmediate(resolve));
		supervisor.close();
		assert.equal(timeouts.length, 1);
		assert.deepEqual(cleared, timeouts);
		registration.unregister();
	});

	it("refuses malformed-list absence", async () => {
		for (const snapshot of [
			{ complete: false, panes: [] },
			{ complete: false, panes: [{ paneId: "one", workspaceId: "workspace" }] },
		]) {
			let fallbackInspections = 0;
			const supervisor = new SupervisionCoordinator(
				async () => snapshot,
				async () => {
					fallbackInspections += 1;
					return {
						kind: "present",
						agentStatus: "idle",
						observedAt: Date.now(),
					};
				},
			);
			const dir = createTestDir();
			try {
				const registration = supervisor.register(join(dir, "one.jsonl"), "one");
				await registration.wait(new AbortController().signal);
				assert.equal((await registration.inspectPane()).kind, "present");
				assert.equal(fallbackInspections, 1);
				registration.unregister();
			} finally {
				supervisor.close();
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("keeps a queued reconciliation when a wake arrives before the next wait", async () => {
		let listener:
			| ((event: string, filename: string | Buffer | null) => void)
			| undefined;
		const watcher = {
			on() {
				return this;
			},
			close() {},
			unref() {
				return this;
			},
		};
		// SAFETY: The fake implements the fs.watch behavior used by FileWakeRegistry.
		const registry = new FileWakeRegistry(((
			_directory: string,
			callback: (event: string, filename: string | Buffer | null) => void,
		) => {
			listener = callback;
			return watcher;
		}) as any);
		const supervisor = new SupervisionCoordinator(
			async () => ({
				complete: true,
				panes: [{ paneId: "one", workspaceId: "workspace" }],
			}),
			async () => ({
				kind: "present",
				agentStatus: "idle",
				observedAt: Date.now(),
			}),
			false,
			registry,
		);
		try {
			const registration = supervisor.register("/tmp/child.jsonl", "one");
			// Let the registration-triggered reconciliation settle and queue its
			// pending "reconcile" reason before any waiter exists.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
			listener?.("rename", null);
			assert.equal(
				await registration.wait(new AbortController().signal),
				"reconcile",
			);
			registration.unregister();
		} finally {
			supervisor.close();
		}
	});
});

describe("role configuration", () => {
	it("has no deprecations when the legacy key is omitted", () => {
		assert.deepEqual(parseRoleConfig({}), { deprecations: [] });
		assert.deepEqual(parseRoleConfig({ roles: {} }), { deprecations: [] });
	});

	it("accepts both legacy bundled booleans as deprecated no-ops", () => {
		for (const bundled of [true, false]) {
			const { deprecations } = parseRoleConfig(
				{ roles: { bundled } },
				"/agent/herdr-agents/config.json",
			);
			assert.equal(deprecations.length, 1);
			assert.match(
				deprecations[0],
				new RegExp(`roles\\.bundled \\(${bundled}\\).*is ignored`),
			);
			assert.match(deprecations[0], /\/agent\/herdr-agents\/config\.json/);
			assert.match(deprecations[0], /Install a role pack/);
			assert.match(deprecations[0], /The file was not changed/);
		}
	});

	it("rejects explicit null and non-object role settings", () => {
		for (const roles of [null, [], "roles"]) {
			assert.throws(
				() => parseRoleConfig({ roles }),
				/roles must be an object/,
			);
		}
		for (const bundled of [null, "false", [], 0]) {
			assert.throws(
				() => parseRoleConfig({ roles: { bundled } }),
				/roles\.bundled must be a boolean/,
			);
		}
		assert.throws(
			() => parseRoleConfig({ roles: { bundled: true, packs: [] } }),
			/roles has unsupported key\(s\): packs/,
		);
	});

	it("loads the shared example when local config is absent", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(examplePath, JSON.stringify({ roles: { bundled: false } }));

			const { deprecations } = loadRoleConfig(dir, examplePath);
			assert.equal(deprecations.length, 1);
			assert.ok(deprecations[0].includes(examplePath));
		});
	});

	it("ships an example configuration without the legacy key", () => {
		const example = JSON.parse(
			readFileSync(getSubagentsConfigExamplePath(), "utf8"),
		);
		assert.equal(Object.hasOwn(example, "roles"), false);
	});

	it("rejects malformed bundled-role settings without falling back", () => {
		assert.throws(
			() => parseRoleConfig({ roles: { bundled: "false" } }),
			/roles\.bundled must be a boolean/,
		);
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const examplePath = join(dir, "config.json.example");
			const raw = JSON.stringify({ roles: { bundled: "false" } });
			writeFileSync(configPath, raw);
			writeFileSync(examplePath, JSON.stringify({ roles: { bundled: false } }));

			assert.throws(
				() => loadRoleConfig(dirname(configPath), examplePath),
				/roles\.bundled must be a boolean/,
			);
			assert.equal(readFileSync(configPath, "utf8"), raw);
		});
	});
});

describe("subagent discovery", () => {
	const testApi = subagentsModule.__test__;

	it("ships an empty role catalog and keeps project > global > role-pack precedence", async () => {
		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const emptyCatalog = testApi.discoverAgentCatalog();
				assert.deepEqual(emptyCatalog, { agents: [], diagnostics: [] });
				for (const name of [
					"scout",
					"planner",
					"worker",
					"reviewer",
					"adversarial-reviewer",
					"visual-tester",
					"poteto",
				])
					assert.equal(
						testApi.loadAgentDefaults(name),
						null,
						`the host must not ship ${name}`,
					);

				const rolesDir = join(projectDir, "scout-pack", "roles");
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolesDir, "..", "package.json"),
					JSON.stringify({ name: "@acme/scout-pack", version: "1.0.0" }),
				);
				writeAgentFile(rolesDir, "scout", "description: Role-pack scout");

				const { api } = createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) =>
						request.register(rolesDir),
				);
				const catalog = testApi.discoverAgentCatalog(api);
				assert.deepEqual(catalog.diagnostics, []);
				assert.deepEqual(
					catalog.agents.map((agent) => [
						agent.name,
						agent.source,
						agent.provider,
					]),
					[["scout", "package", "@acme/scout-pack"]],
				);

				writeAgentFile(
					globalAgentsDir,
					"scout",
					"description: Global scout override",
				);
				assert.equal(
					testApi.loadAgentDefaults("scout", api)?.source,
					"global",
					"a global definition overrides a role-pack definition",
				);
				writeAgentFile(
					projectAgentsDir,
					"scout",
					"description: Project scout override",
				);
				assert.equal(
					testApi.loadAgentDefaults("scout", api)?.source,
					"project",
					"a project definition retains precedence over a global definition",
				);
			},
		);
	});

	it("loads session-mode from frontmatter", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"lineage-mode-test-agent",
				[
					"name: lineage-mode-test-agent",
					"model: anthropic/test-lineage",
					"session-mode: lineage-only",
				].join("\n"),
			);

			const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
			assert.ok(loaded, "expected agent to load");
			assert.equal(loaded.sessionMode, "lineage-only");
		});
	});

	it("accepts only supported thinking levels from frontmatter", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"thinking-test-agent",
				["name: thinking-test-agent", "thinking: high"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"invalid-thinking-test-agent",
				["name: invalid-thinking-test-agent", "thinking: extreme"].join("\n"),
			);

			assert.equal(
				testApi.loadAgentDefaults("thinking-test-agent")?.thinking,
				"high",
			);
			assert.equal(
				testApi.loadAgentDefaults("invalid-thinking-test-agent")?.thinking,
				undefined,
			);
		});
	});

	it("loads explicit interactive flag from frontmatter", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"interactive-true-test-agent",
				[
					"name: interactive-true-test-agent",
					"model: anthropic/test-interactive-true",
					"interactive: true",
				].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"interactive-false-test-agent",
				[
					"name: interactive-false-test-agent",
					"model: anthropic/test-interactive-false",
					"interactive: false",
				].join("\n"),
			);

			const loadedTrue = testApi.loadAgentDefaults(
				"interactive-true-test-agent",
			);
			assert.equal(loadedTrue?.interactive, true);

			const loadedFalse = testApi.loadAgentDefaults(
				"interactive-false-test-agent",
			);
			assert.equal(loadedFalse?.interactive, false);
		});
	});

	it("leaves interactive undefined when not set in frontmatter", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"interactive-unset-test-agent",
				[
					"name: interactive-unset-test-agent",
					"model: anthropic/test-interactive-unset",
				].join("\n"),
			);

			const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
			assert.equal(loaded?.interactive, undefined);
		});
	});

	it("resolves auto-exit and interactive behavior for named and bare spawns", () => {
		// Autonomous named agents are not interactive, so the parent gets status pings.
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "A", task: "T" },
				{ autoExit: true },
			),
			true,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T" },
				{ autoExit: true },
			),
			false,
		);

		// Named agents without auto-exit preserve their interactive behavior.
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "A", task: "T" },
				{ autoExit: false },
			),
			false,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T" },
				{ autoExit: false },
			),
			true,
		);

		// Bare task spawns are autonomous by default. Otherwise a normal final
		// answer leaves the child open and no completion is delivered to the parent.
		assert.equal(
			testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, null),
			true,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
			false,
		);

		// A bare full-context fork invoked directly through the tool is still an
		// autonomous task. Forking only controls inherited conversation context.
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "A", task: "T", fork: true },
				null,
			),
			true,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T", fork: true },
				null,
			),
			false,
		);

		// Interactive bare forks opt out explicitly.
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "A", task: "T", fork: true, interactive: true },
				null,
			),
			false,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T", fork: true, interactive: true },
				null,
			),
			true,
		);
	});

	it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
		// Autonomous agent that still wants to be treated as interactive.
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T" },
				{ autoExit: true, interactive: true },
			),
			true,
		);
		// Non-auto-exit agent that opts back into stall pings.
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T" },
				{ interactive: false },
			),
			false,
		);
	});

	it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T", interactive: false },
				{ autoExit: false, interactive: true },
			),
			false,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T", interactive: true },
				{ autoExit: true, interactive: false },
			),
			true,
		);
	});

	it("lets model-neutral fixture roles inherit the parent runtime and keep interaction modes", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"fixture-leaf",
				["description: Autonomous fixture leaf", "auto-exit: true"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"fixture-interactive",
				"description: Interactive fixture role",
			);
			for (const [name, interactive] of [
				["fixture-leaf", false],
				["fixture-interactive", true],
			] as const) {
				const defs = testApi.loadAgentDefaults(name);
				assert.ok(defs, `expected fixture role ${name} to load`);
				assert.equal(defs.model, undefined);
				assert.equal(defs.thinking, undefined);
				assert.equal(
					testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
					interactive,
				);
			}
		});
	});

	it("keeps singular skill frontmatter compatible for existing agent definitions", async () => {
		await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
			writeAgentFile(
				globalAgentsDir,
				"legacy-skill-test-agent",
				["name: legacy-skill-test-agent", "skill: legacy-skill"].join("\n"),
			);

			assert.equal(
				testApi.loadAgentDefaults("legacy-skill-test-agent")?.skills,
				"legacy-skill",
			);
		});
	});

	it("keeps a non-auto-exit fixture coordinator open for completion steers", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"fixture-coordinator",
				[
					"description: Multi-wave fixture coordinator",
					"tools: read, bash, subagent",
					"spawning: true",
					"auto-exit: false",
					"interactive: false",
					"session-mode: fork",
				].join("\n"),
			);
			const coordinator = testApi.loadAgentDefaults("fixture-coordinator");
			assert.ok(coordinator);
			assert.equal(coordinator.spawning, true);
			assert.equal(
				testApi.resolveEffectiveAutoExit(
					{ name: "Coordinator", task: "Review" },
					coordinator,
				),
				false,
				"a multi-wave coordinator must remain open after each child-result steer",
			);
			assert.equal(
				testApi.resolveEffectiveInteractive(
					{ name: "Coordinator", task: "Review" },
					coordinator,
				),
				false,
				"automatic completion steers must wake the coordinator",
			);
			assert.equal(
				testApi.resolveDenyTools(coordinator).has("subagent"),
				false,
			);
			assert.equal(
				testApi.resolveEffectiveSessionMode(
					{ name: "Coordinator", task: "Review", fork: false },
					coordinator,
				),
				"standalone",
				"fork:false overrides a role's non-standalone session mode",
			);
		});
	});

	it("ignores invalid session-mode values", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"invalid-mode-test-agent",
				[
					"name: invalid-mode-test-agent",
					"model: anthropic/test-invalid",
					"session-mode: sideways",
				].join("\n"),
			);

			const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
			assert.ok(loaded, "expected agent to load");
			assert.equal(loaded.sessionMode, undefined);
		});
	});

	it("resolves session mode with fork override precedence", () => {
		assert.equal(
			testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null),
			"standalone",
		);
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "A", task: "T" },
				{ sessionMode: "lineage-only" },
			),
			"lineage-only",
		);
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "A", task: "T", fork: true },
				{ sessionMode: "lineage-only" },
			),
			"fork",
		);
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "A", task: "T", fork: false },
				{ sessionMode: "fork" },
			),
			"standalone",
			"fork: false must force standalone even when role declares fork",
		);
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "A", task: "T" },
				{ sessionMode: "fork" },
			),
			"fork",
			"omitted fork must inherit role session-mode",
		);
	});

	it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
		assert.deepEqual(
			testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null),
			{
				sessionMode: "standalone",
				seededSessionMode: null,
				inheritsConversationContext: false,
				taskDelivery: "artifact",
			},
		);
		assert.deepEqual(
			testApi.resolveLaunchBehavior(
				{ name: "A", task: "T" },
				{ sessionMode: "lineage-only" },
			),
			{
				sessionMode: "lineage-only",
				seededSessionMode: "lineage-only",
				inheritsConversationContext: false,
				taskDelivery: "artifact",
			},
		);
		assert.deepEqual(
			testApi.resolveLaunchBehavior(
				{ name: "A", task: "T" },
				{ sessionMode: "fork" },
			),
			{
				sessionMode: "fork",
				seededSessionMode: "fork",
				inheritsConversationContext: true,
				taskDelivery: "direct",
			},
		);
		assert.deepEqual(
			testApi.resolveLaunchBehavior(
				{ name: "A", task: "T", fork: true },
				{ sessionMode: "lineage-only" },
			),
			{
				sessionMode: "fork",
				seededSessionMode: "fork",
				inheritsConversationContext: true,
				taskDelivery: "direct",
			},
		);
		assert.deepEqual(
			testApi.resolveLaunchBehavior(
				{ name: "A", task: "T", fork: false },
				{ sessionMode: "fork" },
			),
			{
				sessionMode: "standalone",
				seededSessionMode: null,
				inheritsConversationContext: false,
				taskDelivery: "artifact",
			},
			"fork: false must produce standalone behavior despite role fork mode",
		);
	});

	it("buildSubagentToolAllowlist keeps explicit completion for interactive children", () => {
		assert.equal(
			buildSubagentToolAllowlist("read,bash,web_search"),
			"read,bash,web_search,caller_ping,subagent_done",
		);
	});

	it("buildSubagentToolAllowlist omits explicit completion for auto-exit children", () => {
		assert.equal(
			buildSubagentToolAllowlist("read,bash,web_search,subagent_done", true),
			"read,bash,web_search,caller_ping",
		);
	});

	it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
		assert.equal(buildSubagentToolAllowlist(undefined), null);
		assert.equal(buildSubagentToolAllowlist(""), null);
	});

	it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
		assert.deepEqual(
			testApi.buildPiPromptArgs({
				effectiveSkills: "review,lint",
				taskDelivery: "artifact",
				taskArg: "@artifact.md",
			}),
			["", "/skill:review", "/skill:lint", "@artifact.md"],
		);
	});

	it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
		assert.deepEqual(
			testApi.buildPiPromptArgs({
				effectiveSkills: undefined,
				taskDelivery: "artifact",
				taskArg: "@artifact.md",
			}),
			["@artifact.md"],
		);
	});

	it("buildPiPromptArgs omits separator for direct launches with skills", () => {
		assert.deepEqual(
			testApi.buildPiPromptArgs({
				effectiveSkills: "review",
				taskDelivery: "direct",
				taskArg: "do the task",
			}),
			["/skill:review", "do the task"],
		);
	});

	it("discovers and launches a Pi package role pack without repeated role names", async () => {
		await withIsolatedAgentEnv(async ({ projectDir }) => {
			const rolePackDir = join(projectDir, "security-role-pack");
			const rolesDir = join(rolePackDir, "roles");
			mkdirSync(rolesDir, { recursive: true });
			writeFileSync(
				join(rolePackDir, "package.json"),
				JSON.stringify({ name: "@acme/security-roles", version: "1.2.3" }),
			);
			writeAgentFile(
				rolesDir,
				"security-reviewer",
				[
					"description: Reviews changes for concrete security vulnerabilities",
					"tools: read, bash",
					"spawning: false",
					"auto-exit: true",
				].join("\n"),
			);

			const { api, registeredTools, registeredCommands, sentUserMessages } =
				createMockExtensionApi();
			api.events.on(
				"pi-herdr-subagents:roles:discover:v1",
				(request: { register(path: string): void }) =>
					request.register(rolesDir),
			);
			subagentsModule.default(api);

			const listTool = registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);
			assert.ok(listTool, "expected subagents_list to be registered");
			const result = await listTool.execute();
			const role = result.details.agents.find(
				(agent: any) => agent.name === "security-reviewer",
			);
			assert.ok(role, "expected role-pack definition to be listed");
			assert.equal(role.source, "package");
			assert.equal(role.provider, "@acme/security-roles");
			assert.equal(role.providerVersion, "1.2.3");
			assert.match(
				result.content[0].text,
				/security-reviewer \(package:@acme\/security-roles\)/,
			);

			const command = registeredCommands.find(
				(command) => command.name === "subagent",
			);
			assert.ok(command, "expected /subagent to be registered");
			await command.handler("security-reviewer Review this branch", {
				ui: { notify() {} },
			});
			assert.match(sentUserMessages.at(-1) ?? "", /security-reviewer/);
			const loaded = testApi.loadAgentDefaults("security-reviewer", api);
			assert.equal(loaded?.description, role.description);
			assert.equal(loaded?.body, "You are a test agent.");
		});
	});

	it("removes role-pack listeners when their extension instance shuts down", async () => {
		await withIsolatedAgentEnv(async () => {
			const eventBus = createEventBus();
			const plugin = createMockExtensionApi(eventBus);
			rolePackExample(plugin.api);
			const host = createMockExtensionApi(eventBus);
			subagentsModule.default(host.api);
			const listTool = host.registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);

			let result = await listTool.execute();
			assert.equal(
				result.details.agents.some(
					(agent: any) => agent.name === "example-reviewer",
				),
				true,
			);

			const shutdown = plugin.eventHandlers.get("session_shutdown")?.[0];
			assert.ok(shutdown, "expected role-pack cleanup handler");
			await shutdown({ reason: "reload" }, {});
			result = await listTool.execute();
			assert.equal(
				result.details.agents.some(
					(agent: any) => agent.name === "example-reviewer",
				),
				false,
				"stale role-pack listener must not survive reload",
			);

			const replacement = createMockExtensionApi(eventBus);
			rolePackExample(replacement.api);
			result = await listTool.execute();
			assert.equal(
				result.details.agents.some(
					(agent: any) => agent.name === "example-reviewer",
				),
				true,
			);
		});
	});

	it("rejects ambiguous package-layer role names with actionable diagnostics", async () => {
		await withIsolatedAgentEnv(async ({ projectDir }) => {
			const firstRoles = join(projectDir, "first-pack", "roles");
			const secondRoles = join(projectDir, "second-pack", "roles");
			for (const [rolesDir, packageName] of [
				[firstRoles, "@acme/first-roles"],
				[secondRoles, "@acme/second-roles"],
			] as const) {
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolesDir, "..", "package.json"),
					JSON.stringify({ name: packageName, version: "1.0.0" }),
				);
				writeAgentFile(
					rolesDir,
					"duplicate-reviewer",
					"description: Duplicate package role",
				);
			}
			writeAgentFile(
				firstRoles,
				"scout",
				"description: Single-pack scout with no host-owned competitor",
			);

			const { api, registeredTools, registeredCommands } =
				createMockExtensionApi();
			api.events.on(
				"pi-herdr-subagents:roles:discover:v1",
				(request: { register(path: string): void }) => {
					request.register(firstRoles);
					request.register(secondRoles);
				},
			);
			subagentsModule.default(api);

			const listTool = registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);
			const result = await listTool.execute();
			assert.equal(
				result.details.agents.some(
					(agent: any) => agent.name === "duplicate-reviewer",
				),
				false,
			);
			assert.equal(
				result.details.agents.find((agent: any) => agent.name === "scout")
					?.provider,
				"@acme/first-roles",
				"no host-shipped role protects a pack-contributed name",
			);
			assert.deepEqual(
				result.details.diagnostics.map((diagnostic: any) => diagnostic.code),
				["duplicate-package-role"],
			);
			assert.match(result.content[0].text, /multiple role packs/i);
			assert.match(
				result.content[0].text,
				/@acme\/first-roles, @acme\/second-roles/,
			);
			assert.match(
				result.content[0].text,
				/unavailable until only one pack provides it; use a global or project definition/,
			);

			const notifications: string[] = [];
			const command = registeredCommands.find(
				(command) => command.name === "subagent",
			);
			await command.handler("duplicate-reviewer Review this", {
				ui: {
					notify(message: string) {
						notifications.push(message);
					},
				},
			});
			assert.match(notifications.at(-1) ?? "", /multiple role packs/i);
		});
	});

	it("keeps project and global overrides above contributed role packs", async () => {
		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const rolesDir = join(projectDir, "override-pack", "roles");
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolesDir, "..", "package.json"),
					JSON.stringify({ name: "@acme/override-roles" }),
				);
				writeAgentFile(
					rolesDir,
					"override-reviewer",
					["description: Package role", "model: anthropic/package"].join("\n"),
				);
				writeAgentFile(
					globalAgentsDir,
					"override-reviewer",
					["description: Global role", "model: anthropic/global"].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"override-reviewer",
					["description: Project role", "model: anthropic/project"].join("\n"),
				);

				const { api, registeredTools } = createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) =>
						request.register(rolesDir),
				);
				subagentsModule.default(api);

				const listTool = registeredTools.find(
					(tool) => tool.name === "subagents_list",
				);
				const result = await listTool.execute();
				const role = result.details.agents.find(
					(agent: any) => agent.name === "override-reviewer",
				);
				assert.equal(role.source, "project");
				assert.equal(role.model, "anthropic/project");
				assert.equal(role.provider, undefined);
			},
		);
	});

	it("labels visible package, global, and project agents by source", async () => {
		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const rolesDir = join(projectDir, "list-pack", "roles");
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolesDir, "..", "package.json"),
					JSON.stringify({ name: "@acme/list-roles", version: "1.0.0" }),
				);
				writeAgentFile(rolesDir, "scout", "description: Pack scout");
				writeAgentFile(
					globalAgentsDir,
					"global-discovery-test-agent",
					[
						"name: global-discovery-test-agent",
						"description: Global test agent",
					].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"project-discovery-test-agent",
					[
						"name: project-discovery-test-agent",
						"description: Project test agent",
					].join("\n"),
				);

				const { api, registeredTools } = createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) =>
						request.register(rolesDir),
				);
				subagentsModule.default(api);

				const tool = registeredTools.find(
					(tool) => tool.name === "subagents_list",
				);
				assert.ok(tool, "expected subagents_list to be registered");

				const result = await tool.execute();
				const agents = result.details?.agents ?? [];
				const sourceByName = new Map(
					agents.map((agent: any) => [agent.name, agent.source]),
				);

				assert.equal(sourceByName.get("scout"), "package");
				assert.equal(sourceByName.get("global-discovery-test-agent"), "global");
				assert.equal(
					sourceByName.get("project-discovery-test-agent"),
					"project",
				);
				assert.match(
					result.content[0].text,
					/scout \(package:@acme\/list-roles\)/,
				);
				assert.match(
					result.content[0].text,
					/global-discovery-test-agent \(global\)/,
				);
				assert.match(
					result.content[0].text,
					/project-discovery-test-agent \(project\)/,
				);
			},
		);
	});

	it("rejects malformed capability declarations without widening role tools", async () => {
		await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir }) => {
			const rolePackDir = join(projectDir, "invalid-capability-pack");
			const rolesDir = join(rolePackDir, "roles");
			mkdirSync(rolesDir, { recursive: true });
			writeFileSync(
				join(rolePackDir, "package.json"),
				JSON.stringify({ name: "@acme/invalid-capability-pack" }),
			);
			writeAgentFile(
				rolesDir,
				"multiline-tools",
				["description: Invalid multiline tools", "tools:", "  - read"].join(
					"\n",
				),
			);
			writeAgentFile(
				projectAgentsDir,
				"empty-tools",
				["description: Invalid empty tools", "tools:"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"duplicate-tools",
				[
					"description: Invalid duplicate tools",
					"tools: read",
					"tools: grep",
				].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"invalid-deny-tools",
				[
					"description: Invalid multiline deny tools",
					"deny-tools:",
					"  - subagent",
				].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"invalid-spawning",
				["description: Invalid spawning boolean", "spawning: maybe"].join("\n"),
			);
			for (const [name, frontmatter] of [
				[
					"quoted-deny-tools",
					["description: Quoted deny tools", 'deny-tools: "subagent"'].join(
						"\n",
					),
				],
				[
					"comment-deny-tools",
					[
						"description: Commented deny tools",
						"deny-tools: subagent # prevent recursion",
					].join("\n"),
				],
				[
					"quoted-tools",
					["description: Quoted tools", 'tools: "read"'].join("\n"),
				],
				[
					"comment-tools",
					["description: Commented tools", "tools: read # inspection"].join(
						"\n",
					),
				],
				[
					"indented-tools",
					["description: Indented tools", "  tools: read"].join("\n"),
				],
				[
					"spaced-tools",
					["description: Spaced tools", "tools : read"].join("\n"),
				],
				[
					"quoted-key-tools",
					["description: Quoted key tools", '"tools": read'].join("\n"),
				],
			] as const) {
				writeAgentFile(projectAgentsDir, name, frontmatter);
			}
			// An invalid higher-precedence override fails closed instead of
			// falling through to the valid lower-precedence role-pack definition.
			writeAgentFile(rolesDir, "scout", "description: Valid pack scout");
			writeAgentFile(
				projectAgentsDir,
				"scout",
				["description: Invalid project override", "tools: []"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"valid-comma-tools",
				["description: Valid comma tools", "tools: read, grep"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"valid-deny-tools",
				["description: Valid deny tools", "deny-tools: subagent"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"omitted-tools",
				"description: Intentionally unrestricted",
			);

			const { api, registeredTools } = createMockExtensionApi();
			api.events.on(
				"pi-herdr-subagents:roles:discover:v1",
				(request: { register(path: string): void }) =>
					request.register(rolesDir),
			);
			subagentsModule.default(api);

			const listTool = registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);
			assert.ok(listTool, "expected subagents_list to be registered");
			const result = await listTool.execute();
			const names = new Set(
				result.details.agents.map((agent: any) => agent.name),
			);
			for (const name of [
				"multiline-tools",
				"empty-tools",
				"duplicate-tools",
				"invalid-deny-tools",
				"invalid-spawning",
				"quoted-deny-tools",
				"comment-deny-tools",
				"quoted-tools",
				"comment-tools",
				"indented-tools",
				"spaced-tools",
				"quoted-key-tools",
				"scout",
			]) {
				assert.equal(names.has(name), false, `${name} must be rejected`);
			}
			assert.equal(
				result.details.agents.find(
					(agent: any) => agent.name === "valid-comma-tools",
				)?.tools,
				"read, grep",
			);
			assert.equal(
				result.details.agents.find(
					(agent: any) => agent.name === "omitted-tools",
				)?.tools,
				undefined,
			);
			assert.equal(
				testApi
					.resolveDenyTools(testApi.loadAgentDefaults("valid-deny-tools"))
					.has("subagent"),
				true,
				"a valid deny-tools scalar must resolve the actual tool name",
			);
			assert.equal(
				result.details.diagnostics.filter(
					(diagnostic: any) =>
						diagnostic.code === "invalid-capability-declaration",
				).length,
				13,
			);
			assert.match(result.content[0].text, /tools must use a non-empty/i);
			assert.match(result.content[0].text, /spawning must be true or false/i);
			assert.match(
				result.content[0].text,
				/comments and quotes are unsupported/i,
			);
			assert.match(result.content[0].text, /unquoted, unindented key/i);

			const subagentTool = registeredTools.find(
				(tool) => tool.name === "subagent",
			);
			assert.ok(subagentTool, "expected subagent to be registered");
			const previousHerdrEnv = process.env.HERDR_ENV;
			delete process.env.HERDR_ENV;
			try {
				const launch = await subagentTool.execute(
					"call-1",
					{ name: "Malformed", task: "Review this branch", agent: "scout" },
					new AbortController().signal,
					() => {},
					{},
				);
				assert.equal(launch.details.error, "invalid-capability-declaration");
				assert.match(launch.content[0].text, /tools/i);
			} finally {
				restoreEnvVar("HERDR_ENV", previousHerdrEnv);
			}
		});
	});

	it("uses the effective higher-precedence role before launch diagnostics", async () => {
		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const rolePackDir = join(projectDir, "precedence-capability-pack");
				const rolesDir = join(rolePackDir, "roles");
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolePackDir, "package.json"),
					JSON.stringify({ name: "@acme/precedence-capability-pack" }),
				);
				writeAgentFile(
					globalAgentsDir,
					"global-invalid-project-valid",
					["description: Invalid global", "tools: []"].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"global-invalid-project-valid",
					["description: Valid project", "tools: read"].join("\n"),
				);
				writeAgentFile(
					rolesDir,
					"pack-invalid-project-valid",
					["description: Invalid pack", "tools: []"].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"pack-invalid-project-valid",
					["description: Valid project", "tools: read"].join("\n"),
				);
				writeAgentFile(
					globalAgentsDir,
					"invalid-hidden-project-valid",
					["description: Invalid global", "tools: []"].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"invalid-hidden-project-valid",
					[
						"description: Valid hidden project",
						"tools: read",
						"disable-model-invocation: true",
					].join("\n"),
				);

				const { api, registeredTools } = createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) =>
						request.register(rolesDir),
				);
				subagentsModule.default(api);

				const catalog = testApi.discoverAgentCatalog(api);
				assert.equal(
					catalog.diagnostics.filter(
						(diagnostic) =>
							diagnostic.code === "invalid-capability-declaration",
					).length,
					3,
					"invalid lower-precedence roles remain visible as diagnostics",
				);
				for (const name of [
					"global-invalid-project-valid",
					"pack-invalid-project-valid",
					"invalid-hidden-project-valid",
				]) {
					const agent = catalog.agents.find(
						(candidate) => candidate.name === name,
					);
					assert.equal(agent?.source, "project");
					assert.equal(agent?.tools, "read");
				}

				const subagentTool = registeredTools.find(
					(tool) => tool.name === "subagent",
				);
				assert.ok(subagentTool, "expected subagent to be registered");
				const previousHerdrEnv = process.env.HERDR_ENV;
				delete process.env.HERDR_ENV;
				try {
					for (const agent of [
						"global-invalid-project-valid",
						"pack-invalid-project-valid",
						"invalid-hidden-project-valid",
					]) {
						const launch = await subagentTool.execute(
							"call-1",
							{ name: "Valid override", task: "Inspect", agent },
							new AbortController().signal,
							() => {},
							{},
						);
						assert.equal(launch.details.error, "herdr not available");
						assert.doesNotMatch(
							launch.content[0].text,
							/invalid capability declaration/i,
						);
					}
				} finally {
					restoreEnvVar("HERDR_ENV", previousHerdrEnv);
				}
			},
		);
	});

	it("rejects legacy external CLI roles before launch", async () => {
		await withIsolatedAgentEnv(
			async ({ globalAgentsDir, projectAgentsDir }) => {
				writeAgentFile(
					globalAgentsDir,
					"external-cli-reviewer",
					[
						"description: Legacy external CLI review adapter",
						"cli: claude",
						"cli-model: sonnet",
						"disable-model-invocation: true",
					].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"scout",
					["description: Legacy scout override", "cli: claude"].join("\n"),
				);
				const { api, registeredTools } = createMockExtensionApi();
				subagentsModule.default(api);

				const tool = registeredTools.find(
					(tool) => tool.name === "subagents_list",
				);
				assert.ok(tool, "expected subagents_list to be registered");

				const result = await tool.execute();
				assert.equal(
					result.details.agents.some(
						(agent: any) =>
							agent.name === "external-cli-reviewer" || agent.name === "scout",
					),
					false,
				);
				assert.equal(
					result.details.diagnostics.some(
						(diagnostic: any) =>
							diagnostic.agentName === "external-cli-reviewer" &&
							diagnostic.code === "external-cli-unsupported",
					),
					true,
				);
				assert.match(result.content[0].text, /Pi-only/i);
				assert.match(result.content[0].text, /remove.*cli/i);
				assert.equal(testApi.loadAgentDefaults("external-cli-reviewer"), null);

				const subagentTool = registeredTools.find(
					(tool) => tool.name === "subagent",
				);
				assert.ok(subagentTool, "expected subagent to be registered");
				const previousHerdrEnv = process.env.HERDR_ENV;
				delete process.env.HERDR_ENV;
				try {
					const launch = await subagentTool.execute(
						"call-1",
						{
							name: "Legacy",
							task: "Review this branch",
							agent: "external-cli-reviewer",
							worktree: { branch: "must-not-be-created" },
						},
						new AbortController().signal,
						() => {},
						{},
					);
					assert.equal(launch.details.error, "external-cli-unsupported");
					assert.match(launch.content[0].text, /Pi-only/i);
				} finally {
					restoreEnvVar("HERDR_ENV", previousHerdrEnv);
				}
			},
		);
	});

	it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"hidden-discovery-test-agent",
				[
					"name: hidden-discovery-test-agent",
					"description: Hidden test agent",
					"model: anthropic/test-hidden",
					"disable-model-invocation: true",
				].join("\n"),
				"You are the hidden agent.",
			);

			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);

			const tool = registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);
			assert.ok(tool, "expected subagents_list to be registered");

			const result = await tool.execute();
			const agents = result.details?.agents ?? [];

			assert.equal(
				agents.some(
					(agent: any) => agent.name === "hidden-discovery-test-agent",
				),
				false,
			);
			assert.doesNotMatch(
				result.content[0].text,
				/hidden-discovery-test-agent/,
			);

			const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
			assert.ok(loaded, "expected hidden agent to remain directly loadable");
			assert.equal(loaded.model, "anthropic/test-hidden");
			assert.equal(loaded.body, "You are the hidden agent.");
			assert.equal(loaded.disableModelInvocation, true);
		});
	});

	it("lets a hidden project agent shadow a visible global agent", async () => {
		await withIsolatedAgentEnv(
			async ({ projectAgentsDir, globalAgentsDir }) => {
				writeAgentFile(
					globalAgentsDir,
					"shadowed-discovery-test-agent",
					[
						"name: shadowed-discovery-test-agent",
						"description: Global visible agent",
						"model: anthropic/test-global",
					].join("\n"),
					"You are the global visible agent.",
				);
				writeAgentFile(
					projectAgentsDir,
					"shadowed-discovery-test-agent",
					[
						"name: shadowed-discovery-test-agent",
						"description: Project hidden agent",
						"model: anthropic/test-project",
						"disable-model-invocation: true",
					].join("\n"),
					"You are the project hidden agent.",
				);

				const { api, registeredTools } = createMockExtensionApi();
				subagentsModule.default(api);

				const tool = registeredTools.find(
					(tool) => tool.name === "subagents_list",
				);
				assert.ok(tool, "expected subagents_list to be registered");

				const result = await tool.execute();
				const agents = result.details?.agents ?? [];

				assert.equal(
					agents.some(
						(agent: any) => agent.name === "shadowed-discovery-test-agent",
					),
					false,
				);
				assert.doesNotMatch(
					result.content[0].text,
					/shadowed-discovery-test-agent/,
				);

				const loaded = testApi.loadAgentDefaults(
					"shadowed-discovery-test-agent",
				);
				assert.ok(
					loaded,
					"expected project override to remain directly loadable",
				);
				assert.equal(loaded.model, "anthropic/test-project");
				assert.equal(loaded.body, "You are the project hidden agent.");
				assert.equal(loaded.disableModelInvocation, true);
			},
		);
	});
});
describe("subagent-done.ts", () => {
	it("builds a persistent task completion event", () => {
		const event = buildPersistentTaskEvent("task-1", "generation-1");
		assert.equal(event.version, 1);
		assert.equal(event.type, "task-done");
		assert.equal(event.task, "task-1");
		assert.equal(event.generation, "generation-1");
		assert.ok(event.at);
	});

	it("registers no keyboard shortcut and renders no Ctrl+J hint", () => {
		const previousAgent = process.env.PI_SUBAGENT_AGENT;
		const previousDenyTools = process.env.PI_DENY_TOOLS;
		process.env.PI_SUBAGENT_AGENT = "shortcut-test-agent";
		process.env.PI_DENY_TOOLS = "browser_navigate, subagent";
		try {
			const { api, registeredShortcuts, eventHandlers } =
				createMockExtensionApi();
			api.getAllTools = () => [{ name: "read" }, { name: "bash" }];
			subagentDoneExtension(api);
			assert.deepEqual(registeredShortcuts, []);

			const theme = {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			let widgetFactory: Function | undefined;
			const ctx = {
				ui: {
					setWidget(_name: string, factory: Function) {
						widgetFactory = factory;
					},
				},
			};
			for (const handler of eventHandlers.get("session_start") ?? []) {
				handler({}, ctx);
			}
			assert.deepEqual(
				registeredShortcuts,
				[],
				"session start must not register keyboard shortcuts",
			);
			assert.ok(widgetFactory, "tools widget should still be rendered");
			const widget = widgetFactory?.({}, theme);
			const lines: string[] = widget.render(80);
			assert.equal(
				lines.length,
				1,
				`widget must render one compact line: ${JSON.stringify(lines)}`,
			);
			const rendered = lines[0];
			assert.ok(
				rendered.includes("[shortcut-test-agent] — 2 tools · 2 denied"),
				`widget must show tool and denied counts: ${JSON.stringify(rendered)}`,
			);
			assert.equal(
				rendered.includes("Ctrl+J"),
				false,
				`widget must not mention Ctrl+J: ${JSON.stringify(rendered)}`,
			);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AGENT", previousAgent);
			restoreEnvVar("PI_DENY_TOOLS", previousDenyTools);
		}
	});

	it("does not register subagent_done for auto-exit children", () => {
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "caller_ping"),
				true,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_done"),
				false,
			);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
		}
	});

	it("restarts persistent inbox polling after reload when the initial task is already done", async () => {
		const dir = createTestDir();
		const previousPersistent = process.env.PI_SUBAGENT_PERSISTENT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousTask = process.env.PI_SUBAGENT_TASK_ID;
		const previousGeneration = process.env.PI_SUBAGENT_GENERATION_ID;
		const sessionFile = join(dir, "persistent-reload.jsonl");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "initial-task";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "initial-task",
			generation: "generation",
		});
		writePersistentTaskInbox(sessionFile, 1, {
			task: "next-task",
			message: "next",
		});
		let shutdown: Function | undefined;
		try {
			const { api, eventHandlers, sentUserMessages } = createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, ["next"]);
		} finally {
			shutdown?.({ reason: "reload" });
			restoreEnvVar("PI_SUBAGENT_PERSISTENT", previousPersistent);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_TASK_ID", previousTask);
			restoreEnvVar("PI_SUBAGENT_GENERATION_ID", previousGeneration);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps polling paused after reload while a dispatched follow-up remains unsettled", async () => {
		const dir = createTestDir();
		const previousPersistent = process.env.PI_SUBAGENT_PERSISTENT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousTask = process.env.PI_SUBAGENT_TASK_ID;
		const previousGeneration = process.env.PI_SUBAGENT_GENERATION_ID;
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const sessionFile = join(dir, "persistent-follow-up-reload.jsonl");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "initial-task";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		appendPersistentDeliveryLedger(sessionFile, {
			task: "initial-task",
			outcome: "dispatched",
			generation: "generation",
			logicalId: "logical",
			policyHash: "a".repeat(64),
		});
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "initial-task",
			generation: "generation",
		});
		appendPersistentDeliveryLedger(sessionFile, {
			task: "follow-up-task",
			outcome: "dispatched",
			generation: "generation",
			logicalId: "logical",
			policyHash: "a".repeat(64),
		});
		writePersistentTaskInbox(sessionFile, 2, {
			task: "next-task",
			message: "next",
		});
		let shutdown: Function | undefined;
		try {
			const { api, eventHandlers, registeredTools, sentUserMessages } =
				createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, []);

			const done = registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(done);
			await done.execute("call", {}, undefined, undefined, {});
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, ["next"]);
		} finally {
			shutdown?.({ reason: "reload" });
			restoreEnvVar("PI_SUBAGENT_PERSISTENT", previousPersistent);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_TASK_ID", previousTask);
			restoreEnvVar("PI_SUBAGENT_GENERATION_ID", previousGeneration);
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers subagent_done for interactive children", () => {
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_done"),
				true,
			);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
		}
	});

	it("waits for settlement after a transient compaction error", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const agentEnd = eventHandlers.get("agent_end")?.[0];
				const agentSettled = eventHandlers.get("agent_settled")?.[0];
				assert.ok(agentEnd);
				assert.ok(agentSettled);

				let shutdowns = 0;
				let branch: any[] = [];
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: { getBranch: () => branch },
				};
				const transientError = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				};
				agentEnd({ messages: [transientError] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);

				const completed = {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Completed after compaction." }],
				};
				branch = [
					{ type: "message", message: transientError },
					{ type: "compaction", summary: "Compacted" },
					{ type: "message", message: completed },
				];
				agentEnd({ messages: [completed] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);

				agentSettled({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{
						type: "done",
					},
				);
				assert.equal(shutdowns, 1);
				agentSettled({}, ctx);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("uses the settled branch instead of a stale agent_end error", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const cachedError = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				};
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => [
							{ type: "message", message: cachedError },
							{
								type: "message",
								message: { role: "assistant", stopReason: "stop" },
							},
						],
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [cachedError] }, ctx);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{ type: "done" },
				);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("reports a provider error that remains after settlement", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const error = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "provider failed",
				};
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => {
							throw new Error("session branch unavailable");
						},
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [error] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{
						type: "error",
						errorMessage: "provider failed",
						stopReason: "error",
					},
				);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("stays open when the settled assistant turn was aborted", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const aborted = { role: "assistant", stopReason: "aborted" };
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => [{ type: "message", message: aborted }],
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [aborted] }, ctx);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("stays open when Escape aborts a tool and Pi records the abort as an error", () => {
		// Pi 1.1 continues the loop after an aborted tool batch; the next provider
		// request fails its setup on the aborted signal and is recorded as
		// stopReason "error". agent_settled still reports the run as aborted.
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const abortedAsError = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				};
				const messages = [
					{
						role: "toolResult",
						toolName: "bash",
						isError: true,
						content: [{ type: "text", text: "Command aborted" }],
					},
					abortedAsError,
				];
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () =>
							messages.map((message) => ({ type: "message", message })),
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages }, ctx);
				eventHandlers.get("agent_settled")?.[0]({ aborted: true }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);

				// The person takes over and the next run completes normally.
				const completed = { role: "assistant", stopReason: "stop" };
				messages.push(completed);
				eventHandlers.get("agent_end")?.[0]({ messages: [completed] }, ctx);
				eventHandlers.get("agent_settled")?.[0]({ aborted: false }, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{ type: "done" },
				);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("does not settle a persistent task when Pi reports an aborted run", () => {
		const dir = createTestDir();
		const previousPersistent = process.env.PI_SUBAGENT_PERSISTENT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousTask = process.env.PI_SUBAGENT_TASK_ID;
		const previousGeneration = process.env.PI_SUBAGENT_GENERATION_ID;
		const sessionFile = join(dir, "persistent-abort.jsonl");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "task-1";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		let shutdown: Function | undefined;
		try {
			const { api, eventHandlers } = createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			const messages: any[] = [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				},
			];
			const ctx = {
				shutdown: () => {},
				sessionManager: {
					getBranch: () =>
						messages.map((message) => ({ type: "message", message })),
				},
			};

			eventHandlers.get("agent_end")?.[0]({ messages }, ctx);
			eventHandlers.get("agent_settled")?.[0]({ aborted: true }, ctx);
			assert.deepEqual(readPersistentTaskEvents(sessionFile), []);

			messages.push({ role: "assistant", stopReason: "stop" });
			eventHandlers.get("agent_end")?.[0]({ messages }, ctx);
			eventHandlers.get("agent_settled")?.[0]({ aborted: false }, ctx);
			assert.deepEqual(
				readPersistentTaskEvents(sessionFile).map((event) => event.task),
				["task-1"],
			);
		} finally {
			shutdown?.({ reason: "reload" });
			restoreEnvVar("PI_SUBAGENT_PERSISTENT", previousPersistent);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_TASK_ID", previousTask);
			restoreEnvVar("PI_SUBAGENT_GENERATION_ID", previousGeneration);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves caller_ping completion when the agent later settles", async () => {
		const dir = createTestDir();
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousName = process.env.PI_SUBAGENT_NAME;
		const sessionFile = join(dir, "child.jsonl");
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_NAME = "test-child";
		try {
			const { api, eventHandlers, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			let shutdowns = 0;
			const ctx = {
				shutdown: () => shutdowns++,
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							message: { role: "assistant", stopReason: "stop" },
						},
					],
				},
			};
			const callerPing = registeredTools.find(
				(tool) => tool.name === "caller_ping",
			);
			assert.ok(callerPing);

			await callerPing.execute(
				"call",
				{ message: "Need input" },
				null,
				null,
				ctx,
			);
			eventHandlers.get("agent_end")?.[0](
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.deepEqual(
				JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
				{
					type: "ping",
					name: "test-child",
					message: "Need input",
				},
			);
			assert.equal(shutdowns, 1);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_NAME", previousName);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves non-auto-exit coordinators open until subagent_done", async () => {
		const dir = createTestDir();
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const sessionFile = join(dir, "child.jsonl");
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			const { api, eventHandlers, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			let shutdowns = 0;
			const ctx = {
				shutdown: () => shutdowns++,
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							message: { role: "assistant", stopReason: "stop" },
						},
					],
				},
			};

			eventHandlers.get("agent_end")?.[0](
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.equal(existsSync(`${sessionFile}.exit`), false);
			assert.equal(shutdowns, 0);

			const subagentDone = registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(subagentDone);
			await subagentDone.execute("call", {}, null, null, ctx);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.deepEqual(
				JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
				{
					type: "done",
				},
			);
			assert.equal(shutdowns, 1);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("shouldMarkUserTookOver", () => {
		it("ignores the initial injected task before the first agent run", () => {
			assert.equal(shouldMarkUserTookOver(false), false);
		});

		it("treats later input as manual takeover", () => {
			assert.equal(shouldMarkUserTookOver(true), true);
		});
	});

	describe("shouldAutoExitOnAgentEnd", () => {
		it("auto-exits after normal completion when there was no takeover", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
		});

		it("auto-exits after normal completion even when the user sent the prompt", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
		});

		it("stays open after Escape aborts the run", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
		});

		it("stays open when Pi reports an aborted run whatever the stop reason", () => {
			const messages = [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				},
			];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages, true), false);
			assert.equal(shouldAutoExitOnAgentEnd(false, messages, false), true);
		});

		it("still exits when the latest turn ended with stopReason=error", () => {
			// Auto-exit subagents must shut down on retry-exhaustion errors so the
			// parent is woken. The error sidecar (written separately) carries the
			// failure detail; staying open would just strand the worker.
			const messages = [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "529 overloaded",
				},
			];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
		});
	});

	describe("findLatestAssistantError", () => {
		it("returns the error info from a stopReason=error message", () => {
			const messages = [
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "ok" }],
				},
				{ role: "toolResult", content: [] },
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "Anthropic 529 Overloaded",
				},
			];
			assert.deepEqual(findLatestAssistantError(messages), {
				errorMessage: "Anthropic 529 Overloaded",
				stopReason: "error",
			});
		});

		it("returns null when the latest assistant turn completed normally", () => {
			const messages = [
				{ role: "assistant", stopReason: "error", errorMessage: "old failure" },
				{ role: "user", content: [] },
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "done" }],
				},
			];
			assert.equal(findLatestAssistantError(messages), null);
		});

		it("returns null when the latest assistant turn was aborted by the user", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(findLatestAssistantError(messages), null);
		});

		it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
			const messages = [{ role: "assistant", stopReason: "error" }];
			const info = findLatestAssistantError(messages);
			assert.ok(info);
			assert.equal(info!.stopReason, "error");
			assert.match(info!.errorMessage, /stopReason=error/);
		});

		it("returns null when messages is undefined or empty", () => {
			assert.equal(findLatestAssistantError(undefined), null);
			assert.equal(findLatestAssistantError([]), null);
		});
	});

	describe("buildCompletionSidecar", () => {
		it("emits done immediately for a normal auto-exit completion", () => {
			assert.deepEqual(
				buildCompletionSidecar([
					{
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "done" }],
					},
				]),
				{ type: "done" },
			);
		});

		it("preserves provider errors in the immediate completion sidecar", () => {
			assert.deepEqual(
				buildCompletionSidecar([
					{
						role: "assistant",
						stopReason: "error",
						errorMessage: "provider failed",
					},
				]),
				{
					type: "error",
					errorMessage: "provider failed",
					stopReason: "error",
				},
			);
		});
	});
});

describe("lifecycle.ts", () => {
	const activity = (overrides: Partial<SubagentActivityState> = {}) => ({
		version: 1 as const,
		runningChildId: "child",
		createdAt: 1_000,
		updatedAt: 2_000,
		sequence: 1,
		latestEvent: "agent_start" as const,
		phase: "active" as const,
		agentActive: true,
		turnActive: true,
		providerActive: false,
		toolActive: false,
		activeScope: "agent" as const,
		activeSince: 2_000,
		...overrides,
	});

	it("interrupts only the turn and keeps process runtime open", () => {
		const running = observeLifecycleActivity(
			createLifecycle(1_000),
			{ ok: true, activity: activity() },
			2_000,
		);
		const interrupted = markInterruptRequested(running, 3_000);
		const projection = projectLifecycle(interrupted, 8_000);
		assert.equal(interrupted.process.kind, "running");
		assert.equal(interrupted.turn.kind, "interrupted");
		assert.equal(projection.runtimeEndedAt, undefined);
	});

	it("rejects stale activity after interrupt and accepts a newer sequence", () => {
		const running = observeLifecycleActivity(
			createLifecycle(1_000),
			{ ok: true, activity: activity() },
			2_000,
		);
		const interrupted = markInterruptRequested(running, 3_000);
		const stale = observeLifecycleActivity(
			interrupted,
			{ ok: true, activity: activity({ updatedAt: 3_000 }) },
			3_100,
		);
		assert.equal(stale.turn.kind, "interrupted");
		const resumed = observeLifecycleActivity(
			stale,
			{
				ok: true,
				activity: activity({
					updatedAt: 3_000,
					sequence: 2,
					activeSince: 3_000,
				}),
			},
			3_100,
		);
		assert.equal(resumed.turn.kind, "active");
	});

	it("makes finalizing and terminal process states irreversible", () => {
		const running = observeLifecycleActivity(
			createLifecycle(1_000),
			{ ok: true, activity: activity() },
			2_000,
		);
		const finalizing = markCompletionDetected(
			running,
			{ reason: "done", exitCode: 0 },
			4_000,
		);
		const ignored = observeLifecycleActivity(
			finalizing,
			{
				ok: true,
				activity: activity({ updatedAt: 5_000, sequence: 9 }),
			},
			5_000,
		);
		assert.equal(ignored.process.kind, "finalizing");
		assert.deepEqual(projectLifecycle(ignored, 9_000), {
			kind: "finalizing",
			runtimeEndedAt: 4_000,
		});
		const completed = markCompleted(ignored, 6_000);
		assert.equal(
			markFailed(completed, "late failure", 7_000).process.kind,
			"completed",
		);
	});

	it("projects confirmed running without turn detail as running, not starting", () => {
		const started = createLifecycle(1_000);
		const running = {
			...started,
			process: {
				kind: "running" as const,
				startedAt: 1_000,
				confirmedAt: 1_500,
			},
		};
		assert.deepEqual(projectLifecycle(running, 3_000), { kind: "running" });
	});

	it("detects stalled and recovered transitions from lifecycle projections", () => {
		assert.equal(lifecycleTransition("active", "stalled"), "stalled");
		assert.equal(lifecycleTransition("stalled", "waiting"), "recovered");
		assert.equal(lifecycleTransition("stalled", "active"), "recovered");
		assert.equal(lifecycleTransition("stalled", "blocked"), "recovered");
		assert.equal(lifecycleTransition("stalled", "interrupted"), "recovered");
		assert.equal(lifecycleTransition("waiting", "active"), null);
	});

	it("does not interpret initial idle as completion", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "idle" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 3_000).kind, "starting");
		assert.equal(lifecycle.turn.kind, "starting");
	});

	it("treats working then idle as waiting", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 2_500).kind, "active");
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("preserves state entry time across repeated herdr observations", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "working" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).stateDurationSince, 2_000);

		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 5_000, agentStatus: "blocked" },
			5_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 6_000, agentStatus: "blocked" },
			6_000,
		);
		assert.equal(projectLifecycle(lifecycle, 7_000).stateDurationSince, 5_000);

		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 8_000, agentStatus: "idle" },
			8_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 9_000, agentStatus: "done" },
			9_000,
		);
		assert.equal(projectLifecycle(lifecycle, 10_000).stateDurationSince, 8_000);
	});

	it("does not enter finalizing from herdr idle/done", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "done" },
			3_000,
		);
		assert.equal(lifecycle.process.kind, "running");
		assert.notEqual(projectLifecycle(lifecycle, 4_000).kind, "finalizing");
	});

	it("projects blocked when herdr reports blocked", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "blocked" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 3_000).kind, "blocked");
	});

	it("treats missing pane as pane observation but not immediate failure", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "missing", error: "pane_not_found" },
			3_000,
		);
		assert.equal(lifecycle.pane.kind, "missing");
		assert.equal(lifecycle.process.kind, "running");
	});

	it("preserves local interrupt over stale herdr statuses", () => {
		for (const agentStatus of ["working", "blocked", "idle", "done"] as const) {
			let lifecycle = createLifecycle(1_000);
			lifecycle = observePaneInspection(
				lifecycle,
				{ kind: "present", observedAt: 2_000, agentStatus: "working" },
				2_000,
			);
			lifecycle = markInterruptRequested(lifecycle, 3_000);
			lifecycle = observePaneInspection(
				lifecycle,
				{ kind: "present", observedAt: 3_100, agentStatus },
				3_100,
			);
			assert.equal(
				projectLifecycle(lifecycle, 4_000).kind,
				"interrupted",
				agentStatus,
			);
		}
	});

	it("preserves hasWorked across unavailable observations", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "unavailable", error: "socket" },
			2_500,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "unavailable", error: "socket" },
			2_600,
		);
		assert.equal(lifecycle.pane.kind, "read-error");
		assert.equal(
			lifecycle.pane.kind === "read-error"
				? lifecycle.pane.consecutiveFailures
				: 0,
			2,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("does not let missing activity detail stall healthy herdr working", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{ ok: false, reason: "missing" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 120_000).kind, "active");
	});

	it("uses activity as a fallback after a status-unknown pane snapshot", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "unknown" },
			2_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{ ok: true, activity: activity() },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 3_000).kind, "active");
	});

	it("uses activity only as detail and does not override herdr waiting", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{ ok: true, activity: activity({ updatedAt: 3_100, sequence: 2 }) },
			3_100,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("preserves activity detail duration across repeated updates", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					updatedAt: 2_100,
					sequence: 1,
					activeSince: 2_000,
					activeScope: "tool",
					toolName: "bash",
					toolStartedAt: 2_000,
				}),
			},
			2_100,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					updatedAt: 3_000,
					sequence: 2,
					activeSince: 2_000,
					activeScope: "tool",
					toolName: "bash",
					toolStartedAt: 2_000,
				}),
			},
			3_000,
		);
		const projection = projectLifecycle(lifecycle, 4_000);
		assert.equal(projection.kind, "active");
		assert.equal(projection.label, "bash");
		assert.equal(projection.stateDurationSince, 2_000);
	});
});

describe("no-progress advisories", () => {
	function activeRunning(sessionFile: string, interactive = false) {
		return {
			id: "child",
			name: "Worker",
			task: "",
			surface: "pane",
			startTime: 0,
			sessionFile,
			interactive,
			runtimePlan: undefined,
			lifecycle: observePaneInspection(
				createLifecycle(0),
				{ kind: "present", observedAt: 1, agentStatus: "working" },
				1,
			),
		};
	}

	it("warns once per active no-progress episode and rearms after durable progress", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call", name: "bash" }],
						stopReason: "toolUse",
					},
				}) + "\n",
			);
			utimesSync(sessionFile, 0, 0);
			const running = activeRunning(sessionFile);
			const now = 120_000;
			const first = subagentsModule.__test__.evaluateNoProgressAdvisory(
				running,
				projectLifecycle(running.lifecycle, now),
				now,
				1,
			);
			assert.equal(first?.kind, "warning");
			assert.equal(first?.classification, "blocked-tool");
			assert.equal(first?.lastEntryKind, "assistant");
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					running,
					projectLifecycle(running.lifecycle, now + 1_000),
					now + 1_000,
					1,
				),
				undefined,
			);

			const recoveredAt = 5 * 60 * 60_000;
			utimesSync(sessionFile, 0, recoveredAt / 1_000);
			const recovered = subagentsModule.__test__.evaluateNoProgressAdvisory(
				running,
				projectLifecycle(running.lifecycle, recoveredAt),
				recoveredAt,
				1,
			);
			assert.equal(recovered?.kind, "recovered");
			assert.equal(recovered?.idleMs, recoveredAt);
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					running,
					projectLifecycle(running.lifecycle, recoveredAt + 130_000),
					recoveredAt + 130_000,
					1,
				)?.kind,
				"warning",
			);
		});
	});

	it("formats evidence-based recovery guidance for every child policy", () => {
		const event = {
			kind: "warning" as const,
			idleMs: 60_000,
			classification: "generic-no-progress" as const,
			lastEntryKind: "assistant" as const,
			notify: true,
		};
		const running = activeRunning("/tmp/child.jsonl");
		const worktree = {
			path: "/tmp/worktree",
			workspaceId: "workspace",
			paneId: "pane",
			branch: "branch",
			baseRef: "HEAD",
			baseSha: "sha",
			manifestFile: "manifest",
		};
		const cases = [
			{
				name: "ordinary",
				running,
				expected:
					"interrupt, or after manual termination use subagent_resume or a new spawn",
				forbidden: undefined,
			},
			{
				name: "persistent",
				running: { ...running, persistent: true },
				expected:
					"interrupt, or use subagent_stop then replace with a new persistent specialist",
				forbidden: /subagent_resume/,
			},
			{
				name: "worktree",
				running: { ...running, worktree },
				expected:
					"interrupt, or retain the workspace and continue there after confirming the previous process exited",
				forbidden: /subagent_resume|new spawn/,
			},
			{
				name: "persistent worktree",
				running: { ...running, persistent: true, worktree },
				expected:
					"interrupt, or retain the workspace and continue there after confirming the previous process exited",
				forbidden: /subagent_resume|new persistent specialist/,
			},
		];

		for (const testCase of cases) {
			const line = subagentsModule.__test__.formatNoProgressAdvisoryLine(
				testCase.running,
				event,
			);
			assert.ok(line.includes(`Recovery options: ${testCase.expected}`));
			if (testCase.forbidden) assert.doesNotMatch(line, testCase.forbidden);
			assert.doesNotMatch(line, /cannot self-heal/);
		}

		const truncated = subagentsModule.__test__.formatNoProgressAdvisoryLine(
			running,
			{ ...event, classification: "truncated-turn" },
		);
		assert.match(
			truncated,
			/truncated-turn; observed toolUse stop with no tool call; cause unknown/,
		);

		for (const classification of [
			"blocked-tool",
			"truncated-turn",
			"generic-no-progress",
		] as const) {
			assert.doesNotMatch(
				subagentsModule.__test__.formatNoProgressAdvisoryLine(running, {
					...event,
					classification,
				}),
				/cannot self-heal/,
			);
		}
	});

	it("skips idle runs, resets on fresh heartbeats, and suppresses interactive steers", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "{}\n");
			utimesSync(sessionFile, 0, 0);
			const now = 20 * 60_000;
			const waiting = activeRunning(sessionFile);
			waiting.lifecycle = observePaneInspection(
				waiting.lifecycle,
				{ kind: "present", observedAt: 2, agentStatus: "idle" },
				2,
			);
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					waiting,
					projectLifecycle(waiting.lifecycle, now),
					now,
					1,
				),
				undefined,
			);

			const heartbeating = activeRunning(sessionFile);
			utimesSync(sessionFile, 0, (now - 1) / 1_000);
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					heartbeating,
					projectLifecycle(heartbeating.lifecycle, now),
					now,
					1,
				),
				undefined,
			);

			utimesSync(sessionFile, 0, 0);
			const interactive = activeRunning(sessionFile, true);
			const event = subagentsModule.__test__.evaluateNoProgressAdvisory(
				interactive,
				projectLifecycle(interactive.lifecycle, now),
				now,
				1,
			);
			assert.equal(event?.kind, "warning");
			assert.equal(event?.notify, false);
		});
	});
});

describe("completion.ts", () => {
	it("decodes ping payloads", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "ping",
				name: "Worker",
				message: "need help",
			}),
			{
				reason: "ping",
				exitCode: 0,
				ping: { name: "Worker", message: "need help" },
			},
		);
	});

	it("decodes done payloads", () => {
		assert.deepEqual(interpretExitSidecar({ type: "done" }), {
			reason: "done",
			exitCode: 0,
		});
	});

	it("decodes error payloads and propagates the message with a non-zero exit code", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "error",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
				stopReason: "error",
			}),
			{
				reason: "error",
				exitCode: 1,
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			},
		);
	});

	it("falls back to a placeholder when error payload has no errorMessage", () => {
		const result = interpretExitSidecar({ type: "error" });
		assert.equal(result.reason, "error");
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /no errorMessage/);
	});

	it("rejects unknown completion sidecar payloads", () => {
		for (const payload of [{}, null]) {
			const result = interpretExitSidecar(payload);
			assert.equal(result.reason, "error");
			assert.equal(result.exitCode, 1);
			assert.match(
				result.errorMessage ?? "",
				/Invalid subagent completion sidecar/,
			);
		}
	});

	it("consumes a sidecar and removes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-"));
		const sessionFile = join(dir, "session.jsonl");
		const exitFile = `${sessionFile}.exit`;
		writeFileSync(
			exitFile,
			JSON.stringify({ type: "ping", name: "Scout", message: "ready" }),
		);
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
			});
			assert.deepEqual(result, {
				reason: "ping",
				exitCode: 0,
				ping: { name: "Scout", message: "ready" },
			});
			assert.equal(existsSync(exitFile), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the terminal sentinel exit code", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => "output\n__SUBAGENT_DONE_17__\n",
		});
		assert.deepEqual(result, { reason: "sentinel", exitCode: 17 });
	});

	it("prefers an error sidecar published during the terminal read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sentinel-race-"));
		const sessionFile = join(dir, "child.jsonl");
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => {
					await Promise.resolve();
					writeFileSync(
						`${sessionFile}.exit`,
						JSON.stringify({
							type: "error",
							errorMessage: "account/model rejected",
							stopReason: "error",
						}),
					);
					return "output\n__SUBAGENT_DONE_1__\n";
				},
			});
			assert.deepEqual(result, {
				reason: "error",
				exitCode: 1,
				errorMessage: "account/model rejected",
			});
			assert.equal(existsSync(`${sessionFile}.exit`), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers semantic sidecars published during a zero-exit terminal read", async () => {
		for (const [payload, expected] of [
			[
				{ type: "ping", name: "Scout", message: "need input" },
				{
					reason: "ping",
					exitCode: 0,
					ping: { name: "Scout", message: "need input" },
				},
			],
			[
				{ type: "error", errorMessage: "late semantic failure" },
				{
					reason: "error",
					exitCode: 1,
					errorMessage: "late semantic failure",
				},
			],
		] as const) {
			const dir = mkdtempSync(join(tmpdir(), "completion-zero-race-"));
			const sessionFile = join(dir, "child.jsonl");
			try {
				const result = await waitForCompletion(new AbortController().signal, {
					intervalMs: 1,
					sessionFile,
					readTerminalTail: async () => {
						writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
						return "__SUBAGENT_DONE_0__";
					},
				});
				assert.deepEqual(result, expected);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("retries transient terminal read failures and reports ticks", async () => {
		let reads = 0;
		let ticks = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("pane temporarily unavailable");
				return "__SUBAGENT_DONE_0__";
			},
			onTick: () => {
				ticks += 1;
			},
		});
		assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
		assert.equal(reads, 2);
		assert.equal(ticks, 1);
	});

	it("returns a failure when the pane explicitly disappears", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				throw new Error("pane read failed");
			},
			inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
			paneDisappearanceGraceMs: 0,
		});
		assert.deepEqual(result, {
			reason: "error",
			exitCode: 1,
			errorMessage:
				"Subagent pane disappeared before completion evidence was recorded.",
		});
	});

	it("lets a sidecar win the pane-disappearance race", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-race-"));
		const sessionFile = join(dir, "child.jsonl");
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
				inspectPane: async () => {
					writeFileSync(
						`${sessionFile}.exit`,
						JSON.stringify({ type: "done" }),
					);
					return { kind: "missing", error: "pane_not_found" };
				},
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("waits briefly for delayed sidecar publication after pane disappearance", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-delayed-race-"));
		const sessionFile = join(dir, "child.jsonl");
		const timer = setTimeout(() => {
			writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
		}, 30);
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
				inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
				paneDisappearanceGraceMs: 150,
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
		} finally {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps an ambiguous pane read failure retryable while the pane exists", async () => {
		let reads = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("socket unavailable");
				return "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => ({
				kind: "present",
				observedAt: 0,
				agentStatus: "working",
			}),
		});
		assert.equal(result.exitCode, 0);
		assert.equal(reads, 2);
	});

	it("treats presence-check throws as unknown and keeps polling", async () => {
		let reads = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("pane read failed");
				return "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => {
				throw new Error("herdr list failed");
			},
		});
		assert.equal(result.exitCode, 0);
		assert.equal(reads, 2);
	});

	it("inspects herdr status even when terminal reads succeed", async () => {
		let reads = 0;
		const inspections: string[] = [];
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				return reads === 1 ? "shell output" : "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => ({
				kind: "present",
				observedAt: 2_000,
				agentStatus: "blocked",
			}),
			onPaneInspection: (inspection) =>
				inspections.push(
					inspection.kind === "present"
						? inspection.agentStatus
						: inspection.kind,
				),
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(inspections, ["blocked"]);
	});

	it("rejects promptly when aborted", async () => {
		const controller = new AbortController();
		const completion = waitForCompletion(controller.signal, {
			intervalMs: 10_000,
			readTerminalTail: async () => "",
		});
		controller.abort();
		await assert.rejects(
			completion,
			/Aborted while waiting for subagent to finish/,
		);
	});
});

/** An idle command context with the given registry; notifications are recorded. */
function initContext(modelRegistry: any, notifications: string[] = []) {
	return {
		modelRegistry,
		model: { provider: "p", id: "m" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: (message: string) => notifications.push(message) },
	};
}

const INIT_MODEL = { provider: "p", id: "m", reasoning: false };

describe("commands", () => {
	it("/subagent list labels every visible agent source without spawning one", async () => {
		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const rolesDir = join(projectDir, "command-list-pack", "roles");
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolesDir, "..", "package.json"),
					JSON.stringify({ name: "@acme/command-roles", version: "1.0.0" }),
				);
				writeAgentFile(rolesDir, "scout", "description: Pack scout");
				writeAgentFile(
					globalAgentsDir,
					"global-command-list-test-agent",
					[
						"name: global-command-list-test-agent",
						"description: Global command test agent",
					].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"project-command-list-test-agent",
					[
						"name: project-command-list-test-agent",
						"description: Project command test agent",
					].join("\n"),
				);

				const { api, registeredCommands, sentUserMessages } =
					createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) =>
						request.register(rolesDir),
				);
				subagentsModule.default(api);
				const subagent = registeredCommands.find(
					(command) => command.name === "subagent",
				);
				assert.ok(subagent, "expected /subagent to be registered");

				const notifications: Array<{ message: string; level: string }> = [];
				await subagent.handler("list", {
					ui: {
						notify: (message: string, level: string) =>
							notifications.push({ message, level }),
					},
				});

				assert.equal(notifications.length, 1);
				assert.equal(notifications[0].level, "info");
				assert.match(
					notifications[0].message,
					/scout \(package:@acme\/command-roles\)/,
				);
				assert.match(
					notifications[0].message,
					/global-command-list-test-agent \(global\)/,
				);
				assert.match(
					notifications[0].message,
					/project-command-list-test-agent \(project\)/,
				);
				assert.equal(sentUserMessages.length, 0);
			},
		);
	});

	it("registers /worktree with list and explicit remove usage", async () => {
		const { api, registeredCommands } = createMockExtensionApi();
		subagentsModule.default(api);

		const worktree = registeredCommands.find(
			(command) => command.name === "worktree",
		);
		assert.ok(worktree, "expected /worktree to be registered");
		assert.equal(
			registeredCommands.some((command) => command.name === "handoff-worktree"),
			false,
		);

		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			ui: {
				notify: (message: string, level: string) =>
					notifications.push({ message, level }),
			},
		};
		await worktree.handler("", ctx);
		await worktree.handler("list extra", ctx);
		assert.deepEqual(notifications, [
			{
				message:
					"Usage: /worktree <name> [task] | /worktree list | /worktree remove <target> [--preserve]",
				level: "warning",
			},
			{
				message:
					"Usage: /worktree <name> [task] | /worktree list | /worktree remove <target> [--preserve]",
				level: "warning",
			},
		]);
	});

	it("registers /subagents-init with registry research and reload guidance", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		const init = registeredCommands.find(
			(command) => command.name === "subagents-init",
		);
		assert.ok(init, "expected /subagents-init to be registered");
		await init.handler(
			"",
			initContext({ find: () => undefined, getAvailable: () => [INIT_MODEL] }),
		);
		assert.equal(sentUserMessages.length, 1);
		assert.match(sentUserMessages[0], /registry object/);
		assert.match(sentUserMessages[0], /web search/);
		assert.match(sentUserMessages[0], /registry-only/);
		assert.match(
			sentUserMessages[0],
			/call subagents_write_task_models with the reviewed draft/,
		);
		assert.match(
			sentUserMessages[0],
			/expectedConfigRevision equal to configRevision from the brief/,
		);
		assert.match(sentUserMessages[0], /\/reload/);
	});

	it("injects every live available model with sanitized facts, preferences, and category definitions", async () => {
		const dir = createTestDir();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const { api, registeredCommands, sentUserMessages } =
				createMockExtensionApi();
			subagentsModule.default(api);
			// Written after registration: init must read the current saved preferences, not the module snapshot.
			const configPath = getSubagentsConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					privateSetting: "secret-unrelated-config",
					models: {
						default: "plain/old",
						agents: { worker: "plain/old" },
						tasks: { coding: ["plain/old"] },
						tasksMeta: {
							generatedAt: "2026-09-17T00:00:00Z",
							method: "registry-only",
						},
					},
				}),
			);
			const before = readFileSync(configPath, "utf8");
			const models = Array.from({ length: 30 }, (_, i) => ({
				provider: i === 29 ? "extension-bridge" : "plain",
				id: `model-${String(i).padStart(2, "0")}`,
				name: "Upstream model display name",
				api: "openai-completions",
				baseUrl: "https://secret-endpoint",
				headers: { authorization: "secret-header" },
				apiKey: "secret-key",
				token: "secret-token",
				reasoning: i === 29,
				thinkingLevelMap: {
					minimal: null,
					low: null,
					medium: null,
					high: "secret-effort-value",
					xhigh: null,
					max: "max",
				},
				input: i === 29 ? ["text", "image"] : ["text"],
				contextWindow: 200001 + i,
				maxTokens: 16001 + i,
				cost:
					i === 0
						? undefined
						: { input: 0, output: 2, cacheRead: 0, secret: "secret-cost" },
			}));
			const registry = {
				getAvailable: () => models.slice().reverse(),
				find: (provider: string, id: string) =>
					models.find((m) => m.provider === provider && m.id === id),
				getAll: () => {
					throw new Error("init must not read the unauthenticated catalog");
				},
				getRegisteredProviderIds: () => ["extension-bridge"],
				getProviderAuthStatus: (provider: string) => ({
					configured: true,
					source: provider === "plain" ? "stored" : "secret-auth-source",
					label: "secret-auth-label",
				}),
			};
			const init = registeredCommands.find(
				(command) => command.name === "subagents-init",
			)!;
			await init.handler(
				"  Prefer capability over price; keep\nexisting coding choices.  ",
				initContext(registry),
			);
			assert.equal(sentUserMessages.length, 1);
			const message = sentUserMessages[0];
			assert.doesNotMatch(
				message,
				/secret-|baseUrl|apiKey|authorization|thinkingLevelMap/,
			);
			const json = message.match(/```json\n([\s\S]*?)\n```/);
			assert.ok(json, "init must supply a structured registry brief");
			const brief = JSON.parse(json[1]);
			assert.equal(
				brief.operatorPreferences,
				"Prefer capability over price; keep\nexisting coding choices.",
			);
			assert.deepEqual(brief.categories, {
				coding: "Implementation workers",
				review: "Code reviewers",
				recon: "Reconnaissance scouts",
				qa: "Software and test runners",
				architecture: "Planning and diagnosis",
				docs: "Documentation workers",
			});
			assert.deepEqual(brief.current, {
				default: "plain/old",
				agents: { worker: "plain/old" },
				tasks: { coding: ["plain/old"] },
				tasksMeta: {
					generatedAt: "2026-09-17T00:00:00Z",
					method: "registry-only",
				},
			});
			assert.equal(
				brief.configRevision,
				`sha256:${createHash("sha256").update(before).digest("hex")}`,
				"the revision covers the same bytes as current",
			);
			assert.equal(brief.models.length, 30);
			assert.deepEqual(
				brief.models.map((m: any) => m.ref),
				[
					"extension-bridge/model-29",
					...Array.from(
						{ length: 29 },
						(_, i) => `plain/model-${String(i).padStart(2, "0")}`,
					),
				],
			);
			assert.deepEqual(brief.models[0], {
				ref: "extension-bridge/model-29",
				provider: "extension-bridge",
				id: "model-29",
				name: "Upstream model display name",
				extensionRegistered: true,
				auth: { configured: true },
				reasoning: true,
				supportedThinkingLevels: ["off", "high", "max"],
				input: ["text", "image"],
				contextWindow: 200030,
				maxTokens: 16030,
				cost: { input: 0, output: 2, cacheRead: 0 },
			});
			assert.equal(Object.hasOwn(brief.models[1], "cost"), false);
			assert.deepEqual(brief.models[1].auth, {
				configured: true,
				source: "stored",
			});
			assert.deepEqual(brief.models[1].supportedThinkingLevels, ["off"]);
			assert.equal(Object.hasOwn(brief.models[2].cost, "cacheWrite"), false);
			assert.equal(
				readFileSync(configPath, "utf8"),
				before,
				"init must not save a draft itself",
			);
			for (const rule of [
				/capability-first/,
				/efficiency/,
				/complexity/,
				/notable exclusions/,
				/primary sources/,
				/no usable evidence/,
				/same upstream/,
				/different.*family/,
				/context-isolated/,
				/not cross-family independent/,
				/[Ww]hen no other.*family is available/,
				/[Oo]rdinary review/,
				/before\/after/,
				/launch-time/,
				/first authenticated/,
				/not commands/,
				/parent model/,
			])
				assert.match(message, rule);
			const normalizedPrompt = message.replace(/\s+/g, " ").trim();
			for (const clause of [
				"Cross-family independent review requires a reviewer from a different model family than the author.",
				"For ordinary review, prefer a different authenticated model family.",
				"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
				"Disclose that this review is context-isolated, not cross-family independent.",
				"Cross-family verification must not use this fallback.",
			])
				assert.ok(
					normalizedPrompt.includes(clause),
					`task-model init prompt must include: ${clause}`,
				);
		} finally {
			restoreEnvVar("PI_CODING_AGENT_DIR", previous);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a large init catalog complete in compact JSON and reports snapshot limits", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		const models = Array.from({ length: 350 }, (_, i) => ({
			provider: "gateway",
			id: `alias-${i}`,
			name: `Upstream ${i}`,
			reasoning: false,
		}));
		await registeredCommands
			.find((command) => command.name === "subagents-init")!
			.handler("", initContext({ getAvailable: () => models }));
		const message = sentUserMessages[0];
		const json = message.match(/```json\n([\s\S]*?)\n```/);
		assert.ok(json);
		const brief = JSON.parse(json[1]);
		assert.deepEqual(
			new Set(brief.models.map((model: any) => model.ref)),
			new Set(models.map((model) => `${model.provider}/${model.id}`)),
		);
		assert.equal(brief.models.length, models.length);
		assert.equal(
			json[1],
			JSON.stringify(brief),
			"catalog JSON must not add indentation or formatting whitespace",
		);
		assert.ok(message.includes(`${models.length} models`));
		assert.ok(message.includes(`${json[1].length} JSON characters`));
		assert.match(message, /synchronous snapshot/);
		assert.match(message, /initial catalog refresh/);
	});

	it("tolerates an optional auth-status method returning undefined", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		await registeredCommands
			.find((command) => command.name === "subagents-init")!
			.handler(
				"",
				initContext({
					getAvailable: () => [
						{ provider: "dynamic", id: "model", reasoning: false },
					],
					getProviderAuthStatus: () => undefined,
				}),
			);
		const json = sentUserMessages[0].match(/```json\n([\s\S]*?)\n```/);
		assert.ok(json);
		assert.deepEqual(JSON.parse(json[1]).models[0].auth, { configured: true });
	});

	it("rejects empty task maps through the writer schema but accepts partial categories", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);
		const writer = registeredTools.find(
			(tool) => tool.name === "subagents_write_task_models",
		)!;
		const tasksMeta = {
			generatedAt: "2026-09-18T00:00:00Z",
			method: "registry-only",
		};
		assert.equal(
			Value.Check(writer.parameters, { tasks: {}, tasksMeta }),
			false,
		);
		assert.equal(
			Value.Check(writer.parameters, {
				tasks: { coding: ["fake/worker"] },
				tasksMeta,
			}),
			true,
		);
	});

	it("reports an empty registry without prompting, asking an approval extension, or writing", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		let requests = 0;
		api.events.on(TASK_MODEL_INIT_APPROVAL_EVENT, () => {
			requests += 1;
		});
		const notifications: string[] = [];
		await registeredCommands
			.find((command) => command.name === "subagents-init")!
			.handler(
				"   ",
				initContext(
					{
						find: () => undefined,
						getAvailable: () => [],
						getAll: () => {
							throw new Error("no fallback catalog");
						},
					},
					notifications,
				),
			);
		assert.deepEqual(sentUserMessages, []);
		assert.equal(requests, 0);
		assert.deepEqual(notifications, [
			"Task-model init not started: the active registry has no authenticated models, so there is nothing to rank. Configure a provider, then run /subagents-init again. Nothing was written.",
		]);
	});

	it("refuses init without a selected model before asking anyone or prompting", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		let requests = 0;
		api.events.on(TASK_MODEL_INIT_APPROVAL_EVENT, () => {
			requests += 1;
		});
		const notifications: string[] = [];
		await registeredCommands
			.find((command) => command.name === "subagents-init")!
			.handler("", {
				...initContext({ getAvailable: () => [INIT_MODEL] }, notifications),
				model: undefined,
			});
		assert.deepEqual(sentUserMessages, []);
		assert.equal(requests, 0);
		assert.deepEqual(notifications, [
			"Task-model init not started: no model is selected, so Pi cannot run the init prompt. Select a model, then retry. Nothing was written.",
		]);
	});

	it("refuses init while a turn runs or messages are queued", async () => {
		for (const busy of [
			{ isIdle: () => false },
			{ hasPendingMessages: () => true },
		]) {
			const { api, registeredCommands, sentUserMessages } =
				createMockExtensionApi();
			subagentsModule.default(api);
			let requests = 0;
			api.events.on(TASK_MODEL_INIT_APPROVAL_EVENT, () => {
				requests += 1;
			});
			const notifications: string[] = [];
			await registeredCommands
				.find((command) => command.name === "subagents-init")!
				.handler("", {
					...initContext({ getAvailable: () => [INIT_MODEL] }, notifications),
					...busy,
				});
			assert.deepEqual(sentUserMessages, []);
			assert.equal(requests, 0);
			assert.deepEqual(notifications, [
				"Task-model init not started: a turn is in progress or messages are queued. Nothing was queued; retry when idle. Nothing was written.",
			]);
		}
	});

	it("gives the prompt's destination to the one extension that offers approval, in either load order", async () => {
		for (const order of ["before", "after"]) {
			const events = createEventBus();
			const { api, registeredCommands, registeredTools, sentUserMessages } =
				createMockExtensionApi(events);
			const requests: any[] = [];
			const listen = () =>
				events.on(TASK_MODEL_INIT_APPROVAL_EVENT, (request: any) => {
					requests.push(request);
					request.offer({
						owner: "test-approval",
						open: () => {
							registeredTools.push({ name: "test_apply" });
							return {
								kind: "ready",
								destination: {
									toolName: "test_apply",
									instructions: "Propose through test_apply once.",
								},
								cancel: () => assert.fail("a submitted flow is not cancelled"),
							};
						},
					});
				});
			if (order === "before") listen();
			subagentsModule.default(api);
			if (order === "after") listen();
			const ctx = initContext({ getAvailable: () => [INIT_MODEL] });
			await registeredCommands
				.find((command) => command.name === "subagents-init")!
				.handler("prefer x", ctx);
			assert.equal(requests.length, 1, order);
			const [request] = requests;
			assert.equal(request.apiVersion, 1);
			assert.equal(request.context, ctx, "the live command context");
			assert.ok(Object.isFrozen(request));
			assert.ok(Object.isFrozen(request.brief.models[0]));
			assert.equal(request.brief.operatorPreferences, "prefer x");
			assert.deepEqual(
				request.brief.models.map((model: any) => model.ref),
				["p/m"],
			);
			assert.equal(sentUserMessages.length, 1, order);
			assert.match(
				sentUserMessages[0],
				/\n\nPropose through test_apply once\.\n\n/,
			);
			assert.doesNotMatch(
				sentUserMessages[0],
				/call subagents_write_task_models/i,
			);
		}
	});

	it("never falls back to the direct writer when approval offers conflict or fail", async () => {
		const offers: Array<[string, (request: any) => void, RegExp]> = [
			[
				"two offers",
				(request) => {
					request.offer({ owner: "b-pack", open: () => undefined });
					request.offer({ owner: "a-pack", open: () => undefined });
				},
				/more than one extension offered to approve task-model writes \(a-pack, b-pack\)/,
			],
			[
				"a failing opener",
				(request) => {
					request.offer({
						owner: "a-pack",
						open: () => {
							throw new Error("cannot open");
						},
					});
				},
				/a-pack failed to open its approval flow \(cannot open\)/,
			],
			[
				"a refusal",
				(request) => {
					request.offer({
						owner: "a-pack",
						open: () => ({ kind: "blocked", reason: "no dialog" }),
					});
				},
				/a-pack refused: no dialog/,
			],
		];
		for (const [label, listener, reason] of offers) {
			const { api, registeredCommands, sentUserMessages } =
				createMockExtensionApi();
			subagentsModule.default(api);
			api.events.on(TASK_MODEL_INIT_APPROVAL_EVENT, listener);
			const notifications: string[] = [];
			await registeredCommands
				.find((command) => command.name === "subagents-init")!
				.handler(
					"",
					initContext({ getAvailable: () => [INIT_MODEL] }, notifications),
				);
			assert.deepEqual(sentUserMessages, [], label);
			assert.equal(notifications.length, 1, label);
			assert.match(notifications[0], reason, label);
			assert.match(notifications[0], /Nothing was written\.$/, label);
		}
	});

	it("cannot tell a listener that throws before offering from no listener", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		api.events.on(TASK_MODEL_INIT_APPROVAL_EVENT, () => {
			throw new Error("broken before offering");
		});
		const logged: unknown[][] = [];
		const consoleError = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			await registeredCommands
				.find((command) => command.name === "subagents-init")!
				.handler("", initContext({ getAvailable: () => [INIT_MODEL] }));
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			console.error = consoleError;
		}
		assert.equal(String(logged[0]?.[1]), "Error: broken before offering");
		assert.equal(sentUserMessages.length, 1);
		assert.match(
			sentUserMessages[0],
			/call subagents_write_task_models with the reviewed draft/,
			"the direct prompt runs; an approval extension's writer gate still applies",
		);
	});

	it("offers to run init for another extension's start request and leaves rendering to it", async () => {
		const { api, sentUserMessages } = createMockExtensionApi();
		subagentsModule.default(api);
		const notifications: string[] = [];
		const ctx = initContext(
			{ getAvailable: () => [INIT_MODEL] },
			notifications,
		);
		const offers: any[] = [];
		const offer = (value: any) => {
			offers.push(value);
			return "recorded";
		};
		api.events.emit(TASK_MODEL_INIT_START_EVENT, {
			apiVersion: 1,
			context: ctx,
			preferences: " cheap recon ",
			offer,
		});
		assert.deepEqual(
			offers.map((entry) => entry.owner),
			["pi-herdr-agents"],
		);
		// Not deepEqual: its assertion signature would narrow the array to never[].
		assert.equal(sentUserMessages.length, 0, "offering starts nothing");
		assert.deepEqual(offers[0].start(), {
			kind: "started",
			destination: "subagents_write_task_models",
		});
		assert.equal(sentUserMessages.length, 1);
		const json = sentUserMessages[0].match(/```json\n([\s\S]*?)\n```/);
		assert.equal(JSON.parse(json![1]).operatorPreferences, "cheap recon");
		assert.deepEqual(notifications, [], "the requesting command renders");
		api.events.emit(TASK_MODEL_INIT_START_EVENT, {
			apiVersion: 1,
			context: {},
			preferences: "x",
			offer,
		});
		api.events.emit(TASK_MODEL_INIT_START_EVENT, {
			apiVersion: 2,
			context: ctx,
			preferences: "x",
			offer,
		});
		assert.equal(offers.length, 2, "only v1 requests get an answer");
		assert.deepEqual(offers[1].start(), {
			kind: "not-started",
			reason:
				"the start request lacks a usable command context or preferences text",
		});
		assert.equal(sentUserMessages.length, 1);
	});

	it("returns saved tool details and text from normalized config while preserving unrelated preferences", async () => {
		const dir = createTestDir();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);
			const configPath = getSubagentsConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					status: { enabled: false },
					models: {
						default: "fake/default",
						agents: { scout: "fake/scout" },
						tasks: { review: ["fake/old"] },
					},
				}),
			);
			const writer = registeredTools.find(
				(tool) => tool.name === "subagents_write_task_models",
			)!;
			assert.deepEqual(
				Object.keys(writer.parameters.properties.tasks.properties),
				["coding", "review", "recon", "qa", "architecture", "docs"],
			);
			assert.equal(
				writer.parameters.properties.tasks.additionalProperties,
				false,
			);
			assert.equal(writer.parameters.properties.tasks.required?.length ?? 0, 0);
			const tasksMeta = {
				generatedAt: "2026-09-18T00:00:00Z",
				method: "registry-only",
			};
			const model = { provider: "fake", id: "worker", reasoning: false };
			const result = await writer.execute(
				"init-write",
				{ tasks: { coding: [" fake/worker "] }, tasksMeta },
				undefined,
				undefined,
				{
					modelRegistry: {
						find: (provider: string, id: string) =>
							provider === "fake" && id === "worker" ? model : undefined,
						getAvailable: () => [model],
						hasConfiguredAuth: () => true,
					},
				},
			);
			assert.deepEqual(result.details, {
				configPath,
				tasks: { coding: ["fake/worker"] },
				tasksMeta,
				missingCategories: ["review", "recon", "qa", "architecture", "docs"],
				configRevision: readConfigRevision(configPath),
			});
			assert.match(result.content[0].text, /Reload required/);
			assert.ok(
				result.content[0].text.includes(
					JSON.stringify(result.details, null, 2),
				),
			);
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
				status: { enabled: false },
				models: {
					default: "fake/default",
					agents: { scout: "fake/scout" },
					tasks: { coding: ["fake/worker"] },
					tasksMeta,
				},
			});
		} finally {
			restoreEnvVar("PI_CODING_AGENT_DIR", previous);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exposes an optional exact-byte expectedConfigRevision in the public writer schema", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);
		const writer = registeredTools.find(
			(tool) => tool.name === "subagents_write_task_models",
		)!;
		assert.equal(
			writer.parameters.required.includes("expectedConfigRevision"),
			false,
		);
		assert.match(writer.description, /expectedConfigRevision/);
		assert.match(writer.description, /configRevision/);
		const base = {
			tasks: { coding: ["fake/worker"] },
			tasksMeta: { generatedAt: "2026-10-05T00:00:00Z", method: "research" },
		};
		const hex = "0123456789abcdef".repeat(4);
		assert.equal(Value.Check(writer.parameters, base), true);
		for (const revision of ["missing", `sha256:${hex}`])
			assert.equal(
				Value.Check(writer.parameters, {
					...base,
					expectedConfigRevision: revision,
				}),
				true,
			);
		for (const revision of [
			"",
			null,
			"MISSING",
			`sha256:${hex.toUpperCase()}`,
			`sha256:${hex.slice(1)}`,
			`sha256:${hex}0`,
			hex,
		])
			assert.equal(
				Value.Check(writer.parameters, {
					...base,
					expectedConfigRevision: revision,
				}),
				false,
				String(revision),
			);
	});

	it("accepts an optional ranking basis that matches tasksMeta.method, returns it, and never saves it", async () => {
		const dir = createTestDir();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);
			const configPath = getSubagentsConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					status: { enabled: false },
					models: { default: "fake/default" },
				}),
			);
			const writer = registeredTools.find(
				(tool) => tool.name === "subagents_write_task_models",
			)!;
			const model = { provider: "fake", id: "worker", reasoning: false };
			const ctx = {
				modelRegistry: {
					find: (provider: string, id: string) =>
						provider === "fake" && id === "worker" ? model : undefined,
					getAvailable: () => [model],
					hasConfiguredAuth: () => true,
				},
			};
			const tasks = { coding: ["fake/worker"] };
			const research = {
				generatedAt: "2026-10-09T00:00:00Z",
				method: "research",
			};
			const basis = {
				kind: "research",
				sources: [
					{
						url: "https://vendor.example/evals",
						influence: "coding: ranks worker first on its agentic suite",
					},
				],
				uncertainty: "vendor-reported results only",
			};
			assert.equal(
				Value.Check(writer.parameters, { tasks, tasksMeta: research, basis }),
				true,
			);
			const result = await writer.execute(
				"with-basis",
				{ tasks, tasksMeta: research, basis },
				undefined,
				undefined,
				ctx,
			);
			assert.deepEqual(result.details.basis, basis);
			assert.ok(result.content[0].text.includes("vendor.example/evals"));
			const saved = readFileSync(configPath, "utf8");
			assert.deepEqual(JSON.parse(saved), {
				status: { enabled: false },
				models: { default: "fake/default", tasks, tasksMeta: research },
			});
			assert.equal(
				result.details.configRevision,
				readConfigRevision(configPath),
			);

			const legacy = await writer.execute(
				"legacy-research",
				{ tasks, tasksMeta: research },
				undefined,
				undefined,
				ctx,
			);
			assert.equal(Object.hasOwn(legacy.details, "basis"), false);
			const before = readFileSync(configPath, "utf8");

			const registryOnly = {
				generatedAt: "2026-10-09T00:00:00Z",
				method: "registry-only",
			};
			const invalid: Array<[object, unknown, RegExp]> = [
				[research, { kind: "registry-only" }, /must equal tasksMeta\.method/],
				[registryOnly, basis, /must equal tasksMeta\.method/],
				[research, { ...basis, sources: [] }, /at least one source/],
				[
					research,
					{ ...basis, sources: [{ url: "ftp://x.example/a", influence: "x" }] },
					/http\(s\) URL/,
				],
				[
					research,
					{ ...basis, sources: [{ url: "not a url", influence: "x" }] },
					/http\(s\) URL/,
				],
				[
					research,
					{ ...basis, sources: [{ url: "https://x.example", influence: " " }] },
					/influence must say/,
				],
				[research, { ...basis, uncertainty: "\n" }, /uncertainty/],
				[registryOnly, { kind: "registry-only", note: "x" }, /no other fields/],
				[registryOnly, null, /must be an object/],
			];
			for (const [tasksMeta, value, reason] of invalid)
				await assert.rejects(
					writer.execute(
						"invalid-basis",
						{ tasks: { review: ["fake/worker"] }, tasksMeta, basis: value },
						undefined,
						undefined,
						ctx,
					),
					reason,
					JSON.stringify(value),
				);
			assert.equal(readFileSync(configPath, "utf8"), before, "nothing written");
			assert.equal(
				Value.Check(writer.parameters, {
					tasks,
					tasksMeta: research,
					basis: { ...basis, sources: [] },
				}),
				false,
			);
		} finally {
			restoreEnvVar("PI_CODING_AGENT_DIR", previous);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a conditional tool write after a later change to the approved config snapshot", async () => {
		const dir = createTestDir();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);
			const configPath = getSubagentsConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					unrelated: { keep: 1 },
					models: { tasks: { coding: ["fake/worker"] } },
				}),
			);
			const writer = registeredTools.find(
				(tool) => tool.name === "subagents_write_task_models",
			)!;
			const model = { provider: "fake", id: "worker", reasoning: false };
			const ctx = {
				modelRegistry: {
					find: (provider: string, id: string) =>
						provider === "fake" && id === "worker" ? model : undefined,
					getAvailable: () => [model],
					hasConfiguredAuth: () => true,
				},
			};
			const tasksMeta = {
				generatedAt: "2026-10-05T00:00:00Z",
				method: "registry-only",
			};
			// Approval binds this exact snapshot; a later hook then adds qa.
			const approvedRevision = readConfigRevision(configPath);
			await writer.execute(
				"later-hook",
				{ tasks: { coding: ["fake/worker"], qa: ["fake/worker"] }, tasksMeta },
				undefined,
				undefined,
				ctx,
			);
			const afterHook = readFileSync(configPath, "utf8");
			await assert.rejects(
				writer.execute(
					"approved-write",
					{
						tasks: { coding: ["fake/worker"] },
						tasksMeta,
						expectedConfigRevision: approvedRevision,
					},
					undefined,
					undefined,
					ctx,
				),
				/Stale task model config revision.*not replaced/,
			);
			assert.equal(readFileSync(configPath, "utf8"), afterHook);
			assert.deepEqual(loadModelConfig(dirname(configPath)).tasks, {
				coding: ["fake/worker"],
				qa: ["fake/worker"],
			});
			for (const invalid of [null, ""])
				await assert.rejects(
					writer.execute(
						"invalid-write",
						{
							tasks: { coding: ["fake/worker"] },
							tasksMeta,
							expectedConfigRevision: invalid,
						},
						undefined,
						undefined,
						ctx,
					),
					/Invalid expectedConfigRevision/,
				);
			assert.equal(readFileSync(configPath, "utf8"), afterHook);
			const fresh = await writer.execute(
				"fresh-write",
				{
					tasks: {
						coding: ["fake/worker"],
						qa: ["fake/worker"],
						docs: ["fake/worker"],
					},
					tasksMeta,
					expectedConfigRevision: readConfigRevision(configPath),
				},
				undefined,
				undefined,
				ctx,
			);
			assert.equal(
				fresh.details.configRevision,
				readConfigRevision(configPath),
			);
			assert.ok(
				fresh.content[0].text.includes(
					`"configRevision": "${fresh.details.configRevision}"`,
				),
			);
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).unrelated, {
				keep: 1,
			});
		} finally {
			restoreEnvVar("PI_CODING_AGENT_DIR", previous);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers only generic commands and no retired workflow commands", () => {
		const previousId = process.env.PI_SUBAGENT_ID;
		try {
			for (const [childId, expected] of [
				[undefined, ["subagent", "subagents-init", "worktree"]],
				["command-inventory-child", ["subagent", "worktree"]],
			] as const) {
				restoreEnvVar("PI_SUBAGENT_ID", childId);
				const { api, registeredCommands, sentUserMessages } =
					createMockExtensionApi();
				subagentsModule.default(api);
				const names = registeredCommands.map((command) => command.name);
				assert.deepEqual([...names].sort(), expected);
				for (const retired of ["plan", "iterate", "btw", "btw-close"])
					assert.equal(names.includes(retired), false, `/${retired}`);
				assert.equal(sentUserMessages.length, 0);
			}
		} finally {
			restoreEnvVar("PI_SUBAGENT_ID", previousId);
		}
	});

	it("keeps direct interactive full-context forks available without /iterate", () => {
		const testApi = subagentsModule.__test__;
		const params = {
			name: "Fork",
			task: "Fix the bug",
			fork: true,
			interactive: true,
		};
		assert.deepEqual(testApi.resolveLaunchBehavior(params, null), {
			sessionMode: "fork",
			seededSessionMode: "fork",
			inheritsConversationContext: true,
			taskDelivery: "direct",
		});
		assert.equal(testApi.resolveEffectiveAutoExit(params, null), false);
		assert.equal(testApi.resolveEffectiveInteractive(params, null), true);
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ ...params, interactive: undefined },
				null,
			),
			true,
			"bare forks without interactive remain autonomous",
		);
	});
});

describe("worktree cleanup public surface", () => {
	it("skips startup inventory outside Herdr", async (t) => {
		const previousHerdr = process.env.HERDR_ENV;
		t.after(() => restoreEnvVar("HERDR_ENV", previousHerdr));
		for (const herdrEnv of [undefined, "0"]) {
			restoreEnvVar("HERDR_ENV", herdrEnv);
			const f = cleanupFixture();
			const scan = t.mock.method(f.operations, "scan");
			const { api, eventHandlers } = createMockExtensionApi();
			subagentsModule.default(api, { cleanupOperations: () => f.operations });
			const notices: string[] = [];
			await eventHandlers.get("session_start")![0](
				{},
				{
					cwd: "/repo",
					hasUI: true,
					modelRegistry: { find: () => undefined, getAvailable: () => [] },
					ui: { notify: (text: string) => notices.push(text) },
				},
			);
			assert.deepEqual(notices, []);
			assert.equal(scan.mock.callCount(), 0);
		}
	});
	it("delivers process warnings through tool inventory, successful results, and Pi error messages", async () => {
		for (const status of ["removed", "blocked", "failed"] as const) {
			const f = cleanupFixture();
			const warnings = [
				"Incomplete process coverage: a protected process could hold the checkout undetected.",
			];
			f.operations.holders = async () => ({
				blockers:
					status === "blocked" ? ["Live process 202 holds the checkout"] : [],
				warnings,
			});
			if (status === "failed")
				f.operations.removeCheckout = () => {
					throw new Error("remove refused");
				};
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api, { cleanupOperations: () => f.operations });
			const ctx = { cwd: "/repo" };
			const inventory = await registeredTools
				.find((tool) => tool.name === "worktree_list")!
				.execute("id", {}, undefined, undefined, ctx);
			assert.deepEqual(inventory.details.entries[0].warnings, warnings);
			assert.match(inventory.content[0].text, /Warning:.*protected process/);
			const remove = () =>
				registeredTools
					.find((tool) => tool.name === "worktree_remove")!
					.execute("id", { target: "task" }, undefined, undefined, ctx);
			if (status === "removed") {
				const result = await remove();
				assert.deepEqual(result.details.warnings, warnings);
				assert.match(result.content[0].text, /Warning:.*protected process/);
			} else {
				await assert.rejects(remove, /Warning:.*protected process/);
				assert.deepEqual(f.calls, []);
			}
		}
	});
	it("keeps worktree inventory out of session startup", async (t) => {
		const previousHerdr = process.env.HERDR_ENV;
		process.env.HERDR_ENV = "1";
		t.mock.method(childProcess, "execSync", () => "/fixture/herdr\n");
		syncBuiltinESMExports();
		t.after(() => {
			restoreEnvVar("HERDR_ENV", previousHerdr);
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
		const f = cleanupFixture();
		const { api, registeredTools, registeredCommands, eventHandlers } =
			createMockExtensionApi();
		subagentsModule.default(api, { cleanupOperations: () => f.operations });
		const notices: string[] = [];
		const ctx = {
			cwd: "/repo",
			hasUI: true,
			modelRegistry: { find: () => undefined, getAvailable: () => [] },
			ui: { notify: (text: string) => notices.push(text) },
		};
		const list = registeredTools.find((tool) => tool.name === "worktree_list");
		const remove = registeredTools.find(
			(tool) => tool.name === "worktree_remove",
		);
		assert.ok(list);
		assert.ok(remove);
		const result = await list.execute("id", {}, undefined, undefined, ctx);
		assert.equal(result.details.entries[0].classification, "eligible");
		const scan = t.mock.method(f.operations, "scan");
		await eventHandlers.get("session_start")![0]({}, ctx);
		assert.deepEqual(notices, []);
		assert.equal(scan.mock.callCount(), 0);
		assert.deepEqual(f.calls, []);
		const command = registeredCommands.find(
			(item) => item.name === "worktree",
		)!;
		await command.handler("remove task", ctx);
		assert.match(notices.at(-1)!, /Removed/);
		assert.deepEqual(f.calls, ["git:/repo:/managed/repo/task", "prune:/repo"]);
	});
	it("dispatches preserve explicitly from the tool and command", async () => {
		for (const surface of ["tool", "command"]) {
			const f = cleanupFixture();
			f.state.dirtyFiles = 1;
			const { api, registeredTools, registeredCommands } =
				createMockExtensionApi();
			subagentsModule.default(api, { cleanupOperations: () => f.operations });
			const ctx = { cwd: "/repo", ui: { notify: () => {} } };
			if (surface === "tool")
				await registeredTools
					.find((tool) => tool.name === "worktree_remove")!
					.execute(
						"id",
						{ target: "task", preserve: true },
						undefined,
						undefined,
						ctx,
					);
			else
				await registeredCommands
					.find((item) => item.name === "worktree")!
					.handler("remove task --preserve", ctx);
			assert.equal(f.calls[0], "preserve");
		}
	});
	it("keeps child Herdr list formatting, handoff dispatch, and silent startup", async (t) => {
		const dir = createTestDir();
		const previousId = process.env.PI_SUBAGENT_ID;
		const previousHerdr = process.env.HERDR_ENV;
		process.env.PI_SUBAGENT_ID = "child";
		process.env.HERDR_ENV = "1";
		let worktrees: object[] = [
			{
				branch: "feature/topic",
				path: "/checkout/topic",
				is_linked_worktree: true,
				open_workspace_id: "w9",
			},
			{ branch: "main", path: "/repo", is_linked_worktree: false },
			{
				is_detached: true,
				path: "/checkout/detached",
				is_linked_worktree: true,
			},
		];
		const effects: string[][] = [];
		const availability = t.mock.method(
			childProcess,
			"execSync",
			(command: string) => {
				assert.equal(command, "command -v herdr");
				return "/fixture/herdr\n";
			},
		);
		const mocked = t.mock.method(
			childProcess,
			"execFileSync",
			(file: string, args: string[], options: { cwd?: string }) => {
				effects.push([file, ...args]);
				if (file === "herdr" && args[0] === "worktree" && args[1] === "list") {
					assert.deepEqual(args, ["worktree", "list", "--cwd", "/repo"]);
					return JSON.stringify({
						result: { type: "worktree_list", worktrees },
					});
				}
				if (file === "git") {
					assert.equal(options.cwd, "/repo");
					if (args[1] === "--verify") {
						assert.deepEqual(args, ["rev-parse", "--verify", "HEAD^{commit}"]);
						return "a".repeat(40);
					}
					if (args[1] === "--path-format=absolute") {
						if (args[2] === "--git-dir")
							assert.deepEqual(args, [
								"rev-parse",
								"--path-format=absolute",
								"--git-dir",
							]);
						else if (args[2] === "--git-common-dir")
							assert.deepEqual(args, [
								"rev-parse",
								"--path-format=absolute",
								"--git-common-dir",
							]);
						else assert.fail(`unexpected Git path command: ${args.join(" ")}`);
						return "/repo/.git\n";
					}
					assert.fail(`unexpected Git command: ${args.join(" ")}`);
				}
				assert.equal(file, "herdr");
				assert.deepEqual(args, [
					"worktree",
					"create",
					"--cwd",
					"/repo",
					"--branch",
					"feature/followup",
					"--base",
					"a".repeat(40),
					"--label",
					"wt: feature/followup",
					"--no-focus",
				]);
				// Stop at the external creation boundary: no real workspace is created.
				throw new Error("fixture handoff creation stopped");
			},
		);
		syncBuiltinESMExports();
		try {
			const { api, registeredCommands, eventHandlers } =
				createMockExtensionApi();
			api.getThinkingLevel = () => "medium";
			subagentsModule.default(api, {
				cleanupOperations: () => {
					throw new Error("child must not inspect cleanup inventory");
				},
			});
			const notices: string[] = [];
			const model = { provider: "fake", id: "test", reasoning: true };
			let idleWaits = 0;
			const ctx = {
				cwd: "/repo",
				hasUI: true,
				model,
				modelRegistry: {
					find: () => model,
					getAvailable: () => [model],
					hasConfiguredAuth: () => true,
				},
				ui: { notify: (text: string) => notices.push(text) },
				waitForIdle: async () => {
					idleWaits++;
				},
				sessionManager: {
					getSessionFile: () => join(dir, "parent.jsonl"),
					getLeafId: () => "active-leaf",
					getSessionId: () => "child",
					getSessionDir: () => dir,
				},
			};
			await eventHandlers.get("session_start")![0]({}, ctx);
			assert.deepEqual(notices, []);
			assert.deepEqual(effects, []);
			const command = registeredCommands.find(
				(command) => command.name === "worktree",
			)!;
			await command.handler("list", ctx);
			assert.equal(
				notices.at(-1),
				"feature/topic — /checkout/topic (w9)\nmain — /repo\n(detached HEAD) — /checkout/detached",
			);
			worktrees = [];
			await command.handler("list", ctx);
			assert.equal(notices.at(-1), "No worktrees found.");
			await command.handler("feature/followup", ctx);
			assert.equal(idleWaits, 1);
			assert.equal(
				notices.at(-1),
				"Worktree launch failed: fixture handoff creation stopped",
			);
			// The extra Herdr call is the pre-create snapshot of the source primary workspace.
			assert.equal(effects.length, 7);
			assert.deepEqual(effects.at(-2), [
				"herdr",
				"worktree",
				"list",
				"--cwd",
				"/repo",
			]);
			assert.deepEqual(effects.at(-1)?.slice(0, 3), [
				"herdr",
				"worktree",
				"create",
			]);
			const manifestDir = join(dir, "artifacts", "child", "worktree-runs");
			const manifests = readdirSync(manifestDir);
			assert.equal(manifests.length, 1);
			const manifest = JSON.parse(
				readFileSync(join(manifestDir, manifests[0]), "utf8"),
			);
			assert.equal(manifest.branch, "feature/followup");
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.sourceCwd, "/repo");
		} finally {
			mocked.mock.restore();
			availability.mock.restore();
			syncBuiltinESMExports();
			restoreEnvVar("PI_SUBAGENT_ID", previousId);
			restoreEnvVar("HERDR_ENV", previousHerdr);
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("keeps the child worktree command but rejects removal and hides cleanup tools", async () => {
		process.env.PI_SUBAGENT_ID = "child";
		try {
			const { api, registeredTools, registeredCommands } =
				createMockExtensionApi();
			subagentsModule.default(api);
			assert.equal(
				registeredTools.some((tool) =>
					["worktree_list", "worktree_remove"].includes(tool.name),
				),
				false,
			);
			const command = registeredCommands.find(
				(command) => command.name === "worktree",
			)!;
			assert.ok(command);
			assert.doesNotMatch(command.description, /remove/);
			const notices: string[] = [];
			const ctx = {
				cwd: "/repo",
				ui: { notify: (text: string) => notices.push(text) },
			};
			await command.handler("", ctx);
			assert.match(notices.at(-1)!, /<name>.*worktree list/);
			assert.doesNotMatch(notices.at(-1)!, /remove/);
			await command.handler("remove task --preserve", ctx);
			assert.match(notices.at(-1)!, /parent-only/);
		} finally {
			delete process.env.PI_SUBAGENT_ID;
		}
	});
});

describe("tool registration", () => {
	it("refreshes subagent routing guidance from the live authenticated model registry", () => {
		const { api, registeredTools, eventHandlers } = createMockExtensionApi();
		subagentsModule.default(api);

		const subagent = registeredTools.find((tool) => tool.name === "subagent");
		assert.ok(subagent);
		const sessionStart = eventHandlers.get("session_start")?.[0];
		assert.ok(sessionStart);
		sessionStart(
			{},
			{
				hasUI: false,
				modelRegistry: {
					find: (provider: string, id: string) => ({
						provider,
						id,
						reasoning: true,
					}),
					getAvailable: () => [
						{
							provider: "fake",
							id: "fast",
							reasoning: true,
							input: ["text"],
							contextWindow: 128_000,
							maxTokens: 16_000,
							cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						},
					],
					hasConfiguredAuth: () => true,
				},
			},
		);

		assert.match(subagent.promptGuidelines.join("\n"), /fake\/fast/);
		assert.match(
			subagent.promptGuidelines.join("\n"),
			/explicitly set both model and thinking for every child/,
		);
		assert.match(
			subagent.promptGuidelines.join("\n"),
			/For ordinary review, prefer a different authenticated model family/,
		);
		assert.match(
			subagent.promptGuidelines.join("\n"),
			/context-isolated/,
			"injected routing guidelines must describe context-isolated same-family fallback",
		);
		assert.match(
			subagent.promptGuidelines.join("\n"),
			/Omitting model and thinking still inherits the parent runtime, but this is a discouraged fallback/,
		);
		assert.match(subagent.promptGuidelines.join("\n"), /login-test2/);
	});

	it("distinguishes ordinary context-isolated review from strict cross-family review", () => {
		const registry = wrapPiModelRegistry({
			find: (p: string, id: string) => ({ provider: p, id, reasoning: true }),
			getAvailable: () => [
				{
					provider: "fake",
					id: "worker",
					reasoning: true,
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 16_000,
				},
			],
			getAll: () => {
				throw new Error("must not call getAll");
			},
		});
		const clauses = [
			"For ordinary review, prefer a different authenticated model family.",
			"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
			"Disclose that this review is context-isolated, not cross-family independent.",
			"Cross-family verification must not use this fallback.",
		];
		for (const [label, taskPreferences] of [
			["shortlist", { coding: ["fake/worker"] }],
			["generic", {}],
		] as const) {
			const catalog = buildAuthenticatedModelCatalog(
				registry,
				24,
				taskPreferences,
			);
			const combined = subagentsModule.__test__
				.buildSubagentRoutingGuidelines(catalog, taskPreferences)
				.join("\n")
				.replace(/\s+/g, " ")
				.trim();
			for (const clause of clauses)
				assert.ok(
					combined.includes(clause),
					`${label} combined guidance must include: ${clause}`,
				);
			if (label === "generic") {
				const orchestratedLine = catalog
					.split("\n")
					.find((line) => line.startsWith("For orchestrated children"));
				assert.ok(orchestratedLine);
				assert.doesNotMatch(
					orchestratedLine,
					/ordinary|same-family|context-isolated/i,
				);
			}
		}
	});

	it("states the complete ordinary-review taxonomy in routing guidelines", () => {
		const guidelines = subagentsModule.__test__
			.buildSubagentRoutingGuidelines("catalog", { coding: ["fake/worker"] })
			.join("\n")
			.replace(/\s+/g, " ")
			.trim();
		for (const clause of [
			"For ordinary review, prefer a different authenticated model family.",
			"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
			"Disclose that this review is context-isolated, not cross-family independent.",
			"Cross-family verification must not use this fallback.",
		])
			assert.ok(
				guidelines.includes(clause),
				`routing guidelines must include: ${clause}`,
			);
	});

	it("renders generic routing tiers only when no authenticated shortlist is available", () => {
		const configured = subagentsModule.__test__
			.buildSubagentRoutingGuidelines("catalog", { coding: ["fake/worker"] })
			.join("\n");
		assert.match(configured, /prefer the configured task-category shortlists/);
		assert.doesNotMatch(configured, /first choose a fast, mid, or frontier/);

		const generic = subagentsModule.__test__
			.buildSubagentRoutingGuidelines("catalog", {})
			.join("\n");
		assert.match(generic, /first choose a fast, mid, or frontier/);
		assert.doesNotMatch(
			generic,
			/prefer the configured task-category shortlists/,
		);
	});

	it("ignores an inherited deny list in a parent process", () => {
		delete process.env.PI_SUBAGENT_ID;
		process.env.PI_DENY_TOOLS =
			"subagent,subagent_interrupt,subagent_resume,subagents_list";
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent"),
				true,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_interrupt"),
				true,
			);
		} finally {
			delete process.env.PI_DENY_TOOLS;
		}
	});

	it("applies the deny list inside a child subagent process", () => {
		process.env.PI_SUBAGENT_ID = "child-test";
		process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt";
		try {
			const { api, registeredTools, registeredCommands } =
				createMockExtensionApi();
			subagentsModule.default(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent"),
				false,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_interrupt"),
				false,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagents_list"),
				true,
			);
			assert.equal(
				registeredTools.some(
					(tool) => tool.name === "subagents_write_task_models",
				),
				false,
			);
			assert.equal(
				registeredCommands.some((command) => command.name === "subagents-init"),
				false,
			);
		} finally {
			delete process.env.PI_SUBAGENT_ID;
			delete process.env.PI_DENY_TOOLS;
		}
	});

	it("expands spawning false to deny subagent interruption", () => {
		const testApi = subagentsModule.__test__;
		const denied = testApi.resolveDenyTools({ spawning: false });

		assert.equal(denied.has("subagent"), true);
		assert.equal(denied.has("subagent_interrupt"), true);
		assert.equal(denied.has("subagent_resume"), true);
		assert.equal(denied.has("subagents_write_task_models"), true);
	});

	it("exposes a nullable worktree with branch and optional base", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);

		const subagentTool = registeredTools.find(
			(tool) => tool.name === "subagent",
		);
		const worktreeSchema = subagentTool.parameters.properties.worktree;
		const [objectSchema, nullSchema] = worktreeSchema.anyOf;

		assert.deepEqual(objectSchema.required, ["branch"]);
		assert.equal(objectSchema.properties.branch.minLength, 1);
		assert.equal(objectSchema.properties.base.type, "string");
		assert.equal(nullSchema.type, "null");
		assert.match(worktreeSchema.description, /omit or pass null/i);
		assert.match(subagentTool.description, /retain.*parent review/i);
	});

	it("describes the complete ordinary-review taxonomy in the model parameter", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);
		const subagentTool = registeredTools.find(
			(tool) => tool.name === "subagent",
		);
		const modelDesc = (
			subagentTool.parameters.properties.model.description ?? ""
		)
			.replace(/\s+/g, " ")
			.trim();
		for (const clause of [
			"For ordinary review, prefer a different authenticated model family.",
			"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
			"Disclose that this review is context-isolated, not cross-family independent.",
			"Cross-family verification must not use this fallback.",
		])
			assert.ok(
				modelDesc.includes(clause),
				`model description must include: ${clause}`,
			);
		assert.doesNotMatch(
			modelDesc,
			/when unavailable/i,
			"model description must use the authenticated-family availability gate",
		);
	});

	it("renders partial subagent tool-call args without throwing", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);

		const subagentTool = registeredTools.find(
			(tool) => tool.name === "subagent",
		);
		assert.ok(subagentTool, "expected subagent tool to be registered");

		const theme = {
			fg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		};
		const rendered = subagentTool.renderCall({}, theme);
		const output = rendered.render(80).join("\n");

		assert.match(output, /\(unnamed\)/);
	});

	it("registers subagent_resume with an autoExit override", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);

		const resumeTool = registeredTools.find(
			(tool) => tool.name === "subagent_resume",
		);
		assert.ok(resumeTool, "expected subagent_resume tool to be registered");

		const autoExitSchema = resumeTool.parameters.properties.autoExit;
		assert.equal(autoExitSchema.type, "boolean");
		assert.match(autoExitSchema.description, /Defaults to true/);
	});
});

describe("subagent parent lifecycle", () => {
	it("preserves active subagents while replacing the parent session", () => {
		for (const reason of ["reload", "new", "resume", "fork"]) {
			const abortController = new AbortController();
			const agents = new Map([
				[
					"child",
					{
						abortController,
						lifecycle: createLifecycle(1_000),
					},
				],
			]);

			cleanupSubagentsForShutdown(reason, agents);

			assert.equal(shouldPreserveSubagentsOnShutdown(reason), true);
			assert.equal(abortController.signal.aborted, false);
			assert.equal(shouldDeliverSubagentCompletion(agents.get("child")!), true);
			assert.equal(agents.size, 1);
		}
	});

	it("aborts and clears active subagents during final shutdown", () => {
		for (const reason of ["quit", undefined]) {
			const abortController = new AbortController();
			const running = { abortController, lifecycle: createLifecycle(1_000) };
			const agents = new Map([["child", running]]);

			cleanupSubagentsForShutdown(reason, agents);

			assert.equal(shouldPreserveSubagentsOnShutdown(reason), false);
			assert.equal(abortController.signal.aborted, true);
			// Delivery is suppressed before the map is cleared so a racing watcher
			// that still holds a reference cannot deliver after shutdown.
			assert.equal(running.lifecycle.delivery, "suppressed");
			assert.equal(shouldDeliverSubagentCompletion(running), false);
			assert.equal(agents.size, 0);
		}
	});

	it("treats lifecycle.delivery as the authoritative completion gate", () => {
		const pending = { lifecycle: createLifecycle(1_000) };
		assert.equal(shouldDeliverSubagentCompletion(pending), true);

		const delivered = {
			lifecycle: { ...createLifecycle(1_000), delivery: "delivered" as const },
		};
		assert.equal(shouldDeliverSubagentCompletion(delivered), false);

		const suppressed = {
			lifecycle: { ...createLifecycle(1_000), delivery: "suppressed" as const },
		};
		assert.equal(shouldDeliverSubagentCompletion(suppressed), false);

		// Pre-lifecycle fixtures without a lifecycle field still default to pending.
		// SAFETY: intentionally simulates legacy data missing the (typed as
		// required) `lifecycle` field; the implementation reads it optionally.
		assert.equal(shouldDeliverSubagentCompletion({} as any), true);
	});

	it("delivers completion through the reloaded extension API", () => {
		const previous = { id: "previous" };
		const current = { id: "current" };

		assert.equal(selectCompletionApi(previous, current), current);
		assert.equal(selectCompletionApi(previous, undefined), previous);
	});
});

describe("Task15 unowned host activity", () => {
	it("refreshes without a session/context, hydrates legacy rows and retains successful activity", () => {
		// SAFETY: this fixture saves/restores the extension-owned runtime slot to exercise pre-initialization.
		const root = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
		const previous = { session: root.session, latestCtx: root.latestCtx };
		root.session = undefined;
		root.latestCtx = undefined;
		try {
			withTempDir((dir) => {
				const file = join(dir, "activity.json");
				const recorder = createSubagentActivityRecorder({
					runningChildId: "unowned",
					activityFile: file,
					now: () => 100,
				});
				recorder.sessionStart();
				recorder.toolExecutionStart("tool", "bash");
				// SAFETY: a seeded legacy presentation row intentionally has no lifecycle before ensureLifecycle.
				const row: any = {
					id: "unowned",
					name: "legacy",
					task: "",
					surface: "none",
					startTime: 1,
					sessionFile: "must-not-read",
					interactive: false,
					runtimePlan: undefined,
					activityFile: file,
				};
				hostModule.__test__.observeRunningSubagent(row, 200);
				assert.equal(projectLifecycle(row.lifecycle, 200).kind, "active");
				assert.equal(row.lifecycle.activityDetail.label, "bash");
				assert.deepEqual(row.activityRead, { ok: true });
				const successful = row.activity;
				writeFileSync(file, "{");
				hostModule.__test__.observeRunningSubagent(row, 300);
				assert.equal(row.activity, successful);
				assert.equal(row.activityRead.reason, "invalid");
				assert.ok(row.activityRead.error);
				row.activityFile = join(dir, "missing");
				hostModule.__test__.observeRunningSubagent(row, 400);
				assert.equal(row.activity, successful);
				assert.deepEqual(row.activityRead, {
					ok: false,
					reason: "missing",
					error: undefined,
				});
				assert.ok(Object.hasOwn(row.activityRead, "error"));
				for (const [statusState, kind] of [
					[
						{
							phase: "active",
							activeScope: "tool",
							activityLabel: "read",
							lastActivityAtMs: 50,
							lastActivitySequence: 7,
						},
						"active",
					],
					[{ phase: "done", lastActivityAtMs: 50 }, "waiting"],
					[
						{
							phase: "active",
							activityLabel: "interrupted",
							localOverrideAtMs: 50,
						},
						"interrupted",
					],
				] as const) {
					delete row.lifecycle;
					row.statusState = statusState;
					hostModule.__test__.observeRunningSubagent(row, 500);
					assert.equal(projectLifecycle(row.lifecycle, 500).kind, kind);
				}
			});
		} finally {
			Object.assign(root, previous);
		}
	});

	it("does not acquire unowned or retired rows in a real initialized session", () =>
		withAdapterHost(async (f) => {
			const file = join(f.projectDir, "unowned.json");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "unowned",
				activityFile: file,
				now: () => 100,
			});
			recorder.sessionStart();
			recorder.toolExecutionStart("tool", "bash");
			const row = {
				id: "unowned",
				name: "unowned",
				task: "",
				surface: "none",
				startTime: 1,
				sessionFile: "must-not-read",
				interactive: false,
				runtimePlan: undefined,
				lifecycle: createLifecycle(1),
				activityFile: file,
			};
			const commands = f.commands.length;
			const registrations = f.registrations();
			hostModule.__test__.observeRunningSubagent(row, 200);
			assert.equal(projectLifecycle(row.lifecycle, 200).kind, "active");
			assert.equal(f.runtime.session.getControlTaskId(row.id), undefined);
			assert.equal(f.runtime.session.getTask(row.id), undefined);
			assert.equal(f.runtime.session.getHandle(row.id), undefined);
			assert.equal(f.commands.length, commands);
			assert.equal(f.registrations(), registrations);
			const child = await f.launch({ name: "retired", task: "bounded" });
			const control = f.runtime.session.getControlTaskId(child.id);
			await f.finish(child);
			assert.equal(f.runtime.session.getControlTaskId(child.id), undefined);
			assert.equal(f.runtime.session.getRecord(control), undefined);
			const afterCommands = f.commands.length;
			const afterRegistrations = f.registrations();
			hostModule.__test__.observeRunningSubagent(child, 500);
			assert.equal(f.runtime.session.getControlTaskId(child.id), undefined);
			assert.equal(f.runtime.session.getRecord(control), undefined);
			assert.equal(f.commands.length, afterCommands);
			assert.equal(f.registrations(), afterRegistrations);
		}));
});

describe("subagent activity snapshots", () => {
	function validActivity(overrides: any = {}) {
		return {
			version: 1,
			runningChildId: "child-1",
			createdAt: 1_000,
			updatedAt: 1_000,
			sequence: 1,
			latestEvent: "session_start",
			phase: "starting",
			agentActive: false,
			turnActive: false,
			providerActive: false,
			toolActive: false,
			...overrides,
		};
	}

	it("Task15 projects validated activity by reference, not as a parser", () => {
		assert.deepEqual(projectActivity(undefined), {
			ok: false,
			reason: "missing",
		});
		const state = validActivity();
		const read = projectActivity(state);
		assert.ok(read.ok);
		assert.equal(read.activity, state);
	});

	it("Task15 preserves exact file validation order and real read errors", () => {
		withTempDir((dir) => {
			const file = join(dir, "activity.json");
			assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
				ok: false,
				reason: "missing",
			});
			for (const [value, error] of [
				[42, "activity must be an object"],
				[
					{ version: 2, runningChildId: "other" },
					"unsupported activity version",
				],
				[
					validActivity({ runningChildId: 42 }),
					"runningChildId must be a string",
				],
				[
					validActivity({ latestEvent: "invalid", phase: "invalid" }),
					"unknown latestEvent",
				],
				[
					validActivity({ phase: "invalid", activeScope: "invalid" }),
					"unknown activity phase",
				],
				[
					validActivity({ activeScope: "invalid", createdAt: "invalid" }),
					"unknown activeScope",
				],
				[
					validActivity({ createdAt: "invalid", updatedAt: "invalid" }),
					"createdAt must be finite",
				],
				[
					validActivity({ toolName: "bad\nname" }),
					"toolName must not contain newlines",
				],
			] as const) {
				writeFileSync(file, JSON.stringify(value));
				assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
					ok: false,
					reason: "invalid",
					error,
				});
			}
			writeFileSync(
				file,
				JSON.stringify(
					validActivity({ runningChildId: "other", latestEvent: "invalid" }),
				),
			);
			assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
				ok: false,
				reason: "wrong-id",
			});
			const nullable = validActivity({
				activeScope: null,
				activeSince: null,
				waitingSince: null,
				turnIndex: null,
				toolName: null,
				toolCallId: null,
				messageEventType: null,
				toolStartedAt: null,
				toolEndedAt: null,
			});
			writeFileSync(file, JSON.stringify(nullable));
			assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
				ok: true,
				activity: nullable,
			});
			writeFileSync(file, "{");
			let parseError = "";
			try {
				JSON.parse("{");
			} catch (error) {
				parseError = error instanceof Error ? error.message : String(error);
			}
			assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
				ok: false,
				reason: "invalid",
				error: parseError,
			});
			let directoryError = "";
			try {
				readFileSync(dir, "utf8");
			} catch (error) {
				directoryError = error instanceof Error ? error.message : String(error);
			}
			assert.ok(directoryError);
			assert.deepEqual(readSubagentActivityFile(dir, "child-1"), {
				ok: false,
				reason: "invalid",
				error: directoryError,
			});
		});
	});

	it("writes and validates activity files by running child id", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-1");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-1",
				activityFile,
				now: () => 1_000,
			});

			recorder.sessionStart();
			recorder.toolExecutionStart("tool-1", "bash");

			const read = readSubagentActivityFile(activityFile, "child-1");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "active");
			assert.equal(read.activity.activeScope, "tool");
			assert.equal(read.activity.toolName, "bash");

			assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
				ok: false,
				reason: "wrong-id",
			});
		});
	});

	it("records waiting and final done states", () => {
		withTempDir((dir) => {
			let currentNow = 2_000;
			const activityFile = getSubagentActivityFile(dir, "child-2");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-2",
				activityFile,
				now: () => currentNow,
			});

			recorder.sessionStart();
			currentNow = 3_000;
			recorder.agentEndWaiting();
			let read = readSubagentActivityFile(activityFile, "child-2");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "waiting");
			assert.equal(read.activity.waitingSince, 3_000);

			currentNow = 4_000;
			recorder.subagentDone();
			read = readSubagentActivityFile(activityFile, "child-2");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "done");
			assert.equal(read.activity.agentActive, false);
		});
	});

	it("rejects malformed activity fields used by classification and rendering", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, "subagent-activity"), { recursive: true });
			const cases = [
				{ activeSince: "bad" },
				{ waitingSince: "bad" },
				{ activeScope: "database" },
				{ latestEvent: "unknown" },
				{ runningChildId: 42 },
				{ toolActive: "yes" },
				{ toolName: "bad\nname" },
			];

			for (const [index, overrides] of cases.entries()) {
				const activityFile = getSubagentActivityFile(dir, `child-${index}`);
				const activity = validActivity({
					runningChildId: `child-${index}`,
					...overrides,
				});
				writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

				const read = readSubagentActivityFile(activityFile, `child-${index}`);
				if (read.ok) throw new Error("expected an invalid activity read");
				assert.equal(read.reason, "invalid");
			}
		});
	});

	it("does not let tool_result resurrect finished tool activity", () => {
		withTempDir((dir) => {
			let currentNow = 1_000;
			const activityFile = getSubagentActivityFile(dir, "child-3");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-3",
				activityFile,
				now: () => currentNow,
			});

			recorder.sessionStart();
			recorder.agentStart();
			recorder.turnStart(1);
			currentNow = 2_000;
			recorder.toolExecutionStart("tool-1", "bash");
			currentNow = 3_000;
			recorder.toolExecutionEnd("tool-1", "bash");
			currentNow = 4_000;
			recorder.toolResult("tool-1", "bash");

			const read = readSubagentActivityFile(activityFile, "child-3");
			assert.ok(read.ok);
			assert.equal(read.activity.toolActive, false);
			assert.equal(read.activity.activeScope, "turn");
		});
	});

	it("does not mark reload shutdown as the final done snapshot", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-4");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-4",
				activityFile,
				now: () => 1_000,
			});

			recorder.sessionStart();
			recorder.sessionShutdown("reload");

			const read = readSubagentActivityFile(activityFile, "child-4");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "starting");
			assert.equal(read.activity.latestEvent, "session_start");
		});
	});

	it("cancels pending throttled writes on reload shutdown", async () => {
		const dir = createTestDir();
		try {
			await new Promise<void>((resolve) => {
				let currentNow = 1_000;
				const activityFile = getSubagentActivityFile(dir, "child-5");
				const recorder = createSubagentActivityRecorder({
					runningChildId: "child-5",
					activityFile,
					now: () => currentNow,
				});

				recorder.sessionStart();
				currentNow = 1_100;
				recorder.messageUpdate("delta");
				recorder.sessionShutdown("reload");

				setTimeout(() => {
					const read = readSubagentActivityFile(activityFile, "child-5");
					assert.ok(read.ok);
					assert.equal(read.activity.phase, "starting");
					assert.equal(read.activity.latestEvent, "session_start");
					resolve();
				}, 650);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Task13 demand-driven persistent I/O", () => {
	function drain(
		record: PiRunRecord,
		api: Parameters<typeof hostModule.__test__.drainPersistentTaskEvents>[1],
		io: PiPersistentIO,
	) {
		// SAFETY: index.ts owns this process-local extension slot; fixture swaps only its delivery binding.
		const root = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
		const previous = root.pi;
		root.pi = api;
		try {
			hostModule.__test__.drainPersistentTaskEvents(record, api, io);
		} finally {
			root.pi = previous;
		}
	}
	for (const kind of [
		"quiet",
		"irrelevant",
		"behind-cursor",
		"ledger-duplicate",
		"help",
		"done",
	] as const)
		it(`${kind} uses only the required raw/ledger/transcript reads and no Git capture`, () =>
			withTempDir((dir) => {
				const record: PiRunRecord = {
					id: "io-count",
					name: "io-count",
					task: "first",
					surface: "pane",
					startTime: 0,
					sessionFile: join(dir, "session.jsonl"),
					launchScriptFile: "",
					activityFile: "",
					interactive: false,
					runtimePlan: undefined,
					lifecycle: createLifecycle(0),
					persistent: true,
					logicalId: "logical",
					generationId: "generation",
					policyHash: "a".repeat(64),
					tasksCompleted: 0,
					taskId: "task",
					worktree: {
						path: dir,
						branch: "fixture",
						baseRef: "HEAD",
						baseSha: "not-inspected",
						manifestFile: join(dir, "manifest"),
						workspaceId: "fixture-workspace",
						paneId: "pane",
					},
				};
				writeFileSync(
					record.sessionFile,
					JSON.stringify({
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "last nonempty" }],
						},
					}) + "\n",
				);
				if (kind !== "quiet")
					appendPersistentTaskEvent(record.sessionFile, {
						type: kind === "help" ? "help-request" : "task-done",
						task: "task",
						generation: kind === "irrelevant" ? "other" : "generation",
					});
				if (kind === "behind-cursor") record.observedTaskEvents = 1;
				if (kind === "ledger-duplicate")
					appendPersistentDeliveryLedger(record.sessionFile, {
						task: "task",
						outcome: "delivered",
						generation: "generation",
						logicalId: "logical",
						policyHash: record.policyHash!,
					});
				const counts = [0, 0, 0, 0];
				let sends = 0;
				const io: PiPersistentIO = {
					...testIO,
					readEvents: (r) => {
						counts[0]++;
						return testIO.readEvents(r);
					},
					readLedger: (r) => {
						counts[1]++;
						return testIO.readLedger(r);
					},
					readTaskSummary: (r) => {
						counts[2]++;
						return testIO.readTaskSummary(r);
					},
				};
				const exec = childProcess.execFileSync;
				// Preserve every overloaded call unchanged; count only during this drain.
				Reflect.set(
					childProcess,
					"execFileSync",
					(...args: Parameters<typeof exec>) => {
						counts[3]++;
						return exec(...args);
					},
				);
				syncBuiltinESMExports();
				try {
					drain(
						record,
						{
							sendMessage() {
								sends++;
							},
						},
						io,
					);
				} finally {
					childProcess.execFileSync = exec;
					syncBuiltinESMExports();
				}
				assert.deepEqual(counts, [
					1,
					["ledger-duplicate", "help", "done"].includes(kind) ? 1 : 0,
					kind === "done" ? 1 : 0,
					0,
				]);
				assert.equal(sends, kind === "help" || kind === "done" ? 1 : 0);
				assert.equal(
					record.taskId,
					kind === "help" || kind === "done" ? undefined : "task",
				);
			}));
	it("in-flight wakes skip lazy ledger and transcript reads", () =>
		withTempDir((dir) => {
			const record: PiRunRecord = {
				id: "inflight",
				name: "inflight",
				task: "first",
				surface: "pane",
				startTime: 0,
				sessionFile: join(dir, "session.jsonl"),
				launchScriptFile: "",
				activityFile: "",
				interactive: false,
				runtimePlan: undefined,
				lifecycle: createLifecycle(0),
				persistent: true,
				logicalId: "logical",
				generationId: "generation",
				policyHash: "a".repeat(64),
				tasksCompleted: 0,
				taskId: "task",
			};
			appendPersistentTaskEvent(record.sessionFile, {
				type: "task-done",
				task: "task",
				generation: "generation",
			});
			const counts = [0, 0, 0];
			const io = {
				...testIO,
				readEvents: (r: PiRunRecord) => {
					counts[0]++;
					return testIO.readEvents(r);
				},
				readLedger: (r: PiRunRecord) => {
					counts[1]++;
					return testIO.readLedger(r);
				},
				readTaskSummary: (r: PiRunRecord) => {
					counts[2]++;
					return testIO.readTaskSummary(r);
				},
			};
			drain(
				record,
				{
					sendMessage() {
						counts.fill(0);
						hostModule.__test__.drainPersistentTaskEvents(
							record,
							{
								sendMessage() {
									assert.fail("duplicate in-flight send");
								},
							},
							io,
						);
						assert.deepEqual(counts, [1, 0, 0]);
					},
				},
				testIO,
			);
		}));
	for (const fail of ["send", "append"] as const)
		it(`multi-event ${fail} failure preserves earlier acknowledgements and retries only the failing event`, () =>
			withTempDir((dir) => {
				const record: PiRunRecord = {
					id: "multi",
					name: "multi",
					task: "first",
					surface: "pane",
					startTime: 0,
					sessionFile: join(dir, "session.jsonl"),
					launchScriptFile: "",
					activityFile: "",
					interactive: false,
					runtimePlan: undefined,
					lifecycle: createLifecycle(0),
					persistent: true,
					logicalId: "logical",
					generationId: "generation",
					policyHash: "a".repeat(64),
					tasksCompleted: 0,
					taskId: "second",
				};
				appendPersistentTaskEvent(record.sessionFile, {
					type: "task-done",
					task: "first",
					generation: "generation",
				});
				appendPersistentTaskEvent(record.sessionFile, {
					type: "task-done",
					task: "second",
					generation: "generation",
				});
				let allow = false,
					sends = 0,
					reads = 0;
				const io: PiPersistentIO = {
					...testIO,
					readLedger: (r) => {
						reads++;
						return testIO.readLedger(r);
					},
					acknowledge(r, event) {
						if (event.task === "second" && !allow && fail === "append")
							throw new Error("append failure");
						return testIO.acknowledge(r, event);
					},
				};
				const api = {
					sendMessage() {
						sends++;
						if (sends === 2 && !allow && fail === "send")
							throw new Error("send failure");
					},
				};
				assert.throws(
					() => drain(record, api, io),
					new RegExp(`${fail} failure`),
				);
				assert.equal(record.observedTaskEvents, undefined);
				assert.equal(record.taskId, "second");
				assert.equal(record.tasksCompleted, 1);
				assert.equal(testIO.readLedger(record).length, 1);
				allow = true;
				drain(record, api, io);
				assert.equal(reads, 2);
				assert.equal(sends, 3);
				assert.equal(record.observedTaskEvents, 2);
				assert.equal(record.taskId, undefined);
				assert.equal(record.tasksCompleted, 2);
				assert.equal(testIO.readLedger(record).length, 2);
			}));
});

describe("persistent delivery batch ledger", () => {
	const testApi = subagentsModule.__test__;
	// SAFETY: the extension stores this private runtime under the documented global symbol.
	const runtime = (globalThis as Record<symbol, { pi?: unknown } | undefined>)[
		Symbol.for("pi-subagents/runtime")
	];
	const runtimePi = runtime?.pi;
	before(() => {
		if (runtime) runtime.pi = undefined;
	});
	after(() => {
		if (runtime) runtime.pi = runtimePi;
	});
	const makeRunning = (sessionFile: string): any => ({
		id: "batch",
		name: "Batch",
		sessionFile,
		persistent: true,
		generationId: "generation",
		logicalId: "logical",
		policyHash: "a".repeat(64),
		taskId: "task-1",
		tasksCompleted: 0,
	});

	it("reads once for new events and suppresses same-batch duplicates of both outcomes", () => {
		withTempDir((dir) => {
			const running = makeRunning(join(dir, "batch.jsonl"));
			for (const type of ["help-request", "task-done"] as const) {
				for (const task of ["task-1", "task-2", "task-1", "task-2"]) {
					appendPersistentTaskEvent(running.sessionFile, {
						type,
						task,
						generation: "generation",
					});
				}
			}
			let reads = 0;
			const messages: any[] = [];
			const readLedger = (path: string) => {
				reads++;
				return readPersistentDeliveryLedger(path);
			};
			const api = {
				sendMessage(message: any) {
					messages.push(message);
				},
			};
			testApi.drainPersistentTaskEvents(running, api, readLedger);
			assert.equal(reads, 1);
			assert.deepEqual(
				messages.map((message) => message.customType),
				[
					"subagent_ping",
					"subagent_ping",
					"subagent_result",
					"subagent_result",
				],
			);
			assert.equal(readPersistentDeliveryLedger(running.sessionFile).length, 4);
			assert.equal(running.tasksCompleted, 2);
			assert.equal(running.taskId, undefined);
			assert.equal(running.observedTaskEvents, 8);
			appendPersistentTaskEvent(running.sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: "generation",
			});
			testApi.drainPersistentTaskEvents(running, api, readLedger);
			assert.equal(reads, 2);
			assert.equal(messages.length, 4);
		});
	});

	it("does not load the ledger for another generation or an empty drain", () => {
		withTempDir((dir) => {
			const running = makeRunning(join(dir, "generation.jsonl"));
			const readLedger = () => {
				assert.fail("unnecessary ledger read");
			};
			testApi.drainPersistentTaskEvents(
				running,
				{
					sendMessage() {
						assert.fail("unexpected delivery");
					},
				},
				readLedger,
			);
			appendPersistentTaskEvent(running.sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: "other",
			});
			testApi.drainPersistentTaskEvents(
				running,
				{
					sendMessage() {
						assert.fail("unexpected delivery");
					},
				},
				readLedger,
			);
			assert.equal(running.observedTaskEvents, 1);
		});
	});

	for (const type of ["help-request", "task-done"] as const) {
		it(`keeps the snapshot retryable after ${type} append failure`, () => {
			withTempDir((dir) => {
				const running = makeRunning(join(dir, "failure.jsonl"));
				const event = appendPersistentTaskEvent(running.sessionFile, {
					type,
					task: "task-1",
					generation: "generation",
				});
				const ledger = readPersistentDeliveryLedger(running.sessionFile);
				const ledgerFile = getPersistentDeliveryLedgerFile(running.sessionFile);
				mkdirSync(ledgerFile);
				let sends = 0;
				const api = {
					sendMessage() {
						sends++;
					},
				};
				assert.throws(
					() => testApi.deliverPersistentTaskEvent(running, event, api, ledger),
					/EISDIR/,
				);
				assert.equal(sends, 1);
				assert.deepEqual(ledger, []);
				assert.equal(running.taskId, "task-1");
				assert.equal(running.tasksCompleted, 0);
				rmSync(ledgerFile, { recursive: true });
				testApi.deliverPersistentTaskEvent(running, event, api, ledger);
				assert.equal(ledger.length, 1);
				assert.deepEqual(
					ledger,
					readPersistentDeliveryLedger(running.sessionFile),
				);
				testApi.deliverPersistentTaskEvent(running, event, api, ledger);
				assert.equal(sends, 2);
			});
		});

		it(`direct ${type} delivery reads current disk state`, () => {
			withTempDir((dir) => {
				const running = makeRunning(join(dir, "direct.jsonl"));
				const event = appendPersistentTaskEvent(running.sessionFile, {
					type,
					task: "task-1",
					generation: "generation",
				});
				let sends = 0;
				const api = {
					sendMessage() {
						sends++;
					},
				};
				testApi.deliverPersistentTaskEvent(running, event, api);
				testApi.deliverPersistentTaskEvent(running, event, api);
				assert.equal(sends, 1);
				rmSync(getPersistentDeliveryLedgerFile(running.sessionFile));
				testApi.deliverPersistentTaskEvent(running, event, api);
				assert.equal(sends, 2);
			});
		});
	}
});

describe("persistent subagent send", () => {
	const testApi = subagentsModule.__test__;

	it("rejects a follow-up while its dispatched task is logically active", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "active-task.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-active",
				generationId: "generation-active",
			});
			const now = Date.now();
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set("logical-active", {
				id: "logical-active",
				name: "Persistent active",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-active",
				generationId: "generation-active",
				policyHash: policy.policyHash,
				tasksCompleted: 1,
				taskId: "task-1",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			});
			const first = testApi.handleSubagentSend({
				id: "logical-active",
				message: "second",
			});
			const second = testApi.handleSubagentSend({
				id: "logical-active",
				message: "third",
			});
			assert.equal(first.details.outcome, "rejected-busy");
			assert.equal(second.details.outcome, "rejected-busy");
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			testApi.runningSubagents.clear();
		});
	});

	it("marks a dispatched follow-up busy and accepts sends after help", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "dispatch.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-dispatch",
				generationId: "generation-dispatch",
			});
			const now = Date.now();
			testApi.runningSubagents.clear();
			const running = {
				id: "logical-dispatch",
				name: "Persistent dispatch",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-dispatch",
				generationId: "generation-dispatch",
				policyHash: policy.policyHash,
				tasksCompleted: 1,
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting" as const, startedAt: now },
				},
			};
			testApi.runningSubagents.set(running.id, running);
			const dispatched = testApi.handleSubagentSend({
				id: running.id,
				message: "second",
			});
			assert.equal(dispatched.details.outcome, "dispatched");
			assert.equal(
				testApi.runningSubagents.get(running.id)?.taskId,
				dispatched.details.task,
			);
			assert.equal(
				testApi.handleSubagentSend({ id: running.id, message: "third" }).details
					.outcome,
				"rejected-busy",
			);
			appendPersistentTaskEvent(sessionFile, {
				type: "help-request",
				task: dispatched.details.task!,
				generation: running.generationId,
			});
			testApi.deliverPersistentTaskEvent(
				testApi.runningSubagents.get(running.id),
				readPersistentTaskEvents(sessionFile)[0],
				{ sendMessage() {} },
			);
			assert.equal(testApi.runningSubagents.get(running.id)?.taskId, undefined);
			assert.equal(
				testApi.handleSubagentSend({ id: running.id, message: "reply" }).details
					.outcome,
				"dispatched",
			);
			testApi.runningSubagents.clear();
		});
	});

	it("keeps a help-request task active until its steer and ledger append succeed", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "help-delivery.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-help-delivery",
				generationId: "generation-help-delivery",
			});
			const now = Date.now();
			const running: any = {
				id: "logical-help-delivery",
				name: "Persistent help delivery",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-help-delivery",
				generationId: "generation-help-delivery",
				policyHash: policy.policyHash,
				taskId: "task-1",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			};
			const event = appendPersistentTaskEvent(sessionFile, {
				type: "help-request",
				task: "task-1",
				generation: running.generationId,
				message: "Need direction.",
			});
			assert.throws(
				() =>
					testApi.deliverPersistentTaskEvent(running, event, {
						sendMessage() {
							throw new Error("stale API");
						},
					}),
				/stale API/,
			);
			assert.equal(running.taskId, "task-1");
			assert.equal(readPersistentDeliveryLedger(sessionFile).length, 0);

			const messages: any[] = [];
			testApi.deliverPersistentTaskEvent(running, event, {
				sendMessage(message: any) {
					messages.push(message);
				},
			});
			assert.equal(running.taskId, undefined);
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).filter(
					(entry) => entry.outcome === "help-requested",
				).length,
				1,
			);
			assert.equal(messages.length, 1);
		});
	});

	it("records a task delivery only after its result steer succeeds", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "delivery.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-delivery",
				generationId: "generation-delivery",
			});
			const now = Date.now();
			const running: any = {
				id: "logical-delivery",
				name: "Persistent delivery",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-delivery",
				generationId: "generation-delivery",
				policyHash: policy.policyHash,
				taskId: "task-1",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			};
			const event = appendPersistentTaskEvent(sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: running.generationId,
			});
			assert.throws(
				() =>
					testApi.deliverPersistentTaskEvent(running, event, {
						sendMessage() {
							throw new Error("stale API");
						},
					}),
				/stale API/,
			);
			assert.equal(readPersistentDeliveryLedger(sessionFile).length, 0);
			const messages: any[] = [];
			testApi.deliverPersistentTaskEvent(running, event, {
				sendMessage(message: any) {
					messages.push(message);
				},
			});
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).at(-1)?.outcome,
				"delivered",
			);
			assert.equal(messages[0].details.logicalId, running.logicalId);
			assert.equal(messages[0].details.generationId, running.generationId);
			assert.equal(messages[0].details.policyHash, running.policyHash);
		});
	});

	it("drains final task events before sending a persistent crash notice", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "crash-drain.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-crash-drain",
				generationId: "generation-crash-drain",
			});
			const now = Date.now();
			const running: any = {
				id: "logical-crash-drain",
				name: "Persistent crash drain",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-crash-drain",
				generationId: "generation-crash-drain",
				policyHash: policy.policyHash,
				taskId: "task-1",
				observedTaskEvents: 0,
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			};
			appendPersistentTaskEvent(sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: running.generationId,
			});
			const { api, sentMessages } = createMockExtensionApi();
			subagentsModule.default(api);
			testApi.notifyPersistentCrash(running, api);

			assert.equal(
				readPersistentDeliveryLedger(sessionFile).at(-1)?.outcome,
				"delivered",
			);
			assert.equal(sentMessages.length, 2);
			assert.equal(sentMessages[0].message.details.task, "task-1");
			assert.equal(sentMessages[1].message.details.error, "persistent-crash");
			assert.match(sentMessages[1].message.content, /task-1=delivered/);
		});
	});

	it("rejects sends after a stop request", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "stopping.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stopping",
				generationId: "generation-stopping",
			});
			const now = Date.now();
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set("logical-stopping", {
				id: "logical-stopping",
				name: "Persistent stopping",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-stopping",
				generationId: "generation-stopping",
				policyHash: policy.policyHash,
				tasksCompleted: 1,
				stopState: "requested",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			});
			assert.equal(
				testApi.handleSubagentSend({ id: "logical-stopping", message: "nope" })
					.details.outcome,
				"rejected-busy",
			);
			testApi.runningSubagents.clear();
		});
	});

	it("fails closed after an unconfirmed stop without dispatching", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "unconfirmed-stop.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-unconfirmed-stop",
				generationId: "generation-unconfirmed-stop",
			});
			const now = Date.now();
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set("logical-unconfirmed-stop", {
				id: "logical-unconfirmed-stop",
				name: "Persistent unconfirmed stop",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-unconfirmed-stop",
				generationId: "generation-unconfirmed-stop",
				policyHash: policy.policyHash,
				tasksCompleted: 1,
				stopState: "failed",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			});

			const result = testApi.handleSubagentSend({
				id: "logical-unconfirmed-stop",
				message: "next",
			});

			assert.equal(result.details.outcome, "rejected-busy");
			assert.match(result.details.error!, /unconfirmed-stop state/);
			assert.match(result.details.error!, new RegExp(sessionFile));
			assert.match(result.details.error!, /subagent_stop again/);
			assert.match(result.details.error!, /spawn a new specialist/);
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).some(
					(entry) => entry.outcome === "dispatched",
				),
				false,
			);
			testApi.runningSubagents.clear();
		});
	});

	it("records one busy rejection without creating an inbox", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "persistent.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-1",
				generationId: "generation-1",
			});
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set("logical-1", {
				id: "logical-1",
				name: "Persistent",
				task: "first",
				surface: "pane",
				startTime: Date.now(),
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-1",
				generationId: "generation-1",
				policyHash: policy.policyHash,
				lifecycle: {
					...createLifecycle(Date.now()),
					turn: { kind: "active", startedAt: Date.now(), source: "fallback" },
				},
			});
			const result = testApi.handleSubagentSend({
				id: "logical-1",
				message: "second",
			});
			assert.equal(result.details.outcome, "rejected-busy");
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).filter(
					(entry) => entry.outcome === "rejected-busy",
				).length,
				1,
			);
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			testApi.runningSubagents.clear();
		});
	});
});

describe("type guard aliases", () => {
	it("keeps both object predicate names equivalent", () => {
		assert.equal(isPlainObject({ value: true }), true);
		assert.equal(isRecord({ value: true }), true);
		assert.equal(isPlainObject(null), false);
	});
});

describe("persistent subagent stop", () => {
	const testApi = subagentsModule.__test__;

	function persistentFixture(
		sessionFile: string,
		policyHash: string,
		active = false,
	) {
		const now = Date.now();
		return {
			id: "logical-stop",
			name: "Persistent stop",
			task: "first",
			surface: "pane",
			startTime: now,
			sessionFile,
			interactive: false,
			runtimePlan: undefined,
			persistent: true,
			logicalId: "logical-stop",
			generationId: "generation-stop",
			policyHash,
			taskId: "task-1",
			inboxSequence: 0,
			lifecycle: {
				...createLifecycle(now),
				process: { kind: "running" as const, startedAt: now, confirmedAt: now },
				turn: active
					? {
							kind: "active" as const,
							startedAt: now,
							source: "fallback" as const,
						}
					: { kind: "waiting" as const, startedAt: now },
			},
		};
	}

	it("records stop-pending for an active task and never abandons it", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "stop-pending.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set(
				"logical-stop",
				persistentFixture(sessionFile, policy.policyHash, true),
			);
			const result = testApi.handleSubagentStop(
				{ id: "logical-stop" },
				{ sendMessage() {} },
				60_000,
			);
			assert.equal(result.details.status, "stop_pending");
			assert.equal(
				testApi.runningSubagents.get("logical-stop")?.taskId,
				"task-1",
			);
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).at(-1)?.outcome,
				"stop-pending",
			);
			testApi.runningSubagents.clear();
		});
	});

	it("starts the stop timeout after its active task settles", async () => {
		const dir = createTestDir();
		try {
			const sessionFile = join(dir, "delayed-stop.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			const running = persistentFixture(sessionFile, policy.policyHash, true);
			testApi.runningSubagents.set(running.id, running);
			const messages: any[] = [];
			const api = {
				sendMessage(message: any) {
					messages.push(message);
				},
			};
			testApi.handleSubagentStop({ id: running.id }, api, 0);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(running.stopState, "pending");
			const event = appendPersistentTaskEvent(sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: running.generationId!,
			});
			testApi.deliverPersistentTaskEvent(running, event, api);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(running.stopState, "failed");
			assert.equal(
				messages.filter((message) =>
					/exit was not confirmed/.test(message.content),
				).length,
				1,
			);
		} finally {
			testApi.runningSubagents.clear();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rearms a bounded stop timeout after a prior timeout fails", async () => {
		const dir = createTestDir();
		try {
			const sessionFile = join(dir, "retry-stop-timeout.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			const running = persistentFixture(sessionFile, policy.policyHash);
			running.taskId = undefined;
			running.tasksCompleted = 1;
			testApi.runningSubagents.set(running.id, running);
			const messages: any[] = [];
			const api = {
				sendMessage(message: any) {
					messages.push(message);
				},
			};

			testApi.handleSubagentStop({ id: running.id }, api, 0);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(running.stopState, "failed");
			assert.equal(running.stopTimeout, undefined);

			testApi.handleSubagentStop({ id: running.id }, api, 0);
			assert.equal(running.stopState, "requested");
			assert.ok(running.stopTimeout);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(running.stopState, "failed");
			assert.equal(running.stopTimeout, undefined);
			assert.equal(messages.length, 2);
		} finally {
			testApi.runningSubagents.clear();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries a failed stop after an active task settles", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "retry-active-stop.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			const running = persistentFixture(sessionFile, policy.policyHash, true);
			running.stopState = "failed";
			testApi.runningSubagents.set(running.id, running);

			const result = testApi.handleSubagentStop(
				{ id: running.id },
				{ sendMessage() {} },
				60_000,
			);

			assert.equal(result.details.status, "stop_pending");
			assert.equal(running.stopState, "pending");
			assert.equal(running.stopTimeout, undefined);
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).at(-1)?.outcome,
				"stop-pending",
			);
			const event = appendPersistentTaskEvent(sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: running.generationId!,
			});
			testApi.deliverPersistentTaskEvent(running, event, { sendMessage() {} });
			assert.ok(running.stopTimeout);
			clearTimeout(running.stopTimeout);
			running.stopTimeout = undefined;
			testApi.runningSubagents.clear();
		});
	});

	it("projects an unconfirmed stop as stalled instead of idle", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "failed-stop-state.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			const running = persistentFixture(sessionFile, policy.policyHash);
			running.taskId = undefined;
			running.tasksCompleted = 1;
			running.stopState = "failed";
			testApi.runningSubagents.set(running.id, running);
			assert.equal(testApi.persistentSpecialistState(running), "stalled");
			assert.match(
				testApi.formatLivePersistentSpecialists().join("\n"),
				/Persistent stop .*\| stalled \|/,
			);
			testApi.runningSubagents.clear();
		});
	});

	it("fails closed when bounded stop exit confirmation is unavailable", async () => {
		await new Promise<void>((resolve, reject) =>
			withTempDir((dir) => {
				const sessionFile = join(dir, "stop-timeout.jsonl");
				const policy = writeSubagentSessionPolicy(sessionFile, {
					owner: "public",
					tools: ["read"],
					deniedTools: [],
					persistent: true,
					logicalId: "logical-stop",
					generationId: "generation-stop",
				});
				const messages: any[] = [];
				testApi.runningSubagents.clear();
				const running = persistentFixture(sessionFile, policy.policyHash);
				running.taskId = undefined;
				testApi.runningSubagents.set("logical-stop", running);
				testApi.handleSubagentStop(
					{ id: "logical-stop" },
					{
						sendMessage(message: any) {
							messages.push(message);
						},
					},
					0,
				);
				setTimeout(() => {
					try {
						assert.equal(
							testApi.runningSubagents.get("logical-stop")?.stopState,
							"failed",
						);
						assert.equal(messages.length, 1);
						assert.match(messages[0].content, /exit was not confirmed/);
						resolve();
					} catch (error) {
						reject(error);
					} finally {
						testApi.runningSubagents.clear();
					}
				}, 5);
			}),
		);
	});

	it("rejects a persistent spawn at the cap before resource creation", () => {
		testApi.runningSubagents.clear();
		try {
			for (let index = 0; index < 3; index++) {
				const fixture = persistentFixture(`session-${index}`, "a".repeat(64));
				fixture.taskId = undefined;
				testApi.runningSubagents.set(`logical-${index}`, {
					...fixture,
					id: `logical-${index}`,
					name: `Specialist ${index}`,
					tasksCompleted: index,
				});
			}
			assert.match(
				testApi.persistentCapacityError({ maxAgents: 3 }),
				/Specialist 0 \(idle, 0 completed\)/,
			);
		} finally {
			testApi.runningSubagents.clear();
		}
	});

	it("recognizes only explicit child stop directives", () => {
		assert.equal(
			isPersistentStopDirective({
				version: 1,
				type: "stop",
				task: "stop",
				message: "",
				at: "now",
			}),
			true,
		);
		assert.equal(
			isPersistentStopDirective({
				version: 1,
				task: "task",
				message: "next",
				at: "now",
			}),
			false,
		);
	});
});

describe("subagent interruption", () => {
	interface RunningFixtureOverrides {
		id?: string;
		name?: string;
		surface?: string;
		sessionFile?: string;
		lifecycle?: SubagentLifecycle;
		activityFile?: string;
		abortController?: Pick<AbortController, "abort">;
	}

	function makeRunning(overrides: RunningFixtureOverrides = {}) {
		return {
			id: "a1",
			name: "Worker",
			task: "",
			surface: "pane-1",
			startTime: 0,
			sessionFile: "worker.jsonl",
			interactive: false,
			runtimePlan: undefined,
			lifecycle: createLifecycle(0),
			...overrides,
		};
	}

	it("registers subagent_interrupt in the main session extension", () => {
		const { api, registeredTools } = createMockExtensionApi();

		subagentsModule.default(api);

		assert.equal(
			registeredTools.some((tool) => tool.name === "subagent_interrupt"),
			true,
		);
	});

	it("resolves interrupt targets by exact id and reports name ambiguity", () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		runningMap.clear();

		try {
			runningMap.set(
				"a1",
				makeRunning({
					id: "a1",
					name: "Worker",
					surface: "a1",
					sessionFile: "a1.jsonl",
				}),
			);
			runningMap.set(
				"b2",
				makeRunning({
					id: "b2",
					name: "Worker",
					surface: "b2",
					sessionFile: "b2.jsonl",
				}),
			);
			runningMap.set(
				"c3",
				makeRunning({
					id: "c3",
					name: "Scout",
					surface: "c3",
					sessionFile: "c3.jsonl",
				}),
			);

			const byId = testApi.resolveInterruptTarget({ id: "c3", name: "Worker" });
			assert.equal(byId.running.id, "c3");

			const ambiguous = testApi.resolveInterruptTarget({ name: "Worker" });
			assert.match(ambiguous.error, /Ambiguous subagent name/);
		} finally {
			runningMap.clear();
		}
	});

	it("returns an explicit error when Escape delivery fails", async () => {
		const testApi = subagentsModule.__test__;
		let aborted = false;
		const running = makeRunning({
			abortController: {
				abort() {
					aborted = true;
				},
			},
		});

		const result = await testApi.requestSubagentInterrupt(running, () => {
			throw new Error("mux write failed");
		});

		assert.match(result.error, /Failed to send Escape/);
		assert.equal(aborted, false);
		assert.equal("interruptRequested" in running, false);
	});

	it("leaves status unchanged when Escape delivery fails in the tool path", async () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		runningMap.clear();

		const activeLifecycle = observeLifecycleActivity(
			createLifecycle(0),
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: "a1",
					createdAt: 0,
					updatedAt: 5_000,
					sequence: 1,
					latestEvent: "tool_execution_start",
					phase: "active",
					agentActive: true,
					turnActive: true,
					providerActive: false,
					toolActive: true,
					activeScope: "tool",
					activeSince: 5_000,
					toolName: "bash",
				},
			},
			5_000,
		);

		try {
			runningMap.set("a1", makeRunning({ lifecycle: activeLifecycle }));

			const result = await withMockedNowAsync(20_000, () =>
				testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
					throw new Error("mux write failed");
				}),
			);

			assert.match(result.content[0].text, /Failed to send Escape/);
			assert.equal(
				projectLifecycle(runningMap.get("a1").lifecycle, 20_000).kind,
				"active",
			);
		} finally {
			runningMap.clear();
		}
	});

	it("returns an explicit error when async Escape delivery rejects", async () => {
		const testApi = subagentsModule.__test__;
		const abortController = new AbortController();
		const running = { ...makeRunning(), abortController };

		const result = await testApi.requestSubagentInterrupt(running, async () => {
			throw new Error("async mux write failed");
		});

		assert.ok("error" in result);
		assert.match(result.error, /Failed to send Escape/);
		assert.match(result.error, /async mux write failed/);
		assert.equal(abortController.signal.aborted, false);
		assert.equal("interruptRequested" in running, false);
	});

	it("sends Escape without aborting or mutating running state", async () => {
		const testApi = subagentsModule.__test__;
		let aborted = false;
		let sentSurface = "";
		const running = makeRunning({
			abortController: {
				abort() {
					aborted = true;
				},
			},
		});

		const result = await testApi.requestSubagentInterrupt(
			running,
			async (surface: string) => {
				await Promise.resolve();
				sentSurface = surface;
			},
		);

		assert.deepEqual(result, { ok: true });
		assert.equal(sentSurface, "pane-1");
		assert.equal(aborted, false);
		assert.equal("interruptRequested" in running, false);
	});

	it("refreshes the latest activity snapshot before forcing local interrupt waiting", async () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		let sentSurface = "";
		runningMap.clear();

		const dir = createTestDir();
		try {
			mkdirSync(join(dir, "subagent-activity"), { recursive: true });
			const activityFile = getSubagentActivityFile(dir, "a1");
			const activity = {
				version: 1,
				runningChildId: "a1",
				createdAt: 1_000,
				updatedAt: 19_000,
				sequence: 7,
				latestEvent: "tool_execution_start",
				phase: "active",
				agentActive: true,
				turnActive: true,
				providerActive: false,
				toolActive: true,
				activeScope: "tool",
				activeSince: 19_000,
				toolName: "bash",
			};
			writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

			runningMap.set("a1", makeRunning({ activityFile }));

			await withMockedNowAsync(20_000, () =>
				testApi.handleSubagentInterrupt(
					{ name: "Worker" },
					(surface: string) => {
						sentSurface = surface;
					},
				),
			);

			assert.equal(sentSurface, "pane-1");
			const lifecycle = runningMap.get("a1").lifecycle;
			const projection = projectLifecycle(lifecycle, 20_000);
			assert.equal(projection.kind, "interrupted");
			assert.equal(lifecycle.turn.kind, "interrupted");
			assert.equal(lifecycle.lastActivitySequence, 7);
			assert.equal(lifecycle.turn.previousActivitySequence, 7);
		} finally {
			runningMap.clear();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("acknowledges Pi-backed interrupt requests and forces local status waiting", async () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		let sentSurface = "";
		runningMap.clear();

		const activeLifecycle = observeLifecycleActivity(
			createLifecycle(0),
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: "a1",
					createdAt: 0,
					updatedAt: 5_000,
					sequence: 1,
					latestEvent: "tool_execution_start",
					phase: "active",
					agentActive: true,
					turnActive: true,
					providerActive: false,
					toolActive: true,
					activeScope: "tool",
					activeSince: 5_000,
					toolName: "bash",
				},
			},
			5_000,
		);

		try {
			runningMap.set("a1", makeRunning({ lifecycle: activeLifecycle }));

			const result = await withMockedNowAsync(20_000, () =>
				testApi.handleSubagentInterrupt(
					{ name: "Worker" },
					(surface: string) => {
						sentSurface = surface;
					},
				),
			);

			assert.equal(sentSurface, "pane-1");
			assert.equal(
				result.content[0].text,
				'Interrupt requested for subagent "Worker".',
			);
			assert.deepEqual(result.details, {
				id: "a1",
				name: "Worker",
				status: "interrupt_requested",
			});
			const projection = projectLifecycle(
				runningMap.get("a1").lifecycle,
				20_000,
			);
			assert.equal(projection.kind, "interrupted");
			assert.equal(runningMap.has("a1"), true);
		} finally {
			runningMap.clear();
		}
	});

	it("sends Escape again for repeated interrupt requests", async () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		const surfaces: string[] = [];
		runningMap.clear();

		try {
			runningMap.set("a1", makeRunning());

			await testApi.handleSubagentInterrupt(
				{ name: "Worker" },
				(surface: string) => {
					surfaces.push(surface);
				},
			);
			await testApi.handleSubagentInterrupt(
				{ name: "Worker" },
				(surface: string) => {
					surfaces.push(surface);
				},
			);

			assert.deepEqual(surfaces, ["pane-1", "pane-1"]);
			assert.equal(runningMap.has("a1"), true);
		} finally {
			runningMap.clear();
		}
	});

	it("formats exit code 130 as an ordinary failure", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 130,
				elapsed: 61,
				summary: "Sub-agent exited with code 130",
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Worker",
		);

		assert.match(presentation, /failed \(exit code 130\)/);
		assert.doesNotMatch(presentation, /interrupted/);
		assert.match(presentation, /Resume: pi --session/);
	});

	it("renders a clear provider/agent error when errorMessage is set", () => {
		// Previously, an overload retry-exhaustion produced exitCode 0 with a
		// stale summary — the orchestrator thought the subagent finished
		// quickly. With the error sidecar plumbed through, the presentation
		// must call out the failure, include the underlying error, and tell the
		// orchestrator how to recover.
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 14,
				summary: "ignored when errorMessage is present",
				sessionFile: "/tmp/subagent.jsonl",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			},
			"Worker",
		);

		assert.match(presentation, /Sub-agent "Worker" failed/);
		assert.match(presentation, /provider\/agent error/);
		assert.doesNotMatch(presentation, /auto-retry exhausted/);
		assert.match(
			presentation,
			/Error: Anthropic 529 Overloaded after 3 retries/,
		);
		assert.match(presentation, /subagent_resume/);
		assert.match(presentation, /Resume: pi --session/);
		assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
	});

	it("does not advance fallback for a valid negative task result", () => {
		const testApi = subagentsModule.__test__;
		assert.equal(
			testApi.shouldAdvanceToFallback({ errorMessage: undefined }, 1),
			false,
		);
		assert.equal(
			testApi.shouldAdvanceToFallback({ errorMessage: "provider failed" }, 1),
			true,
		);
		assert.equal(
			testApi.shouldAdvanceToFallback({ errorMessage: "provider failed" }, 0),
			false,
		);
		assert.equal(
			testApi.shouldAdvanceToFallback(
				{ errorMessage: "provider failed" },
				1,
				true,
			),
			false,
		);
	});

	it("preserves raw account/model errors and model evidence without retry claims", () => {
		const testApi = subagentsModule.__test__;
		const modelRef = "openai-codex/gpt-5.4";
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 5,
				summary: "ignored",
				sessionFile: "/tmp/subagent.jsonl",
				errorMessage:
					"Codex error: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
				fallbackAttempts: [modelRef],
				runtimePlan: {
					provider: "openai-codex",
					modelId: "gpt-5.4",
					model: modelRef,
					thinking: "medium",
					modelSource: "request",
					thinkingSource: "request",
				},
			},
			"Worker",
		);

		assert.match(presentation, /Requested model: openai-codex\/gpt-5\.4/);
		assert.match(presentation, /Model used: openai-codex\/gpt-5\.4/);
		assert.match(
			presentation,
			/Error: Codex error: The 'gpt-5\.4' model is not supported.*ChatGPT account/,
		);
		assert.match(presentation, /Next action: check the raw provider reason/);
		assert.doesNotMatch(presentation, /auto-retry exhausted|permanent failure/);
	});

	it("reports ordered fallback causes, attempted models, and the model used on success", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 6,
				summary: "Useful result",
				fallbackAttempts: ["fake/primary", "fake/middle", "fake/secondary"],
				fallbackFailures: [
					{ model: "fake/primary", error: "provider rejected fake/primary" },
					{ model: "fake/middle", error: "provider rejected fake/middle" },
				],
				runtimePlan: {
					provider: "fake",
					modelId: "secondary",
					model: "fake/secondary",
					thinking: "medium",
					modelSource: "request",
					thinkingSource: "request",
				},
			},
			"Worker",
		);

		assert.match(presentation, /Requested model: fake\/primary/);
		assert.match(
			presentation,
			/Models attempted: fake\/primary, fake\/middle, fake\/secondary/,
		);
		assert.match(presentation, /Model used: fake\/secondary/);
		assert.match(
			presentation,
			/Model failures .*fake\/primary: provider rejected fake\/primary.*fake\/middle: provider rejected fake\/middle/s,
		);
		assert.doesNotMatch(presentation, /auto-retry exhausted/);
	});

	it("reports every rejected fallback candidate without inventing retry counts", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 7,
				summary: "ignored",
				errorMessage: "provider rejected fake/secondary",
				fallbackAttempts: ["fake/primary", "fake/middle", "fake/secondary"],
				fallbackFailures: [
					{ model: "fake/primary", error: "provider rejected fake/primary" },
					{ model: "fake/middle", error: "provider rejected fake/middle" },
					{
						model: "fake/secondary",
						error: "provider rejected fake/secondary",
					},
				],
				runtimePlan: {
					provider: "fake",
					modelId: "secondary",
					model: "fake/secondary",
					thinking: "medium",
					modelSource: "request",
					thinkingSource: "request",
				},
			},
			"Worker",
		);

		assert.match(
			presentation,
			/Models attempted: fake\/primary, fake\/middle, fake\/secondary/,
		);
		assert.match(presentation, /Model used: fake\/secondary/);
		assert.match(
			presentation,
			/Model failures .*fake\/primary: provider rejected fake\/primary.*fake\/middle: provider rejected fake\/middle.*fake\/secondary: provider rejected fake\/secondary/s,
		);
		assert.doesNotMatch(presentation, /auto-retry exhausted|after \d+ retries/);
	});

	it("leaves small completion presentations unchanged", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: "Useful result",
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Reviewer",
		);

		assert.equal(
			presentation,
			'Sub-agent "Reviewer" completed (5s).\n\nUseful result\n\n' +
				"Session: /tmp/subagent.jsonl\nResume: pi --session /tmp/subagent.jsonl",
		);
	});

	it("includes a reviewable worktree handoff in completion presentations", () => {
		const testApi = subagentsModule.__test__;
		const worktree = {
			path: "/tmp/worktrees/ticket-123",
			workspaceId: "w9",
			paneId: "w9:p1",
			branch: "ticket/123",
			baseSha: "1111111",
			headSha: "2222222",
			commitsAhead: 2,
			clean: false,
			conflicted: false,
			changedFiles: ["src/auth.ts", "test/auth.test.ts"],
			untrackedFiles: ["notes.txt"],
		};

		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: "Implemented ticket 123",
				sessionFile: "/tmp/subagent.jsonl",
				worktree,
			},
			"Worker",
		);

		assert.match(presentation, /Worktree: \/tmp\/worktrees\/ticket-123/);
		assert.match(presentation, /Branch: ticket\/123/);
		assert.match(presentation, /Base\/head: 1111111 -> 2222222/);
		assert.match(presentation, /State: dirty · 2 commits ahead/);
		assert.match(presentation, /Changed: src\/auth\.ts, test\/auth\.test\.ts/);
		assert.match(presentation, /Untracked: notes\.txt/);
		assert.match(
			presentation,
			/After review and preservation, explicitly remove/,
		);
		assert.match(presentation, /herdr worktree remove --workspace w9/);
		assert.match(presentation, /\/worktree remove w9/);
		assert.match(presentation, /worktree_remove/);
		assert.equal(testApi.shouldRetainSubagentSurface({ worktree }), true);
		assert.equal(testApi.shouldRetainSubagentSurface({}), false);
	});

	it("captures committed and uncommitted worktree state for the parent", () => {
		withTempDir((dir) => {
			execFileSync("git", ["init", "-q"], { cwd: dir });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: dir,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: dir,
			});
			writeFileSync(join(dir, "tracked.txt"), "base\n");
			execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: dir,
				encoding: "utf8",
			}).trim();

			writeFileSync(join(dir, "committed.txt"), "committed\n");
			execFileSync("git", ["add", "committed.txt"], { cwd: dir });
			execFileSync("git", ["commit", "-qm", "ticket"], { cwd: dir });
			writeFileSync(join(dir, "tracked.txt"), "dirty\n");
			writeFileSync(join(dir, "untracked.txt"), "new\n");

			const handoff = captureWorktreeHandoff({
				path: dir,
				workspaceId: "w9",
				paneId: "w9:p1",
				branch: "ticket/123",
				baseRef: "HEAD",
				baseSha,
				manifestFile: join(dir, "manifest.json"),
			});

			assert.equal(handoff.baseSha, baseSha);
			assert.equal(handoff.commitsAhead, 1);
			assert.equal(handoff.clean, false);
			assert.equal(handoff.conflicted, false);
			assert.deepEqual(handoff.changedFiles, [
				"committed.txt",
				"tracked.txt",
				"untracked.txt",
			]);
			assert.deepEqual(handoff.untrackedFiles, ["untracked.txt"]);
			assert.match(handoff.headSha, /^[0-9a-f]{40}$/);
		});
	});

	it("reports unknown state when worktree Git inspection fails", () => {
		withTempDir((dir) => {
			const worktree = {
				path: join(dir, "missing"),
				workspaceId: "w9",
				paneId: "w9:p1",
				branch: "ticket/123",
				baseRef: "HEAD",
				baseSha: "1111111",
				manifestFile: join(dir, "manifest.json"),
			};
			const testApi = subagentsModule.__test__;
			const handoff = captureWorktreeHandoff(worktree);

			assert.equal(handoff.headSha, null);
			assert.equal(handoff.commitsAhead, null);
			assert.equal(handoff.clean, null);
			assert.equal(handoff.conflicted, null);
			assert.equal(handoff.changedFiles, null);
			assert.equal(handoff.untrackedFiles, null);
			assert.match(handoff.gitError, /ENOENT|no such file/i);

			const presentation = testApi.resolveResultPresentation(
				{
					exitCode: 1,
					elapsed: 1,
					summary: "Launch failed",
					worktree: handoff,
				},
				"Worker",
			);
			assert.match(
				presentation,
				/State: inspection unknown · commits ahead unknown/,
			);
			assert.match(presentation, /Base\/head: 1111111 -> unknown/);
		});
	});

	it("marks launch failures as failed while retaining explicit ownership", async () => {
		const dir = mkdtempSync(join(tmpdir(), "worktree-launch-failure-"));
		try {
			const manifestFile = join(
				dir,
				"artifacts",
				"parent",
				"worktree-runs",
				"run-1.json",
			);
			const worktree = {
				path: join(dir, "retained-worktree"),
				workspaceId: "w9",
				paneId: "w9:p1",
				branch: "ticket/123",
				baseRef: "HEAD",
				baseSha: "1111111",
				manifestFile,
			};
			writeWorktreeManifest(manifestFile, {
				state: "provisioning",
				id: "run-1",
			});

			const effects = createWorktreeOperations();
			effects.resolveGitCommit = () => worktree.baseSha;
			effects.resolveWorktreeProvisionCwd = (cwd) => cwd;
			await assert.rejects(
				launchPiSubagent(
					{
						kind: "fresh",
						id: "run-1",
						name: "Worker",
						task: "bounded",
						worktree: { branch: worktree.branch },
						parent: {
							cwd: dir,
							sessionFile: join(dir, "parent.jsonl"),
							sessionId: "parent",
							sessionDir: dir,
							agentDir: dir,
						},
						runtimePlan: {
							provider: "test",
							modelId: "one",
							model: "test/one",
							thinking: "off",
							modelSource: "request",
							thinkingSource: "request",
						},
						behavior: {
							deniedTools: [],
							autoExit: true,
							interactive: false,
							sessionMode: "standalone",
						},
					},
					{
						worktree: effects,
						createPane: () => {
							throw new Error("unexpected ordinary pane");
						},
						createWorktree: () => worktree,
						waitForShellReady: async () => {},
						runScript: () => {
							throw new Error("pane rejected command");
						},
						closePane: () => {
							throw new Error("must retain worktree");
						},
					},
				),
				/worktree retained.*pane rejected command/i,
			);

			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.owner, "pi-herdr-subagents");
			assert.equal(manifest.kind, "worktree-run");
			assert.equal(manifest.id, "run-1");
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.path, worktree.path);
			assert.match(manifest.gitError, /ENOENT|no such file/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("abbreviates large completion presentations while preserving their head, tail, and session path", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: `HEAD-${"h".repeat(9_000)}-MIDDLE-${"t".repeat(9_000)}-TAIL`,
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Reviewer",
		);

		assert.ok(presentation.length <= 16_000);
		assert.match(presentation, /HEAD-/);
		assert.doesNotMatch(presentation, /-MIDDLE-/);
		assert.match(presentation, /-TAIL/);
		assert.match(presentation, /result abbreviated/i);
		assert.match(presentation, /Session: \/tmp\/subagent\.jsonl/);
		assert.match(presentation, /Resume: pi --session \/tmp\/subagent\.jsonl/);
	});

	it("abbreviates oversized provider errors without losing recovery guidance", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 5,
				summary: "ignored",
				sessionFile: "/tmp/subagent.jsonl",
				errorMessage: `ERROR-HEAD-${"x".repeat(18_000)}-ERROR-TAIL`,
			},
			"Reviewer",
		);

		assert.ok(presentation.length <= 16_000);
		assert.match(presentation, /ERROR-HEAD/);
		assert.match(presentation, /ERROR-TAIL/);
		assert.match(presentation, /result abbreviated/i);
		assert.match(presentation, /subagent_resume/);
		assert.match(presentation, /Resume: pi --session \/tmp\/subagent\.jsonl/);
	});

	it("keeps presentations bounded even when a session reference exceeds filesystem limits", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: "Useful result",
				sessionFile: `/tmp/${"x".repeat(20_000)}/subagent.jsonl`,
			},
			"Reviewer",
		);

		assert.ok(presentation.length <= 16_000);
		assert.match(presentation, /session reference abbreviated/i);
	});

	it("bounds unexpected errors from both fresh and resumed delivery paths", () => {
		const testApi = subagentsModule.__test__;
		const error = new Error(`ERROR-HEAD-${"x".repeat(18_000)}-ERROR-TAIL`);

		for (const prefix of ['Sub-agent "Reviewer" error', "Resume error"]) {
			const presentation = testApi.resolveUnexpectedErrorPresentation(
				prefix,
				error,
				"/tmp/subagent.jsonl",
			);

			assert.ok(presentation.length <= 16_000);
			assert.match(presentation, /ERROR-HEAD/);
			assert.match(presentation, /ERROR-TAIL/);
			assert.match(presentation, /Session: \/tmp\/subagent\.jsonl/);
		}
	});

	it("preserves the existing session-before-runtime-warning order for small results", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: "Useful result",
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Reviewer",
			"requested model unavailable",
		);

		assert.equal(
			presentation,
			'Sub-agent "Reviewer" completed (5s).\n\nUseful result\n\n' +
				"Session: /tmp/subagent.jsonl\nResume: pi --session /tmp/subagent.jsonl\n\n" +
				"Runtime warning: requested model unavailable",
		);
	});

	it("delivers bounded fresh and resumed results through one custom message", () => {
		const testApi = subagentsModule.__test__;

		for (const name of ["fresh", "resumed"]) {
			const { api, sentMessages, sentUserMessages } = createMockExtensionApi();
			const sessionFile = `/tmp/${name}.jsonl`;
			const details = {
				name,
				sessionFile,
				fallbackAttempts: ["fake/primary", "fake/secondary"],
				errorMessage: "provider failed",
				runtimePlan: { model: "fake/secondary" },
				worktree: { path: "/tmp/worktree" },
			};
			testApi.sendSubagentResult(
				api,
				`HEAD-${"x".repeat(18_000)}-TAIL\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}`,
				details,
			);

			assert.equal(sentMessages.length, 1);
			const delivered = sentMessages[0];
			assert.equal(delivered.message.customType, "subagent_result");
			assert.ok(delivered.message.content.length <= 16_000);
			assert.match(delivered.message.content, /HEAD-/);
			assert.match(delivered.message.content, /-TAIL/);
			assert.match(
				delivered.message.content,
				/Parent action: Continue the parent task using this result/,
			);
			const resultContent = delivered.message.details.resultContent;
			assert.ok(resultContent.length <= 16_000);
			assert.match(resultContent, /HEAD-/);
			assert.match(resultContent, /-TAIL/);
			assert.match(
				resultContent,
				new RegExp(`Session: ${sessionFile.replace(".", "\\.")}`),
			);
			assert.doesNotMatch(resultContent, /Parent action:/);
			assert.deepEqual(delivered.message.details, {
				...details,
				resultContent,
			});
			assert.deepEqual(delivered.options, {
				triggerTurn: true,
				deliverAs: "steer",
			});
			assert.equal(sentUserMessages.length, 0);
		}
	});
});

describe("subagent status renderer", () => {
	function createTheme() {
		return {
			fg(_color: string, text: string) {
				return text;
			},
			bg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		};
	}

	it("keeps recovery session details in expanded unexpected-error results", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);

		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_result",
		);
		assert.ok(
			rendererEntry,
			"expected subagent_result renderer to be registered",
		);

		const rendered = rendererEntry
			.renderer(
				{
					customType: "subagent_result",
					content:
						'Sub-agent "Reviewer" error: failed\n\nSession: /tmp/subagent.jsonl\n' +
						"Resume: pi --session /tmp/subagent.jsonl",
					details: {
						name: "Reviewer",
						error: "failed",
						sessionFile: "/tmp/subagent.jsonl",
					},
				},
				{ expanded: true },
				createTheme(),
			)
			.render(120)
			.join("\n");

		assert.match(rendered, /Session: \/tmp\/subagent\.jsonl/);
		assert.match(rendered, /Resume:\s+pi --session \/tmp\/subagent\.jsonl/);
	});

	it("recognizes the neutral provider error header when rendering expanded results", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);
		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_result",
		);
		assert.ok(rendererEntry);

		const rendered = rendererEntry
			.renderer(
				{
					customType: "subagent_result",
					content:
						'Sub-agent "Worker" failed after 5s (provider/agent error).\n\n' +
						"Error: account/model rejected\n\n" +
						"Requested model: openai-codex/gpt-5.4\n" +
						"Model used: openai-codex/gpt-5.4",
					details: {
						name: "Worker",
						exitCode: 1,
						errorMessage: "account/model rejected",
						resultContent:
							'Sub-agent "Worker" failed after 5s (provider/agent error).\n\n' +
							"Error: account/model rejected\n\n" +
							"Requested model: openai-codex/gpt-5.4\n" +
							"Model used: openai-codex/gpt-5.4",
					},
				},
				{ expanded: true },
				createTheme(),
			)
			.render(120)
			.join("\n");

		assert.match(rendered, /account\/model rejected/);
		assert.match(rendered, /Requested model: openai-codex\/gpt-5\.4/);
		assert.doesNotMatch(rendered, /auto-retry exhausted/);
	});

	it("renders result details while keeping the custom message context small", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);

		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_result",
		);
		assert.ok(
			rendererEntry,
			"expected subagent_result renderer to be registered",
		);

		const rendered = rendererEntry
			.renderer(
				{
					customType: "subagent_result",
					content:
						'Sub-agent "Reviewer" completed (1s).\n\nDECISIVE_RESULT\n\n' +
						"Parent action: Continue the parent task using this result.",
					details: {
						name: "Reviewer",
						elapsed: 1,
						resultContent:
							'Sub-agent "Reviewer" completed (1s).\n\nDECISIVE_RESULT',
					},
				},
				{ expanded: true },
				createTheme(),
			)
			.render(120)
			.join("\n");

		assert.match(rendered, /DECISIVE_RESULT/);
		assert.doesNotMatch(rendered, /Parent action:/);
	});

	it("renders only capped lines plus overflow", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);

		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_status",
		);
		assert.ok(
			rendererEntry,
			"expected subagent_status renderer to be registered",
		);

		const visibleLines = [
			"Worker running 5m, active (bash 2m).",
			"Scout running 3m, waiting 1m.",
			"Reviewer running 2m, active (streaming 30s).",
			"Planner running 4m, waiting 2m.",
		];
		const rendered = rendererEntry.renderer(
			{
				customType: "subagent_status",
				content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
				details: {
					lines: visibleLines,
					overflow: 2,
				},
			},
			{ expanded: true },
			createTheme(),
		);
		const output = rendered.render(80).join("\n");

		assert.match(output, /Subagent status/);
		for (const line of visibleLines) {
			assert.match(
				output,
				new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
		}
		assert.match(output, /\+2 more running\./);
	});

	it("stays within narrow widths", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);

		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_status",
		);
		assert.ok(
			rendererEntry,
			"expected subagent_status renderer to be registered",
		);

		const rendered = rendererEntry.renderer(
			{
				customType: "subagent_status",
				content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
				details: {
					lines: ["Worker running 5m, active (bash 2m)."],
					overflow: 0,
				},
			},
			{ expanded: true },
			createTheme(),
		);

		for (const width of [4, 5, 6]) {
			for (const line of rendered.render(width)) {
				assert.ok(
					visibleWidth(line) <= width,
					`expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
				);
			}
		}
	});
});

describe("subagents widget rendering", () => {
	it("shows interrupted agents as open while process runtime continues", () => {
		const testApi = subagentsModule.__test__;
		const interruptedAt = 20_000;
		const lifecycle = markInterruptRequested(
			{
				...createLifecycle(5_000),
				process: { kind: "running", startedAt: 5_000, confirmedAt: 5_000 },
			},
			interruptedAt,
		);

		const originalNow = Date.now;
		Date.now = () => 30_000;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Worker",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						lifecycle,
						interactive: false,
					},
				],
				64,
			);

			assert.match(lines[0], /1 open/);
			assert.ok(lines[0].includes("\x1b[38;2;214;158;46m"));
			assert.match(lines[1], /00:25\s+Worker/);
			assert.match(lines[1], /interrupted 10s/);
			assert.doesNotMatch(lines.join("\n"), /running|active/);
		} finally {
			Date.now = originalNow;
		}
	});

	it("hydrates legacy activity done as waiting, not finalizing", () => {
		const testApi = subagentsModule.__test__;
		const doneAt = 20_000;
		const legacyDone = observeStatus(
			createStatusState({ startTimeMs: 5_000 }),
			{
				snapshot: "present",
				updatedAt: doneAt,
				sequence: 1,
				phase: "done",
				latestEvent: "subagent_done",
			},
			doneAt,
		);
		const originalNow = Date.now;
		Date.now = () => 30_000;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "legacy",
						name: "Legacy",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						statusState: legacyDone,
						interactive: false,
					},
				],
				64,
			);
			assert.match(lines[1], /waiting/);
			assert.doesNotMatch(lines[1], /finalizing/);
		} finally {
			Date.now = originalNow;
		}
	});

	it("freezes runtime when the subagent reports done", () => {
		const testApi = subagentsModule.__test__;
		const doneAt = 20_000;
		const lifecycle = markCompletionDetected(
			createLifecycle(5_000),
			{ reason: "done", exitCode: 0 },
			doneAt,
		);

		const originalNow = Date.now;
		Date.now = () => 30_000;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Reviewer",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						lifecycle,
						interactive: false,
					},
				],
				64,
			);

			assert.match(lines[0], /1 open/);
			assert.match(lines[1], /00:15\s+Reviewer/);
			assert.match(lines[1], /finalizing…/);
			assert.doesNotMatch(lines[1], /00:25/);
		} finally {
			Date.now = originalNow;
		}
	});

	it("keeps a blue border and summarizes mixed active and open agents", () => {
		const testApi = subagentsModule.__test__;
		const now = 30_000;
		const active = observeLifecycleActivity(
			createLifecycle(5_000),
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: "a1",
					createdAt: 5_000,
					updatedAt: 29_000,
					sequence: 1,
					latestEvent: "agent_start",
					phase: "active",
					agentActive: true,
					turnActive: true,
					providerActive: false,
					toolActive: false,
					activeScope: "agent",
					activeSince: 29_000,
				},
			},
			29_000,
		);
		const interrupted = markInterruptRequested(
			{
				...createLifecycle(10_000),
				process: { kind: "running", startedAt: 10_000, confirmedAt: 10_000 },
			},
			20_000,
		);

		const originalNow = Date.now;
		Date.now = () => now;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Active",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "s1",
						lifecycle: active,
						interactive: false,
					},
					{
						id: "a2",
						name: "Open",
						task: "",
						surface: "s2",
						startTime: 10_000,
						sessionFile: "s2",
						lifecycle: interrupted,
						interactive: false,
					},
				],
				72,
			);

			assert.match(lines[0], /1 active · 1 open/);
			assert.ok(lines[0].includes("\x1b[38;2;77;163;255m"));
		} finally {
			Date.now = originalNow;
		}
	});

	it("keeps every rendered line within a very narrow width", () => {
		const testApi = subagentsModule.__test__;
		assert.ok(testApi, "expected subagents test helpers to be exported");
		assert.ok(testApi.renderSubagentWidgetLines instanceof Function);

		const originalNow = Date.now;
		Date.now = () => 1_000_000;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "A",
						task: "",
						surface: "s1",
						startTime: 1_000_000 - 13_000,
						sessionFile: "sess1",
						lifecycle: createLifecycle(1_000_000 - 13_000),
					},
					{
						id: "a2",
						name: "B",
						task: "",
						surface: "s2",
						startTime: 1_000_000 - 21_000,
						sessionFile: "sess2",
						lifecycle: createLifecycle(1_000_000 - 21_000),
					},
					{
						id: "a3",
						name: "C",
						task: "",
						surface: "s3",
						startTime: 1_000_000 - 27_000,
						sessionFile: "sess3",
						lifecycle: createLifecycle(1_000_000 - 27_000),
					},
				],
				16,
			);

			assert.deepEqual(
				lines.map((line: string) => visibleWidth(line)),
				[16, 16, 16, 16, 16],
			);
		} finally {
			Date.now = originalNow;
		}
	});

	it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
		const testApi = subagentsModule.__test__;
		assert.ok(testApi, "expected subagents test helpers to be exported");
		assert.ok(testApi.borderLine instanceof Function);

		const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
		assert.equal(visibleWidth(line), 16);
	});

	it("handles ultra-narrow widths without exceeding the width contract", () => {
		const testApi = subagentsModule.__test__;
		assert.ok(testApi, "expected subagents test helpers to be exported");
		assert.ok(testApi.renderSubagentWidgetLines instanceof Function);

		const widths = [0, 1, 2];
		for (const width of widths) {
			const startTime = Date.now() - 5_000;
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "A",
						task: "",
						surface: "s1",
						startTime,
						sessionFile: "sess1",
						lifecycle: createLifecycle(startTime),
					},
				],
				width,
			);

			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
				);
			}
		}
	});
});

describe("herdr.ts", () => {
	it("captures failed CLI stderr without leaking it to the parent terminal", () => {
		const dir = createTestDir();
		try {
			writeFileSync(
				join(dir, "herdr"),
				'#!/bin/sh\nprintf \'{"error":{"code":"server_not_running"}}\\n\' >&2\nexit 1\n',
				{ mode: 0o755 },
			);
			const moduleUrl = new URL(
				"../maestro/surfaces/herdr/herdr.ts",
				import.meta.url,
			).href;
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"-e",
					`
				import { listHerdrWorktrees } from ${JSON.stringify(moduleUrl)};
				try {
					listHerdrWorktrees();
					process.exitCode = 2;
				} catch (error) {
					if (error.status !== 1 || !String(error.stderr).includes("server_not_running")) throw error;
				}
			`,
				],
				{
					encoding: "utf8",
					env: { ...process.env, PATH: dir, NODE_NO_WARNINGS: "1" },
				},
			);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stderr, "");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	describe("isHerdrAvailable", () => {
		it("returns boolean based on HERDR_ENV", () => {
			const result = isHerdrAvailable();
			assert.ok(result === true || result === false);
		});
	});

	describe("herdr command construction", () => {
		it("parses worktree list results", () => {
			assert.deepEqual(
				__herdrTest__.parseHerdrWorktreeList(
					JSON.stringify({
						result: {
							type: "worktree_list",
							worktrees: [
								{
									branch: "main",
									path: "/repo",
									is_linked_worktree: false,
								},
								{
									branch: "feature/auth",
									path: "/tmp/auth",
									label: "Auth",
									open_workspace_id: "w9",
									is_linked_worktree: true,
								},
							],
						},
					}),
				),
				[
					{ branch: "main", path: "/repo", isLinkedWorktree: false },
					{
						branch: "feature/auth",
						path: "/tmp/auth",
						label: "Auth",
						workspaceId: "w9",
						isLinkedWorktree: true,
					},
				],
			);
		});

		it("accepts detached entries without a branch but rejects malformed identities", () => {
			const parse = (
				row: {
					path?: string | number | null;
					branch?: string | number | null;
					is_detached?: boolean | string;
					is_linked_worktree?: boolean;
				} | null,
			) =>
				__herdrTest__.parseHerdrWorktreeList(
					JSON.stringify({
						result: { type: "worktree_list", worktrees: [row] },
					}),
				);
			assert.deepEqual(
				parse({
					path: "/detached",
					is_detached: true,
					is_linked_worktree: true,
				}),
				[{ branch: "", path: "/detached", isLinkedWorktree: true }],
			);
			for (const row of [
				null,
				{ path: "/missing-branch" },
				{ path: "/wrong-flag", is_detached: "true" },
				{ path: "/wrong-branch", branch: 42, is_detached: true },
				{ path: "/null-branch", branch: null, is_detached: true },
				{ path: 42, is_detached: true },
				{ branch: "main", path: null },
			])
				assert.throws(() => parse(row), /Unexpected herdr worktree list entry/);
		});

		it("accepts only complete, unique pane snapshots", () => {
			const snapshot = (
				panes: Array<{ pane_id?: string; workspace_id?: string } | null>,
			) => JSON.stringify({ result: { type: "pane_list", panes } });
			assert.deepEqual(__herdrTest__.parseHerdrPaneSnapshot(snapshot([])), []);
			assert.equal(__herdrTest__.parseHerdrPaneSnapshot('{"result":{}}'), null);
			assert.equal(
				__herdrTest__.parseHerdrPaneSnapshot(
					snapshot([
						{ pane_id: "p1", workspace_id: "w1" },
						{ pane_id: "p1", workspace_id: "w1" },
					]),
				),
				null,
			);
			assert.equal(
				__herdrTest__.parseHerdrPaneSnapshot(snapshot([{ pane_id: "p1" }])),
				null,
			);
			assert.equal(
				__herdrTest__.parseHerdrPaneSnapshot(snapshot([null, {}])),
				null,
			);
		});

		it("parses the recovered root pane for a worktree workspace", () => {
			assert.deepEqual(
				__herdrTest__.parseHerdrPaneList(
					JSON.stringify({
						result: {
							type: "pane_list",
							panes: [
								{ pane_id: "w9:p1", workspace_id: "w9" },
								{ pane_id: "other:p1", workspace_id: "other" },
							],
						},
					}),
					"w9",
				),
				["w9:p1"],
			);
		});

		it("uses caller context when discovering the current pane", () => {
			assert.deepEqual(__herdrTest__.buildCurrentPaneArgs(), [
				"pane",
				"current",
				"--current",
			]);
		});

		it("targets an explicit stable parent when splitting without focus", () => {
			assert.deepEqual(
				__herdrTest__.buildPaneSplitArgs("parent-pane", "down", "/repo"),
				[
					"pane",
					"split",
					"parent-pane",
					"--direction",
					"down",
					"--no-focus",
					"--cwd",
					"/repo",
				],
			);
		});

		it("targets the current workspace when creating a subagent tab", () => {
			assert.deepEqual(
				__herdrTest__.buildTabCreateArgs("reviewer", "/repo", "workspace-2"),
				[
					"tab",
					"create",
					"--workspace",
					"workspace-2",
					"--label",
					"reviewer",
					"--cwd",
					"/repo",
					"--no-focus",
				],
			);
		});

		it("creates a background worktree from an exact base commit", () => {
			assert.deepEqual(
				__herdrTest__.buildWorktreeCreateArgs(
					"Ticket 123",
					"/repo",
					"ticket/123",
					"abc123",
				),
				[
					"worktree",
					"create",
					"--cwd",
					"/repo",
					"--branch",
					"ticket/123",
					"--base",
					"abc123",
					"--label",
					"Ticket 123",
					"--no-focus",
				],
			);
		});
	});

	describe("herdr response parsing", () => {
		it("extracts pane id from a pane split response", () => {
			const output = JSON.stringify({
				result: {
					pane: {
						pane_id: "1-3",
						tab_id: "1:2",
						workspace_id: "1",
					},
				},
			});
			assert.equal(
				__herdrTest__.extractHerdrPaneId(output, "pane split"),
				"1-3",
			);
		});

		it("extracts root pane id from a tab create response", () => {
			const output = JSON.stringify({
				result: {
					tab: { tab_id: "1:2" },
					root_pane: { pane_id: "1-2" },
				},
			});
			assert.equal(
				__herdrTest__.extractHerdrRootPaneId(output, "tab create"),
				"1-2",
			);
		});

		it("extracts the worktree and root surface from a worktree create response", () => {
			const output = JSON.stringify({
				result: {
					type: "worktree_created",
					workspace: { workspace_id: "w9" },
					root_pane: { pane_id: "w9:p1" },
					worktree: {
						path: "/tmp/worktrees/ticket-123",
						branch: "ticket/123",
						label: "Ticket 123",
						is_bare: false,
						is_detached: false,
						is_linked_worktree: true,
						is_prunable: false,
						open_workspace_id: "w9",
					},
				},
			});

			assert.deepEqual(__herdrTest__.extractHerdrWorktree(output), {
				path: "/tmp/worktrees/ticket-123",
				branch: "ticket/123",
				workspaceId: "w9",
				paneId: "w9:p1",
			});
		});

		it("throws on malformed herdr JSON", () => {
			assert.throws(
				() => __herdrTest__.extractHerdrPaneId("not json", "pane split"),
				/Unexpected herdr pane split output/,
			);
		});

		it("parses pane-not-found JSON from stderr-shaped errors", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: JSON.stringify({
					error: { code: "pane_not_found", message: "pane gone" },
				}),
				stdout: "",
			});
			assert.deepEqual(result, { kind: "missing", error: "pane gone" });
		});

		it("continues from non-JSON stderr to structured stdout", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "warning: connection closed",
				stdout: JSON.stringify({
					error: { code: "pane_not_found", message: "pane gone" },
				}),
			});
			assert.deepEqual(result, { kind: "missing", error: "pane gone" });
		});

		it("returns unavailable when both error streams are non-JSON", () => {
			const result = __herdrTest__.parsePaneGetError({
				message: "command failed",
				stderr: "warning: connection closed",
				stdout: "not json either",
			});
			assert.deepEqual(result, {
				kind: "unavailable",
				error: "command failed",
			});
		});

		it("recognizes plain-text pane_not_found on stderr", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "pane_not_found: pane w1:p1 not found",
				stdout: "unrelated output",
			});
			assert.deepEqual(result, {
				kind: "missing",
				error: "pane_not_found: pane w1:p1 not found",
			});
		});

		it("recognizes plain-text not_found on stdout after malformed stderr", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "{malformed json",
				stdout: "not_found: pane w1:p1",
			});
			assert.deepEqual(result, {
				kind: "missing",
				error: "not_found: pane w1:p1",
			});
		});

		it("normalizes unknown agent_status values", () => {
			const result = __herdrTest__.parsePaneGetOutput(
				JSON.stringify({
					result: {
						pane: { pane_id: "w1:p1", agent: "pi", agent_status: "paused" },
					},
				}),
				"w1:p1",
			);
			assert.deepEqual(result, {
				kind: "present",
				agent: "pi",
				agentStatus: "unknown",
			});
		});

		it("recognizes an interactive shell as ready", () => {
			assert.equal(
				__herdrTest__.isHerdrShellReady({
					paneId: "w1:p9",
					shellPid: 100,
					foregroundProcessGroupId: 100,
					pids: [100],
					foregroundProcesses: [],
				}),
				true,
			);
			assert.equal(
				__herdrTest__.isHerdrShellReady({
					paneId: "w1:p9",
					shellPid: 100,
					foregroundProcessGroupId: 200,
					pids: [100, 200],
					foregroundProcesses: [],
				}),
				false,
			);
		});

		it("parses pane process-info identities", () => {
			const result = __herdrTest__.parsePaneProcessInfo(
				JSON.stringify({
					result: {
						process_info: {
							pane_id: "w1:p9",
							shell_pid: 100,
							foreground_process_group_id: 200,
							foreground_processes: [
								{
									pid: 200,
									name: "pi",
									argv0: "pi",
									argv: ["pi", "--session", "/tmp/session.jsonl"],
									cwd: "/tmp/worktree",
								},
								{ pid: 201 },
							],
						},
					},
				}),
				"w1:p9",
			);
			assert.deepEqual(result, {
				paneId: "w1:p9",
				shellPid: 100,
				foregroundProcessGroupId: 200,
				pids: [100, 200, 201],
				foregroundProcesses: [
					{
						pid: 200,
						name: "pi",
						argv0: "pi",
						argv: ["pi", "--session", "/tmp/session.jsonl"],
						cwd: "/tmp/worktree",
					},
					{ pid: 201 },
				],
			});
		});
	});

	describe("process exit confirmation", () => {
		it("returns survivors after the bounded wait", async () => {
			const alive = new Set([11, 22]);
			const survivors = await waitForProcessesExit([11, 22, 33], {
				timeoutMs: 80,
				intervalMs: 10,
				isAlive: (pid) => alive.has(pid),
			});
			assert.deepEqual(survivors.sort(), [11, 22]);
		});
	});
});
