/**
 * Real-Herdr integration tests for the `subagent_cancel` tool (ADR-0014).
 * Case evidence is appended to `$CANCEL_EVIDENCE_DIR/evidence.log`.
 *
 * The deterministic parent script lives in fake-provider.ts
 * (`INTEGRATION_CANCEL:<id>:<mode>`). Each case launches one deliberately slow
 * child (a real `sleep` under the bash tool) whose model list carries a
 * fallback candidate (`fallback-secondary`); any request for that model is
 * therefore proof that a fallback attempt started.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import {
	getAvailableBackends,
	setBackend,
	restoreBackend,
	createTestEnv,
	cleanupTestEnv,
	createTrackedSurface,
	waitForPaneReady,
	startPi,
	waitForFile,
	uniqueId,
	trackTempFile,
	runInPane,
	readPane,
	sleep,
	shellQuote,
	PI_TIMEOUT,
	type TestEnv,
} from "./harness.ts";

const LOG_DIR =
	process.env.CANCEL_EVIDENCE_DIR ??
	join(tmpdir(), "pi-herdr-agents-cancel-evidence");
mkdirSync(LOG_DIR, { recursive: true });

function evidence(label: string, text: string): void {
	appendFileSync(
		join(LOG_DIR, "evidence.log"),
		`\n=== ${label} ===\n${text}\n`,
	);
}

function herdrJson(...args: string[]): any {
	return JSON.parse(execFileSync("herdr", args, { encoding: "utf8" }));
}

function workspacePanes(workspaceId: string): string[] {
	try {
		return herdrJson(
			"pane",
			"list",
			"--workspace",
			workspaceId,
		).result.panes.map((pane: { pane_id: string }) => pane.pane_id);
	} catch {
		return [];
	}
}

function workspaceIds(): string[] {
	return herdrJson("workspace", "list").result.workspaces.map(
		(w: { workspace_id: string }) => w.workspace_id,
	);
}

function paneExists(paneId: string): boolean {
	return workspaceIds().some((w) => workspacePanes(w).includes(paneId));
}

// The session-entry fields these cases assert; JSON.parse supplies the rest.
type Entry = {
	type?: string;
	customType?: string;
	content: string;
	details: {
		error?: string;
		sessionFile?: string;
		fallbackAttempts?: string[];
		cancellation: {
			termination: string;
			requestedAt: number;
			confirmedAt: number;
		};
		worktree?: { branch: string; headSha: string; commitsAhead: number };
	};
	message: {
		role?: string;
		toolName?: string;
		content: unknown;
		details: { id: string; status?: string; repeated?: boolean; error: string };
	};
};

function readEntries(path: string): Entry[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function waitFor<T>(
	probe: () => T | undefined | false,
	what: string,
	timeout = PI_TIMEOUT,
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await sleep(100);
	}
}

const subagentResults = (entries: Entry[]) =>
	entries.filter(
		(e) => e.type === "custom_message" && e.customType === "subagent_result",
	);

const cancelToolResults = (entries: Entry[]) =>
	entries.filter(
		(e) =>
			e.type === "message" &&
			e.message?.role === "toolResult" &&
			e.message?.toolName === "subagent_cancel",
	);

const launchResult = (entries: Entry[]) =>
	entries.find(
		(e) =>
			e.type === "message" &&
			e.message?.role === "toolResult" &&
			e.message?.toolName === "subagent",
	);

function pgrepCount(pattern: string): number {
	try {
		return execFileSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean).length;
	} catch {
		return 0;
	}
}

const FALLBACK = "fallback-secondary";
const MODELS = "pi-integration/test,pi-integration/fallback-secondary";

interface Scenario {
	id: string;
	parent: string;
	parentSession: string;
	startFile: string;
	gateFile: string;
	idFile: string;
	sleepToken: string;
	bystander: string;
	baselinePanes: Set<string>;
}

const backends = getAvailableBackends();

for (const backend of backends) {
	describe(`subagent-cancel [${backend}]`, { timeout: PI_TIMEOUT * 6 }, () => {
		let prevMux: string | undefined;
		let env: TestEnv;

		beforeEach(() => {
			prevMux = setBackend(backend);
			env = createTestEnv(backend);
			resetProviderRequests();
		});

		afterEach(async () => {
			await cleanupTestEnv(env);
			restoreBackend(prevMux);
		});

		async function launch(
			mode: string,
			extra: Record<string, string> = {},
		): Promise<Scenario> {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-cancel-start-${id}.txt`;
			const gateFile = `/tmp/pi-integ-cancel-gate-${id}.txt`;
			const idFile = `/tmp/pi-integ-cancel-id-${id}.txt`;
			for (const f of [startFile, `${startFile}.done`, gateFile, idFile])
				trackTempFile(env, f);
			// Unique decimal so a leaked `sleep` is attributable to this case.
			const sleepToken = `91.${Math.floor(Math.random() * 1e6)}`;
			const parentSession = join(env.dir, `cancel-parent-${id}.jsonl`);
			const parent = await createTrackedSurface(env, `cancel-parent-${id}`);
			const bystander = await createTrackedSurface(
				env,
				`cancel-bystander-${id}`,
			);
			await waitForPaneReady(parent);
			await waitForPaneReady(bystander);
			await runInPane(bystander, `echo BYSTANDER_ALIVE_${id}`);
			const baselinePanes = new Set(workspacePanes(env.workspaceId));
			const lines = [
				`INTEGRATION_CANCEL:${id}:${mode}`,
				`CANCEL_START_FILE: ${startFile}`,
				`CANCEL_GATE_FILE: ${gateFile}`,
				`CANCEL_ID_FILE: ${idFile}`,
				`CANCEL_SLEEP: ${sleepToken}`,
				`CANCEL_MODELS: ${MODELS}`,
				...Object.entries(extra).map(([k, v]) => `CANCEL_${k}: ${v}`),
				"Follow the scripted cancellation scenario.",
			];
			await startPi(parent, env.dir, lines.join("\n"), {
				extraArgs: `--session ${shellQuote(parentSession)}`,
			});
			return {
				id,
				parent,
				parentSession,
				startFile,
				gateFile,
				idFile,
				sleepToken,
				bystander,
				baselinePanes,
			};
		}

		/** The child is provably running: its bash tool wrote the start marker. */
		async function waitRunning(s: Scenario): Promise<string[]> {
			await waitForFile(s.startFile, PI_TIMEOUT, /START_/);
			const childPanes = await waitFor(() => {
				const fresh = workspacePanes(env.workspaceId).filter(
					(p) => !s.baselinePanes.has(p),
				);
				return fresh.length > 0 ? fresh : undefined;
			}, "child pane");
			assert.ok(
				getProviderRequests().some(
					(r) => r.model === "test" && r.lastUser?.includes(`START_${s.id}`),
				),
				"first candidate must have been requested by the child",
			);
			return childPanes;
		}

		function noFallbackRequests(): void {
			const fallback = getProviderRequests().filter(
				(r) => r.model === FALLBACK,
			);
			assert.deepEqual(
				fallback,
				[],
				"no fallback model request may reach the provider",
			);
		}

		function unrelatedUntouched(s: Scenario): void {
			assert.equal(paneExists(s.parent), true, "parent pane must survive");
			assert.equal(
				paneExists(s.bystander),
				true,
				"bystander pane must survive",
			);
			assert.match(
				readPane(s.bystander, 50),
				new RegExp(`BYSTANDER_ALIVE_${s.id}`),
			);
		}

		// (a) ordinary pane child: cancel suppresses fallback
		it("(a) cancels a slow ordinary child: one cancelled result, pane closed, no fallback", async () => {
			const s = await launch("basic");
			const childPanes = await waitRunning(s);
			evidence(
				"a: child panes before cancel",
				JSON.stringify(childPanes, null, 2),
			);
			const requestsBefore = getProviderRequests().length;
			const gateAt = Date.now();
			writeFileSync(s.gateFile, "go\n");

			await waitFor(
				() => subagentResults(readEntries(s.parentSession)).length > 0,
				"cancelled subagent_result",
			);
			// A fallback request would arrive within seconds of pane loss; wait.
			await sleep(8_000);
			const final = readEntries(s.parentSession);
			evidence("a: parent session entries", JSON.stringify(final, null, 2));
			evidence(
				"a: provider requests",
				JSON.stringify(getProviderRequests(), null, 2),
			);
			evidence("a: parent screen", readPane(s.parent, 200));

			const results = subagentResults(final);
			assert.equal(results.length, 1, "exactly one subagent_result");
			const result = results[0];
			assert.equal(result.details.error, "cancelled");
			assert.equal(result.details.cancellation.termination, "confirmed");
			assert.ok(result.details.cancellation.requestedAt >= gateAt - 1_000);
			assert.ok(
				result.details.cancellation.confirmedAt >=
					result.details.cancellation.requestedAt,
			);
			assert.match(result.content, /cancelled by the parent/);
			assert.match(result.content, /no model fallback, retry, or recovery/);
			assert.deepEqual(
				result.details.fallbackAttempts ?? ["pi-integration/test"],
				["pi-integration/test"],
				"only the first candidate was ever attempted",
			);

			const tools = cancelToolResults(final);
			assert.equal(tools.length, 1);
			assert.equal(tools[0].message.details.status, "confirmed");
			assert.match(JSON.stringify(tools[0].message.content), /pane was closed/);

			noFallbackRequests();
			assert.equal(
				getProviderRequests().length - requestsBefore <= 2,
				true,
				"at most the in-flight parent turn requests after the gate",
			);
			for (const pane of childPanes)
				assert.equal(
					paneExists(pane),
					false,
					`child pane ${pane} must be gone`,
				);
			assert.equal(existsSync(`${s.startFile}.done`), false);
			unrelatedUntouched(s);
		});

		// (b) negative control: manual pane close WITHOUT cancel -> fallback
		it("(b) negative control: closing the pane by hand starts the fallback model", async () => {
			const s = await launch("manual");
			const childPanes = await waitRunning(s);
			evidence(
				"b: child panes before manual close",
				JSON.stringify(childPanes, null, 2),
			);
			noFallbackRequests();
			execFileSync("rm", ["-f", s.startFile]);
			for (const pane of childPanes)
				execFileSync("herdr", ["pane", "close", pane], { encoding: "utf8" });

			await waitFor(
				() => getProviderRequests().some((r) => r.model === FALLBACK),
				"fallback model request after manual pane close",
				90_000,
			);
			evidence(
				"b: provider requests",
				JSON.stringify(getProviderRequests(), null, 2),
			);
			// The fallback child re-runs the slow command and rewrites the marker.
			await waitForFile(s.startFile, PI_TIMEOUT, /START_/);
			assert.equal(
				getProviderRequests().some((r) => r.model === FALLBACK),
				true,
			);
			assert.equal(
				subagentResults(readEntries(s.parentSession)).length,
				0,
				"run is still live on the fallback attempt (no result yet)",
			);
			evidence("b: parent screen", readPane(s.parent, 200));
			unrelatedUntouched(s);
		});

		// (c) worktree child
		it("(c) cancels a worktree child: workspace, checkout, commit and handoff retained", async () => {
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
			writeFileSync(join(env.dir, "README.md"), "cancel worktree fixture\n");
			writeFileSync(
				join(env.dir, ".gitignore"),
				".pi/\ncancel-parent-*.jsonl\n",
			);
			execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: env.dir });
			execFileSync("git", ["commit", "-qm", "fixture"], { cwd: env.dir });

			const branch = `integration/cancel-${uniqueId()}`;
			let workspaceToRemove: string | undefined;
			try {
				// Worktree subagents reject model fallback lists by design ("Model
				// fallbacks are not supported for worktree subagents"), so this case
				// uses a single model; no-fallback is covered by (a)/(e).
				const s = await launch("worktree", {
					BRANCH: branch,
					MODELS_OVERRIDE: "pi-integration/test",
				});
				const findWorktree = () =>
					herdrJson(
						"worktree",
						"list",
						"--cwd",
						env.dir,
						"--json",
					).result.worktrees.find(
						(c: { branch?: string }) => c.branch === branch,
					);
				const worktree = await waitFor(findWorktree, `worktree ${branch}`);
				workspaceToRemove = worktree.open_workspace_id;
				await waitForFile(s.startFile, PI_TIMEOUT, /START_/);
				// Herdr can list a new checkout before it opens the workspace; the
				// child is running now, so the current row has the workspace id.
				workspaceToRemove = findWorktree()?.open_workspace_id;
				assert.ok(
					workspaceToRemove,
					"worktree workspace open while child runs",
				);
				const wtPanesBefore = workspacePanes(workspaceToRemove);
				assert.ok(wtPanesBefore.length > 0);
				evidence(
					"c: worktree before cancel",
					JSON.stringify({ worktree, wtPanesBefore }, null, 2),
				);
				const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: worktree.path,
					encoding: "utf8",
				}).trim();
				writeFileSync(s.gateFile, "go\n");

				await waitFor(
					() => subagentResults(readEntries(s.parentSession)).length > 0,
					"cancelled worktree result",
				);
				await sleep(8_000);
				const final = readEntries(s.parentSession);
				evidence("c: parent session entries", JSON.stringify(final, null, 2));
				evidence(
					"c: provider requests",
					JSON.stringify(getProviderRequests(), null, 2),
				);

				const results = subagentResults(final);
				assert.equal(results.length, 1);
				const result = results[0];
				assert.equal(result.details.error, "cancelled");
				assert.equal(result.details.cancellation.termination, "confirmed");
				const handoff = result.details.worktree;
				assert.ok(handoff, "handoff present");
				assert.equal(handoff.branch, branch);
				assert.equal(handoff.headSha, headBefore);
				assert.equal(handoff.commitsAhead, 1);
				assert.match(result.content, /worktree/i);
				const tools = cancelToolResults(final);
				assert.equal(tools[0].message.details.status, "confirmed");
				assert.match(JSON.stringify(tools[0].message.content), /retained/);
				noFallbackRequests();

				// Retained: workspace, root pane, checkout, commit, branch.
				assert.ok(
					workspaceIds().includes(workspaceToRemove),
					"workspace retained",
				);
				const wtPanesAfter = workspacePanes(workspaceToRemove);
				assert.deepEqual(
					wtPanesAfter.sort(),
					wtPanesBefore.sort(),
					"root pane retained",
				);
				assert.equal(existsSync(worktree.path), true, "checkout retained");
				assert.equal(
					existsSync(join(worktree.path, `ticket-${s.id}.txt`)),
					true,
				);
				assert.equal(
					execFileSync("git", ["rev-parse", branch], {
						cwd: env.dir,
						encoding: "utf8",
					}).trim(),
					headBefore,
				);
				assert.match(
					execFileSync("git", ["log", "--format=%s", branch], {
						cwd: env.dir,
						encoding: "utf8",
					}),
					new RegExp(`Cancel ${s.id}`),
				);
				// Weak check only: Pi rewrites its process title, so its argv no
				// longer names the session and this count is 0 even while it runs.
				// Exit evidence is the runtime's identity-based confirmation above.
				// The sleep may linger.
				// SAFETY: a delivered subagent_result always records its session file.
				const childSession = result.details.sessionFile as string;
				assert.equal(
					pgrepCount(childSession),
					0,
					"child pi process terminated",
				);
				evidence(
					"c: leftover sleep processes",
					JSON.stringify(pgrepCount(`sleep ${s.sleepToken}`), null, 2),
				);
				evidence("c: worktree pane screen", readPane(wtPanesAfter[0], 80));

				// Manifest says cancelled.
				const manifestFile = readdirSync(env.dir, {
					recursive: true,
					encoding: "utf8",
				}).find((f) => f.includes("worktree-runs/") && f.endsWith(".json"));
				assert.ok(manifestFile, "manifest present");
				const manifest = JSON.parse(
					readFileSync(join(env.dir, manifestFile), "utf8"),
				);
				evidence("c: manifest", JSON.stringify(manifest, null, 2));
				assert.equal(manifest.state, "cancelled");
				assert.equal(manifest.branch, branch);
				assert.equal(manifest.workspaceId, workspaceToRemove);
				unrelatedUntouched(s);
			} finally {
				if (workspaceToRemove) {
					try {
						execFileSync("herdr", [
							"worktree",
							"remove",
							"--workspace",
							workspaceToRemove,
							"--force",
							"--json",
						]);
					} catch {
						// best effort
					}
				}
				try {
					execFileSync("git", ["branch", "-D", branch], {
						cwd: env.dir,
						stdio: "ignore",
					});
				} catch {
					// best effort
				}
			}
		});

		// (d) persistent specialist rejected
		it("(d) rejects cancel of a persistent specialist and points to subagent_stop", async () => {
			const s = await launch("persistent");
			const childPanes = await waitRunning(s);
			writeFileSync(s.gateFile, "go\n");
			const entries = await waitFor(() => {
				const e = cancelToolResults(readEntries(s.parentSession));
				return e.length > 0 ? readEntries(s.parentSession) : undefined;
			}, "cancel tool result");
			await sleep(5_000);
			const final = readEntries(s.parentSession);
			evidence("d: parent session entries", JSON.stringify(final, null, 2));
			const tool = cancelToolResults(final)[0].message;
			assert.match(JSON.stringify(tool.content), /persistent specialist/);
			assert.match(JSON.stringify(tool.content), /subagent_stop/);
			assert.match(tool.details.error, /subagent_stop/);
			assert.equal(tool.details.status, undefined);
			assert.equal(
				subagentResults(final).length,
				0,
				"no cancelled result delivered",
			);
			noFallbackRequests();
			for (const pane of childPanes)
				assert.equal(paneExists(pane), true, "persistent child pane untouched");
			assert.equal(existsSync(`${s.startFile}.done`), false, "still running");
			void entries;
			unrelatedUntouched(s);
		});

		// (e) double cancel idempotent
		it("(e) double cancel is idempotent: one result, no error, no fallback", async () => {
			const s = await launch("double");
			const childPanes = await waitRunning(s);
			// The run id is only visible in the launch tool result details.
			const launched = await waitFor(
				() => launchResult(readEntries(s.parentSession)),
				"launch result",
			);
			writeFileSync(s.idFile, `${launched.message.details.id}\n`);
			writeFileSync(s.gateFile, "go\n");
			await waitFor(
				() => cancelToolResults(readEntries(s.parentSession)).length >= 4,
				"four cancel tool results",
			);
			await sleep(8_000);
			const final = readEntries(s.parentSession);
			evidence("e: parent session entries", JSON.stringify(final, null, 2));
			evidence(
				"e: provider requests",
				JSON.stringify(getProviderRequests(), null, 2),
			);
			const tools = cancelToolResults(final).map((e) => ({
				status: e.message.details.status,
				repeated: e.message.details.repeated,
				error: e.message.details.error,
				text: e.message.content,
			}));
			evidence("e: cancel tool outcomes", JSON.stringify(tools, null, 2));
			assert.equal(
				subagentResults(final).length,
				1,
				"exactly one subagent_result",
			);
			assert.equal(subagentResults(final)[0].details.error, "cancelled");
			assert.equal(tools.length, 4);
			for (const t of tools.slice(0, 2))
				assert.equal(
					t.status,
					"confirmed",
					"parallel pair both report confirmed",
				);
			noFallbackRequests();
			for (const pane of childPanes) assert.equal(paneExists(pane), false);
			unrelatedUntouched(s);
		});
	});
}
