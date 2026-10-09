import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	isExpectedPiProcess,
	launchOperationsFromSurface,
	PI_LAUNCH_SESSION_ENV,
	launchPiSubagent,
	launchPiWorktreeHandoff,
	type FreshPiLaunchRequest,
	type PiLaunchOperations,
	type ResumePiLaunchRequest,
	type WorktreeSurfaceForLaunch,
} from "../maestro/adapters/pi/launch.ts";
import { createWorktreeOperations } from "../maestro/runtime/worktree-operations.ts";
import { createSubagentPaneFactory } from "../maestro/core/config/pane-config.ts";
import { FakeSurfaceProvider } from "../maestro/surfaces/fake/fake-surface-provider.ts";
import type { SurfaceProvider } from "../maestro/core/surface-provider.ts";
import { WorktreeProvisioningError } from "../maestro/core/surface-provider.ts";
import {
	readSubagentSessionPolicy,
	writeSubagentSessionPolicy,
} from "../maestro/adapters/pi/session.ts";

function expectedShellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function fixture() {
	const root = mkdtempSync(
		join(tmpdir(), "subagent-launch-test-[probe](regex)-"),
	);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "parent-sessions");
	const parentSessionFile = join(sessionDir, "parent.jsonl");
	mkdirSync(project, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		parentSessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: project })}\n`,
	);

	const request: FreshPiLaunchRequest = {
		kind: "fresh",
		id: "child-1",
		name: "Worker",
		task: "Implement the bounded change.",
		agent: "worker",
		parent: {
			cwd: project,
			sessionFile: parentSessionFile,
			sessionId: "parent",
			sessionDir,
			agentDir,
		},
		runtimePlan: {
			provider: "fake",
			modelId: "worker",
			model: "fake/worker",
			thinking: "high",
			modelSource: "request",
			thinkingSource: "request",
		},
		behavior: {
			tools: "read,bash",
			skills: "tdd",
			deniedTools: ["subagent", "subagent_resume"],
			autoExit: true,
			interactive: false,
			identity: "You are a focused worker.",
			systemPromptMode: "append",
			sessionMode: "standalone",
		},
	};
	return { root, project, agentDir, sessionDir, request };
}

function withFixture(
	run: (value: ReturnType<typeof fixture>) => Promise<void> | void,
) {
	const value = fixture();
	return Promise.resolve(run(value)).finally(() => {
		rmSync(value.root, { recursive: true, force: true });
	});
}

function initializeGitRepository(cwd: string): void {
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
}

function commitAll(cwd: string, message: string): string {
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["commit", "-qm", message], { cwd });
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd,
		encoding: "utf8",
	}).trim();
}

function createLinkedGitFixture(root: string, principal: string) {
	initializeGitRepository(principal);
	writeFileSync(join(principal, "base.txt"), "base\n");
	const principalSha = commitAll(principal, "base");
	const linked = join(root, "linked source α\ncheckout");
	execFileSync(
		"git",
		["worktree", "add", "-q", "-b", "linked/source", linked, principalSha],
		{ cwd: principal },
	);
	writeFileSync(join(linked, "linked.txt"), "linked\n");
	const linkedSha = commitAll(linked, "linked change");
	const linkedCwd = join(linked, "nested caller");
	mkdirSync(linkedCwd);
	return { linked, linkedCwd, linkedSha };
}

function writePublicResumePolicy(sessionFile: string): void {
	writeSubagentSessionPolicy(sessionFile, {
		owner: "public",
		tools: "read,bash",
		deniedTools: ["subagent", "subagent_resume"],
	});
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function providerWithOverrides(
	base: FakeSurfaceProvider,
	overrides: Partial<SurfaceProvider>,
): SurfaceProvider {
	return {
		name: base.name,
		isAvailable: () => base.isAvailable(),
		createSurface: (opts) => base.createSurface(opts),
		runCommand: (surface, command) => base.runCommand(surface, command),
		readScreen: (surface, lines) => base.readScreen(surface, lines),
		closeSurface: (surface) => base.closeSurface(surface),
		listSurfaces: () => base.listSurfaces(),
		attachSurface: (surface) => base.attachSurface(surface),
		createWorktreeSurface: (opts) => base.createWorktreeSurface(opts),
		removeWorktreeSurface: (workspace) => base.removeWorktreeSurface(workspace),
		setupHint: () => base.setupHint(),
		runScript: (surface, command, options) =>
			base.runScript(surface, command, options),
		inspectSurface: (surface) => base.inspectSurface(surface),
		sendKeys: (surface, keys) => base.sendKeys(surface, keys),
		getProcessInfo: (surface) => base.getProcessInfo(surface),
		waitForShellReady: (surface) => base.waitForShellReady(surface),
		waitForSurfaceAbsence: (surface, opts) =>
			base.waitForSurfaceAbsence(surface, opts),
		listWorktreeSurfaces: (opts) => base.listWorktreeSurfaces(opts),
		reportOpenedPrimaryWorkspace: (input) =>
			base.reportOpenedPrimaryWorkspace(input),
		focusWorkspace: (workspace) => base.focusWorkspace(workspace),
		setTitle: (target, title) => base.setTitle(target, title),
		...overrides,
	};
}

describe("Pi launch", () => {
	it("launchOperationsFromSurface maps createPane to the provider's grouped placement", async () => {
		const provider = new FakeSurfaceProvider();
		const operations = launchOperationsFromSurface(provider, {
			mode: "grouped",
			direction: "right",
			maxPerTab: 4,
		});

		const surface = await operations.createPane("x", process.cwd());

		assert.equal(surface, "fake-surface-1");
		assert.equal((await provider.listSurfaces())[0]?.name, "x");
	});

	it("launchOperationsFromSurface awaits deferred cleanup before reporting a failed ordinary launch", async () => {
		await withFixture(async ({ request }) => {
			const fake = new FakeSurfaceProvider();
			const closeEntered = deferred();
			const closeGate = deferred();
			let settled = false;
			const provider = providerWithOverrides(fake, {
				name: "async-fake",
				async createSurface(opts) {
					return fake.createSurface(opts);
				},
				async closeSurface(surface) {
					closeEntered.resolve();
					await closeGate.promise;
					fake.closeSurface(surface);
				},
				runScript() {
					throw new Error("script rejected");
				},
			});
			const operations = launchOperationsFromSurface(provider, {
				mode: "grouped",
				direction: "right",
				maxPerTab: 4,
			});

			const launch = launchPiSubagent(request, operations);
			const observedRejection = assert.rejects(launch, /script rejected/);
			launch
				.finally(() => {
					settled = true;
				})
				.catch(() => {});

			await closeEntered.promise;
			await new Promise((resolve) => setImmediate(resolve));
			try {
				assert.equal(settled, false);
				assert.equal((await provider.listSurfaces()).length, 1);
			} finally {
				closeGate.resolve();
			}
			await observedRejection;
			assert.deepEqual(await provider.listSurfaces(), []);
		});
	});

	async function assertPiReady(
		processInfo: SurfaceProvider["getProcessInfo"] extends (
			...args: any[]
		) => infer Result
			? Awaited<Result>
			: never,
	) {
		const provider = new FakeSurfaceProvider();
		provider.createSurface({ name: "ready", cwd: "/repo" });
		const operations = launchOperationsFromSurface(
			providerWithOverrides(provider, {
				getProcessInfo: async () => processInfo,
			}),
			{ mode: "grouped", direction: "right", maxPerTab: 4 },
		);
		assert.ok(operations.waitForPiReady);
		await operations.waitForPiReady(
			"fake-surface-1",
			"/tmp/child.jsonl",
			"/repo",
		);
	}

	async function assertPiReadyRejects(
		processInfo: SurfaceProvider["getProcessInfo"] extends (
			...args: any[]
		) => infer Result
			? Awaited<Result>
			: never,
		reason = /expected Pi process not observed/,
	) {
		const provider = new FakeSurfaceProvider();
		provider.createSurface({ name: "ready", cwd: "/repo" });
		const operations = launchOperationsFromSurface(
			providerWithOverrides(provider, {
				getProcessInfo: () => processInfo,
			}),
			{ mode: "grouped", direction: "right", maxPerTab: 4 },
		);
		const originalNow = Date.now;
		const times = [0, 0, 10_001];
		Date.now = () => times.shift() ?? 10_001;
		try {
			assert.ok(operations.waitForPiReady);
			await assert.rejects(
				operations.waitForPiReady(
					"fake-surface-1",
					"/tmp/child.jsonl",
					"/repo",
				),
				new RegExp(
					`Timed out waiting for Pi session /tmp/child\\.jsonl in Herdr pane fake-surface-1: ${reason.source}`,
				),
			);
		} finally {
			Date.now = originalNow;
		}
	}

	/** A live process whose exec-time environment names one launched session. */
	async function withLaunchedSessionProcess(
		sessionFile: string | undefined,
		run: (pid: number) => Promise<void>,
	) {
		const env = { ...process.env };
		delete env[PI_LAUNCH_SESSION_ENV];
		if (sessionFile !== undefined) env[PI_LAUNCH_SESSION_ENV] = sessionFile;
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1e3)"],
			{
				env,
				stdio: "ignore",
			},
		);
		try {
			await once(child, "spawn");
			assert.ok(child.pid);
			await run(child.pid);
		} finally {
			child.kill("SIGKILL");
		}
	}

	const linuxOnly = { skip: process.platform !== "linux" };

	it("Pi readiness matches the launched session by environment, not rewritten argv", () => {
		// Herdr 0.9.3 pane process-info for a live Pi: its title rewrite leaves no `--session`.
		const herdrReported = {
			pid: 42,
			name: "pi",
			argv: ["pi"],
			cwd: "/repo",
		};
		const environments = new Map([
			[42, new Map([[PI_LAUNCH_SESSION_ENV, "/tmp/child.jsonl"]])],
			[43, new Map([[PI_LAUNCH_SESSION_ENV, "/tmp/other.jsonl"]])],
			[44, new Map<string, string>()],
		]);
		const read = (pid: number) => environments.get(pid);
		assert.equal(
			isExpectedPiProcess(herdrReported, "/tmp/child.jsonl", "/repo", read),
			true,
		);
		for (const process of [
			{ ...herdrReported, pid: 43 },
			{ ...herdrReported, pid: 44 },
			{ ...herdrReported, pid: 45 },
			{
				...herdrReported,
				pid: 43,
				argv: ["pi", "--session", "/tmp/child.jsonl"],
			},
			{ ...herdrReported, cwd: "/wrong" },
			{ ...herdrReported, name: "node" },
		]) {
			assert.equal(
				isExpectedPiProcess(process, "/tmp/child.jsonl", "/repo", read),
				false,
				JSON.stringify(process),
			);
		}
	});

	it(
		'provider Pi readiness accepts a Pi whose argv was rewritten to ["pi"]',
		linuxOnly,
		async () => {
			await withLaunchedSessionProcess("/tmp/child.jsonl", async (pid) => {
				await assertPiReady({
					pids: [pid],
					foregroundProcesses: [
						{ pid, name: "pi", argv: ["pi"], cwd: "/repo" },
					],
				});
				await assertPiReady({
					pids: [pid],
					foregroundProcesses: [
						{ pid, argv0: "/usr/local/bin/pi", argv: ["pi"], cwd: "/repo" },
					],
				});
				await assertPiReady({
					pids: [pid],
					foregroundProcesses: [
						{ pid, name: "pi", argv0: "/not/pi/", argv: ["pi"], cwd: "/repo" },
					],
				});
			});
		},
	);

	it(
		"provider Pi readiness never accepts another session's Pi",
		linuxOnly,
		async () => {
			await withLaunchedSessionProcess("/tmp/other.jsonl", async (pid) => {
				for (const argv of [["pi"], ["pi", "--session", "/tmp/child.jsonl"]]) {
					await assertPiReadyRejects({
						pids: [pid],
						foregroundProcesses: [{ pid, name: "pi", argv, cwd: "/repo" }],
					});
				}
			});
			await withLaunchedSessionProcess(undefined, async (pid) => {
				await assertPiReadyRejects({
					pids: [pid],
					foregroundProcesses: [
						{ pid, name: "pi", argv: ["pi"], cwd: "/repo" },
					],
				});
			});
		},
	);

	it("provider Pi readiness treats an unreadable environment as unproven without hiding a match", {
		skip: process.platform !== "linux" || process.getuid?.() === 0,
	}, async () => {
		// PID 1 belongs to root, so its environment is EACCES, as for an exiting Pi.
		const unreadable = { pid: 1, name: "pi", argv: ["pi"], cwd: "/repo" };
		await assertPiReadyRejects(
			{ pids: [1], foregroundProcesses: [unreadable] },
			/EACCES/,
		);
		await withLaunchedSessionProcess("/tmp/child.jsonl", async (pid) => {
			await assertPiReady({
				pids: [1, pid],
				foregroundProcesses: [
					unreadable,
					{ pid, name: "pi", argv: ["pi"], cwd: "/repo" },
				],
			});
		});
	});

	it(
		"provider Pi readiness rejects each identity mismatch independently",
		linuxOnly,
		async () => {
			await withLaunchedSessionProcess("/tmp/child.jsonl", async (pid) => {
				const correct = {
					pid,
					name: "pi",
					argv0: "/usr/local/bin/pi",
					argv: ["pi"],
					cwd: "/repo",
				};
				for (const process of [
					{ ...correct, cwd: "/wrong" },
					{ ...correct, name: undefined, argv0: "/usr/local/bin/python" },
					{ ...correct, name: undefined, argv0: "/usr/local/bin/pi/" },
				]) {
					await assertPiReadyRejects({
						pids: [process.pid],
						foregroundProcesses: [process],
					});
				}
			});
		},
	);

	it("records recovered worktree metadata from provider provisioning errors", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			initializeGitRepository(project);
			writeFileSync(join(project, "base.txt"), "base\n");
			commitAll(project, "base");
			const provider = new FakeSurfaceProvider();
			const operations = launchOperationsFromSurface(
				providerWithOverrides(provider, {
					createWorktreeSurface() {
						throw new WorktreeProvisioningError("partial provisioning", {
							path: join(root, "partial-tree"),
							branch: "issue/partial",
							workspaceId: "workspace-partial",
						});
					},
				}),
				{ mode: "grouped", direction: "right", maxPerTab: 4 },
				createWorktreeOperations(),
			);

			await assert.rejects(
				launchPiSubagent(
					{ ...request, worktree: { branch: "issue/partial" } },
					operations,
				),
				/partial provisioning/,
			);
			const manifest = JSON.parse(
				readFileSync(
					join(
						sessionDir,
						"artifacts",
						"parent",
						"worktree-runs",
						"child-1.json",
					),
					"utf8",
				),
			);
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.path, join(root, "partial-tree"));
			assert.equal(manifest.branch, "issue/partial");
			assert.equal(manifest.workspaceId, "workspace-partial");
		});
	});

	for (const failed of [true, false]) {
		it(`${failed ? "reports" : "omits"} launch diagnostics without writing claims to the manifest`, async () => {
			await withFixture(async ({ request, project, sessionDir, root }) => {
				initializeGitRepository(project);
				writeFileSync(join(project, "base.txt"), "base\n");
				commitAll(project, "base");
				const worktreePath = join(root, "diagnostic-tree");
				const manifestFile = join(
					sessionDir,
					"artifacts",
					"parent",
					"worktree-runs",
					"child-1.json",
				);
				const diagnostics = [
					"Primary workspace snapshot (before create) failed: x",
				];
				const running = await launchPiSubagent(
					{ ...request, worktree: { branch: "issue/diagnostic" } },
					{
						worktree: createWorktreeOperations(),
						createPane() {
							throw new Error("unexpected pane creation");
						},
						createWorktree(_name, cwd, branch, base) {
							execFileSync(
								"git",
								["worktree", "add", "-q", "-b", branch, worktreePath, base],
								{ cwd },
							);
							const surface: WorktreeSurfaceForLaunch = {
								path: worktreePath,
								branch,
								workspaceId: "workspace-1",
								paneId: "root-pane-1",
							};
							if (failed) surface.diagnostics = diagnostics;
							return surface;
						},
						async waitForShellReady() {},
						runScript: (_surface, _value, options) => options.scriptPath,
						closePane() {},
					},
				);
				assert.deepEqual(
					running.worktree?.diagnostics,
					failed ? diagnostics : undefined,
				);
				const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
				assert.deepEqual(
					Object.keys(manifest).filter((key) =>
						key.startsWith("openedPrimary"),
					),
					[],
				);
			});
		});
	}

	it("launches an ordinary child through one transaction", async () => {
		await withFixture(async ({ request, project, agentDir }) => {
			const projectAgentDir = join(project, ".pi", "agent");
			mkdirSync(projectAgentDir, { recursive: true });
			const events: string[] = [];
			const closed: string[] = [];
			let command = "";
			let scriptPath = "";
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane(name, cwd) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project, "placement must use the child's checkout");
					events.push("create");
					return "pane-1";
				},
				createWorktree() {
					throw new Error("unexpected worktree creation");
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "pane-1");
					events.push("ready");
				},
				runScript(surface, value, options) {
					assert.equal(surface, "pane-1");
					events.push("run");
					command = value;
					scriptPath = options.scriptPath;
					return options.scriptPath;
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			const running = await launchPiSubagent(request, operations);

			assert.deepEqual(events, ["create", "ready", "run"]);
			assert.deepEqual(closed, []);
			assert.equal(running.id, "child-1");
			assert.equal(running.surface, "pane-1");
			assert.equal(running.launchScriptFile, scriptPath);
			assert.ok(running.sessionFile.startsWith(join(agentDir, "sessions")));
			const policy = readSubagentSessionPolicy(running.sessionFile);
			assert.equal(policy.version, 2);
			assert.equal(policy.owner, "public");
			assert.deepEqual(policy.tools, ["read", "bash"]);
			assert.deepEqual(policy.deniedTools, ["subagent", "subagent_resume"]);
			assert.equal(policy.persistent, false);
			assert.equal(command.includes(projectAgentDir), false);
			assert.ok(command.startsWith(`cd ${expectedShellQuote(project)} && `));
			assert.match(command, /--model 'fake\/worker'/);
			assert.match(command, /--thinking 'high'/);
			assert.match(command, /--tools 'read,bash,caller_ping'/);
			assert.doesNotMatch(command, /subagent_done/);
			assert.match(command, /PI_DENY_TOOLS='subagent,subagent_resume'/);
			assert.match(command, /PI_SUBAGENT_AUTO_EXIT=1/);
			// Documented child-context hint: fresh children receive PI_SUBAGENT_ID.
			assert.match(command, /PI_SUBAGENT_ID='child-1'/);
			assert.ok(
				command.includes(
					`${PI_LAUNCH_SESSION_ENV}=${expectedShellQuote(running.sessionFile)}`,
				),
			);
			assert.match(command, /'' '\/skill:tdd' '@[^']+\.md'/);

			const taskPath = command.match(/'@([^']+\.md)'/)?.[1];
			assert.ok(taskPath, "expected artifact-backed task delivery");
			assert.match(
				readFileSync(taskPath, "utf8"),
				/Complete your task autonomously\.[\s\S]*Implement the bounded change\./,
			);
			const systemPromptPath = command.match(
				/--append-system-prompt '([^']+\.md)'/,
			)?.[1];
			assert.ok(systemPromptPath, "expected system prompt artifact");
			assert.equal(
				readFileSync(systemPromptPath, "utf8"),
				"You are a focused worker.",
			);
		});
	});

	it("treats an explicit null worktree as an ordinary pane", async () => {
		await withFixture(async ({ request, project }) => {
			let worktreeCreationAttempts = 0;
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane(name, cwd) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project);
					return "pane-null-worktree";
				},
				createWorktree() {
					worktreeCreationAttempts++;
					throw new Error("unexpected worktree creation");
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "pane-null-worktree");
				},
				runScript(_surface, value, options) {
					command = value;
					return options.scriptPath;
				},
				closePane() {},
				captureProcessIdentity() {
					throw new Error("an ordinary pane captures no process identity");
				},
			};
			let command = "";

			const running = await launchPiSubagent(
				{ ...request, worktree: null },
				operations,
			);

			assert.equal(worktreeCreationAttempts, 0);
			assert.equal(running.surface, "pane-null-worktree");
			assert.equal(running.worktree, undefined);
			assert.doesNotMatch(command, /PI_SUBAGENT_PROCESS_FILE/);
			assert.equal(running.processIdentityFile, undefined);
			assert.equal(running.processIdentityCapture, undefined);
		});
	});

	it("records an ordinary child's process identity when the launch asks for it", async () => {
		await withFixture(async ({ request }) => {
			const identity = {
				pid: 4321,
				startTime: "987",
				bootId: "boot",
				pidNamespace: "pid:[1]",
			};
			const captures: unknown[] = [];
			let command = "";
			const operations: PiLaunchOperations = {
				createPane: () => "pane-ordinary",
				createWorktree() {
					throw new Error("unexpected worktree creation");
				},
				async waitForShellReady() {},
				runScript(_surface, value, options) {
					command = value;
					return options.scriptPath;
				},
				closePane() {},
				async captureProcessIdentity(surface, expected) {
					captures.push({ surface, ...expected });
					return identity;
				},
			};

			const running = await launchPiSubagent(
				{ ...request, recordProcessIdentity: true },
				operations,
			);

			const processFile = `${running.sessionFile}.process.json`;
			assert.equal(running.worktree, undefined);
			assert.equal(running.processIdentityFile, processFile);
			assert.ok(
				command.includes(
					`PI_SUBAGENT_PROCESS_FILE=${expectedShellQuote(processFile)}`,
				),
			);
			assert.deepEqual(await running.processIdentityCapture, identity);
			assert.deepEqual(captures, [
				{
					surface: "pane-ordinary",
					file: processFile,
					id: "child-1",
					sessionFile: running.sessionFile,
				},
			]);
		});
	});

	it("records each resumed run's identity under its own ID, never the reused session's sidecar", async () => {
		await withFixture(async ({ root, project, sessionDir }) => {
			const sessionFile = join(root, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", id: "child", cwd: project }) + "\n",
			);
			writePublicResumePolicy(sessionFile);
			const captures: unknown[] = [];
			const commands: string[] = [];
			const operations: PiLaunchOperations = {
				createPane: () => "pane-resume",
				createWorktree() {
					throw new Error("a resume must not create a worktree");
				},
				async waitForShellReady() {},
				runScript(_surface, value, options) {
					commands.push(value);
					return options.scriptPath;
				},
				closePane() {},
				async captureProcessIdentity(surface, expected) {
					captures.push({ surface, ...expected });
					return {
						pid: 1,
						startTime: "1",
						bootId: "boot",
						pidNamespace: "pid:[1]",
					};
				},
			};
			const request: ResumePiLaunchRequest = {
				kind: "resume",
				id: "resume-1",
				name: "Resume worker",
				sessionFile,
				parent: { sessionId: "parent", sessionDir },
			};

			const plain = await launchPiSubagent(request, operations);
			const marked = await launchPiSubagent(
				{ ...request, id: "resume-2", recordProcessIdentity: true },
				operations,
			);

			assert.equal(plain.processIdentityFile, undefined);
			assert.doesNotMatch(commands[0], /PI_SUBAGENT_PROCESS_FILE/);
			const processFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"process-identity",
				"resume-2.json",
			);
			assert.equal(marked.processIdentityFile, processFile);
			assert.ok(
				commands[1].includes(
					`PI_SUBAGENT_PROCESS_FILE=${expectedShellQuote(processFile)}`,
				),
			);
			await marked.processIdentityCapture;
			assert.deepEqual(captures, [
				{
					surface: "pane-resume",
					file: processFile,
					id: "resume-2",
					sessionFile,
				},
			]);
		});
	});

	for (const kind of ["fresh", "resume"] as const) {
		for (const failurePoint of ["readiness", "command delivery"] as const) {
			it(`closes its ${kind} pane once when ${failurePoint} fails`, async () => {
				await withFixture(async ({ request, root, sessionDir }) => {
					const pane = `pane-${kind}`;
					const closed: string[] = [];
					const sessionFile = join(root, "resumed.jsonl");
					writeFileSync(
						sessionFile,
						JSON.stringify({ type: "session", id: "resumed", cwd: root }) +
							"\n",
					);
					if (kind === "resume") writePublicResumePolicy(sessionFile);
					const launchRequest: FreshPiLaunchRequest | ResumePiLaunchRequest =
						kind === "fresh"
							? request
							: {
									kind: "resume",
									id: "resume-failure",
									name: "Resume worker",
									sessionFile,
									parent: { sessionId: "parent", sessionDir },
								};
					const expectedError = `${kind} ${failurePoint} failed`;
					const operations: PiLaunchOperations = {
						worktree: createWorktreeOperations(),
						createPane: () => pane,
						createWorktree: () => {
							throw new Error("unexpected worktree creation");
						},
						waitForShellReady: async () => {
							if (failurePoint === "readiness") throw new Error(expectedError);
						},
						runScript: (_surface, _command, options) => {
							if (failurePoint === "command delivery")
								throw new Error(expectedError);
							return options.scriptPath;
						},
						closePane(surface) {
							closed.push(surface);
						},
					};

					await assert.rejects(
						launchPiSubagent(launchRequest, operations),
						new RegExp(expectedError),
					);
					assert.deepEqual(closed, [pane]);
				});
			});
		}
	}

	it("closes an owned split child rather than its stable parent on launch failure", async () => {
		await withFixture(async ({ request }) => {
			const parentPane = "parent-pane";
			const childPane = "split-child-pane";
			const closed: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: createSubagentPaneFactory(
					{ mode: "split", direction: "down", maxPerTab: 4 },
					() => {
						throw new Error("must not create a tab");
					},
					(name, direction) => {
						assert.equal(name, "Worker");
						assert.equal(direction, "down");
						return childPane;
					},
				),
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				waitForShellReady: async () => {
					throw new Error("split readiness failed");
				},
				runScript: () => {
					throw new Error("must not run");
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			await assert.rejects(
				launchPiSubagent(request, operations),
				/split readiness failed/,
			);
			assert.deepEqual(closed, [childPane]);
			assert.equal(closed.includes(parentPane), false);
		});
	});

	it("closes its fresh pane when artifact preparation fails", async () => {
		await withFixture(async ({ request, root }) => {
			const blockedSessionDir = join(root, "blocked-session-dir");
			writeFileSync(blockedSessionDir, "not a directory\n");
			const closed: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => "pane-artifact-failure",
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				waitForShellReady: async () => {},
				runScript: () => {
					throw new Error("must not run");
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			await assert.rejects(
				launchPiSubagent(
					{
						...request,
						parent: { ...request.parent, sessionDir: blockedSessionDir },
					},
					operations,
				),
			);
			assert.deepEqual(closed, ["pane-artifact-failure"]);
		});
	});

	it("does not invent pane ownership when creation fails", async () => {
		await withFixture(async ({ request }) => {
			const closed: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => {
					throw new Error("pane creation failed");
				},
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				waitForShellReady: async () => {
					throw new Error("must not wait");
				},
				runScript: () => {
					throw new Error("must not run");
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			await assert.rejects(
				launchPiSubagent(request, operations),
				/pane creation failed/,
			);
			assert.deepEqual(closed, []);
		});
	});

	it("preserves the launch error when ordinary pane cleanup fails", async () => {
		await withFixture(async ({ request }) => {
			let cleanupAttempts = 0;
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => "pane-cleanup-error",
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				waitForShellReady: async () => {
					throw new Error("original launch error");
				},
				runScript: () => {
					throw new Error("must not run");
				},
				async closePane() {
					cleanupAttempts++;
					throw new Error("cleanup error");
				},
			};

			await assert.rejects(
				launchPiSubagent(request, operations),
				(error: Error) => error.message === "original launch error",
			);
			assert.equal(cleanupAttempts, 1);
		});
	});

	it("does not close a caller-supplied surface when launch fails", async () => {
		await withFixture(async ({ request }) => {
			const closed: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => {
					throw new Error("must not create a pane");
				},
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				waitForShellReady: async () => {
					throw new Error("supplied surface readiness failed");
				},
				runScript: () => {
					throw new Error("must not run");
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			await assert.rejects(
				launchPiSubagent({ ...request, surface: "caller-pane" }, operations),
				/supplied surface readiness failed/,
			);
			assert.deepEqual(closed, []);
		});
	});

	it("keeps untrusted launch metadata inside shell comments", async () => {
		await withFixture(async ({ request, root, sessionDir }) => {
			const preambles: string[] = [];
			let pane = 0;
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => `pane-${++pane}`,
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				waitForShellReady: async () => {},
				runScript: (_surface, _command, options) => {
					preambles.push(options.scriptPreamble);
					return options.scriptPath;
				},
				closePane: () => {},
			};
			const injectedName =
				"Worker\nprintf fresh-injection\rprintf carriage-return\u2028printf line-separator\u2029printf paragraph-separator";

			await launchPiSubagent({ ...request, name: injectedName }, operations);

			const resumedSession = join(root, "resumed.jsonl");
			writeFileSync(
				resumedSession,
				JSON.stringify({ type: "session", id: "resumed", cwd: root }) + "\n",
			);
			writePublicResumePolicy(resumedSession);
			await launchPiSubagent(
				{
					kind: "resume",
					id: "resume-injection",
					name: injectedName,
					sessionFile: resumedSession,
					parent: { sessionId: "parent", sessionDir },
				},
				operations,
			);

			assert.equal(preambles.length, 2);
			for (const preamble of preambles) {
				const lines = preamble.split("\n");
				assert.equal(lines.length, 4);
				assert.ok(lines.every((line) => line.startsWith("# ")));
				assert.doesNotMatch(preamble, /\nprintf (?:fresh|carriage)/);
			}
		});
	});

	it("clears inherited auto-exit state for interactive children", async () => {
		await withFixture(async ({ request }) => {
			let command = "";
			await launchPiSubagent(
				{
					...request,
					behavior: {
						...request.behavior,
						autoExit: false,
						interactive: true,
					},
				},
				{
					createPane: () => "pane-interactive",
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					waitForShellReady: async () => {},
					runScript: (_surface, value, options) => {
						command = value;
						return options.scriptPath;
					},
					closePane: () => {},
				},
			);

			assert.match(command, /PI_SUBAGENT_AUTO_EXIT=0/);
			assert.match(command, /--tools 'read,bash,caller_ping,subagent_done'/);
		});
	});

	it("does not seed or inherit context when fork is explicitly false", async () => {
		await withFixture(async ({ request, project }) => {
			writeFileSync(
				request.parent.sessionFile,
				[
					{ type: "session", version: 3, id: "parent", cwd: project },
					{
						type: "message",
						id: "u1",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "secret context" }],
							timestamp: 1,
						},
					},
				]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n",
			);
			let command = "";
			const running = await launchPiSubagent(
				{
					...request,
					fork: false,
					behavior: {
						...request.behavior,
						sessionMode: "fork",
					},
				},
				{
					createPane: () => "pane-no-fork",
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					waitForShellReady: async () => {},
					runScript: (_surface, value, options) => {
						command = value;
						return options.scriptPath;
					},
					closePane: () => {},
				},
			);

			assert.equal(
				existsSync(running.sessionFile),
				false,
				"fork: false must not seed parent conversation into child session",
			);
			const taskPath = command.match(/'@([^']+\.md)'/)?.[1];
			assert.ok(taskPath, "expected artifact-backed task delivery, not direct");
		});
	});

	it("seeds context and uses direct delivery when fork is omitted and sessionMode is fork", async () => {
		await withFixture(async ({ request, project }) => {
			const timestamp = new Date().toISOString();
			writeFileSync(
				request.parent.sessionFile,
				[
					{
						type: "session",
						version: 3,
						id: "parent",
						timestamp,
						cwd: project,
					},
					{
						type: "model_change",
						id: "mc-1",
						parentId: null,
						timestamp,
					},
					{
						type: "message",
						id: "u1",
						parentId: "mc-1",
						timestamp,
						message: {
							role: "user",
							content: [{ type: "text", text: "inherited context" }],
							timestamp: 1,
						},
					},
				]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n",
			);
			let command = "";
			const running = await launchPiSubagent(
				{
					...request,
					behavior: {
						...request.behavior,
						sessionMode: "fork",
					},
				},
				{
					createPane: () => "pane-inherited-fork",
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					waitForShellReady: async () => {},
					runScript: (_surface, value, options) => {
						command = value;
						return options.scriptPath;
					},
					closePane: () => {},
				},
			);

			assert.equal(
				existsSync(running.sessionFile),
				true,
				"omitted fork with sessionMode fork must seed the child session",
			);
			const childSession = readFileSync(running.sessionFile, "utf8");
			assert.match(
				childSession,
				/parentSession/,
				"child session must link to parent",
			);
			assert.doesNotMatch(
				command,
				/'@[^']+\.md'/,
				"fork mode must use direct delivery, not artifact-backed",
			);
			assert.match(
				command,
				/PI_SUBAGENT_ID='child-1'/,
				"forked children receive the same child-context hint as standalone children",
			);
		});
	});

	it("keeps an autonomous multi-wave coordinator open for completion steers", async () => {
		await withFixture(async ({ request }) => {
			let command = "";
			const running = await launchPiSubagent(
				{
					...request,
					name: "Coordinator",
					agent: "test-coordinator",
					behavior: {
						...request.behavior,
						tools: "read,bash,grep,find,ls",
						autoExit: false,
						interactive: false,
					},
				},
				{
					createPane: () => "pane-coordinator",
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					waitForShellReady: async () => {},
					runScript: (_surface, value, options) => {
						command = value;
						return options.scriptPath;
					},
					closePane: () => {},
				},
			);

			assert.equal(running.interactive, false);
			assert.match(command, /PI_SUBAGENT_AUTO_EXIT=0/);
			assert.match(
				command,
				/--tools 'read,bash,grep,find,ls,caller_ping,subagent_done'/,
			);
			const taskPath = command.match(/'@([^']+\.md)'/)?.[1];
			assert.ok(taskPath, "expected artifact-backed coordinator task");
			assert.match(
				readFileSync(taskPath, "utf8"),
				/call the subagent_done tool/i,
			);
		});
	});

	it("resumes a session through the launch transaction", async () => {
		await withFixture(async ({ root, project, sessionDir }) => {
			const sessionFile = join(root, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", id: "child", cwd: project }) + "\n",
			);
			writePublicResumePolicy(sessionFile);
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = join(root, "isolated-agent");
			try {
				const events: string[] = [];
				const closed: string[] = [];
				let command = "";
				let scriptPath = "";
				let scriptPreamble = "";
				const request: ResumePiLaunchRequest = {
					kind: "resume",
					id: "resume-1",
					name: "Resume worker",
					sessionFile,
					message: "Use the approved schema.",
					parent: { sessionId: "parent", sessionDir },
				};
				const operations: PiLaunchOperations = {
					worktree: createWorktreeOperations(),
					createPane(name, cwd) {
						assert.equal(name, "Resume worker");
						assert.equal(cwd, project);
						events.push("create");
						return "pane-resume";
					},
					createWorktree() {
						throw new Error("a resume must not create a worktree");
					},
					async waitForShellReady(surface) {
						assert.equal(surface, "pane-resume");
						events.push("ready");
					},
					runScript(surface, value, options) {
						assert.equal(surface, "pane-resume");
						events.push("run");
						command = value;
						scriptPath = options.scriptPath;
						scriptPreamble = options.scriptPreamble;
						return options.scriptPath;
					},
					closePane(surface) {
						closed.push(surface);
					},
				};

				const running = await launchPiSubagent(request, operations);

				assert.deepEqual(events, ["create", "ready", "run"]);
				assert.deepEqual(closed, []);
				assert.equal(running.id, "resume-1");
				assert.equal(running.name, "Resume worker");
				assert.equal(running.task, "Use the approved schema.");
				assert.equal(running.surface, "pane-resume");
				assert.equal(running.sessionFile, sessionFile);
				assert.equal(running.launchScriptFile, scriptPath);
				assert.equal(running.interactive, false);
				assert.equal(running.runtimePlan, undefined);
				assert.equal(running.worktree, undefined);
				assert.ok(
					command.startsWith(
						`PI_CODING_AGENT_DIR=${expectedShellQuote(process.env.PI_CODING_AGENT_DIR!)} `,
					),
				);
				assert.ok(
					command.includes(
						`pi --session ${expectedShellQuote(sessionFile)} --tools 'read,bash,caller_ping' -e `,
					),
				);
				assert.match(command, /PI_SUBAGENT_NAME='Resume worker'/);
				assert.ok(
					command.includes(
						`PI_SUBAGENT_SESSION=${expectedShellQuote(sessionFile)}`,
					),
				);
				// Documented child-context hint: resumed children receive a new ID.
				assert.match(command, /PI_SUBAGENT_ID='resume-1'/);
				assert.match(command, /PI_SUBAGENT_ACTIVITY_FILE='/);
				assert.match(command, /PI_SUBAGENT_AUTO_EXIT=1/);
				assert.match(command, /PI_DENY_TOOLS='subagent,subagent_resume'/);
				assert.doesNotMatch(command, /--model|--thinking|^cd /);
				const messagePath = command.match(/'@([^']+\.md)'/)?.[1];
				assert.ok(messagePath, "expected artifact-backed follow-up message");
				assert.equal(
					readFileSync(messagePath, "utf8"),
					"Use the approved schema.",
				);
				assert.match(
					scriptPreamble,
					/# Subagent resume script for Resume worker/,
				);
				assert.ok(
					scriptPreamble.includes(`# Resume message file: ${messagePath}`),
				);
			} finally {
				if (previousAgentDir === undefined)
					delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		});
	});

	it("clears inherited auto-exit state when a resumed session is interactive", async () => {
		await withFixture(async ({ root, sessionDir }) => {
			const sessionFile = join(root, "interactive.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", id: "resumed", cwd: root }) + "\n",
			);
			writePublicResumePolicy(sessionFile);
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			try {
				let command = "";
				const running = await launchPiSubagent(
					{
						kind: "resume",
						id: "resume-interactive",
						name: "Interactive resume",
						sessionFile,
						parent: { sessionId: "parent", sessionDir },
						behavior: { autoExit: false },
					},
					{
						createPane: () => "pane-interactive",
						createWorktree: () => {
							throw new Error("a resume must not create a worktree");
						},
						waitForShellReady: async () => {},
						runScript: (_surface, value, options) => {
							command = value;
							return options.scriptPath;
						},
						closePane: () => {},
					},
				);

				assert.equal(running.task, "resumed session");
				assert.equal(running.interactive, true);
				assert.match(command, /PI_SUBAGENT_AUTO_EXIT=0/);
				assert.doesNotMatch(command, /'@[^']+\.md'/);
			} finally {
				if (previousAutoExit === undefined)
					delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
			}
		});
	});

	it("records worktree ownership before creation and targets its root pane", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: project,
			});
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: project,
				encoding: "utf8",
			}).trim();
			const worktreePath = join(root, "worker-tree");
			const worktreeRequest: FreshPiLaunchRequest = {
				...request,
				worktree: { branch: "issue/7", base: "HEAD" },
			};
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const events: string[] = [];
			let command = "";
			const identity = {
				pid: 4321,
				startTime: "987",
				bootId: "boot",
				pidNamespace: "pid:[1]",
			};
			const captures: unknown[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				async captureProcessIdentity(surface, expected) {
					captures.push({ surface, ...expected });
					return identity;
				},
				createWorktree(name, cwd, branch, base) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project);
					assert.equal(branch, "issue/7");
					assert.equal(base, baseSha);
					assert.equal(
						JSON.parse(readFileSync(manifestFile, "utf8")).state,
						"provisioning",
					);
					events.push("create");
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{
							cwd: project,
						},
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-1",
						paneId: "root-pane-1",
					};
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "root-pane-1");
					events.push("ready");
				},
				runScript(surface, value, options) {
					assert.equal(surface, "root-pane-1");
					events.push("run");
					command = value;
					return options.scriptPath;
				},
				closePane: () => {
					throw new Error("must retain the worktree workspace");
				},
			};

			const running = await launchPiSubagent(worktreeRequest, operations);

			assert.deepEqual(events, ["create", "ready", "run"]);
			assert.equal(running.worktree?.baseSha, baseSha);
			assert.equal(running.worktree?.path, worktreePath);
			assert.equal(running.worktree?.sessionFile, running.sessionFile);
			assert.equal(
				readSubagentSessionPolicy(running.sessionFile).owner,
				"managed-worktree",
			);
			assert.ok(
				command.startsWith(`cd ${expectedShellQuote(worktreePath)} && `),
			);
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "running");
			assert.equal(manifest.owner, "pi-herdr-subagents");
			assert.equal(manifest.paneId, "root-pane-1");
			// The child records its own identity beside its session; the parent
			// verifies it against this run, session, and root pane at readiness.
			const processFile = `${running.sessionFile}.process.json`;
			assert.equal(running.processIdentityFile, processFile);
			assert.ok(
				command.includes(
					`PI_SUBAGENT_PROCESS_FILE=${expectedShellQuote(processFile)}`,
				),
			);
			assert.deepEqual(await running.processIdentityCapture, identity);
			assert.deepEqual(running.processIdentity, identity);
			assert.deepEqual(captures, [
				{
					surface: "root-pane-1",
					file: processFile,
					id: running.id,
					sessionFile: running.sessionFile,
				},
			]);
		});
	});

	it("provisions a linked checkout from its principal while preserving its base", async () => {
		await withFixture(async ({ request, project, root, sessionDir }) => {
			const { linkedCwd, linkedSha } = createLinkedGitFixture(root, project);
			const worktreePath = join(root, "linked-child");
			const worktreeRequest: FreshPiLaunchRequest = {
				...request,
				cwd: linkedCwd,
				worktree: { branch: "issue/59-fresh", base: "HEAD" },
			};
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			let command = "";
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(name, cwd, branch, base) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project);
					assert.equal(branch, "issue/59-fresh");
					assert.equal(base, linkedSha);
					const provisioning = JSON.parse(readFileSync(manifestFile, "utf8"));
					assert.equal(provisioning.sourceCwd, linkedCwd);
					assert.equal(provisioning.baseSha, linkedSha);
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{ cwd },
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-linked-fresh",
						paneId: "pane-linked-fresh",
					};
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "pane-linked-fresh");
				},
				runScript(surface, value, options) {
					assert.equal(surface, "pane-linked-fresh");
					command = value;
					return options.scriptPath;
				},
				closePane: () => {
					throw new Error("must retain the worktree workspace");
				},
			};

			const running = await launchPiSubagent(worktreeRequest, operations);

			// Without a capture operation the identity is never guessed.
			assert.equal(running.processIdentity, undefined);
			assert.equal(running.processIdentityCapture, undefined);
			assert.equal(
				running.processIdentityError,
				"process identity capture is unavailable",
			);
			assert.equal(running.worktree?.baseSha, linkedSha);
			assert.equal(running.worktree?.path, worktreePath);
			assert.equal(
				readFileSync(join(worktreePath, "linked.txt"), "utf8"),
				"linked\n",
			);
			assert.ok(
				command.startsWith(`cd ${expectedShellQuote(worktreePath)} && `),
			);
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.sourceCwd, linkedCwd);
			assert.equal(manifest.baseSha, linkedSha);
		});
	});

	it("uses the principal checkout for linked worktree handoffs", async () => {
		await withFixture(async ({ request, project, root, sessionDir }) => {
			const { linked, linkedCwd, linkedSha } = createLinkedGitFixture(
				root,
				project,
			);
			writeFileSync(
				request.parent.sessionFile,
				[
					{
						type: "session",
						version: 3,
						id: "parent",
						cwd: linked,
					},
					{
						type: "message",
						id: "user-1",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "Start the feature" }],
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "assistant-1",
						parentId: "user-1",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Continue" }],
							api: "test",
							provider: "fake",
							model: "worker",
							usage: {},
							stopReason: "stop",
							timestamp: 2,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			const worktreePath = join(root, "linked-handoff-child");
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(name, cwd, branch, base) {
					assert.equal(name, "Handoff");
					assert.equal(cwd, project);
					assert.equal(branch, "handoff/59");
					assert.equal(base, linkedSha);
					assert.equal(
						JSON.parse(readFileSync(manifestFile, "utf8")).sourceCwd,
						linkedCwd,
					);
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{ cwd },
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-linked-handoff",
						paneId: "pane-linked-handoff",
					};
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "pane-linked-handoff");
				},
				runScript(surface, _command, options) {
					assert.equal(surface, "pane-linked-handoff");
					return options.scriptPath;
				},
				async waitForPiReady(surface) {
					assert.equal(surface, "pane-linked-handoff");
				},
				focusWorkspace(workspaceId) {
					assert.equal(workspaceId, "workspace-linked-handoff");
				},
				closePane: () => {
					throw new Error("must retain the worktree workspace");
				},
			};

			const result = await launchPiWorktreeHandoff(
				{
					...request,
					name: "Handoff",
					cwd: linkedCwd,
					worktree: { branch: "handoff/59" },
					handoff: { leafId: "assistant-1" },
				},
				operations,
			);

			assert.equal(result.running.worktree?.baseSha, linkedSha);
			assert.equal(result.running.worktree?.path, worktreePath);
			assert.equal(
				readFileSync(join(worktreePath, "linked.txt"), "utf8"),
				"linked\n",
			);
			assert.equal(
				JSON.parse(readFileSync(manifestFile, "utf8")).sourceCwd,
				linkedCwd,
			);
		});
	});

	it("forks the active conversation and focuses after launch", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			const timestamp = new Date().toISOString();
			writeFileSync(
				request.parent.sessionFile,
				[
					{
						type: "session",
						version: 3,
						id: "parent",
						timestamp,
						cwd: project,
					},
					{
						type: "message",
						id: "user-1",
						parentId: null,
						timestamp,
						message: {
							role: "user",
							content: [{ type: "text", text: "Start the feature" }],
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "assistant-1",
						parentId: "user-1",
						timestamp,
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Continue" }],
							api: "test",
							provider: "fake",
							model: "worker",
							usage: {},
							stopReason: "stop",
							timestamp: 2,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: project,
			});
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			const parentBefore = readFileSync(request.parent.sessionFile, "utf8");
			const worktreePath = join(root, "handoff-tree");
			const events: string[] = [];
			let command = "";
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(_name, cwd, branch, base) {
					assert.equal(cwd, project);
					assert.equal(branch, "handoff/feature");
					assert.equal(
						base,
						execFileSync("git", ["rev-parse", "HEAD"], {
							cwd,
							encoding: "utf8",
						}).trim(),
					);
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{ cwd },
					);
					events.push("create");
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-handoff",
						paneId: "pane-handoff",
					};
				},
				async waitForShellReady() {
					events.push("ready");
				},
				runScript(_surface, value, options) {
					command = value;
					events.push("run");
					return options.scriptPath;
				},
				async waitForPiReady(surface, sessionFile) {
					assert.equal(surface, "pane-handoff");
					assert.match(sessionFile, /\.jsonl$/);
					events.push("pi-ready");
				},
				focusWorkspace(workspaceId) {
					assert.equal(workspaceId, "workspace-handoff");
					events.push("focus");
				},
				closePane: () => {
					throw new Error("must retain the worktree workspace");
				},
			};

			const result = await launchPiWorktreeHandoff(
				{
					...request,
					name: "Handoff",
					worktree: { branch: "handoff/feature" },
					handoff: { leafId: "assistant-1" },
					recordProcessIdentity: true,
				},
				operations,
			);

			assert.deepEqual(events, ["create", "ready", "run", "pi-ready", "focus"]);
			assert.equal(result.focusError, undefined);
			assert.equal(result.running.processIdentityFile, undefined);
			assert.equal(result.running.processIdentityCapture, undefined);
			assert.equal(
				readFileSync(request.parent.sessionFile, "utf8"),
				parentBefore,
			);
			assert.ok(
				command.startsWith(`cd ${expectedShellQuote(worktreePath)} && `),
			);
			// A user-driven worktree handoff is a normal interactive Pi session,
			// not a subagent: it receives no PI_SUBAGENT_ID or child protocol.
			assert.doesNotMatch(
				command,
				/subagent-done|PI_SUBAGENT_|__SUBAGENT_DONE_/,
			);
			assert.ok(
				command.includes(
					`${PI_LAUNCH_SESSION_ENV}=${expectedShellQuote(result.running.sessionFile)}`,
				),
			);
			assert.doesNotMatch(command, /Implement the bounded change/);
			const child = JSON.parse(
				readFileSync(result.running.sessionFile, "utf8").split("\n")[0],
			);
			assert.equal(child.cwd, worktreePath);
			const childText = readFileSync(result.running.sessionFile, "utf8");
			assert.match(childText, /pi-herdr-worktree-handoff/);
			assert.match(childText, /handoff\/feature/);
			assert.match(childText, /Implement the bounded change\./);
			assert.equal(
				readFileSync(join(worktreePath, "base.txt"), "utf8"),
				"base\n",
			);
			assert.ok(sessionDir);
		});
	});

	it("retains the forked session when shell readiness fails", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: project,
			});
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			writeFileSync(
				request.parent.sessionFile,
				[
					{ type: "session", version: 3, id: "parent", cwd: project },
					{
						type: "message",
						id: "ready-user",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "start" }],
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "ready-assistant",
						parentId: "ready-user",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ready" }],
							api: "test",
							provider: "fake",
							model: "worker",
							usage: {},
							stopReason: "stop",
							timestamp: 2,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			const worktreePath = join(root, "shell-timeout-tree");
			const closed: string[] = [];
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);

			await assert.rejects(
				launchPiWorktreeHandoff(
					{
						...request,
						worktree: { branch: "issue/shell-timeout" },
						handoff: { leafId: "ready-assistant" },
					},
					{
						worktree: createWorktreeOperations(),
						createPane: () => {
							throw new Error("unexpected pane creation");
						},
						createWorktree(_name, cwd, branch, base) {
							execFileSync(
								"git",
								["worktree", "add", "-q", "-b", branch, worktreePath, base],
								{ cwd },
							);
							return {
								path: worktreePath,
								branch,
								workspaceId: "workspace-timeout",
								paneId: "pane-timeout",
							};
						},
						waitForShellReady: async () => {
							throw new Error("shell timeout");
						},
						runScript: () => {
							throw new Error("must not run");
						},
						focusWorkspace: () => {
							throw new Error("must not focus");
						},
						closePane: (surface) => {
							closed.push(surface);
						},
					},
				),
				/shell timeout/i,
			);
			assert.deepEqual(closed, []);
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "failed");
			assert.equal(existsSync(manifest.sessionFile), true);
			assert.match(
				readFileSync(manifest.sessionFile, "utf8"),
				/pi-herdr-worktree-handoff/,
			);
		});
	});

	it("does not focus or report success when Pi startup is not confirmed", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: project,
			});
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			writeFileSync(
				request.parent.sessionFile,
				[
					{ type: "session", version: 3, id: "parent", cwd: project },
					{
						type: "message",
						id: "startup-user",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "start" }],
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "startup-assistant",
						parentId: "startup-user",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ready" }],
							api: "test",
							provider: "fake",
							model: "worker",
							usage: {},
							stopReason: "stop",
							timestamp: 2,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			const worktreePath = join(root, "startup-failed-tree");
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			let focused = false;
			await assert.rejects(
				launchPiWorktreeHandoff(
					{
						...request,
						worktree: { branch: "issue/startup-failed" },
						handoff: { leafId: "startup-assistant" },
					},
					{
						worktree: createWorktreeOperations(),
						createPane: () => {
							throw new Error("unexpected pane creation");
						},
						createWorktree(_name, cwd, branch, base) {
							execFileSync(
								"git",
								["worktree", "add", "-q", "-b", branch, worktreePath, base],
								{ cwd },
							);
							return {
								path: worktreePath,
								branch,
								workspaceId: "workspace-startup",
								paneId: "pane-startup",
							};
						},
						waitForShellReady: async () => {},
						runScript: (_surface, _command, options) => options.scriptPath,
						waitForPiReady: async () => {
							throw new Error("pi exited before startup");
						},
						focusWorkspace: () => {
							focused = true;
						},
						closePane: () => {
							throw new Error("must retain the worktree workspace");
						},
					},
				),
				/worktree retained.*pi exited before startup/i,
			);
			assert.equal(focused, false);
			assert.equal(
				JSON.parse(readFileSync(manifestFile, "utf8")).state,
				"failed",
			);
		});
	});

	it("retains an explicit failed worktree handoff when process start fails", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: project,
			});
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			writeFileSync(
				request.parent.sessionFile,
				[
					{ type: "session", version: 3, id: "parent", cwd: project },
					{
						type: "message",
						id: "failure-user",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "start" }],
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "failure-assistant",
						parentId: "failure-user",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ready" }],
							api: "test",
							provider: "fake",
							model: "worker",
							usage: {},
							stopReason: "stop",
							timestamp: 2,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			const parentBefore = readFileSync(request.parent.sessionFile, "utf8");
			const worktreePath = join(root, "failed-tree");
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(_name, cwd, branch, base) {
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{
							cwd,
						},
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-failed",
						paneId: "root-pane-failed",
					};
				},
				async waitForShellReady() {},
				runScript() {
					throw new Error("pane rejected command");
				},
				focusWorkspace() {
					throw new Error("focus must not run after launch failure");
				},
				closePane() {
					throw new Error("must retain the worktree workspace");
				},
			};

			await assert.rejects(
				launchPiWorktreeHandoff(
					{
						...request,
						worktree: { branch: "issue/7-failed" },
						handoff: { leafId: "failure-assistant" },
					},
					operations,
				),
				/worktree retained.*pane rejected command/i,
			);
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.path, worktreePath);
			assert.equal(manifest.sourceSessionFile, request.parent.sessionFile);
			assert.match(manifest.handoffMessage, /issue\/7-failed/);
			assert.equal(manifest.clean, true);
			assert.equal(existsSync(worktreePath), true);
			assert.equal(existsSync(manifest.sessionFile), true);
			assert.match(
				readFileSync(manifest.sessionFile, "utf8"),
				/pi-herdr-worktree-handoff/,
			);
			assert.equal(
				readFileSync(request.parent.sessionFile, "utf8"),
				parentBefore,
			);
		});
	});
});
