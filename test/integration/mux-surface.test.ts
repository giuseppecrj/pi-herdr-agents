/**
 * Integration tests for herdr terminal operations.
 *
 * These tests exercise real herdr operations: creating panes,
 * sending commands, reading output, preserving focus, and closing panes.
 * No LLM calls — fast and free.
 *
 * Run `npm run test:integration` from inside herdr.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import {
	getAvailableBackends,
	setBackend,
	restoreBackend,
	createTestEnv,
	cleanupTestEnv,
	createTrackedSurface,
	createSubagentPane,
	createSubagentWorktree,
	splitCurrentPane,
	getFocusedSurface,
	untrackSurface,
	runInPane,
	runScriptInPane,
	closePane,
	interruptPane,
	uniqueId,
	waitForPaneReady,
	trackTempFile,
	waitForFile,
	waitForScreen,
	type TestEnv,
} from "./harness.ts";
import {
	createSubagentPaneFactory,
	parsePaneConfig,
} from "../../pi-extension/subagents/pane-config.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
	console.log("⚠️  herdr is unavailable — skipping terminal integration tests");
	console.log("   Run inside herdr to enable these tests.");
}

for (const backend of backends) {
	describe(`herdr terminal [${backend}]`, { timeout: 60_000 }, () => {
		let prevMux: string | undefined;
		let env: TestEnv;

		beforeEach(() => {
			prevMux = setBackend(backend);
			env = createTestEnv(backend);
		});

		afterEach(() => {
			cleanupTestEnv(env);
			restoreBackend(prevMux);
		});

		it("keeps focus on the current pane while creating and targeting subagent tabs", async () => {
			const focusedPane = getFocusedSurface(backend);
			assert.ok(
				focusedPane,
				"Expected herdr to report the currently focused pane",
			);

			const childA = createTrackedSurface(env, "focus-child-a");
			await waitForPaneReady(childA);
			assert.equal(getFocusedSurface(backend), focusedPane);

			const childB = createTrackedSurface(env, "focus-child-b");
			await waitForPaneReady(childB);
			assert.equal(getFocusedSurface(backend), focusedPane);

			const markerA = uniqueId();
			const markerB = uniqueId();
			runInPane(childA, `echo "FOCUS_A_${markerA}"`);
			runInPane(childB, `echo "FOCUS_B_${markerB}"`);

			await Promise.all([
				waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
				waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
			]);
			assert.equal(getFocusedSurface(backend), focusedPane);
		});

		it("splits the stable parent without stealing focus or closing it", async () => {
			const parentPane = createTrackedSurface(env, "split-parent");
			await waitForPaneReady(parentPane);
			const focusedPane = getFocusedSurface(backend);
			const parentBefore = JSON.parse(
				execFileSync("herdr", ["pane", "get", parentPane], {
					encoding: "utf8",
				}),
			).result.pane;
			const createConfiguredPane = createSubagentPaneFactory(
				parsePaneConfig({ panes: { mode: "split", direction: "down" } }),
				createSubagentPane,
				splitCurrentPane,
			);
			const previousParentPane = process.env.HERDR_PANE_ID;
			let child: string | undefined;
			try {
				process.env.HERDR_PANE_ID = parentPane;
				child = createConfiguredPane("split-child");
			} finally {
				if (previousParentPane === undefined) delete process.env.HERDR_PANE_ID;
				else process.env.HERDR_PANE_ID = previousParentPane;
			}

			try {
				await waitForPaneReady(child);
				const childInfo = JSON.parse(
					execFileSync("herdr", ["pane", "get", child], {
						encoding: "utf8",
					}),
				).result.pane;
				assert.notEqual(childInfo.pane_id, parentPane);
				assert.equal(childInfo.tab_id, parentBefore.tab_id);
				assert.equal(getFocusedSurface(backend), focusedPane);

				const marker = uniqueId();
				runInPane(child, `echo "SPLIT_${marker}"`);
				await waitForScreen(child, new RegExp(`SPLIT_${marker}`), 20_000, 50);
			} finally {
				closePane(child);
			}

			const parentAfter = JSON.parse(
				execFileSync("herdr", ["pane", "get", parentPane], {
					encoding: "utf8",
				}),
			).result.pane;
			assert.equal(parentAfter.pane_id, parentPane);
		});

		it("creates an isolated worktree workspace without stealing focus", async () => {
			const focusedPane = getFocusedSurface(backend);
			const id = uniqueId();
			const branch = `integration/worktree-${id}`;

			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: env.dir });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: env.dir,
			});
			execFileSync("git", ["config", "user.name", "Integration Test"], {
				cwd: env.dir,
			});
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: env.dir,
			});
			writeFileSync(`${env.dir}/README.md`, "integration worktree fixture\n");
			execFileSync("git", ["add", "."], { cwd: env.dir });
			execFileSync("git", ["commit", "-qm", "fixture"], { cwd: env.dir });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: env.dir,
				encoding: "utf8",
			}).trim();

			const worktree = createSubagentWorktree(
				`worktree-${id}`,
				env.dir,
				branch,
				baseSha,
			);
			try {
				assert.equal(worktree.branch, branch);
				assert.ok(worktree.path !== env.dir);
				assert.equal(getFocusedSurface(backend), focusedPane);

				await waitForPaneReady(worktree.paneId);
				runInPane(worktree.paneId, "pwd");
				await waitForScreen(
					worktree.paneId,
					new RegExp(worktree.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
					20_000,
					50,
				);

				const listed = JSON.parse(
					execFileSync(
						"herdr",
						["worktree", "list", "--workspace", worktree.workspaceId, "--json"],
						{ encoding: "utf8" },
					),
				);
				const listedWorktree = listed.result.worktrees.find(
					(candidate: { path?: string }) => candidate.path === worktree.path,
				);
				assert.ok(
					listedWorktree,
					`Expected worktree list to include ${worktree.path}`,
				);
				assert.equal(listedWorktree.branch, branch);
			} finally {
				execFileSync("herdr", [
					"worktree",
					"remove",
					"--workspace",
					worktree.workspaceId,
					"--json",
				]);
				execFileSync("git", ["branch", "-D", branch], {
					cwd: env.dir,
					stdio: "ignore",
				});
			}
		});

		it("creates a surface, sends a command, reads output, and closes it", async () => {
			const surface = createTrackedSurface(env, "echo-test");
			await waitForPaneReady(surface);

			const marker = uniqueId();
			runInPane(surface, `echo "MARKER_${marker}"`);
			const screen = await waitForScreen(
				surface,
				new RegExp(`MARKER_${marker}`),
				15_000,
				50,
			);
			assert.ok(
				screen.includes(`MARKER_${marker}`),
				`Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
			);

			closePane(surface);
			untrackSurface(env, surface);
		});

		it("preserves shell special characters in echo output", async () => {
			const surface = createTrackedSurface(env, "escape-test");
			await waitForPaneReady(surface);

			const marker = uniqueId();
			// Single-quoted string — $ and " are literal inside single quotes
			runInPane(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
			const screen = await waitForScreen(
				surface,
				new RegExp(`SPEC_${marker}`),
				15_000,
				50,
			);
			assert.ok(
				screen.includes(`SPEC_${marker}`),
				`Expected special-char output. Got:\n${screen}`,
			);
			// $ should be literal inside single quotes
			assert.ok(
				screen.includes("$HOME"),
				`Expected literal $HOME in output. Got:\n${screen}`,
			);
		});

		it("sends a long command via script file without truncation", async () => {
			const surface = createTrackedSurface(env, "long-cmd-test");
			await waitForPaneReady(surface);

			const marker = uniqueId();
			const longValue = "X".repeat(500);
			const command = `echo "LONG_${marker}_${longValue}_END"`;

			runScriptInPane(surface, command);
			const screen = await waitForScreen(
				surface,
				new RegExp(`LONG_${marker}`),
				15_000,
				50,
			);
			assert.ok(
				screen.includes(`LONG_${marker}`),
				`Expected long command output. Got:\n${screen.slice(0, 300)}...`,
			);
			assert.ok(
				screen.includes("_END"),
				`Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
			);
		});

		it("reads screen asynchronously", async () => {
			const surface = createTrackedSurface(env, "async-read-test");
			await waitForPaneReady(surface);

			const marker = uniqueId();
			runInPane(surface, `echo "ASYNC_${marker}"`);
			const screen = await waitForScreen(
				surface,
				new RegExp(`ASYNC_${marker}`),
				15_000,
				50,
			);
			assert.ok(
				screen.includes(`ASYNC_${marker}`),
				`Async read should find marker. Got:\n${screen}`,
			);
		});

		it("manages multiple surfaces concurrently", async () => {
			const s1 = createTrackedSurface(env, "multi-1");
			const s2 = createTrackedSurface(env, "multi-2");
			await Promise.all([waitForPaneReady(s1), waitForPaneReady(s2)]);

			const m1 = uniqueId();
			const m2 = uniqueId();
			runInPane(s1, `echo "S1_${m1}"`);
			runInPane(s2, `echo "S2_${m2}"`);
			const [screen1, screen2] = await Promise.all([
				waitForScreen(s1, new RegExp(`S1_${m1}`), 15_000, 50),
				waitForScreen(s2, new RegExp(`S2_${m2}`), 15_000, 50),
			]);

			assert.ok(
				screen1.includes(`S1_${m1}`),
				`Surface 1 missing marker. Got:\n${screen1}`,
			);
			assert.ok(
				screen2.includes(`S2_${m2}`),
				`Surface 2 missing marker. Got:\n${screen2}`,
			);
		});

		it("writes output to a file and verifies via surface", async () => {
			const surface = createTrackedSurface(env, "file-test");
			await waitForPaneReady(surface);

			const marker = uniqueId();
			const filePath = `/tmp/pi-mux-test-${marker}.txt`;

			runInPane(
				surface,
				`echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`,
			);

			await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
			const content = await waitForFile(
				filePath,
				10_000,
				new RegExp(`FILE_${marker}`),
			);
			assert.ok(
				content.includes(`FILE_${marker}`),
				`File content wrong. Got: ${content}`,
			);

			// Clean up
			try {
				unlinkSync(filePath);
			} catch {}
		});

		it("delivers Escape as byte 27 to the target surface", async () => {
			const surface = createTrackedSurface(env, "escape-byte-test");
			await waitForPaneReady(surface);

			const marker = uniqueId();
			const byteFile = `/tmp/pi-mux-escape-${marker}.txt`;
			trackTempFile(env, byteFile);

			const nodeProgram =
				"const fs = require('node:fs');" +
				"if (!process.stdin.isTTY) throw new Error('stdin is not a TTY');" +
				"process.stdin.setRawMode(true);" +
				"process.stdin.resume();" +
				"process.stdout.write('ESC_READY\\n');" +
				"process.stdin.once('data', (chunk) => {" +
				`fs.writeFileSync(${JSON.stringify(byteFile)}, Array.from(chunk).join(','));` +
				"process.exit(0);" +
				"});";
			const command = `node -e ${JSON.stringify(nodeProgram)}`;

			runScriptInPane(surface, command);
			await waitForScreen(surface, /ESC_READY/, 15_000, 50);

			interruptPane(surface);

			const content = await waitForFile(byteFile, 15_000, /^27$/);
			assert.equal(content.trim(), "27");
		});
	});
}
