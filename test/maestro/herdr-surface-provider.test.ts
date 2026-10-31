import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS } from "../../maestro/surfaces/herdr/herdr.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import { __herdrTest__ } from "../../maestro/surfaces/herdr/herdr.ts";

const paneConfig = {
	mode: "grouped",
	direction: "down",
	maxPerTab: 2,
} as const;

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	readonly [key: string]: JsonValue | undefined;
}

function json(result: JsonObject): string {
	return `${JSON.stringify({ result })}\n`;
}

function paneList(...panes: JsonObject[]): string {
	return json({ type: "pane_list", panes });
}

describe("HerdrSurfaceProvider", () => {
	it("scopes mock Herdr exec to the required callback and restores after throw", async () => {
		await assert.rejects(
			() =>
				__herdrTest__.withMockHerdrExec(
					() => json({ ok: true }),
					() => {
						throw new Error("boom");
					},
				),
			/boom/,
		);

		const calls: string[][] = [];
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				calls.push(args);
				return paneList();
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				assert.deepEqual(await provider.listSurfaces(), []);
			},
		);
		assert.deepEqual(calls, [["pane", "list"]]);
	});

	it("creates grouped surfaces by using the configured cap and split direction", async () => {
		const calls: string[][] = [];
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "current") {
					return json({
						pane: {
							pane_id: "parent",
							tab_id: "parent-tab",
							workspace_id: "workspace-1",
						},
					});
				}
				if (args[0] === "workspace" && args[1] === "list") {
					return json({
						type: "workspace_list",
						workspaces: [
							{
								workspace_id: "workspace-1",
								worktree: { checkout_path: "/repo" },
							},
						],
					});
				}
				if (args[0] === "pane" && args[1] === "list") {
					return paneList({
						pane_id: "pane-1",
						tab_id: "agents-tab",
						workspace_id: "workspace-1",
						cwd: "/repo",
						label: "first",
					});
				}
				if (args[0] === "tab" && args[1] === "create") {
					return json({
						tab: { tab_id: "agents-tab" },
						root_pane: { pane_id: "pane-1" },
					});
				}
				if (args[0] === "pane" && args[1] === "split") {
					return json({ pane: { pane_id: "pane-2" } });
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				assert.equal(
					await provider.createSurface({
						name: "first",
						cwd: "/repo",
						placement: { kind: "grouped" },
					}),
					"pane-1",
				);
				assert.equal(
					await provider.createSurface({ name: "second", cwd: "/repo" }),
					"pane-2",
				);
			},
		);

		assert.deepEqual(
			calls.filter((args) => args[0] === "tab" && args[1] === "create")[0],
			[
				"tab",
				"create",
				"--workspace",
				"workspace-1",
				"--label",
				"Agents",
				"--cwd",
				"/repo",
				"--no-focus",
			],
		);
		assert.equal(
			calls.some((args) => args[0] === "worktree"),
			false,
		);
		assert.deepEqual(
			calls.find((args) => args[0] === "pane" && args[1] === "split"),
			[
				"pane",
				"split",
				"pane-1",
				"--direction",
				"down",
				"--no-focus",
				"--cwd",
				"/repo",
			],
		);
	});

	it("maps tab placement to legacy tab creation rather than worktree workspace creation", async () => {
		const calls: string[][] = [];
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "current") {
					return json({
						pane: {
							pane_id: "parent",
							tab_id: "parent-tab",
							workspace_id: "workspace-1",
						},
					});
				}
				if (args[0] === "tab" && args[1] === "create") {
					return json({
						tab: { tab_id: "tab-1" },
						root_pane: { pane_id: "pane-tab" },
					});
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				assert.equal(
					await provider.createSurface({
						name: "legacy-tab",
						cwd: "/repo",
						placement: { kind: "tab" },
					}),
					"pane-tab",
				);
			},
		);

		assert.deepEqual(
			calls.find((args) => args[0] === "tab" && args[1] === "create"),
			[
				"tab",
				"create",
				"--workspace",
				"workspace-1",
				"--label",
				"legacy-tab",
				"--cwd",
				"/repo",
				"--no-focus",
			],
		);
		assert.equal(
			calls.some((args) => args[0] === "worktree" && args[1] === "create"),
			false,
		);
	});

	it("maps pane listings to SurfaceInfo with tab groups and actual workspace IDs", async () => {
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				if (args[0] === "pane" && args[1] === "list") {
					return paneList(
						{
							pane_id: "pane-a",
							tab_id: "tab-a",
							workspace_id: "workspace-1",
							label: "named",
							cwd: "/repo",
						},
						{
							pane_id: "pane-b",
							tab_id: "tab-b",
							workspace_id: "workspace-2",
							terminal_title_stripped: "fallback",
							cwd: "/other",
						},
					);
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				assert.deepEqual(await provider.listSurfaces(), [
					{
						id: "pane-a",
						group: "tab-a",
						workspaceId: "workspace-1",
						name: "named",
						cwd: "/repo",
					},
					{
						id: "pane-b",
						group: "tab-b",
						workspaceId: "workspace-2",
						name: "fallback",
						cwd: "/other",
					},
				]);
			},
		);
	});

	it("preserves pane list failures", async () => {
		await __herdrTest__.withMockHerdrExec(
			() => {
				throw new Error("list failed");
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				await assert.rejects(
					() => provider.listSurfaces(),
					/Unable to list Herdr panes/,
				);
			},
		);
	});

	it("lists explicitly scoped worktree inventory without remembering prior creations", async () => {
		const calls: Array<{ args: string[]; timeout?: number }> = [];
		await __herdrTest__.withMockHerdrExec(
			(args, timeout) => {
				calls.push({ args, timeout });
				if (args[0] === "worktree" && args[1] === "create") {
					return json({
						type: "worktree_created",
						workspace: { workspace_id: "created-workspace" },
						root_pane: { pane_id: "created-pane" },
						tab: { tab_id: "created-tab" },
						worktree: { path: "/repo-created/branch", branch: "created" },
					});
				}
				if (args[0] === "pane" && args[1] === "list") {
					return paneList({
						pane_id: "created-pane",
						tab_id: "created-tab",
						workspace_id: "created-workspace",
					});
				}
				if (args[0] === "worktree" && args[1] === "list") {
					if (args.includes("/repo-a")) {
						return json({
							type: "worktree_list",
							worktrees: [
								{
									path: "/repo-a/wt",
									branch: "feature/a",
									is_linked_worktree: true,
								},
							],
						});
					}
					return json({ type: "worktree_list", worktrees: [] });
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				await provider.createWorktreeSurface({
					name: "created",
					cwd: "/repo-created",
					branch: "created",
					base: "HEAD",
				});
				assert.deepEqual(
					await provider.listWorktreeSurfaces({
						cwd: "/repo-a",
						timeoutMs: 1234,
					}),
					[
						{
							path: "/repo-a/wt",
							branch: "feature/a",
							isLinkedWorktree: true,
						},
					],
				);
			},
		);

		assert.deepEqual(
			calls.filter(
				(call) => call.args[0] === "worktree" && call.args[1] === "list",
			),
			[
				{
					args: ["worktree", "list", "--cwd", "/repo-created"],
					timeout: OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS,
				},
				{
					args: ["worktree", "list", "--cwd", "/repo-created"],
					timeout: OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS,
				},
				{ args: ["worktree", "list", "--cwd", "/repo-a"], timeout: 1234 },
			],
		);
	});

	it("propagates scoped worktree listing failures instead of returning an empty inventory", async () => {
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				if (args[0] === "worktree" && args[1] === "list") {
					throw new Error("missing source");
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				await assert.rejects(
					() => provider.listWorktreeSurfaces({ cwd: "/gone" }),
					/missing source/,
				);
			},
		);
	});

	it("lists worktree inventory without fabricating provisioning fields", async () => {
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				assert.deepEqual(args, ["worktree", "list"]);
				return json({
					type: "worktree_list",
					worktrees: [
						{
							path: "/repo/wt",
							branch: "feature/a",
							label: "Feature A",
							open_workspace_id: "workspace-a",
							is_linked_worktree: true,
						},
						{
							path: "/repo/detached",
							is_detached: true,
							is_linked_worktree: true,
						},
						{ path: "/repo/plain", branch: "main", is_linked_worktree: false },
					],
				});
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				assert.deepEqual(await provider.listWorktreeSurfaces(), [
					{
						path: "/repo/wt",
						branch: "feature/a",
						label: "Feature A",
						workspaceId: "workspace-a",
						isLinkedWorktree: true,
					},
					{ path: "/repo/detached", branch: "", isLinkedWorktree: true },
					{ path: "/repo/plain", branch: "main", isLinkedWorktree: false },
				]);
			},
		);
	});

	it("normalizes present, missing, and unavailable inspections and preserves process identity fields", async () => {
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				if (args[0] === "pane" && args[1] === "get") {
					if (args[2] === "pane-a") {
						return json({
							pane: { pane_id: "pane-a", agent: "pi", agent_status: "working" },
						});
					}
					if (args[2] === "missing-pane") {
						return `${JSON.stringify({ error: { code: "pane_not_found", message: "gone" } })}\n`;
					}
					return json({
						pane: { pane_id: "other-pane", agent_status: "idle" },
					});
				}
				if (args[0] === "pane" && args[1] === "process-info") {
					return json({
						process_info: {
							pane_id: "pane-a",
							shell_pid: 10,
							foreground_process_group_id: 20,
							foreground_processes: [
								{
									pid: 30,
									name: "pi",
									argv0: "/bin/pi",
									argv: ["pi", "--session", "s.jsonl"],
									cwd: "/repo",
								},
							],
						},
					});
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				const inspection = await provider.inspectSurface("pane-a");
				assert.equal(inspection.kind, "present");
				assert.equal(inspection.agent, "pi");
				assert.equal(inspection.agentStatus, "working");
				assert.equal(Number.isFinite(inspection.observedAt), true);
				assert.deepEqual(await provider.inspectSurface("missing-pane"), {
					kind: "missing",
					error: "gone",
				});
				assert.deepEqual(await provider.inspectSurface("bad-pane"), {
					kind: "unavailable",
					error: "pane id mismatch",
				});
				assert.deepEqual(await provider.getProcessInfo("pane-a"), {
					shellPid: 10,
					foregroundProcessGroupId: 20,
					pids: [10, 20, 30],
					foregroundProcesses: [
						{
							pid: 30,
							name: "pi",
							argv0: "/bin/pi",
							argv: ["pi", "--session", "s.jsonl"],
							cwd: "/repo",
						},
					],
				});
			},
		);
	});

	it("delegates screen and process observations through async Herdr calls", async () => {
		let resolveRead: ((value: string) => void) | undefined;
		let resolveInfo: ((value: string) => void) | undefined;
		const observedModes: Array<string | undefined> = [];
		await __herdrTest__.withMockHerdrExec(
			(args, _timeout, mode) => {
				if (args[0] === "pane" && args[1] === "read") {
					observedModes.push(mode);
					return new Promise<string>((resolve) => {
						resolveRead = resolve;
					});
				}
				if (args[0] === "pane" && args[1] === "process-info") {
					observedModes.push(mode);
					return new Promise<string>((resolve) => {
						resolveInfo = resolve;
					});
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				let readSettled = false;
				const readPromise = provider.readScreen("pane-a", 3).then((value) => {
					readSettled = true;
					return value;
				});
				await Promise.resolve();
				assert.equal(readSettled, false);
				if (!resolveRead) throw new Error("read was not started");
				resolveRead("screen text");
				assert.equal(await readPromise, "screen text");

				let infoSettled = false;
				const infoPromise = provider.getProcessInfo("pane-a").then((info) => {
					infoSettled = true;
					return info;
				});
				await Promise.resolve();
				assert.equal(infoSettled, false);
				if (!resolveInfo)
					throw new Error("process observation was not started");
				resolveInfo(
					json({
						process_info: {
							pane_id: "pane-a",
							shell_pid: 10,
							foreground_processes: [{ pid: 11, name: "pi" }],
						},
					}),
				);
				assert.deepEqual(await infoPromise, {
					shellPid: 10,
					foregroundProcessGroupId: undefined,
					pids: [10, 11],
					foregroundProcesses: [{ pid: 11, name: "pi", argv: undefined }],
				});
			},
		);
		assert.deepEqual(observedModes, ["async", "async"]);
	});

	it("rejects unconfirmed absence and resolves confirmed absence", async () => {
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				if (args[0] === "pane" && args[1] === "get") {
					if (args[2] === "missing-pane") {
						return `${JSON.stringify({ error: { code: "pane_not_found", message: "gone" } })}\n`;
					}
					if (args[2] === "unavailable-pane") {
						return json({
							pane: { pane_id: "other-pane", agent_status: "idle" },
						});
					}
					return json({
						pane: { pane_id: args[2] ?? "present", agent_status: "idle" },
					});
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				await assert.rejects(
					provider.waitForSurfaceAbsence("missing-pane", { timeoutMs: 0 }),
					/finite and positive/,
				);
				await provider.waitForSurfaceAbsence("missing-pane", { timeoutMs: 10 });
				await assert.rejects(
					() =>
						provider.waitForSurfaceAbsence("present-pane", { timeoutMs: 10 }),
					/absence unconfirmed/,
				);
				await assert.rejects(
					() =>
						provider.waitForSurfaceAbsence("unavailable-pane", {
							timeoutMs: 10,
						}),
					/absence unconfirmed/,
				);
			},
		);
	});

	it("delegates focus, title, and worktree removal and preserves driver errors", async () => {
		const calls: string[][] = [];
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "current") {
					return json({
						pane: {
							pane_id: "parent",
							tab_id: "tab-current",
							workspace_id: "workspace-current",
						},
					});
				}
				if (args[0] === "worktree" && args[1] === "remove") {
					throw new Error("remove failed");
				}
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				await provider.focusWorkspace("workspace-target");
				await provider.setTitle("tab", "Tab Title");
				await provider.setTitle("workspace", "Workspace Title");
				await assert.rejects(
					() => provider.removeWorktreeSurface("workspace-dead"),
					/remove failed/,
				);
			},
		);

		assert.deepEqual(calls, [
			["workspace", "focus", "workspace-target"],
			["pane", "current", "--current"],
			["tab", "rename", "tab-current", "Tab Title"],
			["pane", "current", "--current"],
			["workspace", "rename", "workspace-current", "Workspace Title"],
			["worktree", "remove", "--workspace", "workspace-dead"],
		]);
	});

	it("attached handles delegate commands, reads, raw keys, Escape, and close", async () => {
		const calls: string[][] = [];
		await __herdrTest__.withMockHerdrExec(
			(args) => {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "read") return "screen text";
				return json({ ok: true });
			},
			async () => {
				const provider = new HerdrSurfaceProvider({ paneConfig });
				const handle = provider.attachSurface("pane-a");
				await handle.runCommand("echo hi");
				assert.equal(await handle.readScreen(), "screen text");
				assert.ok(handle.sendKeys);
				assert.ok(handle.close);
				await handle.sendKeys("x");
				await provider.sendKeys("pane-a", "Escape");
				await handle.close();
			},
		);

		assert.deepEqual(calls, [
			["pane", "run", "pane-a", "echo hi"],
			["pane", "read", "pane-a", "--source", "visible", "--lines", "50"],
			["pane", "send-keys", "pane-a", "x"],
			["pane", "send-keys", "pane-a", "Escape"],
			["pane", "close", "pane-a"],
		]);
	});
});
