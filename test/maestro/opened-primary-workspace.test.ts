import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clearOpenedPrimaryWorkspaceClaims,
	openedPrimaryWorkspaceClaims,
	rememberOpenedPrimaryWorkspace,
	type PrimaryWorkspaceClaim,
} from "../../maestro/core/opened-primary-workspace.ts";
import { removeContainedWorktree } from "../../maestro/core/worktree-cleanup.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import {
	__herdrTest__,
	createHerdrWorktree,
	OPENED_PRIMARY_REPORT_CALLS,
	OPENED_PRIMARY_REPORT_TIMEOUT_MS,
	OPENED_PRIMARY_REPORT_WORST_CASE_MS,
	OPENED_PRIMARY_SNAPSHOT_CALLS,
	OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS,
	OPENED_PRIMARY_SNAPSHOT_WORST_CASE_MS,
	openedPrimaryWorkspaceNote,
	reportOpenedPrimaryWorkspace,
} from "../../maestro/surfaces/herdr/herdr.ts";
import { cleanupFixture } from "../worktree-cleanup-fixture.ts";

const claim: PrimaryWorkspaceClaim = {
	workspaceId: "w1",
	repoKey: "/repo/.git",
	terminalId: "term-1",
	checkoutPath: "/repo",
};

const note =
	"w1 appears to have been opened by worktree creation; if you haven't used it, close it with herdr workspace close w1";

function json(value: any): string {
	return JSON.stringify({ result: value });
}

interface ListedWorktreeFixture {
	branch: string;
	path: string;
	is_linked_worktree?: boolean;
	open_workspace_id?: string;
}

interface WorktreeSourceFixture {
	repo_name: string;
	repo_key?: string;
	source_checkout_path?: string;
	source_workspace_id?: string;
}

function worktreeList(
	primary?: string,
	rows: ListedWorktreeFixture[] = [],
	repoKey: string | null = "/repo/.git",
	checkoutPath: string | null = "/repo",
): string {
	const source: WorktreeSourceFixture = { repo_name: "repo" };
	if (repoKey) source.repo_key = repoKey;
	if (checkoutPath) source.source_checkout_path = checkoutPath;
	const principal: ListedWorktreeFixture = {
		branch: "main",
		path: "/repo",
		is_linked_worktree: false,
	};
	if (primary) {
		source.source_workspace_id = primary;
		principal.open_workspace_id = primary;
	}
	return json({
		type: "worktree_list",
		source,
		worktrees: [principal, ...rows],
	});
}

function created(): string {
	return json({
		type: "worktree_created",
		workspace: { workspace_id: "w2" },
		root_pane: { pane_id: "w2:p1" },
		tab: { tab_id: "w2:t1" },
		worktree: { path: "/managed/repo/task", branch: "task" },
	});
}

interface WorkspaceFixtureOverride {
	label?: string | number;
	focused?: boolean | string;
	tab_count?: number;
}

interface WorkspaceWorktreeFixtureOverride {
	is_linked_worktree?: boolean;
	repo_key?: string;
	repo_name?: string;
}

function workspace(
	overrides: WorkspaceFixtureOverride = {},
	worktree: WorkspaceWorktreeFixtureOverride = {},
): string {
	return json({
		type: "workspace_info",
		workspace: {
			workspace_id: "w1",
			label: "repo",
			focused: false,
			tab_count: 1,
			worktree: {
				is_linked_worktree: false,
				repo_key: "/repo/.git",
				repo_name: "repo",
				...worktree,
			},
			...overrides,
		},
	});
}

interface PaneFixtureOverride {
	pane_id?: string;
	cwd?: string;
	foreground_cwd?: string;
	terminal_id?: string;
}

function paneList(...panes: PaneFixtureOverride[]): string {
	return json({
		type: "pane_list",
		panes: (panes.length ? panes : [{}]).map((extra) => ({
			pane_id: "w1:p1",
			workspace_id: "w1",
			terminal_id: "term-1",
			cwd: "/repo",
			foreground_cwd: "/repo",
			...extra,
		})),
	});
}

function scriptedHerdr(queues: Record<string, string[]>) {
	const calls: string[][] = [];
	const timeouts: Array<number | undefined> = [];
	const modes: Array<string | undefined> = [];
	return {
		calls,
		timeouts,
		modes,
		exec(args: string[], timeout?: number, mode?: string): string {
			calls.push(args);
			timeouts.push(timeout);
			modes.push(mode);
			if (args[0] === "tab" && args[1] === "rename")
				return json({ type: "ok" });
			const key = `${args[0]} ${args[1]}`;
			const queue = queues[key];
			const next = queue?.shift();
			if (next === undefined)
				throw new Error(`unexpected herdr ${args.join(" ")}`);
			if (next.startsWith("THROW "))
				throw new Error(next.slice("THROW ".length));
			return next;
		},
	};
}

function herdrCalls(calls: string[][]): string[] {
	return calls.map((args) => args.join(" "));
}

function isSnapshot(args: string[]): boolean {
	return (
		(args[0] === "worktree" && args[1] === "list") ||
		(args[0] === "pane" && args[1] === "list")
	);
}

function issuedClose(calls: string[][]): boolean {
	return calls.some((args) => args[0] === "workspace" && args[1] === "close");
}

async function withoutConsole<T>(run: () => Promise<T>): Promise<{
	value: T;
	output: string[];
}> {
	const output: string[] = [];
	const original = {
		log: console.log,
		warn: console.warn,
		error: console.error,
	};
	const capture = (...args: any[]) => {
		output.push(args.map(String).join(" "));
	};
	console.log = capture;
	console.warn = capture;
	console.error = capture;
	try {
		return { value: await run(), output };
	} finally {
		console.log = original.log;
		console.warn = original.warn;
		console.error = original.error;
	}
}

describe("opened primary workspace snapshots", () => {
	it("claims the primary workspace only when create opened it, within the derived budget", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			const script = scriptedHerdr({
				"worktree list": [worktreeList(undefined), worktreeList("w1")],
				"worktree create": [created()],
				"pane list": [paneList()],
			});
			await __herdrTest__.withMockHerdrExec(script.exec, async () => {
				const surface = await createHerdrWorktree(
					"task",
					"/repo",
					"task",
					"HEAD",
				);
				assert.equal(surface.workspaceId, "w2");
				assert.equal(surface.diagnostics, undefined);
			});
			assert.deepEqual(openedPrimaryWorkspaceClaims(), [claim]);
			const snapshotTimeouts = script.calls.flatMap((args, index) =>
				isSnapshot(args) ? [script.timeouts[index] ?? 0] : [],
			);
			assert.equal(snapshotTimeouts.length, OPENED_PRIMARY_SNAPSHOT_CALLS);
			assert.ok(
				snapshotTimeouts.every(
					(timeout) => timeout === OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS,
				),
			);
			assert.equal(
				snapshotTimeouts.reduce((sum, timeout) => sum + timeout, 0),
				OPENED_PRIMARY_SNAPSHOT_WORST_CASE_MS,
			);
			assert.ok(OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS <= 3_000);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("does not claim a primary workspace that was already open", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			const script = scriptedHerdr({
				"worktree list": [worktreeList("w1")],
				"worktree create": [created()],
			});
			await __herdrTest__.withMockHerdrExec(script.exec, () =>
				createHerdrWorktree("task", "/repo", "task", "HEAD"),
			);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), []);
			assert.deepEqual(
				herdrCalls(script.calls).filter((call) =>
					call.startsWith("worktree list"),
				),
				["worktree list --cwd /repo"],
			);
			assert.equal(
				script.calls.some((args) => args[0] === "pane"),
				false,
			);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("reports a before-snapshot failure as a launch diagnostic, without console output, and claims nothing", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			const script = scriptedHerdr({
				"worktree list": ["THROW herdr timed out"],
				"worktree create": [created()],
			});
			const { value: surface, output } = await withoutConsole(() =>
				__herdrTest__.withMockHerdrExec(script.exec, () =>
					createHerdrWorktree("task", "/repo", "task", "HEAD"),
				),
			);
			assert.equal(surface.workspaceId, "w2");
			assert.deepEqual(surface.diagnostics, [
				"Primary workspace snapshot (before create) failed: herdr timed out",
			]);
			assert.deepEqual(output, []);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), []);
			assert.equal(
				herdrCalls(script.calls).filter((call) =>
					call.startsWith("worktree list"),
				).length,
				1,
			);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("reports an after-snapshot failure and does not read a terminal", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			const script = scriptedHerdr({
				"worktree list": [worktreeList(undefined), "THROW list failed"],
				"worktree create": [created()],
			});
			const { value: surface, output } = await withoutConsole(() =>
				__herdrTest__.withMockHerdrExec(script.exec, () =>
					createHerdrWorktree("task", "/repo", "task", "HEAD"),
				),
			);
			assert.deepEqual(surface.diagnostics, [
				"Primary workspace snapshot (after create) failed: list failed",
			]);
			assert.deepEqual(output, []);
			assert.equal(
				script.calls.some((args) => args[0] === "pane"),
				false,
			);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), []);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("reports an opened-workspace pane list failure and claims nothing", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			const script = scriptedHerdr({
				"worktree list": [worktreeList(undefined), worktreeList("w1")],
				"worktree create": [created()],
				"pane list": ["THROW pane list failed"],
			});
			const surface = await __herdrTest__.withMockHerdrExec(script.exec, () =>
				createHerdrWorktree("task", "/repo", "task", "HEAD"),
			);
			assert.deepEqual(surface.diagnostics, [
				"Primary workspace snapshot (opened workspace) failed: pane list failed",
			]);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), []);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("claims nothing when the opened workspace has no terminal id", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			const script = scriptedHerdr({
				"worktree list": [worktreeList(undefined), worktreeList("w1")],
				"worktree create": [created()],
				"pane list": [
					json({
						type: "pane_list",
						panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo" }],
					}),
				],
			});
			await __herdrTest__.withMockHerdrExec(script.exec, () =>
				createHerdrWorktree("task", "/repo", "task", "HEAD"),
			);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), []);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});
});

describe("reporting an opened primary workspace", () => {
	function untouched() {
		return {
			"worktree list": [worktreeList("w1")],
			"workspace get": [workspace()],
			"pane list": [paneList()],
		};
	}

	it("suggests the close command without asserting attribution and never closes", async () => {
		const script = scriptedHerdr(untouched());
		const report = await __herdrTest__.withMockHerdrExec(script.exec, () =>
			reportOpenedPrimaryWorkspace("/repo", [claim]),
		);
		assert.equal(report?.note, note);
		assert.equal(openedPrimaryWorkspaceNote("w1"), note);
		assert.deepEqual(report?.releasedClaims, [
			{ workspaceId: "w1", repoKey: "/repo/.git", terminalId: "term-1" },
		]);
		assert.deepEqual(herdrCalls(script.calls), [
			"worktree list --cwd /repo",
			"workspace get w1",
			"pane list --workspace w1",
		]);
		assert.equal(script.calls.length, OPENED_PRIMARY_REPORT_CALLS);
		assert.ok(script.modes.every((mode) => mode === "async"));
		assert.ok(
			script.timeouts.every(
				(timeout) => timeout === OPENED_PRIMARY_REPORT_TIMEOUT_MS,
			),
		);
		assert.equal(
			script.timeouts.reduce<number>((sum, timeout) => sum + (timeout ?? 0), 0),
			OPENED_PRIMARY_REPORT_WORST_CASE_MS,
		);
		assert.ok(OPENED_PRIMARY_REPORT_TIMEOUT_MS <= 3_000);
		assert.equal(issuedClose(script.calls), false);
	});

	it("makes no Herdr call without a complete claim", async () => {
		const script = scriptedHerdr({});
		const report = await __herdrTest__.withMockHerdrExec(script.exec, () =>
			reportOpenedPrimaryWorkspace("/repo", [{ ...claim, terminalId: "" }]),
		);
		assert.equal(report, undefined);
		assert.deepEqual(script.calls, []);
	});

	for (const [name, queues] of [
		[
			"label is missing",
			{ "workspace get": [workspace({ label: undefined })] },
		],
		["label is not a string", { "workspace get": [workspace({ label: 1 })] }],
		[
			"label and repo_name are both missing",
			{
				"workspace get": [
					workspace({ label: undefined }, { repo_name: undefined }),
				],
			},
		],
		[
			"repo_name is missing",
			{ "workspace get": [workspace({}, { repo_name: undefined })] },
		],
		[
			"focused is missing",
			{ "workspace get": [workspace({ focused: undefined })] },
		],
		[
			"focused is not a boolean",
			{ "workspace get": [workspace({ focused: "false" })] },
		],
		["focused is true", { "workspace get": [workspace({ focused: true })] }],
		["tab_count is 2", { "workspace get": [workspace({ tab_count: 2 })] }],
		[
			"workspace get repo_key differs",
			{ "workspace get": [workspace({}, { repo_key: "/other/.git" })] },
		],
		[
			"is_linked_worktree is missing",
			{
				"workspace get": [workspace({}, { is_linked_worktree: undefined })],
			},
		],
		[
			"foreground_cwd is missing",
			{
				"workspace get": [workspace()],
				"pane list": [paneList({ foreground_cwd: undefined })],
			},
		],
		[
			"foreground_cwd is outside the checkout",
			{
				"workspace get": [workspace()],
				"pane list": [paneList({ foreground_cwd: "/repo-elsewhere" })],
			},
		],
		[
			"cwd is outside the checkout",
			{
				"workspace get": [workspace()],
				"pane list": [paneList({ cwd: "/repo-elsewhere" })],
			},
		],
		[
			"cwd is missing",
			{
				"workspace get": [workspace()],
				"pane list": [paneList({ cwd: undefined })],
			},
		],
		[
			"terminal_id is missing",
			{
				"workspace get": [workspace()],
				"pane list": [paneList({ terminal_id: undefined })],
			},
		],
		[
			"terminal_id differs from the claim",
			{
				"workspace get": [workspace()],
				"pane list": [paneList({ terminal_id: "term-2" })],
			},
		],
		[
			"the workspace has two panes",
			{
				"workspace get": [workspace()],
				"pane list": [paneList({}, { pane_id: "w1:p2" })],
			},
		],
	] as const) {
		it(`fails closed when ${name}`, async () => {
			const script = scriptedHerdr({
				"worktree list": [worktreeList("w1")],
				"workspace get": [...queues["workspace get"]],
				"pane list": "pane list" in queues ? [...queues["pane list"]] : [],
			});
			const report = await __herdrTest__.withMockHerdrExec(script.exec, () =>
				reportOpenedPrimaryWorkspace("/repo", [claim]),
			);
			assert.equal(report?.note, undefined);
			assert.equal(issuedClose(script.calls), false);
		});
	}

	it("ignores claims of other repositories", async () => {
		const script = scriptedHerdr({ "worktree list": [worktreeList("w1")] });
		const report = await __herdrTest__.withMockHerdrExec(script.exec, () =>
			reportOpenedPrimaryWorkspace("/repo", [
				{ ...claim, repoKey: "/other/.git" },
			]),
		);
		assert.equal(report, undefined);
		assert.deepEqual(herdrCalls(script.calls), ["worktree list --cwd /repo"]);
	});

	it("does not report while another linked worktree workspace is open", async () => {
		const script = scriptedHerdr({
			"worktree list": [
				worktreeList("w1", [
					{
						branch: "other",
						path: "/managed/repo/other",
						is_linked_worktree: true,
						open_workspace_id: "w7",
					},
				]),
			],
		});
		const report = await __herdrTest__.withMockHerdrExec(script.exec, () =>
			reportOpenedPrimaryWorkspace("/repo", [claim]),
		);
		assert.equal(report?.note, undefined);
		assert.deepEqual(report?.releasedClaims, []);
		assert.equal(
			script.calls.some((args) => args[0] === "workspace"),
			false,
		);
	});

	it("fails closed on an open workspace whose linked flag is missing", async () => {
		const script = scriptedHerdr({
			"worktree list": [
				worktreeList("w1", [
					{
						branch: "other",
						path: "/managed/repo/other",
						open_workspace_id: "w7",
					},
				]),
			],
			"workspace get": [workspace()],
			"pane list": [paneList()],
		});
		const report = await __herdrTest__.withMockHerdrExec(script.exec, () =>
			reportOpenedPrimaryWorkspace("/repo", [claim]),
		);
		assert.equal(report?.note, undefined);
		assert.deepEqual(herdrCalls(script.calls), ["worktree list --cwd /repo"]);
	});

	it("fails closed when a row naming the primary lacks a linked flag", async () => {
		const script = scriptedHerdr({
			"worktree list": [
				worktreeList("w1", [
					{
						branch: "other",
						path: "/managed/repo/other",
						open_workspace_id: "w1",
					},
				]),
			],
			"workspace get": [workspace()],
			"pane list": [paneList()],
		});
		const report = await __herdrTest__.withMockHerdrExec(script.exec, () =>
			reportOpenedPrimaryWorkspace("/repo", [claim]),
		);
		assert.equal(report?.note, undefined);
		assert.deepEqual(herdrCalls(script.calls), ["worktree list --cwd /repo"]);
	});

	it("asks the Herdr provider, which still never closes", async () => {
		const script = scriptedHerdr(untouched());
		const provider = new HerdrSurfaceProvider({
			paneConfig: { mode: "tab", direction: "right", maxPerTab: 4 },
		});
		const report = await __herdrTest__.withMockHerdrExec(script.exec, () =>
			provider.reportOpenedPrimaryWorkspace({
				sourceRepo: "/repo",
				claims: [claim],
			}),
		);
		assert.equal(report?.note, note);
		assert.equal(issuedClose(script.calls), false);
	});
});

describe("explicit removal reports a live claim only", () => {
	it("includes the suggestion and forgets the claim without closing", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			rememberOpenedPrimaryWorkspace(claim);
			const fixture = cleanupFixture();
			fixture.operations.reportOpenedPrimaryWorkspace = (source, claims) => {
				assert.equal(source, "/repo");
				assert.deepEqual(claims, [claim]);
				return {
					note,
					repoKey: claim.repoKey,
					releasedClaims: [
						{
							workspaceId: claim.workspaceId,
							repoKey: claim.repoKey,
							terminalId: claim.terminalId,
						},
					],
				};
			};
			const result = await removeContainedWorktree(fixture.input);
			assert.equal(result.status, "removed");
			assert.ok(result.message.includes(note), result.message);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), []);
			assert.deepEqual(fixture.calls, [
				"git:/repo:/managed/repo/task",
				"prune:/repo",
			]);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("skips the report when this process holds no claim for the removed repository", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			const other = { ...claim, checkoutPath: "/other" };
			rememberOpenedPrimaryWorkspace(other);
			const fixture = cleanupFixture();
			fixture.operations.reportOpenedPrimaryWorkspace = () => {
				throw new Error("must not be called");
			};
			const result = await removeContainedWorktree(fixture.input);
			assert.equal(result.status, "removed", result.message);
			assert.doesNotMatch(result.message, /worktree creation|report failed/);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), [other]);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("reports nothing after a restart, when this process recorded no claim", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		const fixture = cleanupFixture();
		fixture.operations.reportOpenedPrimaryWorkspace = () => {
			throw new Error("must not be called");
		};
		const result = await removeContainedWorktree(fixture.input);
		assert.equal(result.status, "removed", result.message);
		assert.doesNotMatch(result.message, /worktree creation/);
	});

	it("reports a failed primary lookup as a warning after the checkout is gone", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			rememberOpenedPrimaryWorkspace(claim);
			const fixture = cleanupFixture();
			fixture.operations.reportOpenedPrimaryWorkspace = () => {
				throw new Error("herdr unavailable");
			};
			const result = await removeContainedWorktree(fixture.input);
			assert.equal(result.status, "removed");
			assert.match(
				result.message,
				/Primary workspace report failed: herdr unavailable/,
			);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), [claim]);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});
});
