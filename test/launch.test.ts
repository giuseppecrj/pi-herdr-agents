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
import { execFileSync } from "node:child_process";
import {
	launchPiSubagent,
	launchPiWorktreeHandoff,
	type FreshPiLaunchRequest,
	type PiLaunchOperations,
	type ResumePiLaunchRequest,
} from "../pi-extension/subagents/launch.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "subagent-launch-test-"));
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

describe("Pi launch", () => {
	it("launches an ordinary child through one transaction", async () => {
		await withFixture(async ({ request, project, agentDir }) => {
			const projectAgentDir = join(project, ".pi", "agent");
			mkdirSync(projectAgentDir, { recursive: true });
			const events: string[] = [];
			let command = "";
			let scriptPath = "";
			const operations: PiLaunchOperations = {
				createPane(name) {
					assert.equal(name, "Worker");
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
			};

			const running = await launchPiSubagent(request, operations);

			assert.deepEqual(events, ["create", "ready", "run"]);
			assert.equal(running.id, "child-1");
			assert.equal(running.surface, "pane-1");
			assert.equal(running.launchScriptFile, scriptPath);
			assert.ok(running.sessionFile.startsWith(join(agentDir, "sessions")));
			assert.equal(command.includes(projectAgentDir), false);
			assert.match(command, new RegExp(`^cd '${project}' && `));
			assert.match(command, /--model 'fake\/worker'/);
			assert.match(command, /--thinking 'high'/);
			assert.match(command, /--tools 'read,bash,caller_ping'/);
			assert.doesNotMatch(command, /subagent_done/);
			assert.match(command, /PI_DENY_TOOLS='subagent,subagent_resume'/);
			assert.match(command, /PI_SUBAGENT_AUTO_EXIT=1/);
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

	it("keeps untrusted launch metadata inside shell comments", async () => {
		await withFixture(async ({ request, root, sessionDir }) => {
			const preambles: string[] = [];
			let pane = 0;
			const operations: PiLaunchOperations = {
				createPane: () => `pane-${++pane}`,
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				waitForShellReady: async () => {},
				runScript: (_surface, _command, options) => {
					preambles.push(options.scriptPreamble);
					return options.scriptPath;
				},
			};
			const injectedName =
				"Worker\nprintf fresh-injection\rprintf carriage-return\u2028printf line-separator\u2029printf paragraph-separator";

			await launchPiSubagent({ ...request, name: injectedName }, operations);

			const resumedSession = join(root, "resumed.jsonl");
			writeFileSync(resumedSession, "existing session\n");
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
				},
			);

			assert.match(command, /PI_SUBAGENT_AUTO_EXIT=0/);
			assert.match(command, /--tools 'read,bash,caller_ping,subagent_done'/);
		});
	});

	it("resumes a session through the launch transaction", async () => {
		await withFixture(async ({ root, sessionDir }) => {
			const sessionFile = join(root, "child.jsonl");
			writeFileSync(sessionFile, "existing session\n");
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = join(root, "isolated-agent");
			try {
				const events: string[] = [];
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
					createPane(name) {
						assert.equal(name, "Resume worker");
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
				};

				const running = await launchPiSubagent(request, operations);

				assert.deepEqual(events, ["create", "ready", "run"]);
				assert.equal(running.id, "resume-1");
				assert.equal(running.name, "Resume worker");
				assert.equal(running.task, "Use the approved schema.");
				assert.equal(running.surface, "pane-resume");
				assert.equal(running.sessionFile, sessionFile);
				assert.equal(running.launchScriptFile, scriptPath);
				assert.equal(running.interactive, false);
				assert.equal(running.runtimePlan, undefined);
				assert.equal(running.worktree, undefined);
				assert.match(
					command,
					new RegExp(
						`^PI_CODING_AGENT_DIR='${process.env.PI_CODING_AGENT_DIR}' `,
					),
				);
				assert.match(command, new RegExp(`pi --session '${sessionFile}' -e `));
				assert.match(command, /PI_SUBAGENT_NAME='Resume worker'/);
				assert.match(
					command,
					new RegExp(`PI_SUBAGENT_SESSION='${sessionFile}'`),
				);
				assert.match(command, /PI_SUBAGENT_ID='resume-1'/);
				assert.match(command, /PI_SUBAGENT_ACTIVITY_FILE='/);
				assert.match(command, /PI_SUBAGENT_AUTO_EXIT=1/);
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
				assert.match(
					scriptPreamble,
					new RegExp(`# Resume message file: ${messagePath}`),
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
			writeFileSync(sessionFile, "existing session\n");
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
			const operations: PiLaunchOperations = {
				createPane() {
					throw new Error("unexpected pane creation");
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
			};

			const running = await launchPiSubagent(worktreeRequest, operations);

			assert.deepEqual(events, ["create", "ready", "run"]);
			assert.equal(running.worktree?.baseSha, baseSha);
			assert.equal(running.worktree?.path, worktreePath);
			assert.equal(running.worktree?.sessionFile, running.sessionFile);
			assert.match(command, new RegExp(`^cd '${worktreePath}' && `));
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "running");
			assert.equal(manifest.owner, "pi-herdr-subagents");
			assert.equal(manifest.paneId, "root-pane-1");
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
			};

			const result = await launchPiWorktreeHandoff(
				{
					...request,
					name: "Handoff",
					worktree: { branch: "handoff/feature" },
					handoff: { leafId: "assistant-1" },
				},
				operations,
			);

			assert.deepEqual(events, ["create", "ready", "run", "pi-ready", "focus"]);
			assert.equal(result.focusError, undefined);
			assert.equal(
				readFileSync(request.parent.sessionFile, "utf8"),
				parentBefore,
			);
			assert.match(command, new RegExp(`^cd '${worktreePath}' && `));
			assert.doesNotMatch(
				command,
				/subagent-done|PI_SUBAGENT_|__SUBAGENT_DONE_/,
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
					},
				),
				/shell timeout/i,
			);
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
