/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn real pi sessions with real LLM calls.
 * Each test creates a herdr pane, runs pi with a task that uses the subagent
 * tool, and verifies the outcome through marker files and terminal output.
 *
 * Duration: ~30-120s per test, depending on the selected model.
 *
 * Run `PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000
 * npm run test:integration` from inside herdr. The exact authenticated model keeps
 * real-LLM runs predictable and the longer timeout covers the lifecycle suite.
 *
 * Configuration:
 *   PI_TEST_MODEL     — exact authenticated model for all pi sessions (recommended: openai-codex/gpt-5.6-luna)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import {
	getAvailableBackends,
	setBackend,
	restoreBackend,
	createTestEnv,
	cleanupTestEnv,
	createTrackedSurface,
	focusSurface,
	startPi,
	waitForScreen,
	waitForFile,
	waitForPaneReady,
	waitForPiExit,
	sleep,
	uniqueId,
	trackTempFile,
	readPane,
	runInPane,
	shellQuote,
	PI_TIMEOUT,
	type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

function getWorkspaceActiveTab(workspaceId: string): string | null {
	const workspaces: Array<{
		workspace_id: string;
		active_tab_id?: string;
	}> = JSON.parse(
		execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" }),
	).result.workspaces;
	return (
		workspaces.find((workspace) => workspace.workspace_id === workspaceId)
			?.active_tab_id ?? null
	);
}

function getPaneTab(paneId: string): string | null {
	return (
		JSON.parse(
			execFileSync("herdr", ["pane", "get", paneId], {
				encoding: "utf8",
			}),
		).result.pane?.tab_id ?? null
	);
}

function listBtwPanes(workspaceId: string): string[] {
	const tabs: Array<{ label: string; tab_id: string }> = JSON.parse(
		execFileSync("herdr", ["tab", "list", "--workspace", workspaceId], {
			encoding: "utf8",
		}),
	).result.tabs;
	const btwTabIds = new Set(
		tabs.filter((tab) => tab.label === "BTW").map((tab) => tab.tab_id),
	);
	const panes: Array<{ pane_id: string; tab_id: string }> = JSON.parse(
		execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], {
			encoding: "utf8",
		}),
	).result.panes;
	return panes
		.filter((pane) => btwTabIds.has(pane.tab_id))
		.map((pane) => pane.pane_id);
}

async function waitForBtwPane(
	workspaceId: string,
	previousPane?: string,
	timeout = PI_TIMEOUT,
): Promise<string> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeout) {
		const panes = listBtwPanes(workspaceId);
		if (panes.length === 1 && panes[0] !== previousPane) return panes[0];
		await sleep(500);
	}
	throw new Error(`Timeout waiting for BTW pane in workspace ${workspaceId}`);
}

async function waitForNoBtwPane(
	workspaceId: string,
	timeout = PI_TIMEOUT,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeout) {
		if (listBtwPanes(workspaceId).length === 0) return;
		await sleep(500);
	}
	throw new Error(
		`Timeout waiting for BTW pane cleanup in workspace ${workspaceId}`,
	);
}

if (backends.length === 0) {
	console.log(
		"⚠️  herdr is unavailable — skipping subagent lifecycle integration tests",
	);
	console.log("   Run inside herdr to enable these tests.");
}

for (const backend of backends) {
	describe(`subagent-lifecycle [${backend}]`, {
		timeout: PI_TIMEOUT * 5,
	}, () => {
		let prevMux: string | undefined;
		let env: TestEnv;

		beforeEach(() => {
			prevMux = setBackend(backend);
			env = createTestEnv(backend);
			resetProviderRequests();
		});

		afterEach(() => {
			cleanupTestEnv(env);
			restoreBackend(prevMux);
		});

		// ── Basic spawn + completion ──

		it("opens, replaces, and closes a context-aware BTW pane without steering the parent", async () => {
			const id = uniqueId();
			const contextMarker = `SECRET_${id}`;
			const expectedAnswer = new RegExp(`BTW_CONFIRMED_(?:SECRET_)?${id}`);
			const parentSession = join(env.dir, `btw-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `btw-parent-${id}`);
			await waitForPaneReady(surface);
			const parentTab = getPaneTab(surface);
			assert.ok(parentTab, "parent pane must belong to a Herdr tab");

			startPi(surface, env.dir, `Reply with only ${contextMarker}.`, {
				extraArgs: `--session ${shellQuote(parentSession)}`,
			});
			await waitForScreen(surface, new RegExp(contextMarker), PI_TIMEOUT);
			await waitForFile(parentSession, PI_TIMEOUT, new RegExp(contextMarker));
			const parentBefore = readFileSync(parentSession, "utf8");

			focusSurface(backend, surface);
			assert.equal(getWorkspaceActiveTab(env.workspaceId), parentTab);

			runInPane(surface, "/btw Say FIRST and wait for another question");
			const firstBtwPane = await waitForBtwPane(env.workspaceId);
			assert.equal(
				getWorkspaceActiveTab(env.workspaceId),
				parentTab,
				"opening BTW must not change the workspace's active tab",
			);

			runInPane(
				surface,
				"/btw Read the previous assistant answer. Reply with BTW_CONFIRMED_ followed by its secret code, with no spaces.",
			);
			const secondBtwPane = await waitForBtwPane(env.workspaceId, firstBtwPane);
			assert.notEqual(
				secondBtwPane,
				firstBtwPane,
				"second /btw should replace the first pane",
			);
			assert.equal(
				getWorkspaceActiveTab(env.workspaceId),
				parentTab,
				"replacing BTW must not change the workspace's active tab",
			);

			try {
				await waitForScreen(secondBtwPane, expectedAnswer, PI_TIMEOUT);
			} catch (error) {
				let childScreen = "<pane unavailable>";
				try {
					childScreen = readPane(secondBtwPane, 200);
				} catch {
					// Keep the original wait error when diagnostic screen capture fails.
				}
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\n` +
						`Parent screen:\n${readPane(surface, 200)}\n` +
						`Child screen:\n${childScreen}`,
				);
			}
			assert.equal(
				readFileSync(parentSession, "utf8"),
				parentBefore,
				"BTW must not alter parent history",
			);

			runInPane(surface, "/btw-close");
			await waitForNoBtwPane(env.workspaceId);
		});

		it("spawns a subagent that writes a file and verifies the session", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `echo-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Echo-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
				`After you receive the subagent result, say INTEGRATION_COMPLETE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Verify: subagent created the marker file
			const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
			assert.ok(
				content.includes(`PASS_${id}`),
				`Marker file should contain PASS_${id}. Got: ${content.trim()}`,
			);

			// Verify: outer pi received the subagent result
			const screen = await waitForScreen(
				surface,
				/INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
				PI_TIMEOUT,
			);

			// Verify: session file was created (shown in steer result)
			const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
			if (sessionMatch) {
				const sessionFile = sessionMatch[1];
				assert.ok(
					existsSync(sessionFile),
					`Subagent session file should exist: ${sessionFile}`,
				);

				const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
				assert.ok(
					lines.length >= 2,
					`Session should have ≥2 entries, got ${lines.length}`,
				);

				const header = JSON.parse(lines[0]);
				assert.equal(
					header.type,
					"session",
					"First entry should be session header",
				);
				assert.ok(header.id, "Session header should have an id");
			}
		});

		it("delivers one model-visible custom completion message", async () => {
			const id = uniqueId();
			const childMarker = `CHILD_RESULT_${id}`;
			const parentMarker = `PARENT_CONTINUED_${id}`;
			const parentSession = join(env.dir, `single-result-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `single-result-${id}`);
			await waitForPaneReady(surface);

			startPi(
				surface,
				env.dir,
				[
					"Call the subagent tool with these EXACT parameters:",
					`  name: "SingleResult-${id}"`,
					'  agent: "test-echo"',
					`  task: "Return exactly ${childMarker}"`,
					"Do not do anything else. Just call the subagent tool once.",
					`After you receive the subagent result, say ${parentMarker}.`,
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);

			let entries: any[] = [];
			let customIndex = -1;
			let continued = false;
			const deadline = Date.now() + PI_TIMEOUT;
			while (!continued && Date.now() < deadline) {
				if (existsSync(parentSession)) {
					entries = readFileSync(parentSession, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line));
					customIndex = entries.findIndex(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "subagent_result",
					);
					continued =
						customIndex >= 0 &&
						entries
							.slice(customIndex + 1)
							.some(
								(entry) =>
									entry.type === "message" &&
									entry.message?.role === "assistant" &&
									JSON.stringify(entry.message.content).includes(parentMarker),
							);
				}
				if (!continued) await sleep(50);
			}

			assert.equal(continued, true, readPane(surface, 300));
			const customResults = entries.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "subagent_result",
			);
			assert.equal(customResults.length, 1);
			assert.match(customResults[0].content, new RegExp(childMarker));
			assert.match(customResults[0].content, /Parent action:/);
			assert.match(
				customResults[0].details.resultContent,
				new RegExp(childMarker),
			);
			assert.doesNotMatch(
				customResults[0].details.resultContent,
				/Parent action:/,
			);
			assert.equal(
				entries
					.slice(customIndex + 1)
					.some(
						(entry) =>
							entry.type === "message" && entry.message?.role === "user",
					),
				false,
			);
		});

		it("runs a non-auto-exit coordinator through discovery and synthesis waves", async () => {
			const id = uniqueId();
			const coordinatorName = `nested-${id}`;
			const marker = `INTEGRATION_MULTI_WAVE_COORDINATOR:${id}`;
			const parentSession = join(env.dir, `multi-wave-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `multi-wave-${id}`);
			await waitForPaneReady(surface);

			startPi(
				surface,
				env.dir,
				[
					"Call the subagent tool with these EXACT parameters:",
					`  name: "${coordinatorName}"`,
					'  agent: "adversarial-reviewer"',
					`  task: "${marker}"`,
					"Do not do anything else. Just call the subagent tool once.",
					`After completion, say PARENT_MULTI_WAVE_${id}.`,
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);

			let entries: any[] = [];
			let completion: any;
			const deadline = Date.now() + Math.min(PI_TIMEOUT, 60_000);
			while (!completion && Date.now() < deadline) {
				if (existsSync(parentSession)) {
					entries = readFileSync(parentSession, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line));
					completion = entries.find(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "subagent_result" &&
							entry.details?.name === coordinatorName,
					);
				}
				if (!completion) await sleep(50);
			}

			assert.ok(completion, readPane(surface, 300));
			assert.match(completion.details.resultContent, /completed/i);
			assert.match(
				completion.details.resultContent,
				new RegExp(`FINAL_MULTI_WAVE_${id}`),
			);
			assert.equal(
				entries.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result" &&
						entry.details?.name === coordinatorName,
				).length,
				1,
				"coordinator must deliver exactly one final parent result",
			);

			const coordinatorSession = completion.details.sessionFile;
			assert.ok(coordinatorSession, "coordinator session must be retained");
			assert.equal(existsSync(coordinatorSession), true);
			const coordinatorEntries = readFileSync(coordinatorSession, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const transcript = JSON.stringify(coordinatorEntries);
			assert.match(transcript, new RegExp(`DISCOVERY_RESULT_${id}`));
			assert.match(transcript, new RegExp(`SYNTHESIS_RESULT_${id}`));
			assert.equal(
				coordinatorEntries.some((entry) => {
					if (entry.type !== "message" || entry.message?.role !== "assistant") {
						return false;
					}
					const turn = JSON.stringify(entry.message.content);
					return (
						turn.includes(`FINAL_MULTI_WAVE_${id}`) &&
						turn.includes("subagent_done")
					);
				}),
				true,
				"final report text and subagent_done must occur in the same coordinator turn",
			);
		});

		it("runs a writing subagent in a retained Herdr worktree", async () => {
			const id = uniqueId();
			const branch = `integration/ticket-${id}`;
			const ticketFile = `ticket-${id}.txt`;
			const surface = createTrackedSurface(env, `worktree-run-${id}`);
			await waitForPaneReady(surface);

			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: env.dir });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: env.dir,
			});
			execFileSync("git", ["config", "user.name", "Integration Test"], {
				cwd: env.dir,
			});
			// Worktrees inherit this repo config; disable signing so non-interactive commits succeed.
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: env.dir,
			});
			writeFileSync(join(env.dir, "README.md"), "worktree lifecycle fixture\n");
			// Keep harness .pi/agent config out of the committed base so worktree children
			// inherit PI_CODING_AGENT_DIR instead of writing sessions into the worktree.
			writeFileSync(join(env.dir, ".gitignore"), ".pi/\n");
			execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: env.dir });
			execFileSync("git", ["commit", "-qm", "fixture"], { cwd: env.dir });

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Worktree-${id}"`,
				`  agent: "test-echo"`,
				`  worktree: { branch: "${branch}" }`,
				`  task: "Run: echo 'WORKTREE_${id}' > '${ticketFile}' && git add '${ticketFile}' && git commit -m 'Implement ${id}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
				`After you receive the result, say WORKTREE_COMPLETE_${id} and repeat its worktree path.`,
			].join("\n");

			startPi(surface, env.dir, task);

			let worktree:
				| { path: string; branch: string; open_workspace_id: string }
				| undefined;
			const startedAt = Date.now();
			while (!worktree && Date.now() - startedAt < PI_TIMEOUT) {
				const output = execFileSync(
					"herdr",
					["worktree", "list", "--cwd", env.dir, "--json"],
					{
						encoding: "utf8",
					},
				);
				worktree = JSON.parse(output).result.worktrees.find(
					(candidate: { branch?: string }) => candidate.branch === branch,
				);
				if (!worktree) await sleep(250);
			}
			assert.ok(
				worktree,
				`Expected Herdr to create branch ${branch}. Parent screen:\n${readPane(surface, 300)}`,
			);

			try {
				const content = await waitForFile(
					join(worktree.path, ticketFile),
					PI_TIMEOUT,
					/WORKTREE_/,
				);
				assert.ok(content.includes(`WORKTREE_${id}`));

				await waitForScreen(
					surface,
					new RegExp(`WORKTREE_COMPLETE_${id}`),
					PI_TIMEOUT,
					300,
				);
				assert.equal(
					execFileSync("git", ["status", "--porcelain"], {
						cwd: worktree.path,
						encoding: "utf8",
					}),
					"",
				);
				assert.match(
					execFileSync("git", ["log", "-1", "--pretty=%s"], {
						cwd: worktree.path,
						encoding: "utf8",
					}),
					new RegExp(`Implement ${id}`),
				);
				assert.ok(
					worktree.open_workspace_id,
					"Completed worktree workspace should remain open",
				);
			} finally {
				// Cleanup must not mask body failures or require a perfectly clean tree.
				if (worktree?.open_workspace_id) {
					try {
						execFileSync("herdr", [
							"worktree",
							"remove",
							"--workspace",
							worktree.open_workspace_id,
							"--force",
							"--json",
						]);
					} catch {
						// Best-effort cleanup for interrupted/dirty retained worktrees.
					}
				}
				try {
					execFileSync("git", ["branch", "-D", branch], {
						cwd: env.dir,
						stdio: "ignore",
					});
				} catch {
					// Branch may already be gone after forced worktree removal.
				}
			}
		});

		it("delivers completion after the parent starts a new session", async () => {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-switch-start-${id}.txt`;
			const markerFile = `/tmp/pi-integ-switch-done-${id}.txt`;
			const childDir = join(env.dir, "sibling-project");
			mkdirSync(childDir);
			trackTempFile(env, startFile);
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `switch-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Switch-${id}"`,
				`  agent: "test-echo"`,
				`  cwd: "${childDir}"`,
				`  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 12; echo 'DONE_${id}' > '${markerFile}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
			].join("\n");

			startPi(surface, env.dir, task);
			await waitForFile(startFile, PI_TIMEOUT, /START_/);

			runInPane(surface, "/new");

			const content = await waitForFile(markerFile, PI_TIMEOUT, /DONE_/);
			assert.ok(
				content.includes(`DONE_${id}`),
				"Subagent should finish after the parent session switch",
			);

			const screen = await waitForScreen(
				surface,
				new RegExp(`Switch-${id}.*completed|Sub-agent.*Switch-${id}`, "i"),
				PI_TIMEOUT,
				300,
			);
			assert.match(screen, new RegExp(`Switch-${id}`, "i"));
		});

		// ── In-progress activity snapshots ──

		it("keeps a long active tool call from surfacing false stalled status", async () => {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
			const markerFile = `/tmp/pi-integ-status-${id}.txt`;
			trackTempFile(env, startFile);
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `status-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Status-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Use the bash tool with a 150-second timeout to run exactly: echo 'START_${id}' > '${startFile}'; sleep 120; echo 'STATUS_${id}' > '${markerFile}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
				`After you receive the subagent result, say STATUS_TEST_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			const activeScreen = await waitForScreen(
				surface,
				/active[\s\S]*bash|bash[\s\S]*active/i,
				PI_TIMEOUT,
				300,
			);
			assert.doesNotMatch(
				activeScreen,
				/Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i,
			);

			await waitForFile(startFile, PI_TIMEOUT, /START_/);
			assert.equal(
				existsSync(markerFile),
				false,
				"Completion marker should not exist before the long sleep",
			);
			await sleep(65_000);
			const watchdogScreen = readPane(surface, 300);
			assert.doesNotMatch(
				watchdogScreen,
				/Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i,
			);

			const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
			assert.ok(
				content.includes(`STATUS_${id}`),
				`Marker file should contain STATUS_${id}`,
			);

			const completionScreen = await waitForScreen(
				surface,
				/STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
				PI_TIMEOUT,
				300,
			);
			assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
		});

		// ── Parallel subagent spawn ──

		it("spawns two subagents in parallel and both complete", async () => {
			const id = uniqueId();
			const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
			const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
			trackTempFile(env, fileA);
			trackTempFile(env, fileB);

			const surface = createTrackedSurface(env, `parallel-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`You must call the subagent tool TWICE. Make both calls before waiting for results.`,
				``,
				`First call:`,
				`  name: "ParaA-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
				``,
				`Second call:`,
				`  name: "ParaB-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
				``,
				`Call both subagent tools NOW, do not wait between them.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Both marker files should appear
			const [contentA, contentB] = await Promise.all([
				waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
				waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
			]);

			assert.ok(
				contentA.includes(`DONE_A_${id}`),
				`File A should contain marker`,
			);
			assert.ok(
				contentB.includes(`DONE_B_${id}`),
				`File B should contain marker`,
			);
		});

		// ── Fork mode ──

		it("fork mode creates a child session linked to the parent", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `fork-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Fork-${id}"`,
				`  fork: true`,
				`  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
				`Do not set the agent or interactive parameters. Just set name, fork, and task.`,
				`After you receive the result, say FORK_COMPLETE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Verify: forked subagent created the file
			const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
			assert.ok(
				content.includes(`FORK_OK_${id}`),
				`Fork marker file should exist with content`,
			);

			// Wait for the outer pi to show the result
			const screen = await waitForScreen(
				surface,
				/FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
				PI_TIMEOUT,
			);

			// Receiving the result proves the bare fork auto-exited and its child pane
			// was finalized instead of remaining at the editor as an interactive run.

			// Verify: the forked session has a parent link
			const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
			if (sessionMatch) {
				const sessionFile = sessionMatch[1];
				assert.ok(
					existsSync(sessionFile),
					`Fork session file should exist: ${sessionFile}`,
				);

				const entries = readFileSync(sessionFile, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l));
				const header = entries[0];
				assert.equal(
					header.type,
					"session",
					"First entry should be session header",
				);
				assert.ok(
					header.parentSession,
					"Fork session should have parentSession field",
				);
				// Fork sessions include parent context (model_change entries etc.)
				assert.ok(
					entries.length >= 2,
					"Fork session should have context entries beyond header",
				);
			}
		});

		// ── caller_ping ──

		it("subagent caller_ping sends notification back to the parent", async () => {
			const id = uniqueId();

			const surface = createTrackedSurface(env, `ping-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Ping-${id}"`,
				`  agent: "test-ping"`,
				`  task: "PING_TEST_${id}"`,
				`Just call the subagent tool once. Do not do anything else before calling it.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// The test-ping agent calls caller_ping, which steers a "needs help" message
			// back to the outer pi. Look for it on screen.
			const screen = await waitForScreen(
				surface,
				/needs help|PING|caller_ping|ping/i,
				PI_TIMEOUT,
			);

			assert.ok(
				/needs help|PING/i.test(screen),
				`Screen should show ping notification. Got:\n${screen.slice(-800)}`,
			);
		});

		it("resumes a Pi session and delivers its new result to the parent", async () => {
			const id = uniqueId();
			const sessionFile = join(env.dir, `resume-child-${id}.jsonl`);
			const seedSurface = createTrackedSurface(env, `resume-seed-${id}`);
			await waitForPaneReady(seedSurface);
			startPi(seedSurface, env.dir, "BTW question: Say FIRST", {
				extraArgs: `--print --session ${shellQuote(sessionFile)}`,
			});
			await waitForScreen(seedSurface, /FIRST/);
			assert.equal(await waitForPiExit(seedSurface), 0);
			assert.equal(existsSync(sessionFile), true);

			const resultMarker = `RESUME_RESULT_${id}`;
			const parentSurface = createTrackedSurface(env, `resume-parent-${id}`);
			await waitForPaneReady(parentSurface);
			startPi(
				parentSurface,
				env.dir,
				[
					"Call the subagent_resume tool with these EXACT parameters:",
					`  sessionPath: "${sessionFile}"`,
					`  name: "Resume-${id}"`,
					`  message: "RESUME_FOLLOWUP_INPUT: ${id}"`,
					"  autoExit: true",
					"Call the tool once and wait for its asynchronous result.",
				].join("\n"),
			);

			const screen = await waitForScreen(
				parentSurface,
				new RegExp(resultMarker),
				PI_TIMEOUT,
			);
			assert.match(screen, new RegExp(resultMarker));
		});

		// ── Agent discovery ──

		it("subagent discovers project-local test agents", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `discovery-${id}`);
			await waitForPaneReady(surface);

			// Use subagents_list to verify test agents are discoverable,
			// then spawn one to prove it works end-to-end.
			const task = [
				`First, call the subagents_list tool to see available agents.`,
				`Then call the subagent tool:`,
				`  name: "Disco-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
				`After you receive the subagent result, say DISCOVERY_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// The test-echo agent (discovered from project .pi/agents/) should work
			const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
			assert.ok(
				content.includes(`DISCO_${id}`),
				`Discovery test marker should exist`,
			);
		});

		// ── Subagent with custom system prompt ──

		it("passes systemPrompt to subagent", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `sysprompt-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these parameters:`,
				`  name: "SysP-${id}"`,
				`  agent: "test-echo"`,
				`  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
				`  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
				`After the subagent completes, say SYSPROMPT_TEST_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
			assert.ok(
				content.includes(`SYSPROMPT_${id}`),
				`System prompt test marker should exist`,
			);
		});

		it("falls back after a provider failure and delivers the selected model", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-fallback-${id}.txt`;
			const parentSession = join(env.dir, `fallback-parent-${id}.jsonl`);
			trackTempFile(env, markerFile);
			const surface = createTrackedSurface(env, `fallback-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				[
					`Call subagent once with name: "Fallback-${id}".`,
					`agent: "test-echo".`,
					`model: "pi-integration/fallback-primary, pi-integration/fallback-secondary".`,
					`task: "Run: echo 'FALLBACK_${id}' > '${markerFile}'".`,
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);
			assert.match(
				await waitForFile(markerFile, PI_TIMEOUT),
				new RegExp(`FALLBACK_${id}`),
			);
			assert.ok(
				getProviderRequests().some(
					(request) =>
						request.model === "fallback-primary" && request.status === 503,
				),
			);
			assert.ok(
				getProviderRequests().some(
					(request) =>
						request.model === "fallback-secondary" && request.status === 200,
				),
			);
			await waitForFile(
				parentSession,
				PI_TIMEOUT,
				/"customType":"subagent_result"/,
			);
			const result = readFileSync(parentSession, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result",
				);
			assert.deepEqual(result.details.fallbackAttempts, [
				"pi-integration/fallback-primary",
				"pi-integration/fallback-secondary",
			]);
			assert.equal(
				result.details.runtimePlan.model,
				"pi-integration/fallback-secondary",
			);
		});

		it("reports every attempted model when all fallbacks fail", async () => {
			const id = uniqueId();
			const parentSession = join(env.dir, `fallback-fail-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `fallback-fail-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				[
					`Call subagent once with name: "FallbackFail-${id}".`,
					`agent: "test-echo".`,
					`model: "pi-integration/fallback-primary, pi-integration/fallback-fail".`,
					`task: "Return exactly SHOULD_NOT_COMPLETE".`,
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);
			await waitForFile(
				parentSession,
				PI_TIMEOUT,
				/"customType":"subagent_result"/,
			);
			const result = readFileSync(parentSession, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result",
				);
			assert.deepEqual(result.details.fallbackAttempts, [
				"pi-integration/fallback-primary",
				"pi-integration/fallback-fail",
			]);
			const failedRequests = getProviderRequests().filter((request) =>
				request.model?.startsWith("fallback-"),
			);
			assert.deepEqual(
				[...new Set(failedRequests.map((request) => request.model))].sort(),
				["fallback-fail", "fallback-primary"],
			);
			assert.equal(
				failedRequests.every((request) => request.status === 503),
				true,
			);
		});
	});
}
