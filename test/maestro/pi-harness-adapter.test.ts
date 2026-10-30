import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PiHarnessAdapter } from "../../maestro/adapters/pi/pi-harness-adapter.ts";
import {
	captureSurfacePiProcessIdentity,
	launchOperationsFromSurface,
} from "../../maestro/adapters/pi/launch-operations.ts";
import type {
	PiProcessIdentity,
	ProcessIdentityProbe,
	ProcessStat,
} from "../../maestro/adapters/pi/process-identity.ts";
import {
	createWorktreeOperations,
	readWorktreeManifest,
} from "../../maestro/runtime/worktree-operations.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { createSubagentActivityRecorder } from "../../maestro/adapters/pi/activity-file.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import {
	readSubagentSessionPolicy,
	appendPersistentTaskEvent,
	consumePersistentTaskInbox,
	readPersistentDeliveryLedger,
} from "../../maestro/adapters/pi/session.ts";
import type { SpawnOptions } from "../../maestro/core/harness-adapter.ts";

const paneConfig = {
	mode: "grouped",
	direction: "right",
	maxPerTab: 4,
} as const;
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-adapter-test-"));
	const sessionDir = join(root, "parent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "parent.jsonl");
	writeFileSync(
		sessionFile,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root }) +
			"\n",
	);
	const surface = new FakeSurfaceProvider();
	// Fake only the process launch. Session policy, artifact creation and completion are real.
	const operations = launchOperationsFromSurface(surface, paneConfig);
	operations.runScript = (_surface, _command, options) => options.scriptPath;
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
	const modelRegistry = {
		find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
		available: () => [],
		hasConfiguredAuth: () => true,
		supportedThinkingLevels:
			(): import("../../maestro/core/types.ts").ThinkingLevel[] => [
				"off",
				"minimal",
				"low",
				"medium",
				"high",
			],
		clampThinkingLevel: (
			_model: import("../../maestro/core/routing.ts").RoutingModel,
			level: import("../../maestro/core/types.ts").ThinkingLevel,
		) => level,
	};
	const adapter = new PiHarnessAdapter({
		surface,
		paneConfig,
		operations,
		wake,
		supervision,
		modelRegistry,
		parent: {
			cwd: root,
			sessionFile,
			sessionId: "parent",
			sessionDir,
			agentDir: join(root, "agent"),
		},
		parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
	});
	const options: SpawnOptions = {
		name: "worker",
		task: "bounded task",
		cwd: root,
		sessionId: "logical-task",
		role: {
			name: "worker",
			version: "1",
			description: "test",
			systemPrompt: "Focused identity",
			allowedTools: ["read", "bash"],
			defaults: { autoExit: true, spawning: false },
		},
		runtime: { model: "fake/test", thinking: "off" },
	};
	return {
		root,
		modelRegistry,
		adapter,
		surface,
		options,
		operations,
		wake,
		supervision,
		dispose() {
			supervision.close();
			wake.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
async function usingFixture(
	run: (f: ReturnType<typeof fixture>) => Promise<void>,
) {
	const f = fixture();
	try {
		await run(f);
	} finally {
		f.dispose();
	}
}

describe("PiHarnessAdapter", () => {
	it("standalone provider launch consumes injected worktree effects and refuses managed public resume before creating a pane", async () =>
		usingFixture(async (f) => {
			const effects = createWorktreeOperations();
			const probes: string[] = [];
			effects.resolveGitCommit = (_cwd, ref) => {
				probes.push(ref);
				return "base-sha";
			};
			effects.resolveWorktreeProvisionCwd = (cwd) => cwd;
			const adapter = new PiHarnessAdapter({
				surface: f.surface,
				paneConfig,
				worktreeOperations: effects,
				modelRegistry: f.modelRegistry,
				supervision: f.supervision,
				parent: {
					cwd: f.root,
					sessionFile: join(f.root, "parent", "parent.jsonl"),
					sessionId: "parent",
					sessionDir: join(f.root, "parent"),
					agentDir: join(f.root, "agent"),
				},
				parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
			});
			const handle = await adapter.spawn({
				...f.options,
				worktreeRequest: { branch: "task16" },
			});
			assert.deepEqual(probes, ["HEAD"]);
			assert.equal(handle.worktree?.baseSha, "base-sha");
			assert.equal(
				readWorktreeManifest(handle.worktree!.manifestFile)?.owner,
				"pi-herdr-subagents",
			);
			assert.equal(f.surface.listSurfaces().length, 1);
			await assert.rejects(
				adapter.resume({ name: "resume", sessionId: handle.sessionId! }),
				/Cannot resume managed-worktree session/,
			);
			assert.equal(f.surface.listSurfaces().length, 1);
			assert.equal(f.supervision.diagnostics().watcherCount, 0);
		}));
	it("exports PI_SUBAGENT_SELF_SPAWN only for a named role that declared self-spawn and kept spawning", async () =>
		usingFixture(async (f) => {
			const commands: string[] = [];
			f.operations.runScript = (_surface, command, options) => {
				commands.push(command);
				return options.scriptPath;
			};
			const launch = async (
				defaults: NonNullable<SpawnOptions["role"]["defaults"]>,
			) => {
				await f.adapter.spawn({
					...f.options,
					role: { ...f.options.role, defaults },
				});
				return commands.at(-1) ?? "";
			};
			assert.match(
				await launch({ autoExit: true }),
				/PI_SUBAGENT_SELF_SPAWN=0/,
			);
			assert.match(
				await launch({ autoExit: true, selfSpawn: false }),
				/PI_SUBAGENT_SELF_SPAWN=0/,
			);
			const enabled = await launch({ autoExit: true, selfSpawn: true });
			assert.match(enabled, /PI_SUBAGENT_AGENT='worker'/);
			assert.match(enabled, /PI_SUBAGENT_SELF_SPAWN=1/);
			assert.doesNotMatch(enabled, /PI_DENY_TOOLS/);

			// `spawning: false` denies the spawning tools and wins over `self-spawn`.
			const denied = await launch({
				autoExit: true,
				selfSpawn: true,
				spawning: false,
			});
			assert.match(denied, /PI_SUBAGENT_SELF_SPAWN=0/);
			assert.match(denied, /PI_DENY_TOOLS='subagent,/);
		}));
	it("never lets pane-shell values for self-spawn or depth reach a child", async () =>
		usingFixture(async (f) => {
			const commands: string[] = [];
			f.operations.runScript = (_surface, command, options) => {
				commands.push(command);
				return options.scriptPath;
			};
			const previous = {
				selfSpawn: process.env.PI_SUBAGENT_SELF_SPAWN,
				depth: process.env.PI_SUBAGENT_DEPTH,
			};
			try {
				process.env.PI_SUBAGENT_SELF_SPAWN = "1";
				delete process.env.PI_SUBAGENT_DEPTH;
				await f.adapter.spawn({
					...f.options,
					role: { ...f.options.role, defaults: { autoExit: true } },
				});
				assert.match(commands.at(-1) ?? "", /PI_SUBAGENT_SELF_SPAWN=0/);
				assert.doesNotMatch(commands.at(-1) ?? "", /PI_SUBAGENT_SELF_SPAWN=1/);
				// A top-level parent (no variable) launches depth 1.
				assert.match(commands.at(-1) ?? "", /PI_SUBAGENT_DEPTH=1(?!\d)/);
			} finally {
				for (const [name, value] of [
					["PI_SUBAGENT_SELF_SPAWN", previous.selfSpawn],
					["PI_SUBAGENT_DEPTH", previous.depth],
				] as const) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
			}
		}));
	it("exports parent depth + 1 on fresh and resumed launches and refuses an unknown parent depth", async () =>
		usingFixture(async (f) => {
			const commands: string[] = [];
			f.operations.runScript = (_surface, command, options) => {
				commands.push(command);
				return options.scriptPath;
			};
			const previous = process.env.PI_SUBAGENT_DEPTH;
			try {
				process.env.PI_SUBAGENT_DEPTH = "2";
				const h = await f.adapter.spawn(f.options);
				assert.match(commands.at(-1) ?? "", /PI_SUBAGENT_DEPTH=3(?!\d)/);
				writeFileSync(
					h.sessionId,
					JSON.stringify({
						type: "session",
						version: 3,
						id: h.id,
						cwd: f.root,
					}) + "\n",
				);
				await f.adapter.kill(h);
				await f.adapter.resume({ name: "resumed", sessionId: h.sessionId });
				assert.match(commands.at(-1) ?? "", /PI_SUBAGENT_DEPTH=3(?!\d)/);

				const before = commands.length;
				for (const garbage of ["", "abc", "-1"]) {
					process.env.PI_SUBAGENT_DEPTH = garbage;
					await assert.rejects(
						f.adapter.spawn(f.options),
						/PI_SUBAGENT_DEPTH=.* is not a non-negative integer/,
						garbage,
					);
				}
				assert.equal(commands.length, before, "no command may be sent");
			} finally {
				if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH;
				else process.env.PI_SUBAGENT_DEPTH = previous;
			}
		}));
	it("preserves an already validated host plan without consulting the registry again", async () =>
		usingFixture(async (f) => {
			const plan = {
				provider: "fake",
				modelId: "no-reasoning",
				model: "fake/no-reasoning",
				thinking: "off" as const,
				modelSource: "agent" as const,
				thinkingSource: "parent" as const,
				requestedModel: "fake/no-reasoning",
				thinkingAdjustment: {
					from: "high" as const,
					to: "off" as const,
					reason: "non-reasoning" as const,
				},
			};
			f.modelRegistry.find = () => {
				throw new Error("host plan must not be revalidated");
			};
			const h = await f.adapter.spawn({
				...f.options,
				resolvedLaunch: {
					runtimePlan: plan,
					agent: undefined,
					cwd: undefined,
					tools: undefined,
				},
			});
			const child = f.adapter.getRunningChild(h);
			assert.equal(child.runtimePlan, plan);
			assert.equal(child.agent, undefined);
			assert.equal(readSubagentSessionPolicy(h.sessionId).tools, null);
		}));
	it("keeps absent, explicit and role cwd configuration origins distinct", async () =>
		usingFixture(async (f) => {
			mkdirSync(join(f.root, ".pi", "agent"), { recursive: true });
			const roleCwd = join(f.root, "agent", "role-folder");
			mkdirSync(join(roleCwd, ".pi", "agent"), { recursive: true });
			const commands: string[] = [];
			f.operations.runScript = (_surface, command, options) => {
				commands.push(command);
				return options.scriptPath;
			};
			const plan = {
				provider: "fake",
				modelId: "test",
				model: "fake/test",
				thinking: "off" as const,
				modelSource: "parent" as const,
				thinkingSource: "parent" as const,
			};
			for (const origin of [{}, { cwd: f.root }, { roleCwd: "role-folder" }]) {
				const h = await f.adapter.spawn({
					...f.options,
					resolvedLaunch: { runtimePlan: plan, ...origin },
				});
				assert.equal(h.cwd, "roleCwd" in origin ? roleCwd : f.root);
				if (!("cwd" in origin) && !("roleCwd" in origin))
					assert.ok(h.sessionId.startsWith(join(f.root, "agent", "sessions")));
			}
			assert.ok(
				!commands[0].includes(
					`PI_CODING_AGENT_DIR='${join(f.root, ".pi", "agent")}'`,
				),
			);
			assert.match(
				commands[1],
				new RegExp(`PI_CODING_AGENT_DIR='${join(f.root, ".pi", "agent")}'`),
			);
			assert.match(
				commands[2],
				new RegExp(`PI_CODING_AGENT_DIR='${join(roleCwd, ".pi", "agent")}'`),
			);
		}));
	it("launches the relocated protocol and maps the session handle", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn(f.options);
			assert.equal(h.harness, "pi");
			assert.match(h.sessionId, /\.jsonl$/);
			assert.equal(h.cwd, f.root);
			assert.equal(h.role, "worker");
			const policy = readSubagentSessionPolicy(h.sessionId);
			assert.deepEqual(policy.tools, ["read", "bash"]);
			assert.deepEqual(policy.deniedTools, [
				"subagent",
				"subagent_interrupt",
				"subagent_cancel",
				"subagent_send",
				"subagent_stop",
				"subagents_list",
				"subagent_resume",
			]);
		}));
	it("maps relative cwd to the same directory as the launch transaction", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn({ ...f.options, cwd: "nested" });
			assert.equal(h.cwd, join(f.root, "nested"));
			assert.equal(
				f.surface.listSurfaces().find((surface) => surface.id === h.surfaceId)
					?.cwd,
				h.cwd,
			);
		}));
	it("launches one ordinary candidate and rejects worktree fallback lists before acquisition", async () =>
		usingFixture(async (f) => {
			const runtime = {
				model: "fake/test",
				thinking: "off" as const,
				fallbacks: [{ model: "fake/alternative", thinking: "off" as const }],
			};
			const h = await f.adapter.spawn({ ...f.options, runtime });
			assert.equal(
				f.adapter.getRunningChild(h).runtimePlan?.model,
				"fake/test",
			);
			assert.equal(f.surface.listSurfaces().length, 1);
			await assert.rejects(
				f.adapter.spawn({
					...f.options,
					runtime,
					worktreeRequest: { branch: "unsafe-fallback" },
				}),
				/Model fallbacks are not supported for worktree subagents/,
			);
			assert.equal(f.surface.listSurfaces().length, 1);
		}));
	it("keeps legacy fallback IDs opaque without reusing prior session evidence", async () =>
		usingFixture(async (f) => {
			const launchIdentity = { id: "legacy-fallback-id" };
			const first = await f.adapter.spawn({ ...f.options, launchIdentity });
			writeFileSync(
				`${first.sessionId}.exit`,
				JSON.stringify({
					type: "error",
					errorMessage: "first provider rejected",
				}),
			);
			await f.adapter.awaitCompletion(first, new AbortController().signal);
			const next = await f.adapter.spawn({
				...f.options,
				launchIdentity,
				runtime: { model: "fake/alternative", thinking: "off" },
			});
			assert.equal(next.id, first.id);
			assert.notEqual(next.sessionId, first.sessionId);
			assert.equal(f.adapter.exitCode(next), undefined);
			assert.notEqual(await f.adapter.getState(next), "done");
			await assert.rejects(f.adapter.interrupt(first), /Unknown Pi child/);
			writeFileSync(`${next.sessionId}.exit`, JSON.stringify({ type: "done" }));
			assert.equal(
				(await f.adapter.awaitCompletion(next, new AbortController().signal))
					.reason,
				"done",
			);
			assert.equal(f.adapter.exitCode(first), 1);
			assert.equal(f.adapter.exitCode(next), 0);
			assert.equal(
				(await f.adapter.awaitCompletion(first, new AbortController().signal))
					.reason,
				"error",
			);
		}));
	it("consumes prewritten completion and keeps the first terminal evidence", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn(f.options);
			writeFileSync(
				h.sessionId,
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "finished" }],
						stopReason: "stop",
					},
				}) + "\n",
			);
			writeFileSync(
				`${h.sessionId}.exit`,
				JSON.stringify({ type: "done", exitCode: 0 }),
			);
			const e = await f.adapter.awaitCompletion(
				h,
				new AbortController().signal,
			);
			assert.equal(e.reason, "done");
			assert.equal(e.exitCode, 0);
			assert.equal(e.finalMessage?.text, "finished");
			assert.equal(e.sessionRef, h.sessionId);
			assert.equal(f.adapter.exitCode(h), 0);
			writeFileSync(
				`${h.sessionId}.exit`,
				JSON.stringify({ type: "error", errorMessage: "later" }),
			);
			assert.deepEqual(
				await f.adapter.awaitCompletion(h, new AbortController().signal),
				e,
			);
			assert.equal(await f.adapter.getState(h), "done");
		}));
	it("accepts a late sidecar 200ms after confirmed pane absence", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn(f.options);
			await f.adapter.kill(h);
			assert.equal(
				(await f.surface.inspectSurface(h.surfaceId!)).kind,
				"missing",
			);
			const wait = f.adapter.awaitCompletion(h, new AbortController().signal);
			const timer = setTimeout(
				() =>
					writeFileSync(
						`${h.sessionId}.exit`,
						JSON.stringify({ type: "done" }),
					),
				200,
			);
			try {
				const e = await wait;
				assert.equal(e.reason, "done");
				assert.equal(e.exitCode, 0);
			} finally {
				clearTimeout(timer);
			}
		}));
	it("rejects already-aborted waits and cancellation does not cancel another waiter", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn(f.options);
			const a = new AbortController();
			a.abort();
			await assert.rejects(f.adapter.awaitCompletion(h, a.signal), /abort/i);
			const b = new AbortController();
			const one = f.adapter.awaitCompletion(h, b.signal);
			const rejected = assert.rejects(one, /abort/i);
			const two = f.adapter.awaitCompletion(h, new AbortController().signal);
			b.abort();
			await rejected;
			writeFileSync(
				`${h.sessionId}.exit`,
				JSON.stringify({ type: "ping", name: h.name, message: "help" }),
			);
			assert.equal((await two).reason, "ping");
		}));
	it("restores saved public policy after termination and refuses persistent policy", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn(f.options);
			writeFileSync(
				h.sessionId,
				JSON.stringify({ type: "session", version: 3, id: h.id, cwd: f.root }) +
					"\n",
			);
			await f.adapter.kill(h);
			const resumed = await f.adapter.resume({
				name: "resumed",
				sessionId: h.sessionId,
			});
			assert.notEqual(resumed.id, h.id);
			assert.equal(resumed.sessionId, h.sessionId);
			assert.equal(resumed.cwd, f.root);
			assert.equal(resumed.worktree, undefined);
			const p = await f.adapter.spawn({
				...f.options,
				behavior: { persistent: true },
			});
			await assert.rejects(
				f.adapter.resume({ name: "unsafe", sessionId: p.sessionId }),
				/Cannot resume persistent specialist/,
			);
		}));
	it("persistent sends use task evidence, not coarse idle; busy tasks are not queued", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn({
				...f.options,
				behavior: { persistent: true },
				launchIdentity: {
					id: "opaque-logical",
					generationId: "opaque-generation",
					taskId: "opaque-task",
				},
			});
			const child = f.adapter.getRunningChild(h);
			assert.equal(child.id, "opaque-logical");
			assert.equal(child.generationId, "opaque-generation");
			assert.equal(child.taskId, "opaque-task");
			await assert.rejects(f.adapter.sendInput(h, "busy"), /rejected-busy/);
			assert.equal(consumePersistentTaskInbox(h.sessionId), null);
			appendPersistentTaskEvent(h.sessionId, {
				type: "task-done",
				task: "opaque-task",
				generation: "opaque-generation",
			});
			// Delivery remains the host's explicit responsibility, never inferred by getState.
			assert.equal(child.taskId, "opaque-task");
			assert.equal(f.adapter.readPersistentEvents(h)[0].type, "task-done");
			child.taskId = undefined;
			child.tasksCompleted = 1;
			await f.adapter.sendInput(h, "next task");
			assert.equal(
				consumePersistentTaskInbox(h.sessionId)?.message,
				"next task",
			);
			assert.equal(
				readPersistentDeliveryLedger(h.sessionId).at(-1)?.outcome,
				"dispatched",
			);
			await assert.rejects(f.adapter.sendInput(h, "no queue"), /rejected-busy/);
			assert.equal(consumePersistentTaskInbox(h.sessionId), null);
			assert.equal(f.adapter.exitCode(h), undefined);
			const ordinary = await f.adapter.spawn(f.options);
			await assert.rejects(
				f.adapter.sendInput(ordinary, "text"),
				/child is not a persistent specialist/,
			);
		}));
	it("preserves a textless final error and its raw message", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn(f.options);
			writeFileSync(
				h.sessionId,
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "provider account refused",
					},
				}) + "\n",
			);
			writeFileSync(
				`${h.sessionId}.exit`,
				JSON.stringify({
					type: "error",
					errorMessage: "provider account refused",
				}),
			);
			const evidence = await f.adapter.awaitCompletion(
				h,
				new AbortController().signal,
			);
			assert.equal(evidence.exitCode, 1);
			assert.equal(evidence.errorMessage, "provider account refused");
			assert.deepEqual(evidence.finalMessage, {
				text: "",
				stopReason: "error",
				errorMessage: "provider account refused",
			});
		}));
	it("preserves lineage-only defaults, explicit system prompt, and tool overrides", async () =>
		usingFixture(async (f) => {
			let command = "";
			f.operations.runScript = (_surface, value, options) => {
				command = value;
				return options.scriptPath;
			};
			const h = await f.adapter.spawn({
				...f.options,
				tools: ["read"],
				systemPrompt: "Override identity",
				role: {
					...f.options.role,
					defaults: {
						...f.options.role.defaults,
						sessionMode: "lineage-only",
						systemPromptMode: "replace",
					},
				},
			});
			const header = JSON.parse(
				readFileSync(h.sessionId, "utf8").split("\n")[0],
			);
			assert.match(header.parentSession, /parent\.jsonl$/);
			assert.deepEqual(readSubagentSessionPolicy(h.sessionId).tools, ["read"]);
			const promptPath = command.match(/--system-prompt '([^']+)'/)?.[1];
			assert.ok(promptPath);
			assert.equal(readFileSync(promptPath, "utf8"), "Override identity");
		}));
	it("projects activity and preserves interrupted-turn precedence without inferring process completion", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn(f.options);
			const child = f.adapter.getRunningChild(h);
			let now = Date.now() - 10000;
			const recorder = createSubagentActivityRecorder({
				activityFile: child.activityFile,
				runningChildId: child.id,
				now: () => (now += 1000),
			});
			recorder.sessionStart();
			assert.equal(await f.adapter.getState(h), "idle");
			recorder.agentStart();
			f.surface.scriptInspection(child.surface, {
				kind: "present",
				agentStatus: "working",
				observedAt: Date.now(),
			});
			assert.equal(await f.adapter.getState(h), "working");
			await f.adapter.interrupt(h);
			assert.equal(await f.adapter.getState(h), "unknown");
			assert.equal(f.adapter.exitCode(h), undefined);
			now = Date.now();
			recorder.agentStart();
			assert.equal(await f.adapter.getState(h), "working");
			recorder.agentEndWaiting();
			f.surface.scriptInspection(child.surface, {
				kind: "present",
				agentStatus: "idle",
				observedAt: Date.now(),
			});
			assert.equal(await f.adapter.getState(h), "blocked");
			recorder.agentEndDone();
			assert.notEqual(await f.adapter.getState(h), "done");
			recorder.sessionShutdown("quit");
		}));
	it("awaits Escape delivery and propagates synchronous and asynchronous failures", async () =>
		usingFixture(async (f) => {
			const h = await f.adapter.spawn(f.options);
			const entered = deferred();
			const release = deferred();
			let settled = false;
			f.surface.sendKeys = async (_surface, key) => {
				assert.equal(key, "Escape");
				entered.resolve();
				await release.promise;
			};
			const operation = f.adapter.interrupt(h);
			operation.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await entered.promise;
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(
					settled,
					false,
					"interrupt settled before Escape delivery",
				);
			} finally {
				release.resolve();
			}
			await operation;
			assert.equal(
				f.adapter.getRunningChild(h).lifecycle.turn.kind,
				"interrupted",
			);
			f.surface.sendKeys = () => {
				throw new Error("synchronous send failure");
			};
			await assert.rejects(f.adapter.interrupt(h), /synchronous send failure/);
			f.surface.sendKeys = async () => {
				throw new Error("asynchronous send failure");
			};
			await assert.rejects(f.adapter.interrupt(h), /asynchronous send failure/);
			assert.equal(f.adapter.exitCode(h), undefined);
		}));
	for (const stage of ["close", "absence"] as const)
		it(`kill awaits ${stage} settlement`, async () =>
			usingFixture(async (f) => {
				const h = await f.adapter.spawn(f.options);
				const entered = deferred();
				const release = deferred();
				let settled = false;
				if (stage === "close")
					f.surface.closeSurface = async (id) => {
						entered.resolve();
						await release.promise;
						f.surface.removeSurface(id);
					};
				else
					f.surface.waitForSurfaceAbsence = async () => {
						entered.resolve();
						await release.promise;
					};
				const operation = f.adapter.kill(h);
				operation.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
				try {
					await entered.promise;
					await new Promise((resolve) => setImmediate(resolve));
					assert.equal(settled, false, `kill settled before ${stage}`);
				} finally {
					release.resolve();
				}
				await operation;
				assert.equal(
					(await f.surface.inspectSurface(h.surfaceId!)).kind,
					"missing",
				);
				assert.equal(f.adapter.exitCode(h), undefined);
			}));
	for (const present of [false, true])
		it(`kill after a close failure ${present ? "rejects while the pane is present" : "confirms an already-absent pane"}`, async () =>
			usingFixture(async (f) => {
				const h = await f.adapter.spawn(f.options);
				f.surface.closeSurface = async (id) => {
					if (!present) f.surface.removeSurface(id);
					throw new Error("pane close failed");
				};
				if (present)
					await assert.rejects(
						f.adapter.kill(h),
						/pane close failed; surface still present/,
					);
				else await f.adapter.kill(h);
			}));
});

describe("PiHarnessAdapter retained worktree kill", () => {
	const HOST = { bootId: "boot-a", pidNamespace: "pid:[4026531836]" };
	const identity = (overrides: Partial<PiProcessIdentity> = {}) => ({
		pid: 20,
		startTime: "5000",
		...HOST,
		...overrides,
	});
	type Entry = ProcessStat | "EACCES" | undefined;
	// A kernel process table keyed by PID. `terminate` runs `onTerminate`.
	function fakeProbe(
		table: Map<number, Entry>,
		onTerminate: (pid: number) => void = (pid) => table.delete(pid),
	) {
		const signals: number[] = [];
		const probe: ProcessIdentityProbe = {
			host: () => HOST,
			stat(pid) {
				const entry = table.get(pid);
				if (entry === "EACCES")
					throw Object.assign(new Error(`EACCES: /proc/${pid}/stat`), {
						code: "EACCES",
					});
				return entry;
			},
			terminate(pid) {
				signals.push(pid);
				onTerminate(pid);
			},
		};
		return { probe, signals };
	}
	const alive = (startTime = "5000"): ProcessStat => ({
		state: "S",
		ppid: 10,
		startTime,
	});
	async function worktreeChild(
		f: ReturnType<typeof fixture>,
		options: {
			probe?: ProcessIdentityProbe;
			identity?: PiProcessIdentity;
			capture?: Promise<PiProcessIdentity | undefined>;
			captureError?: string;
			killTimeoutMs?: number;
		} = {},
	) {
		const adapter = new PiHarnessAdapter({
			surface: f.surface,
			paneConfig,
			operations: f.operations,
			supervision: f.supervision,
			modelRegistry: f.modelRegistry,
			parent: {
				cwd: f.root,
				sessionFile: join(f.root, "parent", "parent.jsonl"),
				sessionId: "parent",
				sessionDir: join(f.root, "parent"),
				agentDir: join(f.root, "agent"),
			},
			parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
			killTimeoutMs: options.killTimeoutMs ?? 150,
			processProbe: options.probe,
		});
		const h = await adapter.spawn(f.options);
		const child = adapter.getRunningChild(h);
		const path = join(f.root, "worktree");
		// Only the adapter's ownership of a worktree child matters to kill.
		child.worktree = {
			path,
			workspaceId: "owned-workspace",
			paneId: child.surface,
			branch: "cancel",
			baseRef: "HEAD",
			baseSha: "base",
			manifestFile: join(f.root, "manifest.json"),
		};
		child.processIdentity = options.identity;
		child.processIdentityCapture = options.capture;
		child.processIdentityError = options.captureError;
		const closes: string[] = [];
		f.surface.closeSurface = (id) => {
			closes.push(id);
		};
		// Herdr's foreground list is never evidence: show an owned-looking Pi
		// in every case so no result can depend on it.
		f.surface.getProcessInfo = () => ({
			shellPid: 10,
			foregroundProcessGroupId: 10,
			pids: [10],
			foregroundProcesses: [],
		});
		return { adapter, h, child, closes };
	}
	it("signals only the launch-verified identity, keeps the pane, and confirms when it exits", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
			const w = await worktreeChild(f, { probe, identity: identity() });
			await w.adapter.kill(w.h);
			assert.deepEqual(signals, [20]);
			assert.deepEqual(
				w.closes,
				[],
				"the retained worktree pane is never closed",
			);
			assert.equal(
				(await f.surface.inspectSurface(w.child.surface)).kind,
				"present",
			);
		}));
	it("a signalled identity that stays alive (suspended, or ignoring SIGTERM) is unconfirmed, signalled once", async () =>
		usingFixture(async (f) => {
			const table = new Map<number, Entry>([[20, alive()]]);
			const { probe, signals } = fakeProbe(table, () => {
				table.set(20, { ...alive(), state: "T" });
			});
			const w = await worktreeChild(f, { probe, identity: identity() });
			await assert.rejects(
				w.adapter.kill(w.h),
				/Owned Pi process exit unconfirmed in retained worktree pane .*process 20 \(start time 5000\) is still alive 150ms after SIGTERM/,
			);
			assert.deepEqual(signals, [20], "no repeated signal and no SIGKILL");
			assert.deepEqual(w.closes, []);
		}));
	it("a PID reused by a different start time is unconfirmed and never signalled", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive("7777")]]));
			const w = await worktreeChild(f, { probe, identity: identity() });
			await assert.rejects(
				w.adapter.kill(w.h),
				/PID 20 now names a different process \(start time 7777, recorded 5000\); not signalled/,
			);
			assert.deepEqual(signals, []);
		}));
	it("the identity is re-verified immediately before SIGTERM: reuse after the first read is not signalled", async () =>
		usingFixture(async (f) => {
			const table = new Map<number, Entry>([[20, alive()]]);
			const { probe, signals } = fakeProbe(table);
			let reads = 0;
			const racing: ProcessIdentityProbe = {
				...probe,
				stat(pid) {
					// The first read (in terminateProcessIdentity) is the re-verification.
					if (reads++ === 0) table.set(20, alive("7777"));
					return probe.stat(pid);
				},
			};
			const w = await worktreeChild(f, { probe: racing, identity: identity() });
			await assert.rejects(
				w.adapter.kill(w.h),
				/now names a different process/,
			);
			assert.deepEqual(signals, []);
		}));
	it("a per-process read error on the identity is unconfirmed, never absence", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, "EACCES"]]));
			const w = await worktreeChild(f, { probe, identity: identity() });
			await assert.rejects(
				w.adapter.kill(w.h),
				/process 20 is unreadable: EACCES/,
			);
			assert.deepEqual(signals, []);
		}));
	for (const [label, recorded, pattern] of [
		["another boot", { bootId: "boot-b" }, /recorded on another boot or host/],
		[
			"another PID namespace",
			{ pidNamespace: "pid:[1]" },
			/recorded in another PID namespace/,
		],
	] as const)
		it(`an identity from ${label} is unconfirmed and never signalled`, async () =>
			usingFixture(async (f) => {
				// The same PID is alive locally: a matching number is not identity.
				const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
				const w = await worktreeChild(f, {
					probe,
					identity: identity(recorded),
				});
				await assert.rejects(w.adapter.kill(w.h), pattern);
				assert.deepEqual(signals, []);
			}));
	it("a worktree child launched without identity capture is unconfirmed", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
			const w = await worktreeChild(f, { probe });
			await assert.rejects(
				w.adapter.kill(w.h),
				/nothing was signalled: no identity was recorded at launch/,
			);
			assert.deepEqual(signals, []);
		}));
	it("an uncaptured identity is unconfirmed and nothing is signalled", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
			const w = await worktreeChild(f, {
				probe,
				captureError: "Process identity not captured within 15000ms",
			});
			await assert.rejects(
				w.adapter.kill(w.h),
				/identity was not captured for retained worktree pane .*nothing was signalled: Process identity not captured within 15000ms/,
			);
			assert.deepEqual(signals, []);
		}));
	it("a capture still pending at the deadline is unconfirmed", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
			const w = await worktreeChild(f, {
				probe,
				capture: new Promise(() => {}),
			});
			await assert.rejects(
				w.adapter.kill(w.h),
				/identity was not captured .*identity capture is still pending/,
			);
			assert.deepEqual(signals, []);
		}));
	it("negative control: a capture that settles before the deadline is used", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
			const w = await worktreeChild(f, {
				probe,
				capture: new Promise((resolve) =>
					setTimeout(() => resolve(identity()), 20),
				),
			});
			await w.adapter.kill(w.h);
			assert.deepEqual(signals, [20]);
		}));
	for (const state of ["absent PID", "zombie"] as const)
		it(`confirms an already-exited identity (${state}) without signalling`, async () =>
			usingFixture(async (f) => {
				const { probe, signals } = fakeProbe(
					new Map<number, Entry>(
						state === "zombie" ? [[20, { ...alive(), state: "Z" }]] : [],
					),
				);
				const w = await worktreeChild(f, { probe, identity: identity() });
				await w.adapter.kill(w.h);
				assert.deepEqual(signals, []);
				assert.deepEqual(w.closes, []);
			}));
	for (const [label, options] of [
		["no captured identity", {}],
		["an unreadable identity", { entry: "EACCES" as const }],
		["a reused PID", { entry: alive("7777") }],
	] as const)
		it(`a gone pane confirms with ${label}`, async () =>
			usingFixture(async (f) => {
				const { probe, signals } = fakeProbe(
					new Map<number, Entry>(
						"entry" in options ? [[20, options.entry]] : [],
					),
				);
				const w = await worktreeChild(f, {
					probe,
					identity: "entry" in options ? identity() : undefined,
				});
				f.surface.removeSurface(w.child.surface);
				await w.adapter.kill(w.h);
				assert.deepEqual(signals, []);
			}));
	it("negative control: a gone pane does not confirm while the identity is alive", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]), () => {});
			const w = await worktreeChild(f, { probe, identity: identity() });
			f.surface.removeSurface(w.child.surface);
			await assert.rejects(w.adapter.kill(w.h), /is still alive/);
			assert.deepEqual(signals, [20]);
		}));
	it("a PID reused after SIGTERM is unconfirmed and reported as signalled", async () =>
		usingFixture(async (f) => {
			const table = new Map<number, Entry>([[20, alive()]]);
			const { probe, signals } = fakeProbe(table, () =>
				table.set(20, alive("7777")),
			);
			const w = await worktreeChild(f, { probe, identity: identity() });
			await assert.rejects(
				w.adapter.kill(w.h),
				/PID 20 now names a different process \(start time 7777, recorded 5000\) after SIGTERM/,
			);
			assert.deepEqual(signals, [20], "signalled once, never the new process");
		}));
	it("an unavailable pane state without identity is unconfirmed", async () =>
		usingFixture(async (f) => {
			const w = await worktreeChild(f, { captureError: "not recorded" });
			f.surface.inspectSurface = () => {
				throw new Error("herdr unavailable");
			};
			await assert.rejects(
				w.adapter.kill(w.h),
				/nothing was signalled: not recorded/,
			);
		}));
	for (const settles of [true, false])
		it(`an identity captured during the absence check is judged and signalled, never confirmed by absence (capture ${settles ? "settles" : "wait expires"})`, async () =>
			usingFixture(async (f) => {
				const { probe, signals } = fakeProbe(
					new Map([[20, alive()]]),
					() => {},
				);
				let resolveCapture!: (value: PiProcessIdentity) => void;
				const w = await worktreeChild(f, {
					probe,
					capture: new Promise((resolve) => {
						resolveCapture = resolve;
					}),
				});
				f.surface.inspectSurface = async () => {
					w.child.processIdentity = identity();
					if (settles) resolveCapture(identity());
					await new Promise((resolve) => setTimeout(resolve, 1));
					return { kind: "missing" };
				};
				await assert.rejects(w.adapter.kill(w.h), /is still alive/);
				assert.deepEqual(signals, [20]);
			}));
	it("an unreadable identity known alive again after the pane check is signalled, not confirmed", async () =>
		usingFixture(async (f) => {
			const table = new Map<number, Entry>([[20, "EACCES"]]);
			const { probe, signals } = fakeProbe(table, () => {});
			const w = await worktreeChild(f, { probe, identity: identity() });
			f.surface.inspectSurface = async () => {
				table.set(20, alive());
				return { kind: "missing" };
			};
			await assert.rejects(w.adapter.kill(w.h), /is still alive/);
			assert.deepEqual(signals, [20], "signalled once, after re-verification");
		}));
	const eperm = () => {
		throw Object.assign(new Error("EPERM: kill 20"), { code: "EPERM" });
	};
	it("a failed SIGTERM to an identity known alive again after the pane check is unconfirmed, not confirmed by absence", async () =>
		usingFixture(async (f) => {
			const table = new Map<number, Entry>([[20, "EACCES"]]);
			const { probe, signals } = fakeProbe(table, eperm);
			const w = await worktreeChild(f, { probe, identity: identity() });
			f.surface.inspectSurface = async () => {
				table.set(20, alive());
				return { kind: "missing" };
			};
			await assert.rejects(
				w.adapter.kill(w.h),
				/exit unconfirmed .*SIGTERM to process 20 failed: EPERM: kill 20; process 20 was alive when signalled/,
			);
			assert.deepEqual(signals, [20], "one failed attempt, never repeated");
		}));
	it("a failed SIGTERM to a live identity is unconfirmed even when the pane is already gone", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]), eperm);
			const w = await worktreeChild(f, { probe, identity: identity() });
			f.surface.removeSurface(w.child.surface);
			await assert.rejects(
				w.adapter.kill(w.h),
				/SIGTERM to process 20 failed: EPERM.*was alive when signalled/,
			);
			assert.deepEqual(signals, [20]);
		}));
	for (const paneGone of [false, true])
		it(`negative control: a failed SIGTERM whose identity is really gone confirms (pane ${paneGone ? "gone" : "present"})`, async () =>
			usingFixture(async (f) => {
				const table = new Map<number, Entry>([[20, alive()]]);
				const { probe, signals } = fakeProbe(table, (pid) => {
					table.delete(pid);
					eperm();
				});
				const w = await worktreeChild(f, { probe, identity: identity() });
				if (paneGone) f.surface.removeSurface(w.child.surface);
				await w.adapter.kill(w.h);
				assert.deepEqual(signals, [20]);
			}));
	it("negative control: an identity captured during the absence check that already exited confirms", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map());
			const w = await worktreeChild(f, {
				probe,
				capture: new Promise(() => {}),
			});
			f.surface.inspectSurface = async () => {
				w.child.processIdentity = identity();
				return { kind: "missing" };
			};
			await w.adapter.kill(w.h);
			assert.deepEqual(signals, []);
		}));
	for (const [label, options, pattern] of [
		[
			"no identity",
			{ captureError: "not recorded" },
			/nothing was signalled: not recorded/,
		],
		[
			"an unreadable identity",
			{ identity: identity() },
			/process 20 is unreadable/,
		],
	] as const)
		it(`a stalled pane inspection with ${label} is unconfirmed on time; the late answer changes nothing`, async () =>
			usingFixture(async (f) => {
				const { probe, signals } = fakeProbe(
					new Map<number, Entry>([[20, "EACCES"]]),
				);
				const w = await worktreeChild(f, {
					probe,
					killTimeoutMs: 40,
					...options,
				});
				const release: Array<() => void> = [];
				f.surface.inspectSurface = () =>
					new Promise((resolve) =>
						release.push(() => resolve({ kind: "missing" })),
					);
				const started = Date.now();
				// A repeated cancel is bounded by the same deadline as the first.
				const outcomes = await Promise.allSettled([
					w.adapter.kill(w.h),
					w.adapter.kill(w.h),
				]);
				assert.ok(Date.now() - started < 1_000, "reported on time");
				for (const outcome of outcomes) {
					assert.ok(
						outcome.status === "rejected" && outcome.reason instanceof Error,
					);
					assert.match(outcome.reason.message, pattern);
				}
				for (const answer of release) answer();
				await new Promise((resolve) => setTimeout(resolve, 10));
				assert.deepEqual(signals, []);
				assert.equal(w.child.processIdentity, options.identity);
			}));
	it("a retry after an expired capture recaptures within the cancel's own budget", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
			const w = await worktreeChild(f, {
				probe,
				captureError: "Process identity not captured within 15000ms",
			});
			w.child.processIdentityFile = join(f.root, "late.process.json");
			const budgets: Array<number | undefined> = [];
			f.operations.captureProcessIdentity = async (
				surface,
				expected,
				options,
			) => {
				assert.equal(surface, w.child.surface);
				assert.deepEqual(expected, {
					file: w.child.processIdentityFile,
					id: w.child.id,
					sessionFile: w.child.sessionFile,
				});
				budgets.push(options?.timeoutMs);
				return identity();
			};
			await w.adapter.kill(w.h);
			assert.deepEqual(signals, [20]);
			assert.equal(budgets.length, 1);
			assert.ok(budgets[0]! > 0 && budgets[0]! <= 150, `budget ${budgets[0]}`);
			assert.deepEqual(w.child.processIdentity, identity());
		}));
	it("a failed recapture is unconfirmed with its reason and signals nothing", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
			const w = await worktreeChild(f, { probe, captureError: "expired" });
			w.child.processIdentityFile = join(f.root, "none.process.json");
			f.operations.captureProcessIdentity = async () => {
				throw new Error("still no record");
			};
			await assert.rejects(
				w.adapter.kill(w.h),
				/nothing was signalled: still no record/,
			);
			assert.deepEqual(signals, []);
		}));
	it("negative control: a capture still pending is awaited, not restarted", async () =>
		usingFixture(async (f) => {
			const { probe, signals } = fakeProbe(new Map([[20, alive()]]));
			const w = await worktreeChild(f, {
				probe,
				capture: new Promise(() => {}),
			});
			w.child.processIdentityFile = join(f.root, "pending.process.json");
			let calls = 0;
			f.operations.captureProcessIdentity = async () => {
				calls++;
				return identity();
			};
			await assert.rejects(
				w.adapter.kill(w.h),
				/identity capture is still pending/,
			);
			assert.equal(calls, 0);
			assert.deepEqual(signals, []);
		}));
});

describe("PiHarnessAdapter retained worktree kill with real processes", () => {
	async function realChild(f: ReturnType<typeof fixture>, mode: string) {
		const sessionFile = join(f.root, `real-${mode}.jsonl`);
		const file = `${sessionFile}.process.json`;
		const proc = spawnIdentityChild(file, "real-run", sessionFile, mode);
		await childReady(proc);
		// Pi's `process.title` rewrite has removed the session from argv.
		assert.doesNotMatch(
			readFileSync(`/proc/${proc.pid}/cmdline`, "utf8"),
			/--session|real-run/,
		);
		const captured = await captureSurfacePiProcessIdentity(
			{
				getProcessInfo: () => ({
					shellPid: process.pid,
					pids: [process.pid],
					foregroundProcesses: [],
				}),
			},
			"pane",
			{ file, id: "real-run", sessionFile },
			{ timeoutMs: 5_000, intervalMs: 20 },
		);
		assert.equal(captured.pid, proc.pid);
		const adapter = new PiHarnessAdapter({
			surface: f.surface,
			paneConfig,
			operations: f.operations,
			supervision: f.supervision,
			modelRegistry: f.modelRegistry,
			parent: {
				cwd: f.root,
				sessionFile: join(f.root, "parent", "parent.jsonl"),
				sessionId: "parent",
				sessionDir: join(f.root, "parent"),
				agentDir: join(f.root, "agent"),
			},
			parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
			killTimeoutMs: 300,
		});
		const h = await adapter.spawn(f.options);
		const child = adapter.getRunningChild(h);
		child.worktree = {
			path: join(f.root, "worktree"),
			workspaceId: "owned-workspace",
			paneId: child.surface,
			branch: "cancel",
			baseRef: "HEAD",
			baseSha: "base",
			manifestFile: join(f.root, "manifest.json"),
		};
		child.processIdentity = captured;
		return { proc, adapter, h };
	}
	it("a title-rewritten Pi that survives SIGTERM is unconfirmed until THAT process exits", async () =>
		usingFixture(async (f) => {
			if (process.platform !== "linux") return;
			const r = await realChild(f, "ignore-term");
			try {
				await assert.rejects(r.adapter.kill(r.h), /is still alive/);
				const exited = once(r.proc, "exit");
				r.proc.kill("SIGKILL");
				await exited;
				await r.adapter.kill(r.h);
			} finally {
				r.proc.kill("SIGKILL");
			}
		}));
	it("a suspended title-rewritten Pi is unconfirmed; resumed, SIGTERM ends it and confirms", async () =>
		usingFixture(async (f) => {
			if (process.platform !== "linux") return;
			const r = await realChild(f, "default");
			try {
				process.kill(r.proc.pid!, "SIGSTOP");
				await assert.rejects(r.adapter.kill(r.h), /is still alive/);
				const exited = once(r.proc, "exit");
				process.kill(r.proc.pid!, "SIGCONT");
				await exited;
				await r.adapter.kill(r.h);
			} finally {
				r.proc.kill("SIGKILL");
			}
		}));
});

// Records its identity through the real child-extension hook, rewrites its
// title as Pi does, then idles. `ignore-term` survives SIGTERM.
const IDENTITY_CHILD = `
const [extension, file, id, sessionFile, mode] = process.argv.slice(1);
const { recordProcessIdentity } = await import(extension);
if (mode === "ignore-term") process.on("SIGTERM", () => {});
recordProcessIdentity(id, sessionFile, file);
process.title = "pi";
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;
function spawnIdentityChild(
	file: string,
	id: string,
	sessionFile: string,
	mode: string,
) {
	return spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			"--input-type=module",
			"-e",
			IDENTITY_CHILD,
			"--",
			new URL(
				"../../maestro/adapters/pi/child/subagent-done.ts",
				import.meta.url,
			).href,
			file,
			id,
			sessionFile,
			mode,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
}
async function childReady(proc: ReturnType<typeof spawn>) {
	let output = "";
	for await (const chunk of proc.stdout!) {
		output += String(chunk);
		if (output.includes("ready\n")) return;
	}
	throw new Error("identity child exited before it was ready");
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
