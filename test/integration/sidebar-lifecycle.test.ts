/**
 * Real parent and child Pi sessions with sidebar markers on: delegated
 * children's panes carry the marker while their processes run, the parent's
 * pane never does, and the retained worktree root loses it once its child
 * exits, and turning the setting off then reloading the parent clears them.
 * Run inside an isolated Herdr server, like the rest of this suite.
 *
 * The fixture finds its children by launch record and process identity, never
 * by marker, and cleans up only the worktree its own records and Herdr's
 * inventory of its own repository agree on. Panes it did not create, marked
 * or not, are never asserted on or removed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	getAvailableBackends,
	createTestEnv,
	cleanupTestEnv,
	createTrackedSurface,
	waitForPaneReady,
	startPi,
	waitForFile,
	uniqueId,
	trackTempFile,
	PI_TIMEOUT,
	USE_TEST_PROVIDER,
	sleep,
	shellQuote,
	readPane,
	runInPane,
	waitForScreen,
	type TestEnv,
} from "./harness.ts";
import {
	acquireCanary,
	findCanaryWorktree,
	findOwnedWorktree,
	herdrCommands,
	holdCommand,
	initRepository,
	isHoldRunning,
	paneProcesses,
	planCanary,
	readPaneProcessInfo,
	quiescePane,
	readHold,
	readLaunchRecords,
	releaseCanary,
	removeOwnedWorktree,
	TOKEN,
	waitForHoldsToExit,
	type Canary,
	type CleanupReport,
	type ExpectedWorktree,
	type FixtureCommands,
	type PaneProcessScope,
} from "./sidebar-fixture.ts";
import { inspectPane } from "../../maestro/surfaces/herdr/terminal.ts";
import { requestHerdrSocket } from "../../maestro/surfaces/herdr/herdr-socket.ts";
import { DELEGATED_MARKER_SOURCE } from "../../maestro/runtime/delegated-marker.ts";
import { resetProviderRequests } from "./fake-provider.ts";
import { isRecord, isString } from "../../maestro/core/config/type-guards.ts";

interface ListedPane {
	pane: string;
	workspace: string;
	token?: string;
}

function listPanes(): ListedPane[] {
	const panes = JSON.parse(
		execFileSync("herdr", ["pane", "list"], { encoding: "utf8" }),
	).result.panes;
	assert.ok(Array.isArray(panes));
	return panes.flatMap((pane) => {
		if (!isRecord(pane) || !isString(pane.pane_id)) return [];
		const tokens = isRecord(pane.tokens) ? pane.tokens : {};
		const token = tokens[TOKEN];
		return [
			{
				pane: pane.pane_id,
				workspace: isString(pane.workspace_id) ? pane.workspace_id : "",
				token: isString(token) ? token : undefined,
			},
		];
	});
}

async function waitFor<T>(
	read: () => T | undefined,
	label: string,
	timeoutMs = PI_TIMEOUT,
	intervalMs = 250,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${label}`);
		await sleep(intervalMs);
	}
}

/** The pane's foreground Pi process with every given environment entry. */
function findForegroundPi(
	pane: string,
	...environment: string[]
): number | undefined {
	for (const entry of readPaneProcessInfo(pane)?.foreground_processes ?? []) {
		try {
			const environ = readFileSync(`/proc/${entry.pid}/environ`, "utf8").split(
				"\0",
			);
			if (environment.every((item) => environ.includes(item))) return entry.pid;
		} catch {
			// Exited between the listing and this read.
		}
	}
	return undefined;
}

function foregroundPi(pane: string, ...environment: string[]): number {
	const pid = findForegroundPi(pane, ...environment);
	if (pid === undefined)
		throw new Error(`no Pi process with ${environment.join(" ")} in ${pane}`);
	return pid;
}

/** The processes the fixture's own pane shell starts, for quiescing. */
function paneScope(pane: string): PaneProcessScope {
	const info = readPaneProcessInfo(pane);
	assert.ok(info, `no process info for ${pane}`);
	const scope = {
		pane,
		shellPid: info.shell_pid,
		socket: process.env.HERDR_SOCKET_PATH,
	};
	assert.ok(
		paneProcesses(scope).some(({ pid }) => pid === scope.shellPid),
		`the process scope of ${pane} must include its shell`,
	);
	return scope;
}

function subagentResults(sessionFile: string): number {
	if (!existsSync(sessionFile)) return 0;
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.filter((line) => {
			const entry = JSON.parse(line);
			return (
				entry.type === "custom_message" &&
				entry.customType === "subagent_result"
			);
		}).length;
}

/** What one fixture launch owns. Cleanup acts on nothing else. */
interface Launch {
	expected: ExpectedWorktree;
	scope: PaneProcessScope;
	gate: string;
	/** Each child's hold writes its PID here once it starts. */
	startFiles: string[];
	release: () => Promise<CleanupReport>;
}

interface LaunchOptions {
	/** How long the fixture's own children may take to show their markers. */
	markerTimeoutMs?: number;
	/** Fail as soon as the worktree launch record appears, mid-acquisition. */
	failOnLaunchRecord?: boolean;
	readParentScreen?: (pane: string) => string;
}

/** Every workspace on the server, by ID. */
function workspaceIds(): string[] {
	const workspaces = JSON.parse(herdrCommands.herdr(["workspace", "list"]))
		.result.workspaces;
	assert.ok(Array.isArray(workspaces));
	return workspaces.flatMap((workspace) =>
		isRecord(workspace) && isString(workspace.workspace_id)
			? [workspace.workspace_id]
			: [],
	);
}

const backends = getAvailableBackends();

for (const backend of backends) {
	describe(`sidebar markers [${backend}]`, {
		skip:
			process.platform !== "linux"
				? "sidebar markers are Linux-only"
				: USE_TEST_PROVIDER
					? false
					: "needs the deterministic provider",
		timeout: PI_TIMEOUT * 3,
	}, () => {
		let env: TestEnv;
		let launch: Launch | undefined;
		let canary: Canary | undefined;

		/** Users seed config.json from the example, then add the sidebar key. */
		function writeSidebarSetting(enabled: boolean) {
			const configDir = join(env.dir, ".pi", "agent", "herdr-agents");
			mkdirSync(configDir, { recursive: true });
			const example = JSON.parse(
				readFileSync(
					new URL("../../config.json.example", import.meta.url),
					"utf8",
				),
			);
			writeFileSync(
				join(configDir, "config.json"),
				JSON.stringify({ ...example, sidebar: { enabled } }),
			);
		}

		beforeEach(() => {
			env = createTestEnv(backend);
			launch = undefined;
			canary = undefined;
			resetProviderRequests();
			writeSidebarSetting(true);
		});

		afterEach(async () => {
			// The launch and the canary are released on this one path, whether
			// their setup, their test, or nothing failed.
			const residue = [
				...((await launch?.release())?.residue ?? []),
				...(canary ? releaseCanary(canary).residue : []),
			];
			if (residue.length === 0) {
				cleanupTestEnv(env);
				return;
			}
			// A residual worktree still points at its source repository, and the
			// launch records are the evidence: keep both, and say so.
			const restore = (name: string, value: string | undefined) => {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			};
			restore("HERDR_WORKSPACE_ID", env.previousWorkspaceId);
			restore("HERDR_PANE_ID", env.previousPaneId);
			restore("HERDR_TAB_ID", env.previousTabId);
			restore("PI_CODING_AGENT_DIR", env.previousAgentDir);
			throw new Error(
				`kept ${env.dir} and workspace ${env.workspaceId}; cleanup residue:\n${residue.join("\n")}`,
			);
		});

		/**
		 * Stops the parent's launch work first, so nothing it started can
		 * create a resource after the scan, then removes the one worktree its
		 * records and Herdr agree it owns. Never throws.
		 */
		async function releaseLaunch(
			owned: Omit<Launch, "release">,
		): Promise<CleanupReport> {
			const report: CleanupReport = { removed: [], residue: [] };
			try {
				const alive = await quiescePane(owned.scope);
				if (alive.length > 0)
					report.residue.push(
						`parent pane ${owned.scope.pane} processes still alive: ${alive.join(", ")}`,
					);
				writeFileSync(owned.gate, "go\n");
				// A killed child's hold is orphaned, and only the gate ends it, so
				// every hold must exit before afterEach deletes the gate. A hold
				// that starts after this read sees the gate on its first check.
				const holds = owned.startFiles.flatMap(
					(file) => readHold(file, owned.gate) ?? [],
				);
				for (const hold of await waitForHoldsToExit(holds))
					report.residue.push(
						`hold ${hold.pid} still running after its gate opened`,
					);
				const removal = removeOwnedWorktree(
					() => findOwnedWorktree(owned.expected, env.dir),
					owned.expected.repoRoot,
				);
				if (removal.kind === "residue") report.residue.push(removal.reason);
				if (removal.kind === "removed") report.removed.push(removal.path);
			} catch (error) {
				report.residue.push(
					`cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return report;
		}

		/** A parent that launches one ordinary and one worktree child, both held by a gate file. */
		async function launchHeldChildren(options: LaunchOptions = {}) {
			const {
				markerTimeoutMs = 30_000,
				failOnLaunchRecord = false,
				readParentScreen = (pane: string) => readPane(pane, 200),
			} = options;
			const id = uniqueId();
			const branch = `integration/sidebar-${id}`;
			const ordinaryName = `Sidebar-ordinary-${id}`;
			const worktreeName = `Sidebar-worktree-${id}`;
			const gate = `/tmp/pi-integ-sidebar-gate-${id}`;
			const startOrdinary = `/tmp/pi-integ-sidebar-ord-${id}.txt`;
			const startWorktree = `/tmp/pi-integ-sidebar-wt-${id}.txt`;
			for (const file of [gate, startOrdinary, startWorktree])
				trackTempFile(env, file);
			initRepository(env.dir);

			const parentSession = join(env.dir, `sidebar-parent-${id}.jsonl`);
			const parent = createTrackedSurface(env, `sidebar-parent-${id}`);
			await waitForPaneReady(parent);
			const owned = {
				expected: {
					repoRoot: realpathSync(env.dir),
					branch,
					name: worktreeName,
				},
				scope: paneScope(parent),
				gate,
				startFiles: [startOrdinary, startWorktree],
			};
			let released: Promise<CleanupReport> | undefined;
			const release = () => {
				released ??= releaseLaunch(owned);
				return released;
			};
			// Registered before the parent starts, so afterEach always releases it.
			launch = { ...owned, release };

			const hold = (marker: string, file: string) =>
				`Run: ${holdCommand(marker, file, gate)}`;
			startPi(
				parent,
				env.dir,
				[
					"Call the subagent tool with these EXACT parameters for each child:",
					`  name: "${ordinaryName}"`,
					`  agent: "test-echo"`,
					`  task: "${hold(`START_ORD_${id}`, startOrdinary)}"`,
					`  name: "${worktreeName}"`,
					`  agent: "test-echo"`,
					`  worktree: { branch: "${branch}" }`,
					`  task: "${hold(`START_WT_${id}`, startWorktree)}"`,
					`After both results arrive, say SIDEBAR_DONE_${id}.`,
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);
			try {
				if (failOnLaunchRecord) {
					const record = await waitFor(
						() => readLaunchRecords(env.dir)?.find((r) => r.branch === branch),
						"the worktree launch record",
						PI_TIMEOUT,
						25,
					);
					throw new Error(
						`injected failure with the worktree launch record ${record.state ?? "unknown"}`,
					);
				}
				await waitForFile(startOrdinary, PI_TIMEOUT, /START_ORD_/);
				await waitForFile(startWorktree, PI_TIMEOUT, /START_WT_/);
				const holds = {
					ordinary: readHold(startOrdinary, gate),
					worktree: readHold(startWorktree, gate),
				};
				// Each child is found by its launch and process identity, never by
				// a marker, and only in a workspace this fixture owns.
				const ordinary = await waitFor(
					() =>
						listPanes().find(
							(pane) =>
								pane.workspace === env.workspaceId &&
								findForegroundPi(
									pane.pane,
									`PI_SUBAGENT_NAME=${ordinaryName}`,
								) !== undefined,
						),
					"the ordinary child's pane",
					30_000,
				);
				const worktree = await waitFor(
					() => {
						const found = findOwnedWorktree(owned.expected, env.dir);
						if (found.kind !== "open") return undefined;
						const pane = listPanes().find(
							(entry) =>
								entry.pane === found.record.paneId &&
								entry.workspace === found.workspace,
						);
						return pane &&
							findForegroundPi(
								pane.pane,
								`PI_SUBAGENT_NAME=${worktreeName}`,
								`PI_SUBAGENT_ID=${found.record.id}`,
							) !== undefined
							? pane
							: undefined;
					},
					"the worktree child's pane",
					30_000,
				);
				// Markers appear once each child's process identity is verified.
				await waitFor(
					() => {
						const panes = listPanes();
						return [ordinary, worktree].every(
							(child) =>
								panes.find((pane) => pane.pane === child.pane)?.token ===
								"live",
						)
							? true
							: undefined;
					},
					"the fixture's child markers",
					markerTimeoutMs,
				);
				assert.equal(
					listPanes().find((pane) => pane.pane === parent)?.token,
					undefined,
					"the parent's pane is never marked",
				);
				const { ordinary: ordinaryHold, worktree: worktreeHold } = holds;
				assert.ok(ordinaryHold && worktreeHold, "both holds are running");
				return {
					id,
					gate,
					parent,
					parentSession,
					ordinary,
					worktree,
					holds: [ordinaryHold, worktreeHold],
					worktreeHold,
				};
			} catch (error) {
				let screen: string;
				try {
					screen = readParentScreen(parent);
				} catch (readError) {
					screen = `unavailable: ${readError instanceof Error ? readError.message : String(readError)}`;
				}
				const report = await release();
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\nParent screen:\n${screen}\nCleanup: ${JSON.stringify(report)}`,
				);
			}
		}

		/** Panes in the workspaces this launch owns; foreign panes never count. */
		function ownedPanes(worktreeWorkspace: string): ListedPane[] {
			return listPanes().filter(
				(pane) =>
					pane.workspace === env.workspaceId ||
					pane.workspace === worktreeWorkspace,
			);
		}

		it("marks ordinary and worktree children while they run and clears the retained root after exit", async () => {
			const run = await launchHeldChildren();
			// Renewal keeps both markers past one 15-second TTL while they run.
			await sleep(18_000);
			assert.deepEqual(
				ownedPanes(run.worktree.workspace)
					.filter((pane) => pane.token === "live")
					.map((pane) => pane.pane)
					.sort(),
				[run.ordinary.pane, run.worktree.pane].sort(),
			);

			writeFileSync(run.gate, "go\n");
			await waitFor(
				() => (subagentResults(run.parentSession) >= 2 ? true : undefined),
				"both child results",
			);
			// The worktree root pane is retained as a shell and loses its marker.
			const root = await waitFor(
				() => {
					const pane = listPanes().find(
						(entry) => entry.pane === run.worktree.pane,
					);
					return pane && pane.token === undefined ? pane : undefined;
				},
				"cleared retained worktree root",
				20_000,
			);
			assert.equal(root.workspace, run.worktree.workspace);
			assert.deepEqual(
				ownedPanes(run.worktree.workspace).filter(
					(pane) => pane.token !== undefined,
				),
				[],
			);
		});

		it("clears running children's markers at once when the setting is turned off and the parent reloads", async () => {
			const run = await launchHeldChildren();
			const deadline = Date.now() + PI_TIMEOUT;
			for (;;) {
				const pane = await inspectPane(run.parent);
				if (pane.kind === "present" && pane.agentStatus === "idle") break;
				if (Date.now() > deadline)
					throw new Error("timed out waiting for an idle parent");
				await sleep(250);
			}
			writeSidebarSetting(false);
			const reloadAt = Date.now();
			runInPane(run.parent, "/reload");
			await waitForScreen(run.parent, /Reloaded keybindings/, PI_TIMEOUT);
			// Expiry needs 15s after the last renewal, at most ~5s before the
			// reload; clearing well inside that shows retirement, not the TTL.
			await waitFor(
				() =>
					ownedPanes(run.worktree.workspace).some(
						(pane) => pane.token !== undefined,
					)
						? undefined
						: true,
				"cleared markers after the reload",
				8_000,
			);
			const cleared = Date.now() - reloadAt;
			await sleep(18_000);
			for (const [pane, name] of [
				[run.ordinary.pane, `Sidebar-ordinary-${run.id}`],
				[run.worktree.pane, `Sidebar-worktree-${run.id}`],
			])
				foregroundPi(pane, `PI_SUBAGENT_NAME=${name}`);
			assert.deepEqual(
				ownedPanes(run.worktree.workspace).filter(
					(pane) => pane.token !== undefined,
				),
				[],
				`markers cleared ${cleared}ms after /reload, then stayed clear`,
			);
		});

		it("clears a killed child's marker, and a crashed parent's markers only expire", async (t) => {
			const run = await launchHeldChildren();
			const child = foregroundPi(
				run.worktree.pane,
				`PI_SUBAGENT_NAME=Sidebar-worktree-${run.id}`,
			);
			process.kill(child, "SIGKILL");
			await waitFor(
				() =>
					listPanes().find((pane) => pane.pane === run.worktree.pane)?.token ===
					undefined
						? true
						: undefined,
				"cleared marker after the child was killed",
				20_000,
			);
			assert.equal(
				listPanes().find((pane) => pane.pane === run.ordinary.pane)?.token,
				"live",
			);

			const parentPi = foregroundPi(
				run.parent,
				`PI_CODING_AGENT_DIR=${join(env.dir, ".pi", "agent")}`,
			);
			process.kill(parentPi, "SIGKILL");
			const killedAt = Date.now();
			await waitFor(
				() =>
					listPanes().find((pane) => pane.pane === run.ordinary.pane)?.token ===
					undefined
						? true
						: undefined,
				"expired marker after the parent was killed",
				25_000,
			);
			const elapsed = Date.now() - killedAt;
			assert.ok(
				elapsed >= 5_000 && elapsed <= 20_000,
				`marker expired ${elapsed}ms after the parent died`,
			);

			assert.ok(isHoldRunning(run.worktreeHold), "the orphaned hold runs");
			assert.ok(launch);
			const report = await launch.release();
			t.diagnostic(`cleanup ${JSON.stringify(report)}`);
			assert.deepEqual(report.residue, []);
			assert.deepEqual(run.holds.filter(isHoldRunning), []);
		});

		it("never touches a foreign marked worktree, and removes its own when its worktree marker never appears", async (t) => {
			// Registered before it acquires anything, so afterEach releases it.
			canary = planCanary(uniqueId());
			const foreign = await acquireCanary(canary, {
				socket: process.env.HERDR_SOCKET_PATH,
			});
			// The host's own source with the highest sequence rejects every later
			// write, so the fixture's worktree child is never marked while its
			// ordinary child is: the trigger the old global count misread.
			let blocked: string | undefined;
			let ordinaryMarked = false;
			const socket = process.env.HERDR_SOCKET_PATH ?? "";
			const barrier = setInterval(() => {
				ordinaryMarked ||= listPanes().some(
					(pane) => pane.workspace === env.workspaceId && pane.token === "live",
				);
				if (blocked || !launch) return;
				const branch = launch.expected.branch;
				const pane = readLaunchRecords(env.dir)?.find(
					(record) => record.branch === branch,
				)?.paneId;
				if (!pane) return;
				blocked = pane;
				void requestHerdrSocket(socket, "pane.report_metadata", {
					pane_id: pane,
					source: DELEGATED_MARKER_SOURCE,
					seq: Number.MAX_SAFE_INTEGER,
					tokens: { [TOKEN]: null },
				});
			}, 25);
			try {
				await assert.rejects(
					launchHeldChildren({ markerTimeoutMs: 8_000 }),
					/timed out waiting for the fixture's child markers/,
				);
				clearInterval(barrier);
				assert.ok(blocked, "the barrier found the worktree child's pane");
				assert.ok(ordinaryMarked, "the ordinary child was marked");
				assert.ok(launch);
				const report = await launch.release();
				t.diagnostic(`cleanup ${JSON.stringify(report)}`);
				assert.deepEqual(report.residue, []);
				assert.equal(report.removed.length, 1, "its own worktree existed");
				assert.deepEqual(findOwnedWorktree(launch.expected, env.dir), {
					kind: "absent",
				});
				assert.deepEqual(paneProcesses(launch.scope), []);

				const still = findCanaryWorktree(canary);
				assert.ok(
					still.kind === "open" && still.workspace === foreign.workspace,
					`the foreign worktree remains open: ${JSON.stringify(still)}`,
				);
				assert.ok(existsSync(foreign.path), "the foreign checkout remains");
				assert.equal(
					listPanes().find((pane) => pane.pane === foreign.pane)?.token,
					"live",
					"the foreign pane keeps its marker",
				);
			} finally {
				clearInterval(barrier);
			}
		});

		it("keeps a canary whose worktree it cannot verify, and removes it once its closed checkout is verified", async () => {
			canary = planCanary(uniqueId());
			const foreign = await acquireCanary(canary, {
				socket: process.env.HERDR_SOCKET_PATH,
			});
			herdrCommands.herdr(["workspace", "close", foreign.workspace]);
			assert.equal(findCanaryWorktree(canary).kind, "checkout");

			const unreadable: FixtureCommands = {
				...herdrCommands,
				herdr: (args) => {
					if (args[0] === "worktree" && args[1] === "list")
						throw new Error("inventory unavailable");
					return herdrCommands.herdr(args);
				},
			};
			const kept = releaseCanary(canary, unreadable);
			assert.deepEqual(kept.removed, []);
			assert.match(kept.residue.join("\n"), /unreadable Herdr worktree/);
			assert.ok(existsSync(foreign.path), "the checkout remains");
			assert.ok(existsSync(foreign.repo), "its source repository remains");
			assert.ok(workspaceIds().includes(foreign.source));

			const report = releaseCanary(canary);
			assert.deepEqual(report, {
				removed: [foreign.path, foreign.repo],
				residue: [],
			});
			assert.ok(!existsSync(foreign.path));
			assert.ok(!existsSync(foreign.repo));
			assert.ok(!workspaceIds().includes(foreign.source));
		});

		it("releases everything a canary acquired when Herdr refuses its marker", async () => {
			canary = planCanary(uniqueId());
			const refused: FixtureCommands = {
				...herdrCommands,
				reportMetadata: (socket, params) =>
					herdrCommands.reportMetadata(socket, {
						...params,
						pane_id: "w999999:p1",
					}),
			};
			await assert.rejects(
				acquireCanary(canary, {
					socket: process.env.HERDR_SOCKET_PATH,
					commands: refused,
				}),
				/marking .+ failed: \{"kind":"error"/,
			);
			const stage = canary.stage;
			assert.equal(stage.kind, "worktree");
			const { repo, source, record } = stage;
			assert.ok(record.path && record.workspaceId);
			assert.ok(existsSync(record.path), "the worktree was created");
			assert.ok(workspaceIds().includes(record.workspaceId));

			const report = releaseCanary(canary);
			assert.deepEqual(report, { removed: [record.path, repo], residue: [] });
			assert.ok(!existsSync(record.path));
			assert.ok(!existsSync(repo));
			const open = workspaceIds();
			assert.ok(!open.includes(source) && !open.includes(record.workspaceId));
		});

		it("quiesces a launch that fails mid-acquisition and cleans up even when diagnostics fail", async (t) => {
			let reads = 0;
			const failure = await launchHeldChildren({
				failOnLaunchRecord: true,
				readParentScreen: () => {
					reads++;
					throw new Error("pane read failed");
				},
			}).then(
				() => "",
				(error: Error) => error.message,
			);
			t.diagnostic(failure.split("\n")[0]);
			assert.match(
				failure,
				/^injected failure with the worktree launch record/,
			);
			assert.match(failure, /Parent screen:\nunavailable: pane read failed/);
			assert.equal(reads, 1);
			assert.ok(launch);
			const report = await launch.release();
			t.diagnostic(`cleanup ${JSON.stringify(report)}`);
			assert.deepEqual(report.residue, []);
			assert.deepEqual(paneProcesses(launch.scope), []);
			await sleep(3_000);
			assert.deepEqual(findOwnedWorktree(launch.expected, env.dir), {
				kind: "absent",
			});
			const records = readLaunchRecords(env.dir) ?? [];
			assert.equal(records.length, 1, "the launch recorded its worktree");
		});
	});
}
