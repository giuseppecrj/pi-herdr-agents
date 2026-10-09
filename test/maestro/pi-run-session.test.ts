import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	existsSync,
	readFileSync,
	readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
	createWorktreeOperations,
	readWorktreeManifest,
} from "../../maestro/runtime/worktree-operations.ts";
import * as runtime from "../../maestro/runtime/index.ts";
import type {
	DefaultRunSessionOptions,
	PiLaunchInput,
	PiRunRecord,
	PiCompletedMetadata,
} from "../../maestro/runtime/pi-run-session.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch.ts";
import type { PiProcessIdentity } from "../../maestro/adapters/pi/process-identity.ts";
import { discoverAgentCatalog } from "../../maestro/core/roles/discovery.ts";
import {
	appendPersistentTaskEvent,
	readPersistentDeliveryLedger,
	getNewEntries,
	writeSubagentSessionPolicy,
} from "../../maestro/adapters/pi/session.ts";
import {
	createLifecycle,
	markCompleted,
	markCompletionDetected,
	markDelivery,
	markInterruptRequested,
} from "../../maestro/core/lifecycle.ts";
import { createSubagentActivityRecorder } from "../../maestro/adapters/pi/activity-file.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";

test("Task15 detached activity observation works before any factory and retains lifecycle rules", () => {
	const dir = mkdtempSync(join(tmpdir(), "detached-activity-"));
	try {
		const file = join(dir, "activity.json");
		const recorder = createSubagentActivityRecorder({
			runningChildId: "detached",
			activityFile: file,
			now: () => 100,
		});
		recorder.sessionStart();
		recorder.toolExecutionStart("tool", "bash");
		const initial = createLifecycle(0);
		const before = structuredClone(initial);
		const observed = runtime.observePiActivity(
			{ id: "detached", activityFile: file, lifecycle: initial },
			200,
		);
		assert.deepEqual(initial, before);
		assert.equal(observed.kind, "refresh");
		assert.equal(observed.observedAt, 200);
		assert.equal(observed.projection.kind, "active");
		assert.equal(observed.projection.label, "bash");
		assert.ok(observed.activityRead.ok);
		assert.equal(observed.activity, observed.activityRead.activity);
		const interrupted = markInterruptRequested(observed.lifecycle, 300);
		assert.equal(
			runtime.observePiActivity(
				{ id: "detached", activityFile: file, lifecycle: interrupted },
				400,
			).lifecycle,
			interrupted,
		);
		const completed = markCompleted(
			markCompletionDetected(
				observed.lifecycle,
				{ reason: "done", exitCode: 0 },
				300,
			),
			300,
		);
		assert.equal(
			runtime.observePiActivity(
				{ id: "detached", activityFile: file, lifecycle: completed },
				400,
			).lifecycle,
			completed,
		);
		const suppressed = markDelivery(observed.lifecycle, "suppressed");
		const afterSuppression = runtime.observePiActivity(
			{ id: "detached", activityFile: file, lifecycle: suppressed },
			400,
		);
		assert.equal(afterSuppression.lifecycle.delivery, "suppressed");
		const wrong = runtime.observePiActivity(
			{ id: "other", activityFile: file, lifecycle: initial },
			200,
		);
		assert.deepEqual(wrong.activityRead, { ok: false, reason: "wrong-id" });
		assert.deepEqual(wrong.lifecycle.activityHealth, {
			kind: "problem",
			reason: "wrong-id",
			since: 200,
		});
		for (const activityFile of [undefined, "", join(dir, "missing")]) {
			const missing = runtime.observePiActivity(
				{ id: "detached", activityFile, lifecycle: initial },
				200,
			);
			assert.deepEqual(missing.activityRead, { ok: false, reason: "missing" });
			assert.equal(missing.activity, undefined);
			assert.equal(missing.lifecycle.activityHealth.kind, "problem");
		}
		writeFileSync(file, "{");
		const invalid = runtime.observePiActivity(
			{ id: "detached", activityFile: file, lifecycle: initial },
			200,
		);
		assert.ok(
			!invalid.activityRead.ok &&
				invalid.activityRead.reason === "invalid" &&
				invalid.activityRead.error,
		);
		assert.equal(invalid.lifecycle.activityHealth.kind, "problem");
		assert.deepEqual(initial, before);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
	const dir = mkdtempSync(join(tmpdir(), "pi-composition-"));
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
		configExamplePath: new URL("../../config.json.example", import.meta.url)
			.pathname,
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

test("Task17 discovered Role defaults reach the actual runtime launch without synthetic host roles", () =>
	fixture(async (f) => {
		const agents = join(f.dir, "agents");
		mkdirSync(agents);
		writeFileSync(
			join(agents, "core-worker.md"),
			"---\nname: core-worker\ndescription: Core role\nmodel: test/role-default\nthinking: low\nauto-exit: true\nspawning: false\ndeny-tools: write\nskills: first,second\nsystem-prompt: replace\n---\nCore role identity",
		);
		const definition = discoverAgentCatalog({
			agentConfigDir: f.dir,
			cwd: f.dir,
		}).agents[0];
		f.options.roles.push(definition.role);
		const session = runtime.createDefaultRunSession(f.options, f.session);
		const handle = await session.spawn({
			id: "core-role",
			name: "core-worker",
			prompt: "bounded task",
			role: definition.name,
			cwd: f.dir,
		});
		const started = session.getStarted("core-role")!;
		assert.equal(started.model, "test/role-default");
		assert.equal(started.thinking, "low");
		assert.equal(started.runtimePlan?.modelSource, "agent");
		const record = session.getRecord("core-role")!;
		assert.equal(record.interactive, false);
		const script = f.commands[0];
		assert.match(script, /PI_SUBAGENT_AUTO_EXIT=1/);
		assert.match(script, /PI_DENY_TOOLS=.*write/);
		assert.match(script, /\/skill:first/);
		assert.match(script, /\/skill:second/);
		const promptPath = script.match(/--system-prompt '([^']+)'/)?.[1];
		assert.ok(promptPath);
		assert.equal(readFileSync(promptPath, "utf8"), "Core role identity");
		f.complete(record);
		assert.equal(
			(await session.supervise(handle, session.getTask("core-role")!)).outcome,
			"completed",
		);
	}));

function initializeWorktreeFixture(dir: string) {
	const git = (args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git(["init", "-q", "-b", "main"]);
	git([
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-qm",
		"base",
	]);
	return git;
}

for (const mode of ["success", "focus-warning", "readiness-failure"] as const) {
	test(`runtime handoff executes the unobserved transaction: ${mode}`, () =>
		fixture(async (f) => {
			const git = initializeWorktreeFixture(f.dir);
			const snapshot = f.options.getLaunchSnapshot();
			const source = snapshot.parent.sessionFile;
			const bytes = `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: f.dir })}\n${JSON.stringify({ type: "message", id: "leaf", parentId: null, message: { role: "user", content: [{ type: "text", text: "active branch" }], timestamp: 1 } })}\n`;
			writeFileSync(source, bytes);
			const path = join(f.dir, "handoff-tree");
			let focused = false;
			let entered!: () => void, release!: () => void;
			const readyEntered = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const readyRelease = new Promise<void>((resolve) => {
				release = resolve;
			});
			let manifestFile = "";
			f.operations.createWorktree = (_name, _cwd, branch, base) => {
				const manifests = join(
					snapshot.parent.sessionDir,
					"artifacts",
					"parent",
					"worktree-runs",
				);
				const manifest = readdirSync(manifests)[0];
				manifestFile = join(manifests, manifest);
				assert.equal(readWorktreeManifest(manifestFile)?.state, "provisioning");
				git(["worktree", "add", "-q", "-b", branch, path, base]);
				return { path, branch, workspaceId: "workspace", paneId: "pane" };
			};
			f.operations.waitForPiReady = async (_pane, sessionFile, cwd) => {
				assert.equal(cwd, path);
				assert.ok(existsSync(sessionFile));
				assert.equal(readWorktreeManifest(manifestFile)?.state, "provisioned");
				entered();
				await readyRelease;
				if (mode === "readiness-failure")
					throw new Error("expected Pi not observed");
			};
			f.operations.focusWorkspace = () => {
				assert.equal(readWorktreeManifest(manifestFile)?.state, "running");
				focused = true;
				if (mode === "focus-warning") throw new Error("focus unavailable");
			};
			const { writes } = markedSession(f);
			const handoff = f.session.handoffWorktree({
				name: "handoff",
				task: "continue",
				branch: "handoff",
				leafId: "leaf",
				snapshot,
				runtimePlan: f.input().plans[0],
			});
			const observed = handoff.then(
				(value) => ({ value }),
				(error: Error) => ({ error }),
			);
			try {
				await Promise.race([
					readyEntered,
					observed.then((result) => {
						throw new Error(
							`handoff ended before readiness: ${JSON.stringify(result)}`,
						);
					}),
				]);
				await turn();
				assert.equal(focused, false);
				assert.equal(f.registrations(), 0);
				assert.equal(f.latest(), undefined);
				assert.equal(f.session.getControlTaskId("handoff"), undefined);
				assert.equal(f.session.diagnostics().watcherCount, 0);
			} finally {
				release();
			}
			const result = await observed;
			await turn();
			assert.deepEqual(writes, []);
			assert.equal(readFileSync(source, "utf8"), bytes);
			assert.equal(f.registrations(), 0);
			assert.equal(f.settled.length, 0);
			const command = f.commands[0];
			assert.ok(
				!command.includes("PI_SUBAGENT_") &&
					!command.includes("subagent-done.ts") &&
					!command.includes("__SUBAGENT_DONE_"),
			);
			if ("error" in result) {
				assert.equal(mode, "readiness-failure");
				assert.match(
					result.error.message,
					/worktree retained.*expected Pi not observed/,
				);
				assert.equal(readWorktreeManifest(manifestFile)?.state, "failed");
				assert.equal(focused, false);
			} else {
				assert.equal(result.value.record.worktree?.sourceSessionFile, source);
				assert.equal(result.value.record.worktree?.branch, "handoff");
				assert.equal(result.value.record.interactive, true);
				assert.equal(
					result.value.focusError,
					mode === "focus-warning" ? "focus unavailable" : undefined,
				);
				assert.equal(readWorktreeManifest(manifestFile)?.state, "running");
			}
		}));
}

test("injected worktree finalization precedes delivery and preserves inspection/manifest failures", () =>
	fixture(async (f) => {
		initializeWorktreeFixture(f.dir);
		const calls: string[] = [];
		const worktreeOps = createWorktreeOperations();
		const write = worktreeOps.persistWorktreeResult;
		worktreeOps.captureWorktreeHandoff = (worktree) => {
			calls.push("capture");
			return {
				...worktree,
				headSha: null,
				commitsAhead: null,
				clean: null,
				conflicted: null,
				changedFiles: null,
				untrackedFiles: null,
				gitError: "inspection unavailable",
			};
		};
		worktreeOps.persistWorktreeResult = (worktree, state, handoff) => {
			if (state !== "running") {
				calls.push(`finalize:${state}`);
				throw new Error("write unavailable");
			}
			write(worktree, state, handoff);
		};
		f.options.infrastructure!.worktreeOperations = worktreeOps;
		const session = runtime.createDefaultRunSession(f.options);
		f.operations.createWorktree = (_name, _cwd, branch) => ({
			path: f.dir,
			branch,
			workspaceId: "workspace",
			paneId: "pane",
		});
		const input = f.input();
		input.task.worktree = { branch: "managed" };
		f.options.hooks.onSettled = (_record, result) => {
			calls.push("delivery");
			assert.deepEqual(calls, [
				"capture",
				"capture",
				"finalize:ready_for_review",
				"delivery",
			]);
			assert.equal(result.worktree?.clean, null);
			assert.match(
				result.worktree!.gitError!,
				/inspection unavailable; Manifest update failed: write unavailable/,
			);
		};
		// The fake surface must exist for the unchanged completion producer.
		const pane = f.provider.createSurface({ name: "worktree", cwd: f.dir });
		f.operations.createWorktree = (_name, _cwd, branch) => ({
			path: f.dir,
			branch,
			workspaceId: "workspace",
			paneId: pane,
		});
		try {
			const handle = await session.spawnPi(input);
			const record = session.getRecord(input.task.id)!;
			const wait = session.supervise(handle, input.task);
			f.complete(record);
			await wait;
			assert.equal(calls.at(-1), "delivery");
			assert.equal(f.provider.listSurfaces().length, 1);
		} finally {
			await session.shutdown("quit");
		}
	}));

test("Pi composition consumes real launch metadata, retires live getters and rejects consumed IDs", () =>
	fixture(async (f) => {
		const input = f.input();
		const handle = await f.session.spawnPi(input);
		const record = f.session.getRecord(input.task.id)!;
		assert.equal(record, f.latest());
		assert.equal(handle.id, "public-control");
		assert.equal(f.session.getControlTaskId(handle.id), input.task.id);
		assert.equal(
			f.session.getStarted(input.task.id)?.sessionFile,
			record.sessionFile,
		);
		f.options.hooks.onSettled = (actual, metadata) => {
			assert.equal(actual, record);
			assert.equal(f.session.getCompleted(input.task.id), metadata);
			f.settled.push(metadata);
		};
		const wait = f.session.supervise(handle, f.session.getTask(input.task.id)!);
		f.complete(record);
		const result = await wait;
		assert.equal(result.outcome, "completed");
		assert.equal(f.registrations(), 1);
		assert.equal(f.provider.listSurfaces().length, 0);
		for (const get of [
			f.session.getRecord,
			f.session.getStarted,
			f.session.getCompleted,
		])
			assert.equal(get(input.task.id), undefined);
		assert.equal(f.session.getControlTaskId(handle.id), undefined);
		await assert.rejects(
			f.session.spawnPi(input),
			/control.*reserved or consumed/,
		);
		await assert.rejects(
			f.session.supervise(handle, input.task),
			/retired\/consumed/,
		);
		f.session.suppress(input.task.id);
		assert.equal(f.settled.length, 1);
	}));

test("caller cancellation never cancels the single Pi registration, even after the last observer", () =>
	fixture(async (f) => {
		const input = f.input();
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		const already = new AbortController();
		already.abort();
		await assert.rejects(
			f.session.supervise(h, input.task, already.signal),
			/Aborted/,
		);
		assert.equal(f.registrations(), 0);
		const a = new AbortController(),
			b = new AbortController();
		const one = f.session.supervise(h, input.task, a.signal),
			two = f.session.supervise(h, input.task, b.signal);
		a.abort();
		b.abort();
		await assert.rejects(one, /Aborted/);
		await assert.rejects(two, /Aborted/);
		assert.equal(f.registrations(), 1);
		assert.equal(f.session.getRecord(input.task.id), r);
		const adopted = runtime.createDefaultRunSession(
			{
				...f.options,
				hooks: {
					onSettled(_r, result) {
						f.settled.push(result);
					},
				},
			},
			f.session,
		);
		f.complete(r);
		await adopted.supervise(h, input.task);
		assert.equal(f.registrations(), 1);
		assert.equal(f.settled.length, 1);
	}));

for (const reject of [false, true])
	test(`onSpawned acquisition visible and ${reject ? "rejection recoverable" : "accepted"}`, () =>
		fixture(async (f) => {
			const input = f.input();
			const error = new Error("spawn hook original");
			f.options.hooks.onSpawned = (r, s) => {
				assert.equal(f.session.getRecord(input.task.id), r);
				assert.equal(f.session.getStarted(input.task.id), s);
				if (reject) throw error;
			};
			if (reject)
				await assert.rejects(f.session.spawnPi(input), (e) => e === error);
			else await f.session.spawnPi(input);
			const h = f.session.getHandle(input.task.id)!;
			const r = f.session.getRecord(input.task.id)!;
			assert.ok(h);
			assert.equal(f.registrations(), 0);
			await assert.rejects(f.session.spawnPi(input), /consumed/);
			f.complete(r);
			await f.session.supervise(h, input.task);
			assert.equal(f.settled.length, 1);
		}));

for (const help of [false, true])
	test(`rejected ${help ? "help" : "done"} delivery retires ownership but retains manual panes`, () =>
		fixture(async (f) => {
			const input = f.input();
			const h = await f.session.spawnPi(input);
			const r = f.latest()!;
			const error = new Error("send rejected");
			f.options.hooks.onSettled = () => {
				throw error;
			};
			const wait = f.session.supervise(h, input.task);
			f.complete(
				r,
				help
					? { type: "ping", name: "child", message: "help" }
					: { type: "done" },
			);
			await assert.rejects(wait, (e) => e === error);
			assert.equal(f.session.getRecord(input.task.id), undefined);
			assert.equal(f.session.getControlTaskId(h.id), undefined);
			f.session.suppress(input.task.id);
			assert.equal(f.provider.listSurfaces().length, 1);
		}));

// Inspect the existing private owner only; getters would lazily hide leaked entries.
function ownerEntries(session: runtime.PiRunSession): Map<string, unknown> {
	const key = Symbol.for("pi-herdr-agents/PiRunSession-owner");
	// SAFETY: the production factory attaches this known private owner symbol.
	return (
		session as runtime.PiRunSession & {
			[key: symbol]: { entries: Map<string, unknown> };
		}
	)[key].entries;
}

for (const suppress of [false, true])
	test(`all cancelled callers retire Pi auxiliary entries after ${suppress ? "explicit suppression" : "owned settlement"} without getters`, () =>
		fixture(async (f) => {
			const input = f.input();
			const h = await f.session.spawnPi(input);
			const r = f.latest()!;
			const entries = ownerEntries(f.session);
			const a = new AbortController(),
				b = new AbortController();
			const one = f.session.supervise(h, input.task, a.signal);
			const two = f.session.supervise(h, input.task, b.signal);
			a.abort();
			b.abort();
			await assert.rejects(one, /Aborted/);
			await assert.rejects(two, /Aborted/);
			assert.equal(entries.size, 1);
			if (suppress) {
				f.session.suppress(input.task.id);
				assert.equal(
					entries.size,
					0,
					"suppression must eagerly retire Pi ownership",
				);
			} else f.complete(r);
			const deadline = Date.now() + 3000;
			while (f.session.getTask(input.task.id)) {
				assert.ok(Date.now() < deadline, "owned producer did not retire");
				await turn();
			}
			assert.equal(entries.size, 0);
			assert.equal(f.registrations(), 1);
			assert.equal(f.settled.length, suppress ? 0 : 1);
		}));

for (const cancelled of [false, true])
	test(`post-evidence finalization I/O failure ${cancelled ? "after caller cancellation" : "with joined caller"} delivers Stage3 ordinary error metadata and eagerly retires`, () =>
		fixture(async (f) => {
			const input = f.input();
			input.plans = [
				input.plans[0],
				{ ...input.plans[0], model: "test/two", modelId: "two" },
			];
			const h = await f.session.spawnPi(input);
			const r = f.latest()!;
			const entries = ownerEntries(f.session);
			const completions: { record: PiRunRecord; process: string }[] = [];
			f.options.hooks.onObserved = (record, observation) => {
				if (observation.kind !== "completion") return;
				completions.push({ record, process: record.lifecycle.process.kind });
				// Real adapter read succeeded before its completion callback.
				rmSync(record.sessionFile);
				mkdirSync(record.sessionFile); // Only the composition's next read fails.
			};
			const controller = new AbortController();
			const wait = f.session.supervise(h, input.task, controller.signal);
			if (cancelled) {
				controller.abort();
				await assert.rejects(wait, /Aborted/);
			}
			f.complete(r, { type: "error", errorMessage: "real provider evidence" });
			if (!cancelled) {
				const result = await wait;
				assert.equal(result.outcome, "failed");
				assert.equal(
					result.evidence,
					undefined,
					"processing error must not manufacture provider evidence or retry",
				);
			}
			const deadline = Date.now() + 3000;
			while (f.session.getTask(input.task.id)) {
				assert.ok(Date.now() < deadline);
				await turn();
			}
			assert.equal(completions.length, 1);
			assert.equal(completions[0].record, r);
			assert.equal(completions[0].process, "finalizing");
			assert.equal(
				entries.size,
				0,
				"no Pi getters may prune before this assertion",
			);
			assert.equal(f.settled.length, 1);
			const metadata = f.settled[0];
			assert.equal(metadata.exitCode, 1);
			assert.equal(metadata.name, r.name);
			assert.equal(metadata.task, input.task.prompt);
			assert.equal(metadata.agent, r.agent);
			assert.ok(Number.isInteger(metadata.elapsed));
			assert.equal(
				metadata.error,
				"EISDIR: illegal operation on a directory, read",
			);
			assert.equal(metadata.summary, `Subagent error: ${metadata.error}`);
			assert.equal(metadata.sessionFile, undefined);
			assert.equal(metadata.errorMessage, undefined);
			assert.equal(metadata.runtimePlan, undefined);
			assert.deepEqual(metadata.fallbackAttempts, ["test/one"]);
			assert.deepEqual(metadata.fallbackFailures, []);
			assert.equal(
				f.commands.length,
				1,
				"processing failures are not running provider retries",
			);
			assert.equal(f.provider.listSurfaces().length, 0);
		}));

test("cancelled resume callers still retire both owners on actual lazy-read rejection without getters", () =>
	fixture(async (f) => {
		const path = join(f.dir, "saved.jsonl");
		writeFileSync(
			path,
			JSON.stringify({ type: "session", version: 3, id: "saved", cwd: f.dir }) +
				"\n",
		);
		writeSubagentSessionPolicy(path, { owner: "public", deniedTools: [] });
		const h = await f.session.resumePi({
			taskId: "resume-control",
			name: "resumed",
			sessionPath: path,
		});
		const task = f.session.getTask("resume-control")!;
		const record = f.latest()!;
		const entries = ownerEntries(f.session);
		let calls = 0;
		let actualError: unknown;
		f.options.hooks.onSettled = (r, _result, _task, io) => {
			calls++;
			r.lifecycle = markDelivery(r.lifecycle, "delivered");
			try {
				io.readResumeResult!();
			} catch (error) {
				actualError = error;
				throw error;
			}
		};
		const a = new AbortController(),
			b = new AbortController();
		const one = f.session.supervise(h, task, a.signal),
			two = f.session.supervise(h, task, b.signal);
		a.abort();
		b.abort();
		await assert.rejects(one, /Aborted/);
		await assert.rejects(two, /Aborted/);
		rmSync(path);
		mkdirSync(path);
		f.complete(record);
		const deadline = Date.now() + 3000;
		while (f.session.getTask(task.id)) {
			assert.ok(Date.now() < deadline);
			await turn();
		}
		assert.equal(
			entries.size,
			0,
			"private Pi map must retire with no facade getter",
		);
		assert.equal(calls, 1);
		assert.match(String(actualError), /EISDIR/);
		assert.equal(record.lifecycle.delivery, "delivered");
		assert.equal(f.registrations(), 1);
		assert.equal(f.provider.listSurfaces().length, 1);
		f.session.suppress(task.id);
		assert.equal(f.provider.listSurfaces().length, 1);
		await assert.rejects(f.session.supervise(h, task), /retired\/consumed/);
	}));

test("resume settlement reader is scoped to its run, not shared with concurrent ordinary or persistent I/O", () =>
	fixture(async (f) => {
		const path = join(f.dir, "saved.jsonl");
		writeFileSync(
			path,
			JSON.stringify({ type: "session", version: 3, id: "saved", cwd: f.dir }) +
				"\n",
		);
		writeSubagentSessionPolicy(path, { owner: "public", deniedTools: [] });
		const h = await f.session.resumePi({
			taskId: "resume-control",
			name: "resumed",
			sessionPath: path,
		});
		const r = f.latest()!;
		const input = f.input("ordinary");
		const ordinary = await f.session.spawnPi(input);
		const o = f.latest()!;
		const persistentInput = f.input("persistent", true);
		const persistent = await f.session.spawnPi(persistentInput);
		const p = f.latest()!;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let resumeIO: runtime.PiSettlementIO | undefined;
		const nonResumeIO: runtime.PiSettlementIO[] = [];
		const persistentIO: runtime.PiPersistentIO[] = [];
		f.options.persistent.drain = (_record, io) => {
			persistentIO.push(io);
		};
		f.options.hooks.onSettled = async (_record, _result, task, io) => {
			if (task.id === "resume-control") {
				resumeIO = io;
				await blocked;
				io.readResumeResult!();
			} else nonResumeIO.push(io);
		};
		const resumedWait = f.session.supervise(
			h,
			f.session.getTask("resume-control")!,
		);
		f.complete(r);
		const deadline = Date.now() + 3000;
		while (!resumeIO) {
			assert.ok(Date.now() < deadline);
			await turn();
		}
		try {
			const ordinaryWait = f.session.supervise(ordinary, input.task);
			f.complete(o);
			await ordinaryWait;
			const persistentWait = f.session.supervise(
				persistent,
				persistentInput.task,
			);
			f.complete(p);
			await persistentWait;
			assert.deepEqual(resumeIO.readResumeResult!(), {
				summary: "Resumed session exited without new output",
				sessionFile: path,
			});
			assert.equal(nonResumeIO.length, 2);
			assert.ok(persistentIO.length > 0);
			for (const io of [...nonResumeIO, ...persistentIO]) {
				assert.notEqual(io, resumeIO);
				assert.equal(Object.hasOwn(io, "readResumeResult"), false);
			}
		} finally {
			release();
			await resumedWait;
		}
	}));

test("local evidence drains persistent events without activity hydration while preserving the callback", () =>
	fixture(async (f) => {
		const input = f.input("cold", true);
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		let localObservations = 0,
			drains = 0,
			ticks = 0;
		let lifecycle = r.lifecycle;
		let hydratedOnDrain = false;
		let localHydration = false;
		let tickReadOk: boolean | undefined;
		let tickToolCall: string | undefined;
		f.options.hooks.onObserved = (_record, observation) => {
			if (observation.kind === "local-evidence") {
				localObservations++;
				localHydration ||=
					observation.activityRead !== undefined ||
					observation.lifecycle !== lifecycle;
				if (localObservations === 1) {
					mkdirSync(dirname(r.activityFile), { recursive: true });
					writeFileSync(
						r.activityFile,
						JSON.stringify({
							version: 1,
							runningChildId: r.id,
							createdAt: 1,
							updatedAt: 2,
							sequence: 1,
							latestEvent: "tool_call",
							phase: "active",
							agentActive: true,
							turnActive: true,
							providerActive: false,
							toolActive: true,
							activeScope: "tool",
							activeSince: 2,
							toolName: "bash",
							toolCallId: "fresh-call",
							toolStartedAt: 2,
						}),
					);
				}
			} else {
				lifecycle = r.lifecycle;
				if (observation.kind === "tick") {
					ticks++;
					tickReadOk = observation.activityRead?.ok;
					tickToolCall = observation.activity?.toolCallId;
				}
			}
		};
		f.options.persistent.drain = (record) => {
			drains++;
			hydratedOnDrain ||= record.lifecycle !== lifecycle;
		};
		// Real adapter's synchronous first local-evidence pass precedes its first tick.
		const wait = f.session.supervise(h, input.task);
		assert.equal(
			hydratedOnDrain,
			false,
			"local evidence must not rehydrate activity",
		);
		assert.equal(localObservations, 1);
		assert.equal(
			ticks,
			1,
			"the first tick must hydrate activity written during local evidence",
		);
		assert.equal(localHydration, false);
		assert.equal(tickReadOk, true);
		assert.equal(tickToolCall, "fresh-call");
		assert.ok(drains > 0);
		f.complete(r);
		assert.equal((await wait).outcome, "completed");
	}));

test("worktree candidate validation precedes stripping and launch preparation", () =>
	fixture(async (f) => {
		const input = f.input();
		input.task.worktree = { branch: "never-created" };
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		let preparations = 0;
		input.prepareAttempt = () => {
			preparations++;
			throw new Error("must not prepare");
		};
		await assert.rejects(
			f.session.spawnPi(input),
			/fallbacks are not supported/,
		);
		assert.equal(preparations, 0);
		assert.equal(f.commands.length, 0);
	}));

test("running fallback retains prior attempt, actual persistence and raw failure ordering", () =>
	fixture(async (f) => {
		const input = f.input();
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		const h = await f.session.spawnPi(input);
		const first = f.latest()!;
		const wait = f.session.supervise(h, input.task);
		f.complete(first, { type: "error", errorMessage: "raw account error" });
		while (f.latest() === first) await turn();
		const second = f.latest()!;
		assert.notEqual(second.sessionFile, first.sessionFile);
		assert.equal(second.id, first.id);
		assert.equal(f.provider.listSurfaces().length, 2);
		f.complete(second);
		await wait;
		assert.deepEqual(f.settled[0].fallbackAttempts, ["test/one", "test/two"]);
		assert.deepEqual(f.settled[0].fallbackFailures, [
			{ model: "test/one", error: "raw account error" },
		]);
		assert.equal(f.provider.listSurfaces().length, 0);
	}));

test("persistent events use raw demand-driven I/O, no duplicate initial row or process settlement", () =>
	fixture(async (f) => {
		const input = f.input("persistent", true);
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		let io!: Parameters<DefaultRunSessionOptions["persistent"]["drain"]>[1];
		f.options.persistent.drain = (_r, actual) => {
			io = actual;
		};
		const wait = f.session.supervise(h, input.task);
		await turn();
		assert.equal(readPersistentDeliveryLedger(r.sessionFile).length, 1);
		appendPersistentTaskEvent(r.sessionFile, {
			type: "help-request",
			task: r.taskId!,
			generation: r.generationId!,
		});
		assert.equal(io.readEvents(r).length, 1);
		assert.equal(io.readLedger(r).length, 1);
		const event = io.readEvents(r)[0];
		const ack = io.acknowledge(r, event);
		assert.equal(ack.outcome, "help-requested");
		assert.equal(r.taskId, undefined);
		assert.equal(r.tasksCompleted, 0);
		assert.equal(f.settled.length, 0);
		assert.equal(f.provider.listSurfaces().length, 1);
		const inbox = io.dispatch(r, "followup", "text");
		assert.ok(inbox);
		assert.equal(r.taskId, "followup");
		io.requestStop(r);
		assert.equal(r.taskId, "followup");
		f.complete(r);
		await wait;
	}));

test("suppression gates lifecycle and drains before owned cancellation; deferred close never joins shutdown", () =>
	fixture(async (f) => {
		const input = f.input("shutdown", true);
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		let close!: () => void;
		let closes = 0;
		f.provider.closeSurface = () => {
			closes++;
			return new Promise<void>((resolve) => {
				close = resolve;
			});
		};
		const wait = f.session.supervise(h, input.task);
		let drains = 0;
		f.options.persistent.drain = () => {
			drains++;
			throw new Error("task delivery failed");
		};
		await turn();
		const prior = drains;
		await f.session.shutdown("quit");
		const result = await wait;
		assert.equal(r.lifecycle.delivery, "suppressed");
		assert.equal(result.outcome, "killed");
		assert.equal(drains, prior);
		assert.equal(f.settled.length, 0);
		assert.equal(closes, 1);
		assert.equal(f.session.getRecord(input.task.id), undefined);
		close();
		await turn();
		assert.equal(closes, 1);
	}));

test("resume uses the returned public ID and prelaunch cursor; persistent saved policy refuses acquisition", () =>
	fixture(async (f) => {
		const input = f.input();
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		writeFileSync(
			r.sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "saved", cwd: f.dir }) +
				"\n" +
				JSON.stringify({
					type: "message",
					id: "old",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "old output" }],
					},
				}) +
				"\n",
		);
		f.complete(r);
		await f.session.supervise(h, input.task);
		rmSync(`${r.sessionFile}.exit`, { force: true });
		const resumed = await f.session.resumePi({
			taskId: "resume-control",
			name: "resumed",
			sessionPath: r.sessionFile,
		});
		assert.equal(f.session.getControlTaskId(resumed.id), "resume-control");
		assert.notEqual(resumed.id, "resume-control");
		const next = f.latest()!;
		f.complete(next);
		await f.session.supervise(resumed, f.session.getTask("resume-control")!);
		assert.match(f.settled.at(-1)!.summary, /without new output/);
		assert.equal(getNewEntries(r.sessionFile, 0).length, 2);
	}));

for (const persistent of [false, true])
	test(`launch acquisition failures preserve ordered raw errors for ${persistent ? "persistent" : "ordinary"} attempts`, () =>
		fixture(async (f) => {
			const input = f.input("launch-errors", persistent);
			input.plans = [
				input.plans[0],
				{ ...input.plans[0], model: "test/two", modelId: "two" },
			];
			const run = f.operations.runScript;
			let launches = 0;
			f.operations.runScript = (...args) => {
				if (launches++ === 0) throw new Error("first launch raw");
				return run(...args);
			};
			const h = await f.session.spawnPi(input);
			const r = f.latest()!;
			assert.equal(r.persistent, persistent ? true : undefined);
			f.complete(r);
			await f.session.supervise(h, input.task);
			assert.deepEqual(f.settled[0].fallbackAttempts, ["test/one", "test/two"]);
			assert.deepEqual(f.settled[0].fallbackFailures, [
				{ model: "test/one", error: "first launch raw" },
			]);
		}));

test("exhausted running fallback acquisition keeps prior provider error and attempt order", () =>
	fixture(async (f) => {
		const input = f.input();
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		f.operations.runScript = () => {
			throw new Error("fallback raw launch failure");
		};
		const wait = f.session.supervise(h, input.task);
		f.complete(r, {
			type: "error",
			errorMessage: "original raw provider reason",
		});
		await wait;
		assert.equal(
			f.settled[0].errorMessage,
			"original raw provider reason\n\nFallback launch failures: test/two: fallback raw launch failure",
		);
		assert.deepEqual(f.settled[0].fallbackFailures, [
			{ model: "test/one", error: "original raw provider reason" },
			{ model: "test/two", error: "fallback raw launch failure" },
		]);
	}));

test("effective role-default persistence prevents running fallback but not launch fallback", () =>
	fixture(async (f) => {
		const input = f.input();
		input.task.behavior = {};
		input.role.defaults = { persistent: true };
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		const wait = f.session.supervise(h, input.task);
		f.complete(r, { type: "error", errorMessage: "role-default error" });
		await wait;
		assert.equal(f.commands.length, 1);
		assert.equal(r.persistent, true);
	}));

test("per-attempt normalization changes role and opaque generation, never the validated full plans", () =>
	fixture(async (f) => {
		const input = f.input();
		input.plans = [
			{
				...input.plans[0],
				requestedModel: "test/one",
				thinkingAdjustment: {
					from: "max",
					to: "high",
					reason: "inherited-clamp",
				},
			},
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		let attempts = 0;
		input.prepareAttempt = () => {
			const index = attempts++;
			return {
				...input,
				task: { ...input.task, behavior: { persistent: index === 0 } },
				role: { ...input.role, systemPrompt: `body ${index}` },
				identity: {
					id: `attempt-${index}`,
					logicalId: `logical-${index}`,
					generationId: `gen-${index}`,
					taskId: `task-${index}`,
				},
				snapshot: f.options.getLaunchSnapshot(),
			};
		};
		// Initial acquisition failure still advances when that effective attempt was persistent.
		const run = f.operations.runScript;
		let launches = 0;
		f.operations.runScript = (...args) => {
			if (launches++ === 0) throw new Error("launch fails");
			return run(...args);
		};
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		assert.equal(attempts, 2);
		assert.equal(h.id, "attempt-1");
		assert.equal(r.runtimePlan?.model, "test/two");
		assert.equal(r.persistent, undefined);
		f.complete(r);
		await f.session.supervise(h, input.task);
	}));

for (const reason of ["reload", "new", "resume", "fork"] as const)
	test(`${reason} preserves owners, registration and consumed IDs with fresh rebound hooks`, () =>
		fixture(async (f) => {
			const input = f.input(reason);
			const h = await f.session.spawnPi(input);
			const r = f.latest()!;
			const wait = f.session.supervise(h, input.task);
			await f.session.shutdown(reason);
			assert.equal(f.registrations(), 1);
			assert.equal(f.provider.listSurfaces().length, 1);
			const completed: PiCompletedMetadata[] = [];
			const replacement = runtime.createDefaultRunSession(
				{
					...f.options,
					hooks: {
						onSettled(_r, result) {
							completed.push(result);
						},
					},
				},
				f.session,
			);
			f.complete(r);
			await wait;
			assert.equal(completed.length, 1);
			assert.equal(f.settled.length, 0);
			assert.equal(replacement.getRecord(input.task.id), undefined);
			await assert.rejects(replacement.spawnPi(input), /consumed/);
		}));

test("duplicate pending control IDs reject before normalization and suppression retains a returned real owner", () =>
	fixture(async (f) => {
		const input = f.input("pending");
		let ready!: () => void;
		let waiting!: () => void;
		const entered = new Promise<void>((r) => {
			waiting = r;
		});
		const gate = new Promise<void>((r) => {
			ready = r;
		});
		f.operations.waitForShellReady = async () => {
			waiting();
			await gate;
		};
		let preparations = 0;
		input.prepareAttempt = () => {
			preparations++;
			return { ...input, snapshot: f.options.getLaunchSnapshot() };
		};
		const spawn = f.session.spawnPi(input);
		await entered;
		const replacement = runtime.createDefaultRunSession(f.options, f.session);
		await assert.rejects(replacement.spawnPi(input), /pending.*reserved/);
		assert.equal(preparations, 1);
		await replacement.shutdown("quit");
		ready();
		await assert.rejects(spawn, /Aborted/);
		assert.equal(f.registrations(), 0);
		assert.equal(f.provider.listSurfaces().length, 0);
		assert.equal(replacement.getRecord(input.task.id), undefined);
		assert.equal(replacement.getStarted(input.task.id), undefined);
	}));

for (const rejection of [false, true])
	test(`ordinary settlement doesn't join deferred ${rejection ? "rejected" : "resolved"} close`, () =>
		fixture(async (f) => {
			const input = f.input();
			const h = await f.session.spawnPi(input);
			const r = f.latest()!;
			let end!: (error?: Error) => void;
			let closes = 0;
			f.provider.closeSurface = () => {
				closes++;
				return new Promise<void>((resolve, reject) => {
					end = (error) => (error ? reject(error) : resolve());
				});
			};
			const wait = f.session.supervise(h, input.task);
			f.complete(r);
			await wait;
			assert.equal(closes, 1);
			assert.equal(f.session.getRecord(input.task.id), undefined);
			end(rejection ? new Error("late close rejection") : undefined);
			await turn();
			assert.equal(closes, 1);
			assert.equal(f.settled.length, 1);
		}));

test("new launches capture one snapshot per invocation while adopted handles retain their old context", () =>
	fixture(async (f) => {
		const old = f.input("old"),
			h = await f.session.spawnPi(old),
			record = f.latest()!;
		const wait = f.session.supervise(h, old.task);
		let snapshots = 0;
		const replacement = runtime.createDefaultRunSession(
			{
				...f.options,
				getLaunchSnapshot() {
					snapshots++;
					const snapshot = f.options.getLaunchSnapshot();
					return {
						...snapshot,
						parent: { ...snapshot.parent, sessionId: "new-parent" },
					};
				},
			},
			f.session,
		);
		const next = f.input("next");
		const nh = await replacement.spawnPi(next);
		assert.equal(snapshots, 1);
		assert.equal(replacement.getRecord(old.task.id), record);
		f.complete(record);
		await wait;
		f.complete(replacement.getRecord(next.task.id)!);
		await replacement.supervise(nh, next.task);
		assert.equal(snapshots, 1);
	}));

test("inherited generic resume also uses the actual Pi owner and the caller's control Task", () =>
	fixture(async (f) => {
		const first = f.input();
		const h = await f.session.spawnPi(first);
		const r = f.latest()!;
		f.complete(r);
		await f.session.supervise(h, first.task);
		const task = { ...first.task, id: "generic-resume", prompt: "followup" };
		const resumed = await f.session.resume({
			task,
			name: "generic resumed",
			sessionId: r.sessionFile,
			message: "followup",
		});
		assert.equal(f.session.getTask(task.id), task);
		assert.equal(f.session.getControlTaskId(resumed.id), task.id);
		const next = f.latest()!;
		f.complete(next);
		await f.session.supervise(resumed, task);
	}));

test("ordinary adapter transcript failure delivers Stage3 exit-one metadata without fabricated evidence or fallback", () =>
	fixture(async (f) => {
		const input = f.input();
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		const entries = ownerEntries(f.session);
		rmSync(r.sessionFile, { force: true });
		mkdirSync(r.sessionFile);
		const wait = f.session.supervise(h, input.task);
		f.complete(r);
		const result = await wait;
		assert.equal(result.outcome, "failed");
		assert.equal(result.evidence, undefined);
		assert.equal(f.settled.length, 1);
		const metadata = f.settled[0];
		assert.equal(metadata.exitCode, 1);
		assert.equal(metadata.name, r.name);
		assert.equal(metadata.task, input.task.prompt);
		assert.equal(metadata.agent, r.agent);
		assert.ok(Number.isInteger(metadata.elapsed));
		assert.equal(
			metadata.error,
			"EISDIR: illegal operation on a directory, read",
		);
		assert.equal(metadata.summary, `Subagent error: ${metadata.error}`);
		assert.equal(metadata.sessionFile, undefined);
		assert.equal(metadata.errorMessage, undefined);
		assert.equal(metadata.runtimePlan, undefined);
		assert.deepEqual(metadata.fallbackAttempts, ["test/one"]);
		assert.deepEqual(metadata.fallbackFailures, []);
		assert.equal(
			entries.size,
			0,
			"inspect eager retirement before any Pi getter",
		);
		assert.equal(f.registrations(), 1);
		assert.equal(f.commands.length, 1);
		assert.equal(f.provider.listSurfaces().length, 0);
		assert.equal(f.session.getRecord(input.task.id), undefined);
	}));

test("actual per-launch persistence overrides the initially captured persistent role default", () =>
	fixture(async (f) => {
		const input = f.input();
		input.task.behavior = {};
		input.role.defaults = { persistent: true };
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		input.prepareAttempt = () => ({
			...input,
			task: { ...input.task, behavior: { persistent: false } },
			snapshot: f.options.getLaunchSnapshot(),
		});
		const h = await f.session.spawnPi(input);
		const first = f.latest()!;
		const wait = f.session.supervise(h, input.task);
		f.complete(first, {
			type: "error",
			errorMessage: "not persistent this launch",
		});
		const deadline = Date.now() + 3000;
		while (f.latest() === first) {
			assert.ok(Date.now() < deadline);
			await turn();
		}
		f.complete(f.latest()!);
		await wait;
		assert.equal(f.commands.length, 2);
	}));

for (const suppress of [false, true])
	test(`ordinary resumed help ${suppress ? "suppression" : "rejected delivery"} keeps the public resume safety and retirement contract`, () =>
		fixture(async (f) => {
			const input = f.input();
			const h = await f.session.spawnPi(input);
			const r = f.latest()!;
			f.complete(r);
			await f.session.supervise(h, input.task);
			const resumed = await f.session.resumePi({
				taskId: "resumed",
				name: "resumed",
				sessionPath: r.sessionFile,
			});
			const next = f.latest()!;
			f.options.hooks.onSettled = () => {
				throw new Error("resume send rejected");
			};
			const wait = f.session.supervise(resumed, f.session.getTask("resumed")!);
			if (suppress) {
				f.session.suppress("resumed");
				await wait;
			} else {
				f.complete(next, { type: "ping", name: "resumed", message: "help" });
				await assert.rejects(wait, /resume send rejected/);
			}
			assert.equal(f.session.getRecord("resumed"), undefined);
			assert.equal(f.session.getControlTaskId(resumed.id), undefined);
			assert.equal(f.provider.listSurfaces().length, suppress ? 0 : 1);
		}));

test("running normalization failures retain complete attempted plans and raw error order", () =>
	fixture(async (f) => {
		const input = f.input();
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		input.prepareAttempt = (index) => {
			if (index === 1) throw new Error("role disappeared at actual launch");
			return { ...input, snapshot: f.options.getLaunchSnapshot() };
		};
		const h = await f.session.spawnPi(input);
		const r = f.latest()!;
		const wait = f.session.supervise(h, input.task);
		f.complete(r, { type: "error", errorMessage: "prior error" });
		await wait;
		assert.deepEqual(f.settled[0].fallbackAttempts, ["test/one", "test/two"]);
		assert.deepEqual(f.settled[0].fallbackFailures, [
			{ model: "test/one", error: "prior error" },
			{ model: "test/two", error: "role disappeared at actual launch" },
		]);
	}));

test("public, control, logical specialist, generation and inbox namespaces remain distinct across actual retries", () =>
	fixture(async (f) => {
		const input = f.input();
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		input.prepareAttempt = (index) => ({
			...input,
			task: { ...input.task, behavior: { persistent: index === 1 } },
			identity: {
				id: `public-${index}`,
				logicalId: "distinct-logical",
				generationId: `gen-${index}`,
				taskId: `inbox-${index}`,
			},
			snapshot: f.options.getLaunchSnapshot(),
		});
		const h = await f.session.spawnPi(input);
		const first = f.latest()!;
		const wait = f.session.supervise(h, input.task);
		f.complete(first, { type: "error", errorMessage: "first ordinary fails" });
		const deadline = Date.now() + 3000;
		while (f.latest() === first) {
			assert.ok(Date.now() < deadline);
			await turn();
		}
		const next = f.latest()!;
		assert.equal(next.id, "public-0");
		assert.equal(next.logicalId, "distinct-logical");
		assert.equal(next.generationId, "gen-1");
		assert.equal(next.taskId, "inbox-1");
		assert.equal(f.session.getControlTaskId(next.id), "control");
		f.complete(next);
		await wait;
	}));

interface RecordedMarkerWrite {
	paneId: string;
	seq: number;
	live: boolean;
}

/** Turns markers on for the fixture's shared composition. */
function markedSession(
	f: Awaited<ReturnType<typeof makeFixture>>,
	enabled = true,
) {
	const writes: RecordedMarkerWrite[] = [];
	let held: Array<() => void> | undefined;
	const infrastructure = f.options.infrastructure;
	assert.ok(infrastructure);
	const session = runtime.createDefaultRunSession(
		{
			...f.options,
			sidebarMarkers: enabled,
			infrastructure: {
				...infrastructure,
				markerWriter: (write) => {
					writes.push(write);
					const pending = held;
					return pending
						? new Promise((settle) => pending.push(() => settle("answered")))
						: Promise.resolve("answered");
				},
			},
		},
		f.session,
	);
	return {
		session,
		writes,
		/** Leaves later writes in flight until `release`. */
		hold() {
			held = [];
		},
		release() {
			const pending = held ?? [];
			held = undefined;
			for (const settle of pending) settle();
		},
	};
}

/** Reloads the composition, as `/reload` does, with the setting changed. */
function reloadSession(
	f: Awaited<ReturnType<typeof makeFixture>>,
	previous: ReturnType<typeof runtime.createDefaultRunSession>,
	enabled: boolean,
) {
	return runtime.createDefaultRunSession(
		{ ...f.options, sidebarMarkers: enabled },
		previous,
	);
}

/**
 * A fake /proc behind the injected probe, so marker tests run on any host.
 * Install it before `markedSession`: markers take the probe when created.
 */
function fakeProcesses(f: Awaited<ReturnType<typeof makeFixture>>) {
	const host = { bootId: "boot", pidNamespace: "pid:[1]" };
	const alive = new Set<number>();
	let nextPid = 4_000;
	const infrastructure = f.options.infrastructure;
	assert.ok(infrastructure);
	// The session shares this infrastructure object, so its markers see the probe.
	infrastructure.processProbe = {
		host: () => host,
		stat: (pid) =>
			alive.has(pid) ? { state: "S", ppid: 1, startTime: "100" } : undefined,
		terminate() {
			throw new Error("markers never signal");
		},
	};
	return {
		start(): PiProcessIdentity {
			const pid = nextPid++;
			alive.add(pid);
			return { pid, startTime: "100", ...host };
		},
		exit(identity: PiProcessIdentity) {
			alive.delete(identity.pid);
		},
	};
}

/** Bounded by iterations, not `Date.now`, which some tests freeze. */
async function until(predicate: () => boolean, label: string) {
	for (let attempt = 0; !predicate(); attempt++) {
		if (attempt > 400) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("sidebar markers are off by default: no identity recording and no Herdr writes", () =>
	fixture(async (f) => {
		const { session, writes } = markedSession(f, false);
		const input = f.input("unmarked");
		const handle = await session.spawnPi(input);
		assert.doesNotMatch(f.commands.at(-1) ?? "", /PI_SUBAGENT_PROCESS_FILE/);
		const record = f.latest();
		assert.ok(record);
		f.complete(record);
		await session.supervise(handle, input.task);
		await turn();
		assert.deepEqual(writes, []);
	}));

test("a delegated child is marked after identity verification and cleared before delivery", () =>
	fixture(async (f) => {
		const child = fakeProcesses(f).start();
		f.operations.captureProcessIdentity = async () => child;
		const { session, writes } = markedSession(f);
		const input = f.input("marked");
		const handle = await session.spawnPi(input);
		const record = f.latest();
		assert.ok(record);
		assert.match(f.commands.at(-1) ?? "", /PI_SUBAGENT_PROCESS_FILE=/);
		await until(() => writes.length === 1, "the first marker write");
		assert.deepEqual(
			writes.map(({ paneId, live }) => ({ paneId, live })),
			[{ paneId: record.surface, live: true }],
		);
		// Observations inside the renewal interval do not write again.
		session.observe(input.task.id);
		await turn();
		assert.equal(writes.length, 1);
		f.complete(record);
		await session.supervise(handle, input.task);
		await until(() => writes.length === 2, "the clearing write");
		assert.equal(writes[1].live, false);
		assert.ok(writes[1].seq > writes[0].seq);
	}));

test("a child whose identity was never verified is never marked", () =>
	fixture(async (f) => {
		f.operations.captureProcessIdentity = async () => {
			throw new Error("no identity recorded");
		};
		const { session, writes } = markedSession(f);
		const input = f.input("unverified");
		const handle = await session.spawnPi(input);
		const record = f.latest();
		assert.ok(record);
		await turn();
		f.complete(record);
		await session.supervise(handle, input.task);
		await turn();
		assert.deepEqual(writes, []);
	}));

test("suppressing a marked run clears its marker without waiting for renewal", () =>
	fixture(async (f) => {
		const child = fakeProcesses(f).start();
		f.operations.captureProcessIdentity = async () => child;
		const { session, writes } = markedSession(f);
		const input = f.input("suppressed");
		await session.spawnPi(input);
		await until(() => writes.length === 1, "the first marker write");
		session.suppress(input.task.id);
		await until(() => writes.length === 2, "the clearing write");
		assert.deepEqual(
			writes.map(({ live }) => live),
			[true, false],
		);
	}));

test("turning sidebar markers off on reload clears a live marker after its in-flight renewal", (t) =>
	fixture(async (f) => {
		t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
		const child = fakeProcesses(f).start();
		f.operations.captureProcessIdentity = async () => child;
		const marked = markedSession(f);
		const input = f.input("live-before-reload");
		await marked.session.spawnPi(input);
		const record = f.latest();
		assert.ok(record);
		await until(() => marked.writes.length === 1, "the first marker write");
		marked.hold();
		t.mock.timers.tick(5_000);
		marked.session.observe(input.task.id);
		await until(() => marked.writes.length === 2, "the in-flight renewal");

		const reloaded = reloadSession(f, marked.session, false);
		await turn();
		assert.equal(marked.writes.length, 2);
		marked.release();
		await until(() => marked.writes.length === 3, "the clearing write");
		assert.deepEqual(
			marked.writes.map(({ paneId, live }) => ({ paneId, live })),
			[
				{ paneId: record.surface, live: true },
				{ paneId: record.surface, live: true },
				{ paneId: record.surface, live: false },
			],
		);
		assert.ok(marked.writes[2].seq > marked.writes[1].seq);
		t.mock.timers.tick(5_000);
		reloaded.observe(input.task.id);
		await turn();
		assert.equal(marked.writes.length, 3);
	}));

test("turning sidebar markers off on reload retires a pending marker; re-enabling marks only new children", (t) =>
	fixture(async (f) => {
		t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
		const processes = fakeProcesses(f);
		const late = processes.start();
		let verifyLate!: (identity: PiProcessIdentity) => void;
		f.operations.captureProcessIdentity = () =>
			new Promise<PiProcessIdentity>((resolve) => {
				verifyLate = resolve;
			});
		const marked = markedSession(f);
		const input = f.input("pending-before-reload");
		await marked.session.spawnPi(input);
		await turn();
		assert.ok(verifyLate, "identity capture started");

		const reloaded = reloadSession(f, marked.session, false);
		verifyLate(late);
		await turn();
		t.mock.timers.tick(5_000);
		reloaded.observe(input.task.id);
		await turn();
		assert.deepEqual(marked.writes, []);

		const reenabled = reloadSession(f, reloaded, true);
		t.mock.timers.tick(5_000);
		reenabled.observe(input.task.id);
		await turn();
		assert.deepEqual(marked.writes, []);

		const fresh = processes.start();
		f.operations.captureProcessIdentity = async () => fresh;
		await reenabled.spawnPi(f.input("after-reenable"));
		const record = f.latest();
		assert.ok(record);
		await until(() => marked.writes.length === 1, "the new child's marker");
		assert.deepEqual(
			marked.writes.map(({ paneId, live }) => ({ paneId, live })),
			[{ paneId: record.surface, live: true }],
		);
	}));

test("reloading with sidebar markers still on keeps renewing existing markers", (t) =>
	fixture(async (f) => {
		t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
		const child = fakeProcesses(f).start();
		f.operations.captureProcessIdentity = async () => child;
		const { session, writes } = markedSession(f);
		const input = f.input("kept-on-reload");
		await session.spawnPi(input);
		await until(() => writes.length === 1, "the first marker write");
		const reloaded = reloadSession(f, session, true);
		await turn();
		assert.equal(writes.length, 1);
		t.mock.timers.tick(5_000);
		reloaded.observe(input.task.id);
		await until(() => writes.length === 2, "the renewal after reload");
		assert.deepEqual(
			writes.map(({ live }) => live),
			[true, true],
		);
		assert.ok(writes[1].seq > writes[0].seq);
	}));

test("persistent and resumed children are marked like fresh ones", () =>
	fixture(async (f) => {
		const child = fakeProcesses(f).start();
		f.operations.captureProcessIdentity = async () => child;
		const { session, writes } = markedSession(f);
		const persistent = f.input("persistent", true);
		await session.spawnPi(persistent);
		await until(() => writes.length === 1, "the persistent marker");
		const specialist = f.latest();
		assert.ok(specialist?.persistent);
		assert.equal(writes[0].paneId, specialist.surface);
		appendPersistentTaskEvent(specialist.sessionFile, {
			type: "task-done",
			task: "inbox-persistent",
			generation: "generation-persistent",
		});
		session.observe(persistent.task.id);
		await turn();
		assert.deepEqual(
			writes.map(({ live }) => live),
			[true],
		);

		const input = f.input("before-resume");
		const handle = await session.spawnPi(input);
		const first = f.latest();
		assert.ok(first);
		writeFileSync(
			first.sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "saved", cwd: f.dir })}\n`,
		);
		f.complete(first);
		await session.supervise(handle, input.task);
		rmSync(`${first.sessionFile}.exit`, { force: true });
		const resumed = await session.resumePi({
			taskId: "resume-marked",
			name: "resumed",
			sessionPath: first.sessionFile,
		});
		const command = f.commands.at(-1) ?? "";
		assert.match(command, /PI_SUBAGENT_PROCESS_FILE=.*process-identity/);
		const record = f.latest();
		assert.ok(record && record.id === resumed.id);
		await until(
			() => writes.some((w) => w.paneId === record.surface && w.live),
			"the resumed marker",
		);
	}));
