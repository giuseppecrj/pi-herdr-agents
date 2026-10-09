/**
 * Ownership and teardown for the sidebar lifecycle fixture. A marker token or
 * an "other workspace" never proves that the fixture owns a resource. The
 * fixture owns a worktree only when its own launch record and Herdr's
 * inventory of its own source repository agree on the branch, checkout, and
 * workspace. The foreign canary is owned on the same terms.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
	requestHerdrSocket,
	type HerdrSocketReply,
} from "../../maestro/surfaces/herdr/herdr-socket.ts";
import type { JsonObject } from "../../maestro/core/config/type-guards.ts";

export const TOKEN = "piha_delegated_v1";

/** The commands fixture setup and teardown run. Unit tests replace them. */
export interface FixtureCommands {
	/** `herdr <args>`'s output; throws when the command fails. */
	herdr(args: string[]): string;
	git(cwd: string, args: string[]): void;
	reportMetadata(socket: string, params: JsonObject): Promise<HerdrSocketReply>;
}

/**
 * The real commands. Neither CLI call has a timeout: a call returns only
 * after Herdr answered or the request failed, so nothing it asked for can
 * appear after cleanup has looked.
 */
export const herdrCommands: FixtureCommands = {
	herdr: (args) =>
		execFileSync("herdr", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	git: (cwd, args) => {
		execFileSync("git", args, { cwd, stdio: "pipe" });
	},
	reportMetadata: (socket, params) =>
		requestHerdrSocket(socket, "pane.report_metadata", params),
};

const InventoryRow = Type.Object({
	branch: Type.Optional(Type.String()),
	path: Type.String(),
	is_linked_worktree: Type.Boolean(),
	open_workspace_id: Type.Optional(Type.String()),
});

/** `herdr worktree list --cwd <source> --json`. */
const Inventory = Type.Object({
	result: Type.Object({
		source: Type.Object({ repo_root: Type.String() }),
		worktrees: Type.Array(InventoryRow),
	}),
});

export type Inventory = Static<typeof Inventory>;

/** A `worktree-runs/<id>.json` record, written before Herdr creates anything. */
const LaunchRecord = Type.Object({
	id: Type.String(),
	state: Type.Optional(Type.String()),
	name: Type.String(),
	sourceCwd: Type.String(),
	branch: Type.String(),
	path: Type.Optional(Type.String()),
	workspaceId: Type.Optional(Type.String()),
	paneId: Type.Optional(Type.String()),
});

export type LaunchRecord = Static<typeof LaunchRecord>;

function parseJson<T extends TSchema>(
	schema: T,
	text: string,
): Static<T> | undefined {
	try {
		const value = JSON.parse(text);
		return Value.Check(schema, value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function parseInventory(text: string): Inventory | undefined {
	return parseJson(Inventory, text);
}

export function parseLaunchRecord(text: string): LaunchRecord | undefined {
	return parseJson(LaunchRecord, text);
}

/** The worktree one fixture launch asked for, in its own source repository. */
export interface ExpectedWorktree {
	repoRoot: string;
	branch: string;
	name: string;
}

export type WorktreeOwnership =
	| { kind: "absent" }
	| {
			kind: "open";
			path: string;
			workspace: string;
			record: LaunchRecord;
	  }
	| { kind: "checkout"; path: string; record: LaunchRecord }
	| { kind: "unknown"; reason: string };

/**
 * Judges whether Herdr lists a worktree this launch created. Anything that
 * does not match the launch record exactly is unknown, never removable.
 */
export function judgeWorktreeOwnership(
	expected: ExpectedWorktree,
	inventory: Inventory,
	records: LaunchRecord[],
): WorktreeOwnership {
	const { source, worktrees } = inventory.result;
	if (source.repo_root !== expected.repoRoot)
		return {
			kind: "unknown",
			reason: `inventory is for ${source.repo_root}, not ${expected.repoRoot}`,
		};
	const matching = records.filter(
		(record) =>
			record.branch === expected.branch &&
			record.name === expected.name &&
			record.sourceCwd === expected.repoRoot,
	);
	const rows = worktrees.filter((row) => row.branch === expected.branch);
	if (rows.length === 0) return { kind: "absent" };
	if (rows.length > 1 || matching.length !== 1)
		return {
			kind: "unknown",
			reason: `${rows.length} worktrees and ${matching.length} launch records for ${expected.branch}`,
		};
	const [row] = rows;
	const [record] = matching;
	if (!row.is_linked_worktree || row.path === expected.repoRoot)
		return { kind: "unknown", reason: `${row.path} is not a linked worktree` };
	if (record.path !== undefined && record.path !== row.path)
		return {
			kind: "unknown",
			reason: `launch record path ${record.path} differs from ${row.path}`,
		};
	if (row.open_workspace_id === undefined)
		return { kind: "checkout", path: row.path, record };
	if (
		record.workspaceId !== undefined &&
		record.workspaceId !== row.open_workspace_id
	)
		return {
			kind: "unknown",
			reason: `launch record workspace ${record.workspaceId} differs from ${row.open_workspace_id}`,
		};
	return {
		kind: "open",
		path: row.path,
		workspace: row.open_workspace_id,
		record,
	};
}

/**
 * Every launch record a parent session in `sessionDir` wrote, or undefined
 * when any of them is unreadable.
 */
export function readLaunchRecords(
	sessionDir: string,
): LaunchRecord[] | undefined {
	const artifacts = join(sessionDir, "artifacts");
	if (!existsSync(artifacts)) return [];
	const records: LaunchRecord[] = [];
	for (const session of readdirSync(artifacts)) {
		const dir = join(artifacts, session, "worktree-runs");
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
			const record = parseLaunchRecord(readFileSync(join(dir, file), "utf8"));
			if (!record) return undefined;
			records.push(record);
		}
	}
	return records;
}

/** Herdr's worktree inventory for one repository, or undefined if unreadable. */
export function readWorktreeInventory(
	sourceDir: string,
	commands: FixtureCommands = herdrCommands,
): Inventory | undefined {
	try {
		return parseInventory(
			commands.herdr(["worktree", "list", "--cwd", sourceDir, "--json"]),
		);
	} catch {
		return undefined;
	}
}

/** The fixture's verified worktree, read from its own records and Herdr. */
export function findOwnedWorktree(
	expected: ExpectedWorktree,
	sessionDir: string,
): WorktreeOwnership {
	const records = readLaunchRecords(sessionDir);
	if (!records) return { kind: "unknown", reason: "unreadable launch record" };
	const inventory = readWorktreeInventory(expected.repoRoot);
	if (!inventory)
		return { kind: "unknown", reason: "unreadable Herdr worktree inventory" };
	return judgeWorktreeOwnership(expected, inventory, records);
}

export type WorktreeRemoval =
	| { kind: "absent" }
	| { kind: "removed"; path: string }
	| { kind: "residue"; reason: string };

/**
 * Removes the worktree `find` says the fixture owns, then requires `find` to
 * report it absent. Unknown ownership, a failed removal, or a worktree still
 * listed afterwards is residue: the caller must then keep the source
 * repository, which the checkout still points at. Never throws.
 */
export function removeOwnedWorktree(
	find: () => WorktreeOwnership,
	repoRoot: string,
	commands: FixtureCommands = herdrCommands,
): WorktreeRemoval {
	try {
		const found = find();
		switch (found.kind) {
			case "absent":
				return found;
			case "unknown":
				return {
					kind: "residue",
					reason: `worktree ownership unknown: ${found.reason}`,
				};
			case "open":
				commands.herdr([
					"worktree",
					"remove",
					"--workspace",
					found.workspace,
					"--force",
					"--json",
				]);
				break;
			case "checkout":
				// Run from the source repository, Git removes only its own worktree.
				commands.git(repoRoot, ["worktree", "remove", "--force", found.path]);
				break;
			default: {
				const _exhaustive: never = found;
				return _exhaustive;
			}
		}
		const after = find();
		if (after.kind !== "absent")
			return {
				kind: "residue",
				reason: `${found.path} still listed after removal (${after.kind})`,
			};
		// Herdr can leave the directory named after the source repository
		// behind, empty; rmdir refuses anything else.
		try {
			rmdirSync(dirname(found.path));
		} catch {
			// Not empty, or already gone.
		}
		return { kind: "removed", path: found.path };
	} catch (error) {
		return {
			kind: "residue",
			reason: `worktree removal failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function initRepository(
	dir: string,
	commands: FixtureCommands = herdrCommands,
): void {
	const git = (args: string[]) => commands.git(dir, args);
	git(["init", "-q", "-b", "main"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Integration Test"]);
	git(["config", "commit.gpgsign", "false"]);
	writeFileSync(join(dir, "README.md"), "sidebar fixture\n");
	writeFileSync(join(dir, ".gitignore"), ".pi/\nsidebar-parent-*.jsonl\n");
	git(["add", "README.md", ".gitignore"]);
	git(["commit", "-qm", "fixture"]);
}

export interface CleanupReport {
	removed: string[];
	residue: string[];
}

/**
 * What the canary holds so far. Each stage is recorded before the request
 * for the next resource, so teardown knows everything that may exist.
 */
export type CanaryStage =
	| { kind: "none" }
	| { kind: "repo"; repo: string }
	/** `source` is undefined while Herdr's answer to the create is unknown. */
	| { kind: "source"; repo: string; source: string | undefined }
	/** The record is written before the worktree is requested. */
	| { kind: "worktree"; repo: string; source: string; record: LaunchRecord };

/**
 * A marked worktree that another parent seems to have launched, in a
 * repository of its own with a unique label and branch. The fixture owns it
 * on the same terms as its own launch.
 */
export interface Canary {
	label: string;
	branch: string;
	stage: CanaryStage;
}

export function planCanary(id: string): Canary {
	return {
		label: `pi-integ-foreign-${id}`,
		branch: `foreign/marked-${id}`,
		stage: { kind: "none" },
	};
}

const WorkspaceCreated = Type.Object({
	result: Type.Object({
		workspace: Type.Object({ workspace_id: Type.String() }),
	}),
});

const WorktreeCreated = Type.Object({
	result: Type.Object({
		workspace: Type.Object({ workspace_id: Type.String() }),
		root_pane: Type.Object({ pane_id: Type.String() }),
		worktree: Type.Object({ path: Type.String() }),
	}),
});

const WorkspaceList = Type.Object({
	result: Type.Object({
		workspaces: Type.Array(
			Type.Object({
				workspace_id: Type.String(),
				label: Type.Optional(Type.String()),
			}),
		),
	}),
});

export interface CanaryWorktree {
	repo: string;
	source: string;
	workspace: string;
	pane: string;
	path: string;
}

/**
 * Creates the canary's repository, source workspace, and worktree, and marks
 * the worktree's pane live. On any failure, everything recorded so far is
 * left in `canary.stage` for `releaseCanary`.
 */
export async function acquireCanary(
	canary: Canary,
	options: {
		socket: string | undefined;
		commands?: FixtureCommands;
		tmp?: string;
	},
): Promise<CanaryWorktree> {
	const { socket, commands = herdrCommands, tmp = tmpdir() } = options;
	if (!socket) throw new Error("HERDR_SOCKET_PATH is required to mark a pane");
	if (canary.stage.kind !== "none")
		throw new Error(`canary ${canary.label} was already acquired`);
	const repo = realpathSync(
		mkdtempSync(join(tmp, "pi-integ-sidebar-foreign-")),
	);
	canary.stage = { kind: "repo", repo };
	initRepository(repo, commands);

	canary.stage = { kind: "source", repo, source: undefined };
	const source = parseJson(
		WorkspaceCreated,
		commands.herdr([
			"workspace",
			"create",
			"--cwd",
			repo,
			"--label",
			canary.label,
			"--no-focus",
		]),
	)?.result.workspace.workspace_id;
	if (source === undefined)
		throw new Error(`unreadable answer creating workspace ${canary.label}`);
	canary.stage = { kind: "source", repo, source };

	const record: LaunchRecord = {
		id: canary.label,
		name: canary.label,
		sourceCwd: repo,
		branch: canary.branch,
	};
	canary.stage = { kind: "worktree", repo, source, record };
	const created = parseJson(
		WorktreeCreated,
		commands.herdr([
			"worktree",
			"create",
			"--workspace",
			source,
			"--branch",
			canary.branch,
			"--no-focus",
		]),
	)?.result;
	if (!created)
		throw new Error(`unreadable answer creating worktree ${canary.branch}`);
	record.path = created.worktree.path;
	record.workspaceId = created.workspace.workspace_id;
	record.paneId = created.root_pane.pane_id;

	const reply = await commands.reportMetadata(socket, {
		pane_id: record.paneId,
		source: "pi-integ-foreign",
		seq: 1,
		tokens: { [TOKEN]: "live" },
	});
	if (reply.kind !== "result")
		throw new Error(
			`marking ${record.paneId} failed: ${JSON.stringify(reply)}`,
		);
	return {
		repo,
		source,
		workspace: record.workspaceId,
		pane: record.paneId,
		path: record.path,
	};
}

/** The canary's worktree, judged by its own record and repository only. */
export function findCanaryWorktree(
	canary: Canary,
	commands: FixtureCommands = herdrCommands,
): WorktreeOwnership {
	if (canary.stage.kind !== "worktree") return { kind: "absent" };
	const { repo, record } = canary.stage;
	const inventory = readWorktreeInventory(repo, commands);
	if (!inventory)
		return { kind: "unknown", reason: "unreadable Herdr worktree inventory" };
	return judgeWorktreeOwnership(
		{ repoRoot: repo, branch: canary.branch, name: canary.label },
		inventory,
		[record],
	);
}

/** The source workspace, found by its unique label when its ID is unknown. */
function closeCanarySource(
	canary: Canary,
	source: string | undefined,
	commands: FixtureCommands,
): void {
	if (source === undefined) {
		const listed = parseJson(
			WorkspaceList,
			commands.herdr(["workspace", "list"]),
		);
		if (!listed) throw new Error("unreadable Herdr workspace list");
		const matching = listed.result.workspaces.filter(
			(workspace) => workspace.label === canary.label,
		);
		if (matching.length > 1)
			throw new Error(`${matching.length} workspaces named ${canary.label}`);
		if (matching.length === 0) return;
		source = matching[0].workspace_id;
	}
	commands.herdr(["workspace", "close", source]);
}

/**
 * Releases what the canary holds, last acquired first. The source workspace
 * and repository go only after the worktree is verified absent; otherwise
 * they stay, and the report says why. Never throws, and can be retried.
 */
export function releaseCanary(
	canary: Canary,
	commands: FixtureCommands = herdrCommands,
): CleanupReport {
	const report: CleanupReport = { removed: [], residue: [] };
	const stage = canary.stage;
	if (stage.kind === "none") return report;
	if (stage.kind === "worktree") {
		const removal = removeOwnedWorktree(
			() => findCanaryWorktree(canary, commands),
			stage.repo,
			commands,
		);
		if (removal.kind === "residue") {
			report.residue.push(
				`kept canary ${stage.repo} and workspace ${stage.source}: ${removal.reason}`,
			);
			return report;
		}
		if (removal.kind === "removed") report.removed.push(removal.path);
		canary.stage = { kind: "source", repo: stage.repo, source: stage.source };
	}
	if (canary.stage.kind === "source") {
		try {
			closeCanarySource(canary, canary.stage.source, commands);
		} catch (error) {
			report.residue.push(
				`kept canary ${stage.repo}: closing its source workspace failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return report;
		}
		canary.stage = { kind: "repo", repo: stage.repo };
	}
	try {
		rmSync(stage.repo, { recursive: true, force: true });
	} catch (error) {
		report.residue.push(
			`removing canary ${stage.repo} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return report;
	}
	report.removed.push(stage.repo);
	canary.stage = { kind: "none" };
	return report;
}

/** `herdr pane process-info --pane <id>`. */
const PaneProcessInfo = Type.Object({
	result: Type.Object({
		process_info: Type.Object({
			shell_pid: Type.Number(),
			foreground_processes: Type.Array(Type.Object({ pid: Type.Number() })),
		}),
	}),
});

export type PaneProcessInfo = Static<
	typeof PaneProcessInfo
>["result"]["process_info"];

/** A pane's shell and foreground processes, or undefined if unreadable. */
export function readPaneProcessInfo(pane: string): PaneProcessInfo | undefined {
	try {
		return parseJson(
			PaneProcessInfo,
			execFileSync("herdr", ["pane", "process-info", "--pane", pane], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		)?.result.process_info;
	} catch {
		return undefined;
	}
}

/** The processes a pane's shell started: its session, under its Herdr identity. */
export interface PaneProcessScope {
	pane: string;
	shellPid: number;
	socket: string | undefined;
}

interface ProcessEntry {
	pid: number;
	argv0: string;
	stopped: boolean;
}

function readProcessEntry(
	pid: number,
	scope: PaneProcessScope,
): ProcessEntry | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (Number(fields[3]) !== scope.shellPid) return undefined;
		const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
		if (!environ.includes(`HERDR_PANE_ID=${scope.pane}`)) return undefined;
		if (scope.socket && !environ.includes(`HERDR_SOCKET_PATH=${scope.socket}`))
			return undefined;
		const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
		return { pid, argv0, stopped: fields[0] === "T" };
	} catch {
		return undefined;
	}
}

export function paneProcesses(scope: PaneProcessScope): ProcessEntry[] {
	return readdirSync("/proc")
		.filter((name) => /^\d+$/.test(name))
		.flatMap((name) => readProcessEntry(Number(name), scope) ?? []);
}

function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch {
		// Already gone.
	}
}

/**
 * The shell line a held child runs. It writes its marker and its own PID to
 * `startFile`, then waits for `gate`, bounded. Pi runs it in a session of
 * its own, so when that Pi is killed the loop keeps running, and only the
 * gate or the bound ends it.
 */
export function holdCommand(
	marker: string,
	startFile: string,
	gate: string,
): string {
	return `echo '${marker}' $$ > '${startFile}'; for i in $(seq 600); do [ -e '${gate}' ] && break; sleep 0.2; done`;
}

/** A hold, pinned by its PID and kernel start time. */
export interface HeldProcess {
	pid: number;
	startTime: string;
}

/** The process's start time, or undefined once it has exited or is a zombie. */
function liveStartTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[0] === "Z" ? undefined : fields[19];
	} catch {
		return undefined;
	}
}

/**
 * The hold that wrote `startFile`, while its command line still names `gate`.
 * Undefined when it never started or has exited.
 */
export function readHold(
	startFile: string,
	gate: string,
): HeldProcess | undefined {
	let pid: number;
	try {
		pid = Number(readFileSync(startFile, "utf8").trim().split(/\s+/)[1]);
	} catch {
		return undefined;
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const startTime = liveStartTime(pid);
	try {
		if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(gate))
			return undefined;
	} catch {
		return undefined;
	}
	// The same process before and after its command line was read.
	return startTime !== undefined && liveStartTime(pid) === startTime
		? { pid, startTime }
		: undefined;
}

export function isHoldRunning(hold: HeldProcess): boolean {
	return liveStartTime(hold.pid) === hold.startTime;
}

/** Waits for each hold to exit. Returns the holds still running at the bound. */
export async function waitForHoldsToExit(
	holds: HeldProcess[],
	timeoutMs = 10_000,
): Promise<HeldProcess[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const running = holds.filter(isHoldRunning);
		if (running.length === 0 || Date.now() > deadline) return running;
		await delay(50);
	}
}

/**
 * Stops a pane's launch work so nothing it starts can create a resource
 * after cleanup scans for one. Every process is frozen first, so none can
 * start another. In-flight `herdr` requests then finish, and everything else
 * is killed. Returns the processes still alive after the bound.
 */
export async function quiescePane(
	scope: PaneProcessScope,
	timeoutMs = 30_000,
): Promise<number[]> {
	const frozen = new Set<number>();
	for (let pass = 0; pass < 50; pass++) {
		const fresh = paneProcesses(scope).filter(({ pid }) => !frozen.has(pid));
		if (fresh.length === 0) break;
		for (const { pid } of fresh) {
			signal(pid, "SIGSTOP");
			frozen.add(pid);
		}
	}
	for (const entry of paneProcesses(scope)) {
		if (basename(entry.argv0) === "herdr") signal(entry.pid, "SIGCONT");
		else signal(entry.pid, "SIGKILL");
	}
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const alive = paneProcesses(scope).map(({ pid }) => pid);
		if (alive.length === 0 || Date.now() > deadline) return alive;
		await delay(100);
	}
}
