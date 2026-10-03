import { execFile, execSync, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { isFiniteNumber, isPlainObject, isString } from "./type-guards.ts";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
	if (commandAvailability.has(command)) {
		return commandAvailability.get(command)!;
	}

	let available = false;
	if (process.platform === "win32") {
		try {
			execFileSync("where.exe", [command], { stdio: "ignore" });
			available = true;
		} catch {
			try {
				execSync(`command -v ${command}`, { stdio: "ignore" });
				available = true;
			} catch {
				available = false;
			}
		}
	} else {
		try {
			execSync(`command -v ${command}`, { stdio: "ignore" });
			available = true;
		} catch {
			available = false;
		}
	}

	commandAvailability.set(command, available);
	return available;
}

export function isHerdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function parseHerdrJson(value: string) {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function extractHerdrPaneId(output: string, context: string): string {
	const parsed = parseHerdrJson(output);
	const paneId = parsed?.result?.pane?.pane_id;
	if (!isString(paneId) || !paneId) {
		throw new Error(
			`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`,
		);
	}
	return paneId;
}

function extractHerdrRootPaneId(output: string, context: string): string {
	const parsed = parseHerdrJson(output);
	const paneId = parsed?.result?.root_pane?.pane_id;
	if (!isString(paneId) || !paneId) {
		throw new Error(
			`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`,
		);
	}
	return paneId;
}

export interface HerdrWorktreeSurface {
	path: string;
	branch: string;
	workspaceId: string;
	paneId: string;
	/**
	 * Set only when this create call made Herdr open the source repository's
	 * primary workspace; a workspace the user already had open is not claimed.
	 */
	openedPrimaryWorkspaceId?: string;
	/** Herdr's `repo_key` of the source the claimed workspace belongs to. */
	openedPrimaryRepoKey?: string;
	/** Herdr `terminal_id` of the claimed workspace's only pane at create time. */
	openedPrimaryTerminalId?: string;
	/** Source checkout path the claimed workspace was opened at. */
	openedPrimaryCheckoutPath?: string;
}

/**
 * A primary workspace claim, bound to the source repository, the terminal that
 * existed in the workspace when this extension caused it to open, and the
 * checkout path that terminal started in.
 */
export interface PrimaryWorkspaceClaim {
	workspaceId: string;
	repoKey: string;
	terminalId: string;
	checkoutPath: string;
}

type OpenedPrimaryClaim = Pick<
	HerdrWorktreeSurface,
	| "openedPrimaryWorkspaceId"
	| "openedPrimaryRepoKey"
	| "openedPrimaryTerminalId"
	| "openedPrimaryCheckoutPath"
>;

function extractHerdrWorktree(output: string): HerdrWorktreeSurface {
	const parsed = parseHerdrJson(output);
	const result = parsed?.result;
	if (
		result?.type !== "worktree_created" ||
		!isString(result.workspace?.workspace_id) ||
		!result.workspace.workspace_id ||
		!isString(result.root_pane?.pane_id) ||
		!result.root_pane.pane_id ||
		!isString(result.worktree?.path) ||
		!result.worktree.path ||
		!isString(result.worktree.branch) ||
		!result.worktree.branch
	) {
		throw new Error(
			`Unexpected herdr worktree create output: ${output.trim() || "(empty)"}`,
		);
	}
	return {
		path: result.worktree.path,
		branch: result.worktree.branch,
		workspaceId: result.workspace.workspace_id,
		paneId: result.root_pane.pane_id,
	};
}

function herdrExec(args: string[], timeout?: number): string {
	return execFileSync("herdr", args, {
		stdio: "pipe",
		encoding: "utf8",
		timeout,
		killSignal: "SIGKILL",
	});
}

async function herdrExecAsync(
	args: string[],
	timeout?: number,
): Promise<string> {
	const { stdout } = await execFileAsync("herdr", args, {
		encoding: "utf8",
		timeout,
		killSignal: "SIGKILL",
	});
	return stdout;
}

function getHerdrParentPaneId(): string {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) {
		throw new Error("HERDR_PANE_ID not set");
	}
	return paneId;
}

function buildCurrentPaneArgs(): string[] {
	return ["pane", "current", "--current"];
}

interface HerdrCurrentPaneInfo {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
}

function getHerdrCurrentPaneInfo(): HerdrCurrentPaneInfo {
	// Inherited IDs go stale after a pane moves. Herdr resolves the calling
	// terminal's original identity to its live pane, tab, and workspace.
	const output = herdrExec(buildCurrentPaneArgs());
	const parsed = parseHerdrJson(output);
	const pane = parsed?.result?.pane;
	if (
		!isString(pane?.pane_id) ||
		!isString(pane?.tab_id) ||
		!isString(pane?.workspace_id)
	) {
		throw new Error(
			`Unexpected herdr pane current output: ${output.trim() || "(empty)"}`,
		);
	}
	return {
		pane_id: pane.pane_id,
		tab_id: pane.tab_id,
		workspace_id: pane.workspace_id,
	};
}

function buildTabCreateArgs(
	name: string,
	cwd: string,
	workspaceId: string,
): string[] {
	return [
		"tab",
		"create",
		"--workspace",
		workspaceId,
		"--label",
		name,
		"--cwd",
		cwd,
		"--no-focus",
	];
}

function buildPaneSplitArgs(
	parentPaneId: string,
	direction: "right" | "down",
	cwd: string,
): string[] {
	return [
		"pane",
		"split",
		parentPaneId,
		"--direction",
		direction,
		"--no-focus",
		"--cwd",
		cwd,
	];
}

function buildWorktreeCreateArgs(
	name: string,
	cwd: string,
	branch: string,
	base: string,
): string[] {
	return [
		"worktree",
		"create",
		"--cwd",
		cwd,
		"--branch",
		branch,
		"--base",
		base,
		"--label",
		name,
		"--no-focus",
	];
}

export function createHerdrSurface(name: string, cwd = process.cwd()): string {
	// Legacy tab mode and BTW target the caller workspace explicitly; Herdr's
	// implicit default may be another workspace.
	const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
	const output = herdrExec(buildTabCreateArgs(name, cwd, workspaceId));
	const paneId = extractHerdrRootPaneId(output, "tab create");
	try {
		herdrExec(["pane", "rename", paneId, name]);
	} catch {
		// Optional — pane label is cosmetic.
	}
	return paneId;
}

interface OwnedAgentsTab {
	workspaceId: string;
	panes: Set<string>;
	retainedPaneId?: string;
}

// In-memory ownership survives /reload, not process restart. Separate parent
// processes never adopt tabs by label or share a capacity reservation.
const agentsTabsKey = Symbol.for("pi-herdr-subagents:agents-tabs");
// SAFETY: this extension alone writes this process-local symbol.
const placementGlobal = globalThis as typeof globalThis & {
	[agentsTabsKey]?: Map<string, OwnedAgentsTab>;
};
const agentsTabs = (placementGlobal[agentsTabsKey] ??= new Map<
	string,
	OwnedAgentsTab
>());

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function containsCwd(root: string, cwd: string): boolean {
	const child = relative(root, cwd);
	return (
		child === "" ||
		(child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
	);
}

function placementPanes(): Array<{
	pane_id: string;
	tab_id: string;
	workspace_id: string;
}> {
	const parsed = parseHerdrJson(herdrExec(["pane", "list"]));
	const panes = parsed?.result?.panes;
	if (
		parsed?.result?.type !== "pane_list" ||
		!Array.isArray(panes) ||
		panes.some(
			(pane) =>
				!isString(pane?.pane_id) ||
				!isString(pane?.tab_id) ||
				!isString(pane?.workspace_id),
		)
	) {
		throw new Error("Unexpected herdr pane list output for placement");
	}
	return panes;
}

export function createHerdrGroupedSurface(
	name: string,
	cwd: string,
	maxPerTab: number,
	direction: "right" | "down",
): string {
	const callerWorkspace = getHerdrCurrentPaneInfo().workspace_id;
	const parsed = parseHerdrJson(herdrExec(["workspace", "list"]));
	const workspaces = parsed?.result?.workspaces;
	if (parsed?.result?.type !== "workspace_list" || !Array.isArray(workspaces)) {
		throw new Error("Unexpected herdr workspace list output for placement");
	}
	const panes = placementPanes();
	const target = canonicalPath(cwd);
	let workspaceId = callerWorkspace;
	let matchLength = -1;
	for (const workspace of workspaces) {
		if (!isString(workspace?.workspace_id))
			throw new Error("Unexpected herdr workspace identity");
		// Herdr exposes checkout ownership, but no stable non-Git workspace root.
		// A shell's incidental cwd is not a workspace association.
		const checkout = workspace.worktree?.checkout_path;
		if (!isString(checkout)) continue;
		const canonical = canonicalPath(checkout);
		if (
			containsCwd(canonical, target) &&
			(canonical.length > matchLength ||
				(canonical.length === matchLength &&
					workspace.workspace_id === callerWorkspace))
		) {
			workspaceId = workspace.workspace_id;
			matchLength = canonical.length;
		}
	}

	// The entire inspect/create/record window is synchronous, before launch's
	// first await. Overlapping launches in this parent cannot overbook a tab.
	let paneId: string | undefined;
	for (const [tabId, owned] of agentsTabs) {
		if (owned.workspaceId !== workspaceId) continue;
		const live = panes.filter(
			(pane) => pane.tab_id === tabId && pane.workspace_id === workspaceId,
		);
		if (live.length === 0) {
			agentsTabs.delete(tabId);
			continue;
		}
		if (live.length >= maxPerTab) continue;
		// The tab ID remains ours even when only user-added panes survive.
		const anchor =
			live.find((pane) => owned.panes.has(pane.pane_id)) ?? live[0];
		paneId = extractHerdrPaneId(
			herdrExec(buildPaneSplitArgs(anchor.pane_id, direction, cwd)),
			"pane split",
		);
		owned.panes.add(paneId);
		break;
	}
	if (!paneId) {
		const count = [...agentsTabs.values()].filter(
			(tab) => tab.workspaceId === workspaceId,
		).length;
		const label = count === 0 ? "Agents" : `Agents ${count + 1}`;
		const output = herdrExec(buildTabCreateArgs(label, cwd, workspaceId));
		paneId = extractHerdrRootPaneId(output, "tab create");
		const tabId = parseHerdrJson(output)?.result?.tab?.tab_id;
		if (!isString(tabId) || !tabId) {
			// Only the explicitly returned pane is ours to roll back.
			try {
				herdrExec(["pane", "close", paneId]);
			} catch {
				/* preserve parse error */
			}
			throw new Error("Unexpected herdr tab create identity");
		}
		agentsTabs.set(tabId, { workspaceId, panes: new Set([paneId]) });
	}
	try {
		herdrExec(["pane", "rename", paneId, name]);
	} catch {
		/* cosmetic */
	}
	return paneId;
}

/** Worktree records returned by `herdr worktree list`. */
export interface HerdrWorktreeInfo {
	/** Empty for a detached HEAD, matching cleanup's Git inspection. */
	branch: string;
	path: string;
	label?: string;
	workspaceId?: string;
	isLinkedWorktree: boolean;
}

export class HerdrWorktreeCreateError extends Error {
	readonly recoveredWorktree: Pick<
		HerdrWorktreeInfo,
		"path" | "branch" | "workspaceId"
	> &
		OpenedPrimaryClaim;

	constructor(
		message: string,
		recoveredWorktree: Pick<
			HerdrWorktreeInfo,
			"path" | "branch" | "workspaceId"
		> &
			OpenedPrimaryClaim,
	) {
		super(message);
		this.name = "HerdrWorktreeCreateError";
		this.recoveredWorktree = recoveredWorktree;
	}
}

export function parseHerdrWorktreeList(output: string): HerdrWorktreeInfo[] {
	const parsed = parseHerdrJson(output);
	const worktrees = parsed?.result?.worktrees;
	if (parsed?.result?.type !== "worktree_list" || !Array.isArray(worktrees)) {
		throw new Error("Unexpected herdr worktree list output");
	}
	return worktrees.map((worktree) => {
		if (
			!isPlainObject(worktree) ||
			!isString(worktree.path) ||
			(!isString(worktree.branch) &&
				!(worktree.branch === undefined && worktree.is_detached === true))
		) {
			throw new Error("Unexpected herdr worktree list entry");
		}
		const info: HerdrWorktreeInfo = {
			branch: isString(worktree.branch) ? worktree.branch : "",
			path: worktree.path,
			isLinkedWorktree: worktree.is_linked_worktree === true,
		};
		if (isString(worktree.label)) info.label = worktree.label;
		if (isString(worktree.open_workspace_id))
			info.workspaceId = worktree.open_workspace_id;
		return info;
	});
}

/** Source repository facts returned beside `herdr worktree list` rows. */
interface HerdrWorktreeSource {
	repoKey?: string;
	/** Checkout the source's primary workspace is opened at. */
	checkoutPath?: string;
	/** Absent when no workspace is open for the source checkout. */
	primaryWorkspaceId?: string;
}

function parseHerdrWorktreeSource(output: string): HerdrWorktreeSource {
	const parsed = parseHerdrJson(output);
	if (parsed?.result?.type !== "worktree_list") {
		throw new Error("Unexpected herdr worktree list output");
	}
	const source = parsed.result.source;
	const info: HerdrWorktreeSource = {};
	if (isPlainObject(source)) {
		if (isString(source.repo_key)) info.repoKey = source.repo_key;
		if (isString(source.source_checkout_path) && source.source_checkout_path)
			info.checkoutPath = source.source_checkout_path;
		if (isString(source.source_workspace_id) && source.source_workspace_id)
			info.primaryWorkspaceId = source.source_workspace_id;
	}
	return info;
}

export function buildWorktreeRemoveArgs(workspaceId: string): string[] {
	return ["worktree", "remove", "--workspace", workspaceId];
}

export function removeHerdrWorktree(
	workspaceId: string,
	timeout?: number,
): void {
	herdrExec(buildWorktreeRemoveArgs(workspaceId), timeout);
}

export function listHerdrWorktrees(
	cwd?: string,
	timeout?: number,
): HerdrWorktreeInfo[] {
	const args = ["worktree", "list"];
	if (cwd) args.push("--cwd", cwd);
	return parseHerdrWorktreeList(herdrExec(args, timeout));
}

interface HerdrPaneRecord {
	paneId: string;
	terminalId?: string;
	cwd?: string;
	foregroundCwd?: string;
}

function parseHerdrPaneRecords(
	output: string,
	workspaceId: string,
): HerdrPaneRecord[] {
	const parsed = parseHerdrJson(output);
	if (
		parsed?.result?.type !== "pane_list" ||
		!Array.isArray(parsed.result.panes)
	) {
		throw new Error("Unexpected herdr pane list output");
	}
	const panes: Array<{
		workspace_id?: unknown;
		pane_id?: unknown;
		terminal_id?: unknown;
		cwd?: unknown;
		foreground_cwd?: unknown;
	}> = parsed.result.panes;
	const records: HerdrPaneRecord[] = [];
	for (const pane of panes) {
		if (pane.workspace_id !== workspaceId || !isString(pane.pane_id)) continue;
		const record: HerdrPaneRecord = { paneId: pane.pane_id };
		if (isString(pane.terminal_id) && pane.terminal_id)
			record.terminalId = pane.terminal_id;
		if (isString(pane.cwd)) record.cwd = pane.cwd;
		if (isString(pane.foreground_cwd))
			record.foregroundCwd = pane.foreground_cwd;
		records.push(record);
	}
	return records;
}

function parseHerdrPaneList(output: string, workspaceId: string): string[] {
	return parseHerdrPaneRecords(output, workspaceId).map((pane) => pane.paneId);
}

function recoverHerdrWorktree(
	cwd: string,
	branch: string,
): HerdrWorktreeSurface | HerdrWorktreeInfo | undefined {
	const matches = listHerdrWorktrees(cwd).filter(
		(worktree) => worktree.branch === branch,
	);
	if (matches.length !== 1) return undefined;
	const worktree = matches[0];
	if (!worktree.workspaceId) return worktree;
	const panes = parseHerdrPaneList(
		herdrExec(["pane", "list", "--workspace", worktree.workspaceId]),
		worktree.workspaceId,
	);
	if (panes.length !== 1) return worktree;
	return {
		path: worktree.path,
		branch: worktree.branch,
		workspaceId: worktree.workspaceId,
		paneId: panes[0],
	};
}

function retainWorktreeTab(
	worktree: HerdrWorktreeSurface,
	output: string,
): HerdrWorktreeSurface {
	const returnedTabId = parseHerdrJson(output)?.result?.tab?.tab_id;
	const tabId =
		isString(returnedTabId) && returnedTabId
			? returnedTabId
			: placementPanes().find(
					(pane) =>
						pane.pane_id === worktree.paneId &&
						pane.workspace_id === worktree.workspaceId,
				)?.tab_id;
	if (tabId) {
		agentsTabs.set(tabId, {
			workspaceId: worktree.workspaceId,
			panes: new Set([worktree.paneId]),
			retainedPaneId: worktree.paneId,
		});
		try {
			herdrExec(["tab", "rename", tabId, "Agents"]);
		} catch {
			/* cosmetic */
		}
	}
	return worktree;
}

/** Bounds the extra snapshots so a stuck Herdr cannot stall a launch twice more. */
const WORKTREE_SNAPSHOT_TIMEOUT_MS = 10_000;

function readHerdrWorktreeSource(
	cwd: string,
	timeout: number,
): HerdrWorktreeSource | undefined {
	try {
		return parseHerdrWorktreeSource(
			herdrExec(["worktree", "list", "--cwd", cwd], timeout),
		);
	} catch {
		return undefined;
	}
}

/** The claimed workspace's terminal, or undefined unless it holds exactly one. */
function readPrimaryTerminalId(
	workspaceId: string,
	timeout: number,
): string | undefined {
	try {
		const panes = parseHerdrPaneRecords(
			herdrExec(["pane", "list", "--workspace", workspaceId], timeout),
			workspaceId,
		);
		return panes.length === 1 ? panes[0].terminalId : undefined;
	} catch {
		return undefined;
	}
}

export function createHerdrWorktree(
	name: string,
	cwd: string,
	branch: string,
	base: string,
	snapshotTimeoutMs = WORKTREE_SNAPSHOT_TIMEOUT_MS,
): HerdrWorktreeSurface {
	// Herdr groups a linked worktree with its source repository's primary
	// workspace and opens one when none exists. Without a trustworthy "before"
	// snapshot nothing is claimed (a timeout counts as unreadable), so an
	// unreadable snapshot only risks a leftover workspace, never closing one the
	// user owns.
	const before = readHerdrWorktreeSource(cwd, snapshotTimeoutMs);
	const output = herdrExec(buildWorktreeCreateArgs(name, cwd, branch, base));
	const after =
		before && !before.primaryWorkspaceId
			? readHerdrWorktreeSource(cwd, snapshotTimeoutMs)
			: undefined;
	// The claim also pins the opened workspace's terminal and start directory, so
	// a later workspace that reuses the id can never be mistaken for it.
	const terminalId =
		after?.primaryWorkspaceId && after.repoKey && after.checkoutPath
			? readPrimaryTerminalId(after.primaryWorkspaceId, snapshotTimeoutMs)
			: undefined;
	const claim: OpenedPrimaryClaim =
		after?.primaryWorkspaceId &&
		after.repoKey &&
		after.checkoutPath &&
		terminalId
			? {
					openedPrimaryWorkspaceId: after.primaryWorkspaceId,
					openedPrimaryRepoKey: after.repoKey,
					openedPrimaryTerminalId: terminalId,
					openedPrimaryCheckoutPath: after.checkoutPath,
				}
			: {};
	try {
		return {
			...retainWorktreeTab(extractHerdrWorktree(output), output),
			...claim,
		};
	} catch (parseError) {
		let recovered: HerdrWorktreeSurface | HerdrWorktreeInfo | undefined;
		try {
			recovered = recoverHerdrWorktree(cwd, branch);
		} catch {
			throw parseError;
		}
		if (recovered?.workspaceId && "paneId" in recovered)
			return { ...retainWorktreeTab(recovered, output), ...claim };
		if (recovered) {
			throw new HerdrWorktreeCreateError(
				`Herdr created branch ${branch}, but its workspace response was incomplete`,
				{ ...recovered, ...claim },
			);
		}
		throw parseError;
	}
}

/** Outcome of inspecting claimed primary workspaces for one source repository. */
export interface PrimaryWorkspaceCleanup {
	/** Why the workspace was closed or left open; absent when nothing applied. */
	note?: string;
	/** The workspace and terminal that were closed, when one was. */
	closedWorkspaceId?: string;
	closedTerminalId?: string;
	/** Source the result applies to; only claims bound to it may be updated. */
	repoKey: string;
	/** Claims for `repoKey` that can never match a workspace again. */
	releasedClaims: Array<
		Pick<PrimaryWorkspaceClaim, "workspaceId" | "terminalId">
	>;
}

/**
 * Whether `pid` has child processes: true or false when `pgrep` answered,
 * undefined when it could not run.
 */
export function shellHasChildProcesses(pid: number): boolean | undefined {
	try {
		execFileSync("pgrep", ["-P", String(pid)], {
			stdio: "pipe",
			encoding: "utf8",
			timeout: 5_000,
			killSignal: "SIGKILL",
		});
		return true;
	} catch (error) {
		// pgrep exits 1 when it ran and found no children; anything else (missing
		// binary, timeout, other exit codes) means the check did not complete.
		return error instanceof Error && "status" in error && error.status === 1
			? false
			: undefined;
	}
}

function samePath(a: string | undefined, b: string): boolean {
	if (!a) return false;
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/**
 * Close the source repository's primary workspace after its last linked
 * worktree was removed, but only when an earlier create call opened it
 * (`claims`, honored only for this source's `repo_key`) and nothing suggests
 * the user used it: the claimed terminal is still its only pane, that pane is
 * still at the source checkout, and its shell is idle with no child processes.
 * Claims for this source that can never match again (the workspace vanished,
 * was replaced, or holds another terminal) are reported as released. Returns
 * undefined when no claim applies to this source. Never passes `--group`.
 *
 * Command history alone (no cwd change, no background job) is not detectable,
 * so a workspace the user only typed in can still be closed.
 */
export function closeOpenedPrimaryWorkspace(
	cwd: string,
	claims: readonly PrimaryWorkspaceClaim[],
	timeout?: number,
	hasChildProcesses: (
		pid: number,
	) => boolean | undefined = shellHasChildProcesses,
): PrimaryWorkspaceCleanup | undefined {
	const listing = herdrExec(["worktree", "list", "--cwd", cwd], timeout);
	const source = parseHerdrWorktreeSource(listing);
	const repoKey = source.repoKey;
	const own = repoKey
		? claims.filter((claim) => claim.repoKey === repoKey)
		: [];
	if (!repoKey || !own.length) return undefined;
	const id = source.primaryWorkspaceId;
	const releasing = (
		released: readonly PrimaryWorkspaceClaim[],
		extra: Partial<PrimaryWorkspaceCleanup> = {},
	): PrimaryWorkspaceCleanup => ({
		repoKey,
		releasedClaims: released.map(({ workspaceId, terminalId }) => ({
			workspaceId,
			terminalId,
		})),
		...extra,
	});
	const elsewhere = own.filter((claim) => claim.workspaceId !== id);
	const result = (extra: Partial<PrimaryWorkspaceCleanup> = {}) =>
		releasing(elsewhere, extra);
	const named = own.filter((claim) => claim.workspaceId === id);
	if (!id || !named.length) return result();
	const keep = (
		reason: string,
		released: readonly PrimaryWorkspaceClaim[] = elsewhere,
	) =>
		releasing(released, {
			note: `Primary workspace ${id} left open: ${reason}.`,
		});
	const linked = parseHerdrWorktreeList(listing).filter(
		(worktree) => worktree.workspaceId && worktree.workspaceId !== id,
	);
	if (linked.length)
		return keep(
			`linked worktree workspace ${linked.map((worktree) => worktree.workspaceId).join(", ")} still open`,
		);
	const workspace = parseHerdrJson(herdrExec(["workspace", "get", id], timeout))
		?.result?.workspace;
	const group = workspace?.worktree;
	if (
		!isPlainObject(workspace) ||
		!isPlainObject(group) ||
		group.is_linked_worktree !== false ||
		group.repo_key !== repoKey
	)
		return keep("it is not the source repository's primary workspace");
	// A renamed, extended, or watched workspace is no longer the empty one
	// Herdr opened.
	if (workspace.label !== group.repo_name) return keep("its label was changed");
	if (workspace.focused === true) return keep("it is focused");
	if (workspace.tab_count !== 1)
		return keep("it does not hold exactly one tab");
	const panes = parseHerdrPaneRecords(
		herdrExec(["pane", "list", "--workspace", id], timeout),
		id,
	);
	if (panes.length !== 1) return keep("it does not hold exactly one pane");
	const pane = panes[0];
	// A reused workspace id, or a pane the user replaced, holds another terminal.
	const owned = named.filter((claim) => claim.terminalId === pane.terminalId);
	if (!owned.length)
		return keep("its terminal is not the one this extension recorded", own);
	const claim = owned[0];
	// The shell has left the checkout it was opened in: the user used it.
	if (
		!samePath(pane.cwd, claim.checkoutPath) ||
		(pane.foregroundCwd !== undefined &&
			!samePath(pane.foregroundCwd, claim.checkoutPath))
	)
		return keep("its pane is no longer at the source checkout");
	const info = getHerdrPaneProcessInfo(pane.paneId, timeout);
	if (!info.shellPid || info.foregroundProcessGroupId !== info.shellPid)
		return keep("its pane is not an idle shell");
	const children = hasChildProcesses(info.shellPid);
	if (children === undefined)
		return keep("its shell's child processes could not be checked");
	if (children) return keep("its shell has child processes");
	herdrExec(["workspace", "close", id], timeout);
	return result({
		note: `Closed primary workspace ${id}, which this extension opened.`,
		closedWorkspaceId: id,
		closedTerminalId: claim.terminalId,
	});
}

export function createHerdrSurfaceSplit(
	name: string,
	direction: "right" | "down",
	cwd = process.cwd(),
): string {
	const parentPaneId = getHerdrParentPaneId();
	const output = herdrExec(buildPaneSplitArgs(parentPaneId, direction, cwd));
	const paneId = extractHerdrPaneId(output, "pane split");
	try {
		herdrExec(["pane", "rename", paneId, name]);
	} catch {
		// Optional.
	}
	return paneId;
}

export function readHerdrScreen(surface: string, lines = 50): string {
	// `visible` is reliable for freshly created panes where herdr's `recent`
	// scrollback may not be populated yet.
	return herdrExec([
		"pane",
		"read",
		surface,
		"--source",
		"visible",
		"--lines",
		String(lines),
	]);
}

export async function readHerdrScreenAsync(
	surface: string,
	lines = 50,
): Promise<string> {
	return herdrExecAsync([
		"pane",
		"read",
		surface,
		"--source",
		"visible",
		"--lines",
		String(lines),
	]);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

type PaneInspectionResult =
	| {
			kind: "present";
			agent?: string;
			agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
	  }
	| { kind: "missing"; error?: string }
	| { kind: "unavailable"; error: string };

function parsePaneGetOutput(
	output: string,
	surface: string,
): PaneInspectionResult {
	const parsed = parseHerdrJson(output);
	const errorObj = parsed?.error;
	if (errorObj?.code === "pane_not_found" || errorObj?.code === "not_found") {
		return {
			kind: "missing",
			error: isString(errorObj.message) ? errorObj.message : "pane not found",
		};
	}
	const record = parsed?.result?.pane;
	if (!isPlainObject(record))
		return { kind: "unavailable", error: "pane get returned no pane record" };
	if (record.pane_id !== surface)
		return { kind: "unavailable", error: "pane id mismatch" };
	const agent = isString(record.agent) ? record.agent : undefined;
	const rawStatus = isString(record.agent_status)
		? record.agent_status
		: "unknown";
	const agentStatus =
		rawStatus === "idle" ||
		rawStatus === "working" ||
		rawStatus === "blocked" ||
		rawStatus === "done" ||
		rawStatus === "unknown"
			? rawStatus
			: "unknown";
	const result: PaneInspectionResult = { kind: "present", agentStatus };
	if (agent) result.agent = agent;
	return result;
}

function parsePaneGetError(error: any): PaneInspectionResult {
	for (const raw of [error?.stderr, error?.stdout]) {
		if (!isString(raw) || !raw.trim()) continue;
		try {
			const parsed = parsePaneGetOutput(raw, "");
			if (parsed.kind === "missing") return parsed;
		} catch {
			// A CLI may emit plain diagnostics on one stream and structured JSON on
			// the other. Parse each stream independently before giving up.
		}
		// Older/alternate Herdr builds may print the stable error code as plain
		// text rather than JSON. Only match explicit identifiers, not generic
		// prose such as "pane unavailable".
		if (/\b(?:pane_not_found|not_found)\b/.test(raw)) {
			return { kind: "missing", error: raw.trim() };
		}
	}
	const message = error?.message
		? String(error.message)
		: "herdr pane get failed";
	return { kind: "unavailable", error: message };
}

/**
 * Structured pane query.
 * - present: pane is reachable; agent/agentStatus may be present when detected
 * - missing: server responded, pane is gone
 * - unavailable: server command failed; caller should keep polling
 */
export interface HerdrPaneListEntry {
	paneId: string;
	workspaceId: string;
}

/** Parse only complete snapshots; partial lists never establish pane absence. */
export function parseHerdrPaneSnapshot(
	output: string,
): HerdrPaneListEntry[] | null {
	const parsed = parseHerdrJson(output);
	const panes = parsed?.result?.panes;
	if (parsed?.result?.type !== "pane_list" || !Array.isArray(panes))
		return null;
	const ids = new Set<string>();
	const result: HerdrPaneListEntry[] = [];
	for (const pane of panes) {
		if (
			!isString(pane?.pane_id) ||
			!pane.pane_id ||
			!isString(pane?.workspace_id) ||
			!pane.workspace_id ||
			ids.has(pane.pane_id)
		)
			return null;
		ids.add(pane.pane_id);
		result.push({ paneId: pane.pane_id, workspaceId: pane.workspace_id });
	}
	return result;
}

export async function listHerdrPanes(
	timeout?: number,
): Promise<HerdrPaneListEntry[] | null> {
	try {
		return parseHerdrPaneSnapshot(
			await herdrExecAsync(["pane", "list"], timeout),
		);
	} catch {
		return null;
	}
}

export async function inspectHerdrPane(
	surface: string,
): Promise<PaneInspectionResult> {
	try {
		return parsePaneGetOutput(
			await herdrExecAsync(["pane", "get", surface]),
			surface,
		);
	} catch (error: any) {
		return parsePaneGetError(error);
	}
}

export interface HerdrForegroundProcess {
	pid: number;
	name?: string;
	argv0?: string;
	argv?: string[];
	cwd?: string;
}

export interface HerdrPaneProcessInfo {
	paneId: string;
	shellPid?: number;
	foregroundProcessGroupId?: number;
	pids: number[];
	foregroundProcesses: HerdrForegroundProcess[];
}

export function parsePaneProcessInfo(
	output: string,
	paneId: string,
): HerdrPaneProcessInfo {
	const parsed = parseHerdrJson(output);
	const info = parsed?.result?.process_info;
	if (!isPlainObject(info)) {
		throw new Error(
			`Unexpected herdr pane process-info output: ${output.trim() || "(empty)"}`,
		);
	}
	if (isString(info.pane_id) && info.pane_id !== paneId) {
		throw new Error(
			`herdr pane process-info pane id mismatch: ${info.pane_id} != ${paneId}`,
		);
	}
	const pids = new Set<number>();
	if (Number.isInteger(info.shell_pid) && info.shell_pid > 0) {
		pids.add(info.shell_pid);
	}
	if (
		Number.isInteger(info.foreground_process_group_id) &&
		info.foreground_process_group_id > 0
	) {
		pids.add(info.foreground_process_group_id);
	}
	const foregroundProcesses: HerdrForegroundProcess[] = [];
	for (const process of info.foreground_processes ?? []) {
		if (Number.isInteger(process?.pid) && process.pid > 0) {
			pids.add(process.pid);
			const entry: HerdrForegroundProcess = { pid: process.pid };
			if (isString(process.name)) entry.name = process.name;
			if (isString(process.argv0)) entry.argv0 = process.argv0;
			if (Array.isArray(process.argv) && process.argv.every(isString)) {
				entry.argv = process.argv;
			}
			if (isString(process.cwd)) entry.cwd = process.cwd;
			foregroundProcesses.push(entry);
		}
	}
	const result: HerdrPaneProcessInfo = {
		paneId,
		pids: [...pids],
		foregroundProcesses,
	};
	if (isFiniteNumber(info.shell_pid)) result.shellPid = info.shell_pid;
	if (isFiniteNumber(info.foreground_process_group_id)) {
		result.foregroundProcessGroupId = info.foreground_process_group_id;
	}
	return result;
}

export function getHerdrPaneProcessInfo(
	surface: string,
	timeout?: number,
): HerdrPaneProcessInfo {
	return parsePaneProcessInfo(
		herdrExec(["pane", "process-info", "--pane", surface], timeout),
		surface,
	);
}

async function getHerdrPaneProcessInfoAsync(
	surface: string,
): Promise<HerdrPaneProcessInfo> {
	return parsePaneProcessInfo(
		await herdrExecAsync(["pane", "process-info", "--pane", surface]),
		surface,
	);
}

function isHerdrShellReady(info: HerdrPaneProcessInfo): boolean {
	return (
		info.shellPid != null && info.foregroundProcessGroupId === info.shellPid
	);
}

function isExpectedPiProcess(
	process: HerdrForegroundProcess,
	sessionFile: string,
	cwd: string,
): boolean {
	const sessionIndex = process.argv?.indexOf("--session") ?? -1;
	return (
		(process.name === "pi" || process.argv0?.split("/").pop() === "pi") &&
		sessionIndex >= 0 &&
		process.argv?.[sessionIndex + 1] === sessionFile &&
		process.cwd === cwd
	);
}

export async function waitForHerdrPiReady(
	surface: string,
	sessionFile: string,
	cwd: string,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	let lastError = "expected Pi process not observed";

	while (Date.now() <= deadline) {
		try {
			const info = await getHerdrPaneProcessInfoAsync(surface);
			if (
				info.foregroundProcesses.some((process) =>
					isExpectedPiProcess(process, sessionFile, cwd),
				)
			) {
				return;
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`Timed out waiting for Pi session ${sessionFile} in Herdr pane ${surface}: ${lastError}`,
	);
}

export async function waitForHerdrShellReady(
	surface: string,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	let lastError = "no interactive shell foreground process";

	while (Date.now() <= deadline) {
		if (options.signal?.aborted)
			throw new Error("Shell readiness wait cancelled.");
		try {
			if (isHerdrShellReady(await getHerdrPaneProcessInfoAsync(surface)))
				return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`Timed out waiting for interactive shell in Herdr pane ${surface}: ${lastError}`,
	);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// SAFETY: process.kill only throws Node's fs/process errors here, which
		// are always Error instances carrying an ErrnoException `code`.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function waitForProcessesExit(
	pids: readonly number[],
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		isAlive?: (pid: number) => boolean;
	} = {},
): Promise<number[]> {
	const isAlive = options.isAlive ?? isProcessAlive;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 50;
	const remaining = new Set(
		pids.filter((pid) => Number.isInteger(pid) && pid > 0 && isAlive(pid)),
	);
	const deadline = Date.now() + timeoutMs;
	while (remaining.size > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		for (const pid of remaining) {
			if (!isAlive(pid)) remaining.delete(pid);
		}
	}
	return [...remaining];
}

export async function waitForHerdrPaneAbsence(
	surface: string,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		inspect?: (surface: string) => Promise<PaneInspectionResult>;
	} = {},
): Promise<boolean> {
	const inspect = options.inspect ?? inspectHerdrPane;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const inspection = await inspect(surface);
		if (inspection.kind === "missing") return true;
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	const finalInspection = await inspect(surface);
	return finalInspection.kind === "missing";
}

export function sendHerdrCommand(surface: string, command: string): void {
	// pane run sends the text and Enter in a single socket request, avoiding
	// a race where Enter could arrive before the text is fully processed.
	herdrExec(["pane", "run", surface, command]);
}

export function sendHerdrEscape(surface: string): void {
	herdrExec(["pane", "send-keys", surface, "Escape"]);
}

export function closeHerdrSurface(surface: string): void {
	for (const owned of agentsTabs.values()) {
		if (owned.retainedPaneId === surface) return;
	}
	// Herdr removes a tab when its last pane closes. Never close a whole tab:
	// a user may have added a pane since our last snapshot.
	herdrExec(["pane", "close", surface]);
	// Keep tab ownership until placement observes that the tab is actually gone.
	for (const owned of agentsTabs.values()) owned.panes.delete(surface);
}

export function renameHerdrTab(title: string): void {
	const { tab_id: tabId } = getHerdrCurrentPaneInfo();
	herdrExec(["tab", "rename", tabId, title]);
}

export function renameHerdrWorkspace(title: string): void {
	const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
	herdrExec(["workspace", "rename", workspaceId, title]);
}

export function focusHerdrWorkspace(workspaceId: string): void {
	herdrExec(["workspace", "focus", workspaceId]);
}

export const __herdrTest__ = {
	buildCurrentPaneArgs,
	buildTabCreateArgs,
	buildPaneSplitArgs,
	buildWorktreeCreateArgs,
	buildWorktreeRemoveArgs,
	parseHerdrJson,
	extractHerdrPaneId,
	extractHerdrRootPaneId,
	extractHerdrWorktree,
	parseHerdrWorktreeList,
	parseHerdrWorktreeSource,
	parseHerdrPaneList,
	parsePaneGetOutput,
	parsePaneGetError,
	parseHerdrPaneSnapshot,
	parsePaneProcessInfo,
	isHerdrShellReady,
	isExpectedPiProcess,
};
