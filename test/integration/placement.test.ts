import {
	getSubagentsConfigDir,
	getSubagentsConfigExamplePath,
} from "../../pi-extension/subagents/config-path.ts";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	launchPiSubagent as launchWithOperations,
	launchOperationsFromSurface,
	type FreshPiLaunchRequest,
	type PiLaunchRequest,
	type PiLaunchOperations,
} from "../../maestro/adapters/pi/launch.ts";
import {
	readWorktreeManifest,
	createWorktreeOperations,
} from "../../maestro/runtime/worktree-operations.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";

function launchPiSubagent(
	request: PiLaunchRequest,
	operations?: PiLaunchOperations,
) {
	const config = loadPaneConfig(
		getSubagentsConfigDir(),
		getSubagentsConfigExamplePath(),
	);
	return launchWithOperations(
		request,
		operations ??
			launchOperationsFromSurface(
				new HerdrSurfaceProvider({ paneConfig: config }),
				config,
				createWorktreeOperations(),
			),
	);
}
import {
	closePane,
	createSubagentPane,
	splitCurrentPane,
	createGroupedSubagentPane,
	createSubagentWorktree,
	waitForShellReady,
	runScriptInPane,
	shellQuote,
} from "../../maestro/surfaces/herdr/terminal.ts";
import {
	createSubagentPaneFactory,
	loadPaneConfig,
} from "../../maestro/core/config/pane-config.ts";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
import { isNonEmptyString } from "../../maestro/core/config/type-guards.ts";
import {
	createEventBus,
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	createTestEnv,
	cleanupTestEnv,
	getAvailableBackends,
	getFocusedSurface,
	sleep,
	uniqueId,
	waitForFile,
	PI_TIMEOUT,
	TEST_MODEL,
	type TestEnv,
} from "./harness.ts";

function panes(
	workspaceId: string,
): Array<{ pane_id: string; tab_id: string; cwd: string }> {
	return JSON.parse(
		execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], {
			encoding: "utf8",
		}),
	).result.panes;
}

type LifecycleEvent = { reason?: "quit" };

/**
 * Mirrors Pi's extension lifecycle registry: each `on` call appends a handler,
 * and an emit awaits every handler in registration order. A single-valued map
 * would let a later `session_shutdown` registration replace host shutdown.
 */
function createLifecycleHandlers<Context>() {
	const registered = new Map<string, Function[]>();
	return {
		on(name: string, handler: Function) {
			registered.set(name, [...(registered.get(name) ?? []), handler]);
			return () =>
				registered.set(
					name,
					(registered.get(name) ?? []).filter((entry) => entry !== handler),
				);
		},
		// Like Pi, a failing handler does not skip later ones; unlike Pi, the
		// fixture surfaces those failures instead of reporting and continuing.
		async emit(name: string, event: LifecycleEvent, ctx: Context) {
			const errors: unknown[] = [];
			for (const handler of registered.get(name) ?? []) {
				try {
					await handler(event, ctx);
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 0)
				throw new AggregateError(errors, `${name} handler failed`);
		},
	};
}

const PLACEMENT_TEST_COUNT = 14;
const PLACEMENT_SUITE_TIMEOUT = PLACEMENT_TEST_COUNT * 30_000;

for (const backend of getAvailableBackends()) {
	describe("grouped public launch placement", {
		timeout: Math.max(PI_TIMEOUT, PLACEMENT_SUITE_TIMEOUT),
	}, () => {
		let env: TestEnv;
		beforeEach(() => {
			env = createTestEnv(backend);
		});
		afterEach(() => {
			cleanupTestEnv(env);
		});

		function request(index: number): FreshPiLaunchRequest {
			const sessionFile = join(env.dir, "parent.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "parent",
					cwd: env.dir,
				}) + "\n",
			);
			return {
				kind: "fresh",
				name: `placement-${index}`,
				task: "Reply with only PLACEMENT_COMPLETE.",
				parent: {
					cwd: env.dir,
					sessionFile,
					sessionId: "parent",
					sessionDir: env.dir,
				},
				runtimePlan: {
					provider: "pi-integration",
					modelId: "test",
					model: TEST_MODEL,
					thinking: "off",
					modelSource: "request",
					thinkingSource: "request",
				},
				behavior: {
					tools: "read",
					deniedTools: ["subagent"],
					autoExit: true,
					interactive: false,
					sessionMode: "standalone",
				},
			};
		}

		it("places an unmatched child in the live caller workspace after its parent pane moves", async () => {
			const identities = (workspaceId: string) =>
				panes(workspaceId).map(({ pane_id, tab_id, cwd }) => ({
					pane_id,
					tab_id,
					cwd,
				}));
			const sourceBaseline = identities(env.workspaceId);
			const destination = createTestEnv(backend);
			try {
				const focus = getFocusedSurface(backend);
				const destinationBaseline = identities(destination.workspaceId);
				const parent = JSON.parse(
					execFileSync(
						"herdr",
						[
							"tab",
							"create",
							"--workspace",
							env.workspaceId,
							"--cwd",
							env.dir,
							"--label",
							"moved-parent",
							"--no-focus",
						],
						{ encoding: "utf8" },
					),
				).result.root_pane;
				const script = join(env.dir, "moved-parent.mjs");
				const report = join(env.dir, "moved-parent.json");
				const launchUrl = new URL(
					"../../maestro/adapters/pi/launch.ts",
					import.meta.url,
				).href;
				// Execute inside the original terminal: do not manufacture inherited
				// Herdr identity in the runner. The same process moves, then launches.
				writeFileSync(
					script,
					`
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchPiSubagent, launchOperationsFromSurface } from ${JSON.stringify(launchUrl)};
import { HerdrSurfaceProvider } from ${JSON.stringify(new URL("../../maestro/surfaces/herdr/herdr-surface-provider.ts", import.meta.url).href)};
import { loadPaneConfig } from ${JSON.stringify(new URL("../../maestro/core/config/pane-config.ts", import.meta.url).href)};
import { getSubagentsConfigDir, getSubagentsConfigExamplePath } from ${JSON.stringify(new URL("../../pi-extension/subagents/config-path.ts", import.meta.url).href)};
const cli = (...args) => JSON.parse(execFileSync("herdr", args, { encoding: "utf8" })).result;
const result = {};
try {
  result.inherited = { pane_id: process.env.HERDR_PANE_ID, tab_id: process.env.HERDR_TAB_ID, workspace_id: process.env.HERDR_WORKSPACE_ID };
  result.before = cli("pane", "current", "--current").pane;
  result.move = cli("pane", "move", result.before.pane_id, "--new-tab", "--workspace", ${JSON.stringify(destination.workspaceId)}, "--no-focus").move_result;
  result.after = cli("pane", "current", "--current").pane;
  const config = loadPaneConfig(getSubagentsConfigDir(), getSubagentsConfigExamplePath());
  result.child = await launchPiSubagent(${JSON.stringify(request(1))}, launchOperationsFromSurface(new HerdrSurfaceProvider({ paneConfig: config }), config));
} catch (error) {
  result.error = String(error.stack ?? error);
}
writeFileSync(${JSON.stringify(report)}, JSON.stringify(result));
`,
				);
				await waitForShellReady(parent.pane_id);
				runScriptInPane(
					parent.pane_id,
					`PI_CODING_AGENT_DIR=${shellQuote(join(env.dir, ".pi", "agent"))} ${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(script)}`,
					{ scriptPath: join(env.dir, "moved-parent.sh") },
				);
				const result = JSON.parse(await waitForFile(report, 60_000));
				console.log("native moved-parent evidence", JSON.stringify(result));
				assert.equal(result.error, undefined);
				assert.equal(result.inherited.pane_id, parent.pane_id);
				assert.equal(result.inherited.workspace_id, env.workspaceId);
				assert.equal(result.before.pane_id, parent.pane_id);
				assert.equal(result.after.workspace_id, destination.workspaceId);
				assert.equal(result.after.pane_id, result.move.pane.pane_id);
				assert.equal(result.after.terminal_id, result.before.terminal_id);
				assert.notEqual(result.after.pane_id, result.inherited.pane_id);
				assert.notEqual(result.after.tab_id, result.inherited.tab_id);
				assert.equal(getFocusedSurface(backend), focus);
				assert.ok(
					panes(destination.workspaceId).some(
						(pane) =>
							pane.pane_id === result.child.surface &&
							pane.cwd === realpathSync(env.dir),
					),
					"unmatched non-Git cwd must use the parent's live workspace, not inherited workspace",
				);
				await waitForFile(`${result.child.sessionFile}.exit`, 60_000);
				closePane(result.child.surface);
				closePane(result.after.pane_id);
				assert.deepEqual(identities(env.workspaceId), sourceBaseline);
				assert.deepEqual(
					identities(destination.workspaceId),
					destinationBaseline,
				);
				assert.equal(getFocusedSurface(backend), focus);
			} finally {
				cleanupTestEnv(destination);
			}
		});

		it("fills four panes before overflow, counts user panes, and reuses their tab after all children close", async () => {
			const focus = getFocusedSurface(backend);
			const baseline = panes(env.workspaceId);
			const userTab = JSON.parse(
				execFileSync(
					"herdr",
					[
						"tab",
						"create",
						"--workspace",
						env.workspaceId,
						"--cwd",
						env.dir,
						"--label",
						"Agents",
						"--no-focus",
					],
					{ encoding: "utf8" },
				),
			).result;
			const children = await Promise.all(
				Array.from({ length: 5 }, (_, index) =>
					launchPiSubagent(request(index)),
				),
			);
			const snapshot = panes(env.workspaceId);
			const childTabs = children.map(
				(child) =>
					snapshot.find((pane) => pane.pane_id === child.surface)!.tab_id,
			);
			assert.equal(new Set(childTabs.slice(0, 4)).size, 1);
			assert.notEqual(childTabs[4], childTabs[0]);
			assert.notEqual(
				childTabs[0],
				userTab.tab.tab_id,
				"a matching display label never grants ownership",
			);
			assert.equal(getFocusedSurface(backend), focus);

			closePane(children[0].surface);
			const userPane = JSON.parse(
				execFileSync(
					"herdr",
					[
						"pane",
						"split",
						children[1].surface,
						"--direction",
						"down",
						"--cwd",
						env.dir,
						"--no-focus",
					],
					{ encoding: "utf8" },
				),
			).result.pane.pane_id;
			const sixth = await launchPiSubagent(request(6));
			assert.equal(
				panes(env.workspaceId).find((pane) => pane.pane_id === sixth.surface)!
					.tab_id,
				childTabs[4],
				"actual user panes consume capacity",
			);
			for (const child of [...children.slice(1), sixth])
				closePane(child.surface);
			const remaining = panes(env.workspaceId);
			assert.deepEqual(
				new Set(remaining.map((pane) => pane.pane_id)),
				new Set([
					...baseline.map((pane) => pane.pane_id),
					userTab.root_pane.pane_id,
					userPane,
				]),
			);
			const tabs = JSON.parse(
				execFileSync("herdr", ["tab", "list", "--workspace", env.workspaceId], {
					encoding: "utf8",
				}),
			).result.tabs;
			assert.equal(
				tabs.some((tab: { tab_id: string }) => tab.tab_id === childTabs[4]),
				false,
				"empty owned tab disappears",
			);
			const next = await launchPiSubagent(request(7));
			assert.equal(
				panes(env.workspaceId).find((pane) => pane.pane_id === next.surface)
					?.tab_id,
				childTabs[0],
				"the ID-owned Agents tab remains reusable with only a user pane",
			);
			closePane(next.surface);
			assert.deepEqual(
				new Set(panes(env.workspaceId).map((pane) => pane.pane_id)),
				new Set(remaining.map((pane) => pane.pane_id)),
				"cleanup preserves the user's existing shell identity",
			);
		});

		it("respects configured capacity during overlapping launches and rolls back only a failed child", async () => {
			const configDir = join(env.dir, "placement-config");
			mkdirSync(configDir);
			const configPath = join(configDir, "config.json");
			writeFileSync(configPath, JSON.stringify({ panes: { maxPerTab: 2 } }));
			const operations = {
				createPane: createSubagentPaneFactory(
					loadPaneConfig(configDir, getSubagentsConfigExamplePath()),
					createSubagentPane,
					splitCurrentPane,
					createGroupedSubagentPane,
				),
				createWorktree: createSubagentWorktree,
				waitForShellReady,
				runScript: runScriptInPane,
				closePane,
			};
			const children = await Promise.all(
				Array.from({ length: 5 }, (_, index) =>
					launchPiSubagent(request(index), operations),
				),
			);
			const snapshot = panes(env.workspaceId);
			const counts = new Map<string, number>();
			for (const child of children) {
				const tab = snapshot.find(
					(pane) => pane.pane_id === child.surface,
				)!.tab_id;
				counts.set(tab, (counts.get(tab) ?? 0) + 1);
			}
			assert.deepEqual([...counts.values()], [2, 2, 1]);
			await assert.rejects(
				launchPiSubagent(request(6), {
					...operations,
					runScript: () => {
						throw new Error("injected command delivery failure");
					},
				}),
				/injected command delivery failure/,
			);
			assert.deepEqual(
				panes(env.workspaceId).map((pane) => pane.pane_id),
				snapshot.map((pane) => pane.pane_id),
			);
		});

		for (const scenario of [
			{
				name: "ordinary",
				task: "Return exactly DELIVERED",
				model: TEST_MODEL,
				type: "subagent_result",
			},
			{
				name: "rejected delivery",
				task: "Return exactly DELIVERED",
				model: TEST_MODEL,
				type: "subagent_result",
			},
			{
				name: "help",
				task: "ONLY call caller_ping",
				model: TEST_MODEL,
				type: "subagent_ping",
			},
			{
				name: "provider error",
				task: "Return exactly DELIVERED",
				model: "pi-integration/account-rejected",
				type: "subagent_result",
			},
			{
				name: "fallback",
				task: "Return exactly DELIVERED",
				model:
					"pi-integration/fallback-primary,pi-integration/fallback-secondary",
				type: "subagent_result",
			},
			{
				name: "fallback rejected delivery",
				task: "Return exactly DELIVERED",
				model:
					"pi-integration/fallback-primary,pi-integration/fallback-secondary",
				type: "subagent_result",
			},
		])
			it(`${scenario.name}: closes panes only after accepted delivery`, async () => {
				const previousId = process.env.PI_SUBAGENT_ID;
				delete process.env.PI_SUBAGENT_ID;
				const tools = new Map<string, any>();
				const lifecycle = createLifecycleHandlers<typeof ctx>();
				const deliveries: Array<{
					type: string;
					panes: string[];
					details: any;
				}> = [];
				const api: Partial<ExtensionAPI> = {
					events: createEventBus(),
					on: lifecycle.on,
					registerTool: (tool: any) => tools.set(tool.name, tool),
					registerCommand() {},
					registerShortcut() {},
					registerMessageRenderer() {},
					getThinkingLevel: () => "off",
					getAllTools: () => [],
					sendMessage: (message: { customType: string; details?: any }) => {
						deliveries.push({
							type: message.customType,
							panes: panes(env.workspaceId).map((pane) => pane.pane_id),
							details: message.details,
						});
						if (
							scenario.name === "rejected delivery" ||
							(scenario.name === "fallback rejected delivery" &&
								deliveries.length === 1)
						)
							throw new Error("injected parent delivery failure");
					},
				};
				const sessionManager = SessionManager.create(env.dir, env.dir);
				sessionManager.appendMessage({
					role: "user",
					content: "fixture",
					timestamp: Date.now(),
				});
				const model = {
					provider: "pi-integration",
					id: "test",
					reasoning: true,
				};
				// SAFETY: no UI methods are used by this headless public-tool host.
				const ctx = {
					cwd: env.dir,
					hasUI: false,
					sessionManager,
					model,
					modelRegistry: {
						find: (provider: string, id: string) => ({
							...model,
							provider,
							id,
						}),
						getAvailable: () => [model],
						hasConfiguredAuth: () => true,
					},
				};
				try {
					// SAFETY: this host implements the public SDK methods exercised by these tools.
					subagentsExtension(api as ExtensionAPI);
					await lifecycle.emit("session_start", {}, ctx);
					const baseline = new Set(
						panes(env.workspaceId).map((pane) => pane.pane_id),
					);
					const started = await tools.get("subagent").execute(
						"call",
						{
							name: "delivery-order",
							task: scenario.task,
							model: scenario.model,
							tools: "read",
						},
						undefined,
						undefined,
						ctx,
					);
					const child = panes(env.workspaceId).find(
						(pane) => !baseline.has(pane.pane_id),
					);
					assert.ok(child);
					const deadline = Date.now() + 60_000;
					while (
						!deliveries.some((entry) => entry.type === scenario.type) &&
						Date.now() < deadline
					)
						await sleep(50);
					const delivery = deliveries.find(
						(entry) => entry.type === scenario.type,
					);
					assert.ok(delivery, "result must reach the parent");
					assert.ok(
						delivery.panes.includes(child.pane_id),
						"the owned pane must exist at parent result delivery",
					);
					if (scenario.name === "fallback rejected delivery") {
						assert.equal(delivery.details.exitCode, 0);
						assert.notEqual(
							delivery.details.sessionFile,
							started.details.sessionFile,
							"the rejected result belongs to the successful fallback session",
						);
						assert.deepEqual(delivery.details.fallbackAttempts, [
							"pi-integration/fallback-primary",
							"pi-integration/fallback-secondary",
						]);
						assert.match(
							delivery.details.fallbackFailures[0].error,
							/deterministic fallback provider failure/,
						);
						assert.equal(
							deliveries.length,
							1,
							"rejected fallback delivery must not send an error for the first attempt",
						);
						assert.equal(delivery.panes.length, baseline.size + 2);
						assert.deepEqual(
							panes(env.workspaceId).map((pane) => pane.pane_id),
							delivery.panes,
							"both attempt panes must remain until explicit cleanup",
						);
						return;
					}
					if (scenario.name === "rejected delivery") {
						assert.ok(
							panes(env.workspaceId).some(
								(pane) => pane.pane_id === child.pane_id,
							),
							"failed delivery must retain the pane for inspection",
						);
						return;
					}
					while (
						panes(env.workspaceId).some(
							(pane) => pane.pane_id === child.pane_id,
						) &&
						Date.now() < deadline
					)
						await sleep(50);
					assert.deepEqual(
						new Set(panes(env.workspaceId).map((pane) => pane.pane_id)),
						baseline,
					);
					if (scenario.name === "ordinary") {
						deliveries.length = 0;
						await tools.get("subagent_resume").execute(
							"resume",
							{
								sessionPath: started.details.sessionFile,
								name: "resume-order",
								message: "Return exactly RESUMED",
							},
							undefined,
							undefined,
							ctx,
						);
						const resumed = panes(env.workspaceId).find(
							(pane) => !baseline.has(pane.pane_id),
						)!;
						while (
							!deliveries.some((entry) => entry.type === "subagent_result") &&
							Date.now() < deadline
						)
							await sleep(50);
						assert.ok(
							deliveries
								.find((entry) => entry.type === "subagent_result")
								?.panes.includes(resumed.pane_id),
						);
						while (
							panes(env.workspaceId).some(
								(pane) => pane.pane_id === resumed.pane_id,
							) &&
							Date.now() < deadline
						)
							await sleep(50);
						assert.deepEqual(
							new Set(panes(env.workspaceId).map((pane) => pane.pane_id)),
							baseline,
						);
					}
				} finally {
					await lifecycle.emit("session_shutdown", { reason: "quit" }, ctx);
					if (previousId === undefined) delete process.env.PI_SUBAGENT_ID;
					else process.env.PI_SUBAGENT_ID = previousId;
				}
			});

		for (const managed of [false, true])
			it(`parent quit after rejected persistent task delivery: ${managed ? "retains managed root" : "closes ordinary pane and process"}`, async () => {
				const previousId = process.env.PI_SUBAGENT_ID;
				delete process.env.PI_SUBAGENT_ID;
				const tools = new Map<string, any>();
				const lifecycle = createLifecycleHandlers<typeof ctx>();
				let childSurface: string;
				let childPid: number | undefined;
				let rejectedDeliveries = 0;
				let shutdown: Promise<void> | undefined;
				let worktree: { workspaceId: string; path: string } | undefined;
				const api: Partial<ExtensionAPI> = {
					events: createEventBus(),
					on: lifecycle.on,
					registerTool: (tool: any) => tools.set(tool.name, tool),
					registerCommand() {},
					registerShortcut() {},
					registerMessageRenderer() {},
					getThinkingLevel: () => "off",
					getAllTools: () => [],
					sendMessage: (message: { customType: string }) => {
						assert.equal(message.customType, "subagent_result");
						if (rejectedDeliveries++ === 0) {
							const info = JSON.parse(
								execFileSync(
									"herdr",
									["pane", "process-info", "--pane", childSurface],
									{
										encoding: "utf8",
									},
								),
							).result.process_info;
							childPid = info.foreground_processes.find(
								(child: { name: string }) => child.name === "pi",
							)?.pid;
							// Quit while a real task event remains undelivered. A later
							// drain would hit the same unavailable parent SDK binding.
							shutdown = lifecycle.emit(
								"session_shutdown",
								{ reason: "quit" },
								ctx,
							);
						}
						throw new Error("parent delivery unavailable during quit");
					},
				};
				const sessionManager = SessionManager.create(env.dir, env.dir);
				sessionManager.appendMessage({
					role: "user",
					content: "fixture",
					timestamp: Date.now(),
				});
				const model = {
					provider: "pi-integration",
					id: "test",
					reasoning: true,
				};
				const ctx = {
					cwd: env.dir,
					hasUI: false,
					sessionManager,
					model,
					modelRegistry: {
						find: () => model,
						getAvailable: () => [model],
						hasConfiguredAuth: () => true,
					},
				};
				try {
					if (managed) {
						execFileSync("git", ["init", "-q", "-b", "main"], { cwd: env.dir });
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
								"--allow-empty",
								"-qm",
								"fixture",
							],
							{ cwd: env.dir },
						);
					}
					// SAFETY: headless host implements the public SDK methods used here.
					subagentsExtension(api as ExtensionAPI);
					await lifecycle.emit("session_start", {}, ctx);
					const baseline = panes(env.workspaceId).map((pane) => pane.pane_id);
					type PersistentQuitParams = {
						name: string;
						task: string;
						model: string;
						tools: string;
						persistent: boolean;
						worktree?: { branch: string };
					};
					const params: PersistentQuitParams = {
						name: "persistent-quit",
						task: "Return exactly TASK_COMPLETE",
						model: TEST_MODEL,
						tools: "read",
						persistent: true,
					};
					if (managed)
						params.worktree = { branch: "placement-persistent-quit" };
					const started = await tools
						.get("subagent")
						.execute("persistent-quit", params, undefined, undefined, ctx);
					assert.equal(started.details.status, "started");
					worktree = started.details.worktree;
					childSurface = panes(worktree?.workspaceId ?? env.workspaceId).find(
						(pane) => !baseline.includes(pane.pane_id),
					)!.pane_id;
					const deadline = Date.now() + 60_000;
					while (!shutdown && Date.now() < deadline) await sleep(50);
					assert.ok(shutdown, "a real task result must trigger parent quit");
					await shutdown;
					assert.ok(
						childPid,
						"the specialist must still be a live Pi process at quit",
					);
					if (managed) {
						assert.deepEqual(
							panes(worktree!.workspaceId).map((pane) => pane.pane_id),
							[childSurface],
						);
					} else {
						const closeDeadline = Date.now() + 10_000;
						while (
							panes(env.workspaceId).some(
								(pane) => pane.pane_id === childSurface,
							) &&
							Date.now() < closeDeadline
						)
							await sleep(50);
						assert.deepEqual(
							panes(env.workspaceId).map((pane) => pane.pane_id),
							baseline,
							"explicit quit must close the ordinary pane despite failed event delivery",
						);
						while (Date.now() < closeDeadline) {
							try {
								process.kill(childPid, 0);
							} catch {
								break;
							}
							await sleep(50);
						}
						assert.throws(() => process.kill(childPid!, 0), { code: "ESRCH" });
					}
					assert.equal(
						rejectedDeliveries,
						1,
						"quit must not drain pending task events again",
					);
				} finally {
					await lifecycle.emit("session_shutdown", { reason: "quit" }, ctx);
					if (worktree) {
						execFileSync("herdr", [
							"worktree",
							"remove",
							"--workspace",
							worktree.workspaceId,
							"--force",
						]);
						rmdirSync(dirname(worktree.path));
					}
					if (previousId === undefined) delete process.env.PI_SUBAGENT_ID;
					else process.env.PI_SUBAGENT_ID = previousId;
				}
			});

		it("launches a worktree from a linked checkout through the real Herdr path", async () => {
			const linked = join(env.dir, "linked-source");
			const linkedCwd = join(linked, "nested caller");
			const principalBranch = "integration/linked";
			const branch = `integration/linked-child-${uniqueId()}`;
			const childId = uniqueId();
			const manifestFile = join(
				env.dir,
				"artifacts",
				"parent",
				"worktree-runs",
				`${childId}.json`,
			);
			let repositoryInitialized = false;
			let linkedWorktreeCreated = false;
			let child: Awaited<ReturnType<typeof launchPiSubagent>> | undefined;
			let childWorkspaceId: string | undefined;
			try {
				execFileSync("git", ["init", "-q", "-b", "main"], { cwd: env.dir });
				repositoryInitialized = true;
				execFileSync("git", ["config", "user.email", "test@example.com"], {
					cwd: env.dir,
				});
				execFileSync("git", ["config", "user.name", "Integration Test"], {
					cwd: env.dir,
				});
				execFileSync("git", ["config", "commit.gpgsign", "false"], {
					cwd: env.dir,
				});
				writeFileSync(join(env.dir, "base.txt"), "base\n");
				execFileSync("git", ["add", "base.txt"], { cwd: env.dir });
				execFileSync("git", ["commit", "-qm", "base"], { cwd: env.dir });
				execFileSync(
					"git",
					["worktree", "add", "-q", "-b", principalBranch, linked, "HEAD"],
					{ cwd: env.dir },
				);
				linkedWorktreeCreated = true;
				writeFileSync(join(linked, "linked.txt"), "linked\n");
				execFileSync("git", ["add", "linked.txt"], { cwd: linked });
				execFileSync("git", ["commit", "-qm", "linked"], { cwd: linked });
				mkdirSync(linkedCwd);
				const linkedSha = execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: linkedCwd,
					encoding: "utf8",
				}).trim();
				const focusedPane = getFocusedSurface(backend);
				child = await launchPiSubagent({
					...request(3),
					id: childId,
					cwd: linkedCwd,
					worktree: { branch },
				});
				childWorkspaceId = child.worktree?.workspaceId;
				assert.ok(child.worktree);
				assert.equal(child.worktree.branch, branch);
				assert.notEqual(child.worktree.path, linked);
				const childSurface = child.surface;
				assert.equal(
					panes(child.worktree.workspaceId).find(
						(pane) => pane.pane_id === childSurface,
					)?.cwd,
					realpathSync(child.worktree.path),
				);
				assert.equal(
					readFileSync(join(child.worktree.path, "linked.txt"), "utf8"),
					"linked\n",
				);
				assert.equal(
					execFileSync("git", ["rev-parse", "HEAD"], {
						cwd: linkedCwd,
						encoding: "utf8",
					}).trim(),
					linkedSha,
				);
				assert.equal(
					getFocusedSurface(backend),
					focusedPane,
					"linked checkout provisioning must not steal focus",
				);
				await waitForFile(`${child.sessionFile}.exit`, 60_000);
			} finally {
				const deleteBranch = (name: string) => {
					if (!repositoryInitialized) return;
					try {
						execFileSync(
							"git",
							["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
							{ cwd: env.dir },
						);
					} catch {
						return;
					}
					execFileSync("git", ["branch", "-D", name], {
						cwd: env.dir,
						stdio: "ignore",
					});
				};
				if (!childWorkspaceId && existsSync(manifestFile)) {
					const manifest = readWorktreeManifest(manifestFile);
					if (
						manifest?.id === childId &&
						manifest.branch === branch &&
						isNonEmptyString(manifest.workspaceId)
					) {
						childWorkspaceId = manifest.workspaceId;
					}
				}
				try {
					if (childWorkspaceId)
						execFileSync("herdr", [
							"worktree",
							"remove",
							"--workspace",
							childWorkspaceId,
							"--force",
						]);
				} finally {
					try {
						if (linkedWorktreeCreated)
							execFileSync("git", ["worktree", "remove", "--force", linked], {
								cwd: env.dir,
							});
					} finally {
						try {
							if (linkedWorktreeCreated) deleteBranch(principalBranch);
						} finally {
							deleteBranch(branch);
						}
					}
				}
			}
		});

		it("keeps the writer root shell and places a reviewer in the retained worktree tab", async () => {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: env.dir });
			writeFileSync(join(env.dir, "README.md"), "fixture\n");
			execFileSync("git", ["add", "README.md"], { cwd: env.dir });
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
				{ cwd: env.dir },
			);
			const writer = await launchPiSubagent({
				...request(1),
				worktree: { branch: "placement-writer" },
			});
			assert.ok(writer.worktree);
			try {
				await waitForFile(`${writer.sessionFile}.exit`, 60_000);
				await waitForShellReady(writer.surface);
				const root = panes(writer.worktree.workspaceId).find(
					(pane) => pane.pane_id === writer.surface,
				)!;
				const reviewer = await launchPiSubagent({
					...request(2),
					cwd: writer.worktree.path,
				});
				assert.equal(
					panes(writer.worktree.workspaceId).find(
						(pane) => pane.pane_id === reviewer.surface,
					)?.tab_id,
					root.tab_id,
				);
				closePane(reviewer.surface);
				assert.deepEqual(
					panes(writer.worktree.workspaceId).map((pane) => pane.pane_id),
					[writer.surface],
				);
			} finally {
				execFileSync("herdr", [
					"worktree",
					"remove",
					"--workspace",
					writer.worktree.workspaceId,
					"--force",
				]);
				// Herdr leaves the empty directory for this unique test repository.
				rmdirSync(dirname(writer.worktree.path));
			}
		});

		it("resolves a descendant checkout to its owning workspace despite a misleading shell cwd", async () => {
			const other = createTestEnv(backend);
			let checkoutWorkspace: string | undefined;
			try {
				process.env.HERDR_WORKSPACE_ID = env.workspaceId;
				const checkout = join(other.dir, "repo");
				const cwd = join(checkout, "src");
				mkdirSync(cwd, { recursive: true });
				execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
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
						"--allow-empty",
						"-qm",
						"fixture",
					],
					{ cwd: checkout },
				);
				const created = JSON.parse(
					execFileSync(
						"herdr",
						[
							"worktree",
							"open",
							"--cwd",
							checkout,
							"--path",
							checkout,
							"--label",
							"pi-integ-checkout",
							"--no-focus",
						],
						{ encoding: "utf8" },
					),
				).result;
				checkoutWorkspace = created.workspace.workspace_id;
				assert.equal(
					created.workspace.worktree.checkout_path,
					realpathSync(checkout),
				);
				const misleading = JSON.parse(
					execFileSync(
						"herdr",
						[
							"tab",
							"create",
							"--workspace",
							other.workspaceId,
							"--cwd",
							cwd,
							"--no-focus",
						],
						{ encoding: "utf8" },
					),
				).result.root_pane.pane_id;
				assert.equal(
					panes(other.workspaceId).find((pane) => pane.pane_id === misleading)
						?.cwd,
					realpathSync(cwd),
				);
				const child = await launchPiSubagent({ ...request(1), cwd });
				assert.ok(
					panes(checkoutWorkspace!).some(
						(pane) =>
							pane.pane_id === child.surface && pane.cwd === realpathSync(cwd),
					),
					"checkout ownership must outrank another workspace's shell cwd",
				);
				closePane(child.surface);
			} finally {
				if (checkoutWorkspace)
					execFileSync("herdr", ["workspace", "close", checkoutWorkspace]);
				cleanupTestEnv(other);
			}
		});
	});
}
