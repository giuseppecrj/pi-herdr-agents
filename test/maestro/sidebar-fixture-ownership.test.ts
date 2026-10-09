/**
 * The sidebar lifecycle fixture's ownership rules: it removes only a worktree
 * its own launch record and Herdr's inventory of its own repository agree on,
 * it stops its parent's launch work before it scans, and it owns its foreign
 * canary on the same terms.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	acquireCanary,
	herdrCommands,
	holdCommand,
	isHoldRunning,
	judgeWorktreeOwnership,
	paneProcesses,
	parseInventory,
	parseLaunchRecord,
	planCanary,
	quiescePane,
	readHold,
	releaseCanary,
	waitForHoldsToExit,
	type Canary,
	type FixtureCommands,
	type Inventory,
	type LaunchRecord,
} from "../integration/sidebar-fixture.ts";
import type { JsonObject } from "../../maestro/core/config/type-guards.ts";

const REPO = "/tmp/pi-integ-own";
const BRANCH = "integration/sidebar-abc";
const NAME = "Sidebar-worktree-abc";
const PATH = "/home/u/.herdr/worktrees/pi-integ-own/integration-sidebar-abc";
const expected = { repoRoot: REPO, branch: BRANCH, name: NAME };

type Row = Inventory["result"]["worktrees"][number];

function inventory(rows: Row[], repoRoot = REPO): Inventory {
	return {
		result: {
			source: { repo_root: repoRoot },
			worktrees: [
				{ branch: "main", path: repoRoot, is_linked_worktree: false },
				...rows,
			],
		},
	};
}

const ownRow: Row = {
	branch: BRANCH,
	path: PATH,
	is_linked_worktree: true,
	open_workspace_id: "w5",
};

const record: LaunchRecord = {
	id: "child-1",
	state: "running",
	name: NAME,
	sourceCwd: REPO,
	branch: BRANCH,
	path: PATH,
	workspaceId: "w5",
	paneId: "w5:p1",
};

describe("sidebar fixture worktree ownership", () => {
	it("owns the worktree its launch record and Herdr agree on", () => {
		assert.deepEqual(
			judgeWorktreeOwnership(expected, inventory([ownRow]), [record]),
			{ kind: "open", path: PATH, workspace: "w5", record },
		);
	});

	it("owns a worktree Herdr created while the record still said provisioning", () => {
		const provisioning: LaunchRecord = {
			id: "child-1",
			state: "provisioning",
			name: NAME,
			sourceCwd: REPO,
			branch: BRANCH,
		};
		assert.deepEqual(
			judgeWorktreeOwnership(expected, inventory([ownRow]), [provisioning]),
			{ kind: "open", path: PATH, workspace: "w5", record: provisioning },
		);
	});

	it("owns a listed checkout whose workspace is already closed", () => {
		const closed = { ...ownRow, open_workspace_id: undefined };
		assert.deepEqual(
			judgeWorktreeOwnership(expected, inventory([closed]), [record]),
			{ kind: "checkout", path: PATH, record },
		);
	});

	it("ignores every other worktree, marked or not, and reports its own as absent", () => {
		const foreign: Row = {
			branch: "foreign/marked",
			path: "/home/u/.herdr/worktrees/x/foreign-marked",
			is_linked_worktree: true,
			open_workspace_id: "w4",
		};
		assert.deepEqual(
			judgeWorktreeOwnership(expected, inventory([foreign]), [record]),
			{ kind: "absent" },
		);
	});

	it("never claims a worktree without exactly one matching launch record", () => {
		for (const records of [
			[],
			[{ ...record, name: "Someone-else" }],
			[{ ...record, sourceCwd: "/tmp/other" }],
			[record, { ...record, id: "child-2" }],
		])
			assert.equal(
				judgeWorktreeOwnership(expected, inventory([ownRow]), records).kind,
				"unknown",
			);
	});

	it("never claims a worktree whose workspace or path differs from the record", () => {
		for (const row of [
			{ ...ownRow, open_workspace_id: "w4" },
			{ ...ownRow, path: "/elsewhere" },
		])
			assert.equal(
				judgeWorktreeOwnership(expected, inventory([row]), [record]).kind,
				"unknown",
			);
	});

	it("never claims an inventory for another repository or the principal checkout", () => {
		assert.equal(
			judgeWorktreeOwnership(expected, inventory([ownRow], "/tmp/other"), [
				record,
			]).kind,
			"unknown",
		);
		const principal = { ...ownRow, path: REPO, is_linked_worktree: false };
		assert.equal(
			judgeWorktreeOwnership(expected, inventory([principal]), [record]).kind,
			"unknown",
		);
	});

	it("parses Herdr's and the launch's JSON, rejecting anything malformed", () => {
		const listed = JSON.stringify({ id: "cli", ...inventory([ownRow]) });
		assert.deepEqual(
			parseInventory(listed)?.result.worktrees[1].open_workspace_id,
			"w5",
		);
		assert.equal(parseInventory("{"), undefined);
		assert.equal(parseInventory(JSON.stringify({ result: {} })), undefined);
		assert.deepEqual(
			parseLaunchRecord(JSON.stringify({ ...record, baseSha: "abc" }))?.id,
			"child-1",
		);
		assert.equal(
			parseLaunchRecord(JSON.stringify({ ...record, branch: 1 })),
			undefined,
		);
	});
});

describe("sidebar fixture pane quiescing", {
	skip: process.platform === "linux" ? false : "reads /proc",
}, () => {
	it("stops a pane that keeps spawning, and lets an in-flight herdr request finish", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sidebar-quiesce-"));
		// A stand-in for an in-flight `herdr` CLI request: one second of work,
		// beside a shell that forks back to back, bounded, so the race is real.
		symlinkSync("/bin/sleep", join(dir, "herdr"));
		const pane = `quiesce-${process.pid}`;
		const shell = spawn(
			"/bin/bash",
			[
				"-c",
				`"${dir}/herdr" 1 & for i in $(seq 2000); do sleep 30 & done; wait`,
			],
			{
				detached: true,
				stdio: "ignore",
				env: { ...process.env, HERDR_PANE_ID: pane },
			},
		);
		shell.unref();
		assert.ok(shell.pid);
		const scope = { pane, shellPid: shell.pid, socket: undefined };
		try {
			let request: number | undefined;
			for (let attempt = 0; attempt < 100 && !request; attempt++) {
				await delay(20);
				request = paneProcesses(scope).find((entry) =>
					entry.argv0.endsWith("/herdr"),
				)?.pid;
			}
			assert.ok(request, "the stand-in request started");
			assert.ok(paneProcesses(scope).length > 2, "the pane kept spawning");
			const startedAt = Date.now();
			assert.deepEqual(await quiescePane(scope, 10_000), []);
			assert.ok(
				Date.now() - startedAt >= 500,
				"the in-flight request ran to completion instead of being killed",
			);
			await delay(300);
			assert.deepEqual(paneProcesses(scope), []);
		} finally {
			try {
				process.kill(-shell.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sidebar fixture holds", {
	skip: process.platform === "linux" ? false : "reads /proc",
}, () => {
	it("pins a running hold by PID, and waits for it to exit once its gate opens", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sidebar-hold-"));
		const start = join(dir, "start");
		const gate = join(dir, "gate");
		// In a session of its own, as Pi's bash tool runs it.
		const hold = spawn(
			"/bin/bash",
			["-c", holdCommand("START_X", start, gate)],
			{
				detached: true,
				stdio: "ignore",
			},
		);
		assert.ok(hold.pid);
		try {
			for (let attempt = 0; attempt < 100 && !existsSync(start); attempt++)
				await delay(20);
			const held = readHold(start, gate);
			assert.ok(held);
			assert.equal(held.pid, hold.pid);
			assert.ok(isHoldRunning(held));
			assert.deepEqual(await waitForHoldsToExit([held], 300), [held]);

			writeFileSync(gate, "go\n");
			assert.deepEqual(await waitForHoldsToExit([held], 5_000), []);
			assert.equal(isHoldRunning(held), false);
			assert.equal(readHold(start, gate), undefined);
		} finally {
			try {
				process.kill(-hold.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never claims a hold that did not start or a PID running another command", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sidebar-hold-"));
		const start = join(dir, "start");
		const gate = join(dir, "gate");
		try {
			assert.equal(readHold(start, gate), undefined);
			writeFileSync(start, "START_X\n");
			assert.equal(readHold(start, gate), undefined);
			writeFileSync(start, `START_X ${process.pid}\n`);
			assert.ok(
				!readFileSync(`/proc/${process.pid}/cmdline`, "utf8").includes(gate),
			);
			assert.equal(readHold(start, gate), undefined);
			assert.deepEqual(await waitForHoldsToExit([], 0), []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * A stand-in Herdr over real Git. Worktrees are real checkouts under `root`,
 * and the inventory is Git's own list of them. `fail` throws for a matching
 * call before it runs; `lose` runs the call and then garbles its answer.
 */
interface FakeHerdr {
	calls: string[];
	workspaces: Map<string, { label?: string; cwd: string; open: boolean }>;
	fail: (call: string) => boolean;
	lose: (call: string) => boolean;
	gitFail: (args: string[]) => boolean;
	refuseMarker: boolean;
	/** The repository Herdr's inventory claims to be for, if it lies. */
	reportRepo: string | undefined;
	/** Moves a checkout to another open workspace, as a stranger could. */
	reopen(path: string, label: string): string;
}

function fakeHerdr(root: string) {
	const workspaces = new Map<
		string,
		{ label?: string; cwd: string; open: boolean }
	>();
	/** Checkout path to its source repository and workspace. */
	const worktrees = new Map<string, { repo: string; workspace: string }>();
	const fake: FakeHerdr = {
		calls: [],
		workspaces,
		fail: () => false,
		lose: () => false,
		gitFail: () => false,
		refuseMarker: false,
		reportRepo: undefined,
		reopen(path, label) {
			const entry = worktrees.get(path);
			assert.ok(entry);
			const workspace = open(path, label);
			worktrees.set(path, { ...entry, workspace });
			return workspace;
		},
	};
	function open(cwd: string, label?: string): string {
		const id = `w${workspaces.size + 1}`;
		workspaces.set(id, { label, cwd, open: true });
		return id;
	}
	const flag = (args: string[], name: string) =>
		args[args.indexOf(name) + 1] ?? "";
	const answer = (call: string, result: JsonObject) =>
		fake.lose(call) ? "{" : JSON.stringify({ result });
	const inventory = (repo: string) =>
		execFileSync("git", ["worktree", "list", "--porcelain"], {
			cwd: repo,
			encoding: "utf8",
		})
			.trim()
			.split("\n\n")
			.map((block, index) => {
				const path = /^worktree (.*)$/m.exec(block)?.[1] ?? "";
				const branch = /^branch refs\/heads\/(.*)$/m.exec(block)?.[1];
				const row: Row = { branch, path, is_linked_worktree: index > 0 };
				const workspace = worktrees.get(path)?.workspace;
				if (workspace && workspaces.get(workspace)?.open)
					row.open_workspace_id = workspace;
				return row;
			});
	const commands: FixtureCommands = {
		herdr(args) {
			const call = args.slice(0, 2).join(" ");
			fake.calls.push(args.join(" "));
			if (fake.fail(call)) throw new Error(`herdr ${call} failed`);
			switch (call) {
				case "workspace create": {
					const workspace = open(flag(args, "--cwd"), flag(args, "--label"));
					return answer(call, { workspace: { workspace_id: workspace } });
				}
				case "worktree create": {
					const source = workspaces.get(flag(args, "--workspace"));
					assert.ok(source?.open, "worktree create needs an open workspace");
					const branch = flag(args, "--branch");
					const path = join(
						root,
						"worktrees",
						basename(source.cwd),
						branch.replaceAll("/", "-"),
					);
					mkdirSync(join(path, ".."), { recursive: true });
					herdrCommands.git(source.cwd, [
						"worktree",
						"add",
						"-q",
						"-b",
						branch,
						path,
					]);
					const workspace = open(path);
					worktrees.set(path, { repo: source.cwd, workspace });
					return answer(call, {
						workspace: { workspace_id: workspace },
						root_pane: { pane_id: `${workspace}:p1` },
						worktree: { path },
					});
				}
				case "worktree list": {
					const repo = flag(args, "--cwd");
					return answer(call, {
						source: { repo_root: fake.reportRepo ?? repo },
						worktrees: inventory(repo),
					});
				}
				case "worktree remove": {
					const workspace = flag(args, "--workspace");
					const [path, entry] =
						[...worktrees].find(([, held]) => held.workspace === workspace) ??
						[];
					assert.ok(path && entry, `no worktree in workspace ${workspace}`);
					herdrCommands.git(entry.repo, [
						"worktree",
						"remove",
						"--force",
						path,
					]);
					worktrees.delete(path);
					const closed = workspaces.get(workspace);
					if (closed) closed.open = false;
					return answer(call, {});
				}
				case "workspace close": {
					const workspace = workspaces.get(args[2] ?? "");
					assert.ok(workspace?.open, `workspace ${args[2]} is not open`);
					workspace.open = false;
					return answer(call, {});
				}
				case "workspace list":
					return answer(call, {
						workspaces: [...workspaces]
							.filter(([, workspace]) => workspace.open)
							.map(([workspace_id, { label }]) => ({ workspace_id, label })),
					});
				default:
					throw new Error(`unexpected herdr ${args.join(" ")}`);
			}
		},
		git(cwd, args) {
			fake.calls.push(`git ${args.join(" ")}`);
			if (fake.gitFail(args)) throw new Error(`git ${args[0]} failed`);
			herdrCommands.git(cwd, args);
		},
		reportMetadata: () =>
			Promise.resolve(
				fake.refuseMarker
					? { kind: "error", code: "pane_not_found", message: "refused" }
					: { kind: "result", result: {} },
			),
	};
	return { fake, commands };
}

describe("sidebar fixture foreign canary", () => {
	/** A scratch directory for the canary's repositories and checkouts. */
	async function withScratch(
		run: (scope: {
			tmp: string;
			fake: FakeHerdr;
			commands: FixtureCommands;
			acquire: (canary: Canary) => ReturnType<typeof acquireCanary>;
			repos: () => string[];
		}) => Promise<void>,
	): Promise<void> {
		const tmp = mkdtempSync(join(tmpdir(), "pi-sidebar-canary-"));
		const { fake, commands } = fakeHerdr(tmp);
		try {
			await run({
				tmp,
				fake,
				commands,
				acquire: (canary) =>
					acquireCanary(canary, { socket: "/fake.sock", commands, tmp }),
				repos: () =>
					readdirSync(tmp).filter((name) =>
						name.startsWith("pi-integ-sidebar-foreign-"),
					),
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	const openWorkspaces = (fake: {
		workspaces: Map<string, { open: boolean }>;
	}) => [...fake.workspaces].filter(([, w]) => w.open).map(([id]) => id);

	it("removes its worktree, then its source workspace, then its repository", () =>
		withScratch(async ({ fake, commands, acquire, repos }) => {
			const canary = planCanary("a");
			const held = await acquire(canary);
			assert.deepEqual(releaseCanary(canary, commands), {
				removed: [held.path, held.repo],
				residue: [],
			});
			assert.ok(!existsSync(held.path) && !existsSync(held.repo));
			assert.deepEqual(openWorkspaces(fake), []);
			assert.deepEqual(repos(), []);
			const removed = fake.calls.findIndex((c) =>
				c.startsWith("worktree remove"),
			);
			const closed = fake.calls.indexOf(`workspace close ${held.source}`);
			assert.ok(removed >= 0 && removed < closed, fake.calls.join("\n"));
			assert.deepEqual(releaseCanary(canary, commands), {
				removed: [],
				residue: [],
			});
		}));

	it("removes a checkout whose workspace closed with Git before its source", () =>
		withScratch(async ({ fake, commands, acquire }) => {
			const canary = planCanary("a");
			const held = await acquire(canary);
			commands.herdr(["workspace", "close", held.workspace]);
			assert.deepEqual(releaseCanary(canary, commands), {
				removed: [held.path, held.repo],
				residue: [],
			});
			assert.ok(
				fake.calls.includes(`git worktree remove --force ${held.path}`),
			);
			assert.ok(!fake.calls.some((c) => c.startsWith("worktree remove")));
			assert.ok(!existsSync(held.path) && !existsSync(held.repo));
			assert.deepEqual(openWorkspaces(fake), []);
		}));

	it("keeps its source and repository while its worktree cannot be verified", async () => {
		const faults: [string, (fake: FakeHerdr, path: string) => () => void][] = [
			[
				"unreadable",
				(fake) => {
					fake.fail = (call) => call === "worktree list";
					return () => (fake.fail = () => false);
				},
			],
			[
				"garbled",
				(fake) => {
					fake.lose = (call) => call === "worktree list";
					return () => (fake.lose = () => false);
				},
			],
			[
				"another repository's",
				(fake) => {
					fake.reportRepo = "/tmp/elsewhere";
					return () => (fake.reportRepo = undefined);
				},
			],
			[
				"another workspace's",
				(fake, path) => {
					fake.reopen(path, "stranger");
					return () => {};
				},
			],
		];
		for (const [name, inject] of faults)
			await withScratch(async ({ fake, commands, acquire }) => {
				const canary = planCanary("a");
				const held = await acquire(canary);
				const heal = inject(fake, held.path);
				const kept = releaseCanary(canary, commands);
				assert.deepEqual(kept.removed, [], name);
				assert.match(
					kept.residue.join("\n"),
					/^kept canary .+ worktree ownership unknown: /,
					name,
				);
				assert.ok(existsSync(held.path) && existsSync(held.repo), name);
				assert.ok(openWorkspaces(fake).includes(held.source), name);
				assert.ok(!fake.calls.includes(`workspace close ${held.source}`), name);
				heal();
				const retried = releaseCanary(canary, commands);
				if (name === "another workspace's")
					assert.equal(retried.residue.length, 1, name);
				else
					assert.deepEqual(
						retried,
						{ removed: [held.path, held.repo], residue: [] },
						name,
					);
			});
	});

	it("keeps its source and repository when removal fails or leaves the worktree listed", async () => {
		const faults: [
			string,
			RegExp,
			(scope: {
				fake: FakeHerdr;
				commands: FixtureCommands;
				workspace: string;
			}) => void,
		][] = [
			[
				"herdr refuses",
				/worktree removal failed: herdr worktree remove failed/,
				({ fake }) => {
					fake.fail = (call) => call === "worktree remove";
				},
			],
			[
				"git refuses",
				/worktree removal failed: git worktree failed/,
				({ fake, commands, workspace }) => {
					commands.herdr(["workspace", "close", workspace]);
					fake.gitFail = (args) =>
						args[0] === "worktree" && args[1] === "remove";
				},
			],
			[
				"herdr claims success",
				/still listed after removal \(open\)/,
				({ commands }) => {
					const herdr = commands.herdr;
					commands.herdr = (args) =>
						args[0] === "worktree" && args[1] === "remove" ? "{}" : herdr(args);
				},
			],
		];
		for (const [name, reason, inject] of faults)
			await withScratch(async ({ fake, commands, acquire }) => {
				const canary = planCanary("a");
				const held = await acquire(canary);
				inject({ fake, commands, workspace: held.workspace });
				const kept = releaseCanary(canary, commands);
				assert.deepEqual(kept.removed, [], name);
				assert.match(kept.residue.join("\n"), reason, name);
				assert.ok(existsSync(held.path) && existsSync(held.repo), name);
				assert.ok(openWorkspaces(fake).includes(held.source), name);
			});
	});

	it("checks its prerequisites before it acquires anything", () =>
		withScratch(async ({ fake, commands, tmp, acquire, repos }) => {
			const canary = planCanary("a");
			await assert.rejects(
				acquireCanary(canary, { socket: undefined, commands, tmp }),
				/HERDR_SOCKET_PATH is required/,
			);
			assert.deepEqual(canary.stage, { kind: "none" });
			assert.deepEqual(fake.calls, []);
			assert.deepEqual(repos(), []);
			await acquire(canary);
			await assert.rejects(acquire(canary), /already acquired/);
			assert.equal(releaseCanary(canary, commands).residue.length, 0);
		}));

	it("releases a setup that failed before its worktree was requested", async () => {
		const cases: [string, RegExp, (fake: FakeHerdr) => void, number][] = [
			[
				"git init fails",
				/git commit failed/,
				(fake) => {
					fake.gitFail = (args) => args[0] === "commit";
				},
				0,
			],
			[
				"workspace create fails",
				/herdr workspace create failed/,
				(fake) => {
					fake.fail = (call) => call === "workspace create";
				},
				0,
			],
			[
				"workspace create answer is lost",
				/unreadable answer creating workspace/,
				(fake) => {
					fake.lose = (call) => call === "workspace create";
				},
				1,
			],
		];
		for (const [name, failure, inject, created] of cases)
			await withScratch(async ({ fake, commands, acquire, repos }) => {
				const canary = planCanary("a");
				inject(fake);
				await assert.rejects(acquire(canary), failure, name);
				assert.equal(fake.workspaces.size, created, name);
				const stage = canary.stage;
				assert.ok(stage.kind === "repo" || stage.kind === "source", name);
				assert.deepEqual(
					releaseCanary(canary, commands),
					{ removed: [stage.repo], residue: [] },
					name,
				);
				assert.deepEqual(repos(), [], name);
				assert.deepEqual(openWorkspaces(fake), [], name);
				assert.ok(!fake.calls.some((c) => c.startsWith("worktree")), name);
			});
	});

	it("keeps its repository when it cannot tell whether a lost workspace exists", async () => {
		for (const fault of ["fail", "lose"] as const)
			await withScratch(async ({ fake, commands, acquire }) => {
				const canary = planCanary("a");
				fake.lose = (call) => call === "workspace create";
				await assert.rejects(acquire(canary));
				fake[fault] = (call) =>
					call === "workspace list" || call === "workspace create";
				const kept = releaseCanary(canary, commands);
				assert.match(
					kept.residue.join("\n"),
					/closing its source workspace failed/,
					fault,
				);
				const stage = canary.stage;
				assert.ok(stage.kind === "source" && existsSync(stage.repo), fault);
				assert.equal(openWorkspaces(fake).length, 1, fault);
				fake[fault] = () => false;
				assert.equal(releaseCanary(canary, commands).residue.length, 0, fault);
				assert.deepEqual(openWorkspaces(fake), [], fault);
			});
	});

	it("releases a setup that failed after its worktree was requested", async () => {
		const cases: [string, RegExp, (fake: FakeHerdr) => void, boolean][] = [
			[
				"worktree create fails",
				/herdr worktree create failed/,
				(fake) => {
					fake.fail = (call) => call === "worktree create";
				},
				false,
			],
			[
				"worktree create answer is lost",
				/unreadable answer creating worktree/,
				(fake) => {
					fake.lose = (call) => call === "worktree create";
				},
				true,
			],
			[
				"Herdr refuses the marker",
				/marking w2:p1 failed: \{"kind":"error"/,
				(fake) => {
					fake.refuseMarker = true;
				},
				true,
			],
		];
		for (const [name, failure, inject, created] of cases)
			await withScratch(async ({ tmp, fake, commands, acquire, repos }) => {
				const canary = planCanary("a");
				inject(fake);
				await assert.rejects(acquire(canary), failure, name);
				const stage = canary.stage;
				assert.equal(stage.kind, "worktree", name);
				const checkouts = join(tmp, "worktrees", basename(stage.repo));
				assert.equal(existsSync(checkouts), created, name);
				const report = releaseCanary(canary, commands);
				assert.deepEqual(report.residue, [], name);
				assert.equal(report.removed.length, created ? 2 : 1, name);
				assert.equal(report.removed.at(-1), stage.repo, name);
				assert.ok(!existsSync(checkouts), name);
				assert.deepEqual(repos(), [], name);
				assert.deepEqual(openWorkspaces(fake), [], name);
			});
	});

	it("tears down only its own repository and branch", () =>
		withScratch(async ({ fake, commands, acquire }) => {
			const mine = planCanary("a");
			const other = planCanary("b");
			const held = await acquire(mine);
			const kept = await acquire(other);
			assert.equal(releaseCanary(mine, commands).residue.length, 0);
			assert.ok(!existsSync(held.path));
			assert.ok(existsSync(kept.path) && existsSync(kept.repo));
			assert.deepEqual(
				openWorkspaces(fake).sort(),
				[kept.source, kept.workspace].sort(),
			);
			assert.equal(releaseCanary(other, commands).residue.length, 0);
		}));
});
