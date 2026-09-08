import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	launchPiSubagent,
	type FreshPiLaunchRequest,
} from "../../pi-extension/subagents/launch.ts";
import {
	closePane,
	createSubagentPane,
	splitCurrentPane,
	createGroupedSubagentPane,
	createSubagentWorktree,
	waitForShellReady,
	runScriptInPane,
} from "../../pi-extension/subagents/terminal.ts";
import {
	createSubagentPaneFactory,
	loadPaneConfig,
} from "../../pi-extension/subagents/pane-config.ts";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
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
	waitForFile,
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

for (const backend of getAvailableBackends()) {
	describe("grouped public launch placement", { timeout: 120_000 }, () => {
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
			const configPath = join(env.dir, "placement-config.json");
			writeFileSync(configPath, JSON.stringify({ panes: { maxPerTab: 2 } }));
			const operations = {
				createPane: createSubagentPaneFactory(
					loadPaneConfig(configPath),
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
		])
			it(`${scenario.name}: closes panes only after accepted delivery`, async () => {
				const previousId = process.env.PI_SUBAGENT_ID;
				delete process.env.PI_SUBAGENT_ID;
				const tools = new Map<string, any>();
				const handlers = new Map<string, Function>();
				const deliveries: Array<{ type: string; panes: string[] }> = [];
				const api: Partial<ExtensionAPI> = {
					events: createEventBus(),
					on: (name: string, handler: Function) => handlers.set(name, handler),
					registerTool: (tool: any) => tools.set(tool.name, tool),
					registerCommand() {},
					registerShortcut() {},
					registerMessageRenderer() {},
					getThinkingLevel: () => "off",
					getAllTools: () => [],
					sendMessage: (message: { customType: string }) => {
						deliveries.push({
							type: message.customType,
							panes: panes(env.workspaceId).map((pane) => pane.pane_id),
						});
						if (scenario.name === "rejected delivery")
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
					handlers.get("session_start")?.({}, ctx);
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
					await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
					if (previousId === undefined) delete process.env.PI_SUBAGENT_ID;
					else process.env.PI_SUBAGENT_ID = previousId;
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
				assert.equal(created.workspace.worktree.checkout_path, checkout);
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
					cwd,
				);
				const child = await launchPiSubagent({ ...request(1), cwd });
				assert.ok(
					panes(checkoutWorkspace!).some(
						(pane) => pane.pane_id === child.surface && pane.cwd === cwd,
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
