import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as runtime from "../../maestro/runtime/index.ts";
import type {
	DefaultRunSessionOptions,
	PiCompletedMetadata,
	PiLaunchInput,
	PiRunRecord,
} from "../../maestro/runtime/pi-run-session-types.ts";
import { createWorktreeOperations } from "../../maestro/runtime/worktree-operations.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import type { AcceptRunner } from "../../maestro/adapters/pi/accept-runner.ts";
import {
	normalizeAcceptSpec,
	type AcceptRequest,
	type ChildAcceptReport,
	type OutcomeLedgerLine,
} from "../../maestro/core/accept.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";

/** The `.exit` sidecar shapes a child writes. */
type Sidecar =
	| { type: "done"; accept?: ChildAcceptReport }
	| { type: "ping"; name: string; message: string }
	| { type: "error"; errorMessage: string };

interface Fixture {
	dir: string;
	provider: FakeSurfaceProvider;
	options: DefaultRunSessionOptions;
	session: runtime.PiRunSession;
	settled: PiCompletedMetadata[];
	commands: string[];
	input(accept?: AcceptRequest): PiLaunchInput;
	complete(record: PiRunRecord, sidecar?: Sidecar): void;
	ledger(): OutcomeLedgerLine[];
}

async function fixture(
	run: (f: Fixture) => Promise<void>,
	extra: Partial<DefaultRunSessionOptions> & { runner?: AcceptRunner } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "accept-recheck-"));
	const parent = join(dir, "parent.jsonl");
	writeFileSync(
		parent,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir })}\n`,
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
	const coordinator = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: provider
				.listSurfaces()
				.map((s) => ({ paneId: s.id, workspaceId: "fixture" })),
		}),
		(id) => provider.inspectSurface(id),
		false,
		new FileWakeRegistry(),
	);
	const settled: PiCompletedMetadata[] = [];
	const { runner, ...rest } = extra;
	const options: DefaultRunSessionOptions = {
		configDir: dir,
		configExamplePath: new URL("../../config.json.example", import.meta.url)
			.pathname,
		infrastructure: {
			surfaceProvider: provider,
			launchOperations: operations,
			supervision: coordinator,
			acceptRunner: runner,
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
				supportedThinkingLevels: () => ["off", "low", "medium", "high"],
				clampThinkingLevel: (_model, level) => level,
			},
		}),
		hooks: {
			onSettled(_record, result) {
				settled.push(result);
			},
		},
		persistent: {
			send: () => ({ error: "test policy" }),
			stop: () => ({ error: "test policy" }),
			drain() {},
		},
		...rest,
	};
	const session = runtime.createDefaultRunSession(options);
	const f: Fixture = {
		dir,
		provider,
		options,
		session,
		settled,
		commands,
		input(accept) {
			return {
				task: {
					id: "control",
					name: "checked",
					prompt: "bounded",
					role: "",
					cwd: dir,
					behavior: { autoExit: true, persistent: false },
					accept: accept ? normalizeAcceptSpec(accept) : undefined,
					requestedModel: "task:implementation",
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
					id: "public-control",
					logicalId: "logical",
					generationId: "generation",
					taskId: "inbox",
				},
			};
		},
		complete(record, sidecar = { type: "done" }) {
			if (!existsSync(record.sessionFile))
				writeFileSync(
					record.sessionFile,
					`${JSON.stringify({ type: "session", version: 3, id: record.id, cwd: dir })}\n`,
				);
			writeFileSync(`${record.sessionFile}.exit`, JSON.stringify(sidecar));
		},
		ledger() {
			const file = join(dir, "herdr-agents", "outcomes.jsonl");
			return existsSync(file)
				? readFileSync(file, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [];
		},
	};
	try {
		await run(f);
	} finally {
		await session.shutdown("quit");
		rmSync(dir, { recursive: true, force: true });
	}
}

async function runChild(
	f: Fixture,
	input: PiLaunchInput,
	sidecar?: Sidecar,
	beforeComplete?: (record: PiRunRecord) => void,
) {
	const handle = await f.session.spawnPi(input);
	const record = f.session.getRecord(input.task.id)!;
	const wait = f.session.supervise(handle, f.session.getTask(input.task.id)!);
	beforeComplete?.(record);
	f.complete(record, sidecar);
	return { record, result: await wait, completed: f.settled.at(-1)! };
}

const passedTwice: ChildAcceptReport = {
	tries: 2,
	childVerdict: "passed",
	lastExitCode: 0,
	timedOut: false,
};

test("the parent re-check accepts a completed run and writes one ledger line", () =>
	fixture(async (f) => {
		const run = "test -f done.txt";
		writeFileSync(join(f.dir, "done.txt"), "");
		const { completed, result } = await runChild(f, f.input({ run }), {
			type: "done",
			accept: passedTwice,
		});
		assert.equal(result.outcome, "completed");
		assert.equal(completed.accept?.verdict, "accepted");
		assert.equal(completed.accept?.tries, 2);
		assert.equal(completed.accept?.exitCode, 0);
		assert.equal(completed.accept?.cwd, f.dir);
		assert.equal(completed.accept?.sharedCheckout, true);
		assert.match(completed.accept?.checkHash ?? "", /^sha256:[0-9a-f]{64}$/);
		const [line, ...more] = f.ledger();
		assert.deepEqual(more, []);
		assert.deepEqual(Object.keys(line).sort(), [
			"at",
			"attempt",
			"category",
			"checkHash",
			"checkTries",
			"elapsedSec",
			"model",
			"outcome",
			"requestedModel",
			"runId",
			"thinking",
			"v",
			"verdict",
		]);
		assert.equal(line.verdict, "accepted");
		assert.equal(line.category, "implementation");
		assert.equal(line.checkTries, 2);
		assert.equal(line.runId, "public-control");
		const raw = readFileSync(
			join(f.dir, "herdr-agents", "outcomes.jsonl"),
			"utf8",
		);
		assert.ok(!raw.includes(run) && !raw.includes("bounded"), raw);
	}));

test("the parent re-check is authoritative over the child's reported pass", () =>
	fixture(async (f) => {
		const { completed, result } = await runChild(
			f,
			f.input({ run: "echo 'FAIL parser' >&2; exit 1" }),
			{ type: "done", accept: passedTwice },
		);
		assert.equal(result.outcome, "completed", "the run itself completed");
		assert.equal(completed.exitCode, 0);
		assert.equal(completed.accept?.verdict, "rejected");
		assert.equal(completed.accept?.childVerdict, "passed");
		assert.equal(completed.accept?.exitCode, 1);
		assert.match(completed.accept?.output ?? "", /FAIL parser/);
		assert.equal(f.ledger()[0].verdict, "rejected");
	}));

test("a re-check timeout is verdict error, not rejected", () =>
	fixture(
		async (f) => {
			const { completed } = await runChild(
				f,
				f.input({ run: "slow", timeoutSec: 7 }),
			);
			assert.equal(completed.accept?.verdict, "error");
			assert.equal(completed.accept?.reason, "timed out after 7s");
			assert.equal(completed.accept?.tries, undefined, "no sidecar report");
		},
		{
			runner: async (options) => {
				assert.equal(options.timeoutMs, 7_000);
				assert.equal(options.run, "slow");
				return { kind: "timeout", output: "partial" };
			},
		},
	));

test("a cancel during the parent re-check stops it and delivers a cancelled, skipped result", () =>
	fixture(async (f) => {
		const started = join(f.dir, "check-started");
		const input = f.input({ run: `touch ${started}; sleep 30` });
		const handle = await f.session.spawnPi(input);
		const record = f.session.getRecord(input.task.id)!;
		const wait = f.session.supervise(handle, f.session.getTask(input.task.id)!);
		f.complete(record);
		const deadline = Date.now() + 10_000;
		while (!existsSync(started)) {
			assert.ok(Date.now() < deadline, "the parent re-check never started");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const began = Date.now();
		const report = await f.session.cancel(input.task.id);
		assert.equal(report.status, "confirmed");
		const result = await wait;
		assert.ok(Date.now() - began < 5_000, "the check was stopped, not waited");
		assert.equal(result.outcome, "killed");
		assert.equal(result.cancellation?.termination, "confirmed");
		const completed = f.settled.at(-1)!;
		assert.equal(completed.error, "cancelled");
		assert.equal(completed.summary, "Subagent cancelled.");
		assert.equal(completed.accept?.verdict, "skipped");
		assert.equal(completed.accept?.reason, "cancelled");
		assert.equal(f.ledger()[0].outcome, "cancelled");
		assert.equal(f.ledger()[0].verdict, "skipped");
		assert.equal(
			(await f.session.cancel(input.task.id)).status,
			"already-terminal",
		);
	}));

test("help requests, provider errors and failed exits skip the re-check", () =>
	fixture(
		async (f) => {
			for (const [sidecar, reason] of [
				[{ type: "ping", name: "checked", message: "help" }, "help request"],
				[{ type: "error", errorMessage: "overloaded" }, "provider error"],
			] as const) {
				const input = f.input({ run: "never" });
				input.task.id = `control-${reason}`;
				const { completed } = await runChild(f, input, sidecar);
				assert.equal(completed.accept?.verdict, "skipped");
				assert.equal(completed.accept?.reason, reason);
			}
		},
		{
			runner: async () => {
				throw new Error("the re-check must not run");
			},
		},
	));

test("an unchecked run has no verdict and logs verdict none; the off switch writes nothing", async () => {
	await fixture(async (f) => {
		const { completed } = await runChild(f, f.input());
		assert.equal(completed.accept, undefined);
		const [line] = f.ledger();
		assert.equal(line.verdict, "none");
		assert.equal(line.checkHash, undefined);
		assert.equal(line.outcome, "completed");
	});
	await fixture(
		async (f) => {
			const { completed } = await runChild(f, f.input({ run: "true" }));
			assert.equal(completed.accept?.verdict, "accepted");
			assert.equal(
				existsSync(join(f.dir, "herdr-agents", "outcomes.jsonl")),
				false,
			);
		},
		{ outcomeLedger: false },
	);
});

/** A second session over the fixture whose one child gets a worktree. */
function worktreeSession(f: Fixture) {
	const git = (args: string[]) =>
		execFileSync("git", args, { cwd: f.dir, stdio: "pipe" });
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
	const tree = join(f.dir, "tree");
	mkdirSync(tree);
	const states: string[] = [];
	const worktreeOps = createWorktreeOperations();
	const write = worktreeOps.persistWorktreeResult;
	worktreeOps.captureWorktreeHandoff = async (worktree) => ({
		...worktree,
		headSha: "head",
		commitsAhead: 1,
		clean: true,
		conflicted: false,
		changedFiles: ["src/a.ts", "test/a.test.ts"],
		untrackedFiles: ["test/new.test.ts"],
	});
	worktreeOps.persistWorktreeResult = (worktree, state, handoff) => {
		states.push(state);
		write(worktree, state, handoff);
	};
	f.options.infrastructure!.worktreeOperations = worktreeOps;
	const session = runtime.createDefaultRunSession(f.options);
	const pane = f.provider.createSurface({ name: "worktree", cwd: tree });
	const operations = f.options.infrastructure!.launchOperations;
	operations.createWorktree = (_name, _cwd, branch) => ({
		path: tree,
		branch,
		workspaceId: "workspace",
		paneId: pane,
	});
	return { session, tree, pane, states };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(ready: () => boolean, what: string, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (!ready()) {
		assert.ok(Date.now() < deadline, what);
		await delay(20);
	}
}

/** Whether no process is left in group `pgid`. */
function groupGone(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return false;
	} catch (error) {
		// SAFETY: process.kill throws only Node system errors, which carry `code`.
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** The pid a check wrote to `file`, which leads its process group. */
function readPid(file: string): number {
	return Number(readFileSync(file, "utf8").trim());
}

test("worktree re-check runs in the worktree, reports changed check files and leaves the manifest state", () =>
	fixture(async (f) => {
		const { session, tree, states } = worktreeSession(f);
		const input = f.input({ run: "pwd; exit 4", paths: ["test"] });
		input.task.worktree = { branch: "checked" };
		try {
			const handle = await session.spawnPi(input);
			const record = session.getRecord(input.task.id)!;
			const wait = session.supervise(handle, input.task);
			f.complete(record);
			await wait;
			const completed = f.settled.at(-1)!;
			assert.equal(completed.accept?.verdict, "rejected");
			assert.equal(completed.accept?.cwd, tree);
			assert.equal(completed.accept?.sharedCheckout, undefined);
			assert.match(completed.accept?.output ?? "", /\/tree\n/);
			assert.deepEqual(completed.accept?.changedCheckFiles, [
				"test/a.test.ts",
				"test/new.test.ts",
			]);
			// A rejected verdict changes no worktree manifest state.
			assert.equal(states.at(-1), "ready_for_review");
		} finally {
			await session.shutdown("quit");
		}
	}));

test("a rejected verdict never starts a model fallback", () =>
	fixture(async (f) => {
		const input = f.input({ run: "exit 1" });
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], modelId: "two", model: "test/two" },
		];
		const { completed } = await runChild(f, input);
		assert.equal(completed.accept?.verdict, "rejected");
		assert.deepEqual(completed.fallbackAttempts, ["test/one"]);
		assert.deepEqual(
			f.ledger().map((line) => [line.attempt, line.model, line.verdict]),
			[[1, "test/one", "rejected"]],
		);
	}));

test("a confirmed cancel while the check's pipes drain wins: skipped, cancelled manifest and ledger, one delivery", () =>
	fixture(async (f) => {
		const { session, pane, states } = worktreeSession(f);
		// No identity to wait for: the gone pane alone confirms termination.
		delete f.options.infrastructure!.launchOperations.captureProcessIdentity;
		const started = join(f.dir, "shell-started");
		// The shell exits 0 at once; its background job keeps the pipes open.
		const input = f.input({ run: `echo $$ > ${started}; sleep 10 & exit 0` });
		input.task.worktree = { branch: "checked" };
		try {
			const handle = await session.spawnPi(input);
			const record = session.getRecord(input.task.id)!;
			const wait = session.supervise(handle, input.task);
			f.complete(record);
			await until(
				() => existsSync(started) && readPid(started) > 0,
				"the parent re-check never started",
			);
			const pgid = readPid(started);
			await delay(150);
			// The child's Pi has exited with its pane: termination is confirmed.
			f.provider.closeSurface(pane);
			const report = await session.cancel(input.task.id);
			const result = await wait;
			assert.equal(report.status, "confirmed");
			assert.equal(result.outcome, "killed");
			assert.equal(f.settled.length, 1, "exactly one delivery");
			const [completed] = f.settled;
			assert.equal(completed.error, "cancelled");
			assert.equal(completed.accept?.verdict, "skipped");
			assert.equal(completed.accept?.reason, "cancelled");
			assert.equal(states.at(-1), "cancelled");
			assert.deepEqual(
				f.ledger().map((line) => [line.outcome, line.verdict]),
				[["cancelled", "skipped"]],
			);
			await until(() => groupGone(pgid), "the check's group outlived it");
		} finally {
			await session.shutdown("quit");
		}
	}));

test("parent shutdown terminates a TERM-ignoring re-check within the bound", () =>
	fixture(async (f) => {
		const started = join(f.dir, "check.pid");
		const input = f.input({
			run: `trap '' TERM; echo $$ > ${started}; sleep 30`,
		});
		const handle = await f.session.spawnPi(input);
		const record = f.session.getRecord(input.task.id)!;
		const wait = f.session.supervise(handle, f.session.getTask(input.task.id)!);
		f.complete(record);
		await until(
			() => existsSync(started) && readPid(started) > 0,
			"the parent re-check never started",
		);
		const pgid = readPid(started);
		const began = Date.now();
		try {
			await f.session.shutdown("quit");
			// SIGTERM grace plus settle margin, with slack for reaping.
			await until(
				() => groupGone(pgid),
				"the re-check's group outlived parent shutdown",
				Math.max(0, 2_500 - (Date.now() - began)),
			);
			await wait;
			assert.deepEqual(f.settled, [], "a suppressed run delivers nothing");
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}));
