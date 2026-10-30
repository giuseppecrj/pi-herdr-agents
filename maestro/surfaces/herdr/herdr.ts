import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import {
	isBoolean,
	isFiniteNumber,
	isNonEmptyString,
	isPlainObject,
	isString,
} from "../../core/config/type-guards.ts";
import {
	isCompletePrimaryWorkspaceClaim,
	rememberOpenedPrimaryWorkspace,
	type OpenedPrimaryWorkspaceReport,
	type PrimaryWorkspaceClaim,
	type ReleasedPrimaryWorkspaceClaim,
} from "../../core/opened-primary-workspace.ts";
import { WorktreeProvisioningError } from "../../core/surface-provider.ts";
import {
	herdrExec,
	herdrExecAsync,
	parseHerdrJson,
	swapHerdrExecForTest,
	type HerdrExecForTest,
} from "./herdr-cli.ts";
import {
	isHerdrShellReady,
	parseHerdrPaneSnapshot,
	parsePaneGetError,
	parsePaneGetOutput,
	parsePaneProcessInfo,
} from "./herdr-pane.ts";

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
	/** Primary-workspace snapshot failures; the launch still succeeds. */
	diagnostics?: string[];
}

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
	// Legacy tab mode targets the caller workspace explicitly; Herdr's
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

export class HerdrWorktreeCreateError extends WorktreeProvisioningError {
	constructor(
		message: string,
		recoveredWorktree: Pick<
			HerdrWorktreeInfo,
			"path" | "branch" | "workspaceId"
		>,
	) {
		super(message, recoveredWorktree);
		this.name = "HerdrWorktreeCreateError";
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

function parseHerdrPaneList(output: string, workspaceId: string): string[] {
	const parsed = parseHerdrJson(output);
	if (
		parsed?.result?.type !== "pane_list" ||
		!Array.isArray(parsed.result.panes)
	) {
		throw new Error("Unexpected herdr pane list output");
	}
	const panes: Array<{ workspace_id?: unknown; pane_id?: unknown }> =
		parsed.result.panes;
	return panes
		.filter((pane) => pane.workspace_id === workspaceId)
		.map((pane) => pane.pane_id)
		.filter(isString);
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

/** Each launch snapshot: `worktree list` before and after create, and the opened workspace's `pane list`. */
export const OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS = 3_000;
export const OPENED_PRIMARY_SNAPSHOT_CALLS = 3;
/** Synchronous launch blocking if every snapshot runs to its timeout. */
export const OPENED_PRIMARY_SNAPSHOT_WORST_CASE_MS =
	OPENED_PRIMARY_SNAPSHOT_CALLS * OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS;

/** Each asynchronous removal read: `worktree list`, `workspace get`, `pane list`. */
export const OPENED_PRIMARY_REPORT_TIMEOUT_MS = 3_000;
export const OPENED_PRIMARY_REPORT_CALLS = 3;
/** Wall time added to a removal if every read runs to its timeout; the event loop is not blocked. */
export const OPENED_PRIMARY_REPORT_WORST_CASE_MS =
	OPENED_PRIMARY_REPORT_CALLS * OPENED_PRIMARY_REPORT_TIMEOUT_MS;

interface HerdrWorktreeSource {
	repoKey?: string;
	checkoutPath?: string;
	primaryWorkspaceId?: string;
}

type SnapshotPhase = "before create" | "after create" | "opened workspace";

function snapshotFailure(
	phase: SnapshotPhase,
	error: any,
	diagnostics: string[],
): void {
	diagnostics.push(
		`Primary workspace snapshot (${phase}) failed: ${error instanceof Error ? error.message : String(error)}`,
	);
}

function parseHerdrWorktreeSource(output: string): HerdrWorktreeSource {
	const parsed = parseHerdrJson(output);
	if (parsed?.result?.type !== "worktree_list") {
		throw new Error("Unexpected herdr worktree list output");
	}
	const source = parsed.result.source;
	const info: HerdrWorktreeSource = {};
	if (!isPlainObject(source)) return info;
	if (isNonEmptyString(source.repo_key)) info.repoKey = source.repo_key;
	if (isNonEmptyString(source.source_checkout_path))
		info.checkoutPath = source.source_checkout_path;
	if (isNonEmptyString(source.source_workspace_id))
		info.primaryWorkspaceId = source.source_workspace_id;
	return info;
}

function readHerdrWorktreeSource(
	cwd: string,
	timeout: number,
	phase: SnapshotPhase,
	diagnostics: string[],
): HerdrWorktreeSource | undefined {
	try {
		return parseHerdrWorktreeSource(
			herdrExec(["worktree", "list", "--cwd", cwd], timeout),
		);
	} catch (error) {
		snapshotFailure(phase, error, diagnostics);
		return undefined;
	}
}

interface ClaimedPane {
	paneId: string;
	terminalId?: string;
	cwd?: string;
	foregroundCwd?: string;
}

function parseClaimedPanes(output: string, workspaceId: string): ClaimedPane[] {
	const parsed = parseHerdrJson(output);
	if (
		parsed?.result?.type !== "pane_list" ||
		!Array.isArray(parsed.result.panes)
	) {
		throw new Error("Unexpected herdr pane list output");
	}
	const panes: ClaimedPane[] = [];
	for (const pane of parsed.result.panes) {
		if (!isPlainObject(pane) || pane.workspace_id !== workspaceId) continue;
		if (!isNonEmptyString(pane.pane_id)) continue;
		const record: ClaimedPane = { paneId: pane.pane_id };
		if (isNonEmptyString(pane.terminal_id))
			record.terminalId = pane.terminal_id;
		if (isNonEmptyString(pane.cwd)) record.cwd = pane.cwd;
		if (isNonEmptyString(pane.foreground_cwd))
			record.foregroundCwd = pane.foreground_cwd;
		panes.push(record);
	}
	return panes;
}

function readPrimaryTerminalId(
	workspaceId: string,
	timeout: number,
	diagnostics: string[],
): string | undefined {
	try {
		const panes = parseClaimedPanes(
			herdrExec(["pane", "list", "--workspace", workspaceId], timeout),
			workspaceId,
		);
		return panes.length === 1 ? panes[0].terminalId : undefined;
	} catch (error) {
		snapshotFailure("opened workspace", error, diagnostics);
		return undefined;
	}
}

function openedPrimaryClaim(
	source: HerdrWorktreeSource | undefined,
	timeout: number,
	diagnostics: string[],
): PrimaryWorkspaceClaim | undefined {
	if (!source?.primaryWorkspaceId || !source.repoKey || !source.checkoutPath)
		return undefined;
	const terminalId = readPrimaryTerminalId(
		source.primaryWorkspaceId,
		timeout,
		diagnostics,
	);
	if (!terminalId) return undefined;
	const claim: PrimaryWorkspaceClaim = {
		workspaceId: source.primaryWorkspaceId,
		repoKey: source.repoKey,
		terminalId,
		checkoutPath: source.checkoutPath,
	};
	return isCompletePrimaryWorkspaceClaim(claim) ? claim : undefined;
}

function withDiagnostics(
	worktree: HerdrWorktreeSurface,
	diagnostics: string[],
): HerdrWorktreeSurface {
	return diagnostics.length ? { ...worktree, diagnostics } : worktree;
}

export function createHerdrWorktree(
	name: string,
	cwd: string,
	branch: string,
	base: string,
	snapshotTimeoutMs = OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS,
): HerdrWorktreeSurface {
	// A failed before-snapshot claims nothing and skips the later snapshots.
	// Herdr does not report which workspace create opened, so a workspace that
	// appears during a long checkout can be misattributed. Removal only
	// suggests closing it; it never closes the workspace.
	const diagnostics: string[] = [];
	const before = readHerdrWorktreeSource(
		cwd,
		snapshotTimeoutMs,
		"before create",
		diagnostics,
	);
	const output = herdrExec(buildWorktreeCreateArgs(name, cwd, branch, base));
	const after =
		before && !before.primaryWorkspaceId
			? readHerdrWorktreeSource(
					cwd,
					snapshotTimeoutMs,
					"after create",
					diagnostics,
				)
			: undefined;
	const claim = openedPrimaryClaim(after, snapshotTimeoutMs, diagnostics);
	if (claim) rememberOpenedPrimaryWorkspace(claim);
	try {
		return withDiagnostics(
			retainWorktreeTab(extractHerdrWorktree(output), output),
			diagnostics,
		);
	} catch (parseError) {
		let recovered: HerdrWorktreeSurface | HerdrWorktreeInfo | undefined;
		try {
			recovered = recoverHerdrWorktree(cwd, branch);
		} catch {
			throw parseError;
		}
		if (recovered?.workspaceId && "paneId" in recovered)
			return withDiagnostics(retainWorktreeTab(recovered, output), diagnostics);
		if (recovered) {
			throw new HerdrWorktreeCreateError(
				`Herdr created branch ${branch}, but its workspace response was incomplete`,
				recovered,
			);
		}
		throw parseError;
	}
}

interface DecodedPrimaryWorkspace {
	label?: string;
	focused?: boolean;
	tabCount?: number;
	linked?: boolean;
	repoKey?: string;
	repoName?: string;
}

function decodePrimaryWorkspace(
	value: any,
): DecodedPrimaryWorkspace | undefined {
	if (!isPlainObject(value)) return undefined;
	const decoded: DecodedPrimaryWorkspace = {};
	if (isNonEmptyString(value.label)) decoded.label = value.label;
	if (isBoolean(value.focused)) decoded.focused = value.focused;
	if (isFiniteNumber(value.tab_count)) decoded.tabCount = value.tab_count;
	if (!isPlainObject(value.worktree)) return decoded;
	if (isBoolean(value.worktree.is_linked_worktree))
		decoded.linked = value.worktree.is_linked_worktree;
	if (isNonEmptyString(value.worktree.repo_key))
		decoded.repoKey = value.worktree.repo_key;
	if (isNonEmptyString(value.worktree.repo_name))
		decoded.repoName = value.worktree.repo_name;
	return decoded;
}

function workspaceLooksUntouched(
	workspace: DecodedPrimaryWorkspace | undefined,
	repoKey: string,
): boolean {
	return (
		workspace?.label !== undefined &&
		workspace.repoName !== undefined &&
		workspace.label === workspace.repoName &&
		workspace.focused === false &&
		workspace.tabCount === 1 &&
		workspace.linked === false &&
		workspace.repoKey === repoKey
	);
}

/**
 * Any open workspace in the listing other than the primary's own principal
 * row blocks the note, including rows whose linked flag is missing.
 */
function otherWorkspaceIsOpen(listing: string, primaryId: string): boolean {
	const worktrees = parseHerdrJson(listing)?.result?.worktrees;
	if (!Array.isArray(worktrees)) return true;
	return worktrees.some((row) => {
		if (!isPlainObject(row)) return true;
		const open = row.open_workspace_id;
		if (open === undefined || open === null) return false;
		return !(open === primaryId && row.is_linked_worktree === false);
	});
}

function sameCheckoutPath(left: string, right: string): boolean {
	if (left === right) return true;
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
}

function releaseClaim(
	claim: PrimaryWorkspaceClaim,
): ReleasedPrimaryWorkspaceClaim {
	return {
		workspaceId: claim.workspaceId,
		repoKey: claim.repoKey,
		terminalId: claim.terminalId,
	};
}

interface PrimaryInspection {
	release: ReleasedPrimaryWorkspaceClaim[];
	matched?: PrimaryWorkspaceClaim;
}

async function inspectOpenedPrimary(
	workspaceId: string,
	repoKey: string,
	named: readonly PrimaryWorkspaceClaim[],
): Promise<PrimaryInspection> {
	const decoded = decodePrimaryWorkspace(
		parseHerdrJson(
			await herdrExecAsync(
				["workspace", "get", workspaceId],
				OPENED_PRIMARY_REPORT_TIMEOUT_MS,
			),
		)?.result?.workspace,
	);
	if (!workspaceLooksUntouched(decoded, repoKey)) return { release: [] };
	const panes = parseClaimedPanes(
		await herdrExecAsync(
			["pane", "list", "--workspace", workspaceId],
			OPENED_PRIMARY_REPORT_TIMEOUT_MS,
		),
		workspaceId,
	);
	if (panes.length !== 1) return { release: [] };
	const pane = panes[0];
	const matched = pane.terminalId
		? named.find((claim) => claim.terminalId === pane.terminalId)
		: undefined;
	if (!matched) return { release: named.map(releaseClaim) };
	const stale = named.filter((claim) => claim !== matched).map(releaseClaim);
	if (
		!pane.cwd ||
		!pane.foregroundCwd ||
		!sameCheckoutPath(pane.cwd, matched.checkoutPath) ||
		!sameCheckoutPath(pane.foregroundCwd, matched.checkoutPath)
	)
		return { release: stale };
	return { release: stale, matched };
}

export function openedPrimaryWorkspaceNote(workspaceId: string): string {
	return `${workspaceId} appears to have been opened by worktree creation; if you haven't used it, close it with herdr workspace close ${workspaceId}`;
}

/**
 * Suggest closing a primary workspace this process recorded at worktree
 * creation when it still looks untouched. Never closes the workspace. At most
 * three asynchronous reads, each bounded by OPENED_PRIMARY_REPORT_TIMEOUT_MS,
 * all taken after the checkout is removed and immediately before the note.
 * Returns undefined when no claim applies to the source Herdr reports.
 */
export async function reportOpenedPrimaryWorkspace(
	cwd: string,
	claims: readonly PrimaryWorkspaceClaim[],
): Promise<OpenedPrimaryWorkspaceReport | undefined> {
	const complete = claims.filter(isCompletePrimaryWorkspaceClaim);
	if (!complete.length) return undefined;
	const listing = await herdrExecAsync(
		["worktree", "list", "--cwd", cwd],
		OPENED_PRIMARY_REPORT_TIMEOUT_MS,
	);
	const source = parseHerdrWorktreeSource(listing);
	if (!source.repoKey) return undefined;
	const repoKey = source.repoKey;
	const own = complete.filter((claim) => claim.repoKey === repoKey);
	if (!own.length) return undefined;
	const id = source.primaryWorkspaceId;
	const elsewhere = own
		.filter((claim) => claim.workspaceId !== id)
		.map(releaseClaim);
	const named = own.filter((claim) => claim.workspaceId === id);
	if (!id || !named.length || otherWorkspaceIsOpen(listing, id))
		return { repoKey, releasedClaims: elsewhere };
	const inspection = await inspectOpenedPrimary(id, repoKey, named);
	if (!inspection.matched)
		return { repoKey, releasedClaims: [...elsewhere, ...inspection.release] };
	return {
		note: openedPrimaryWorkspaceNote(id),
		repoKey,
		releasedClaims: [
			...elsewhere,
			...inspection.release,
			releaseClaim(inspection.matched),
		],
	};
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

export function sendHerdrCommand(surface: string, command: string): void {
	// pane run sends the text and Enter in a single socket request, avoiding
	// a race where Enter could arrive before the text is fully processed.
	herdrExec(["pane", "run", surface, command]);
}

export function sendHerdrKeys(surface: string, keys: string): void {
	herdrExec(["pane", "send-keys", surface, keys]);
}

export function sendHerdrEscape(surface: string): void {
	sendHerdrKeys(surface, "Escape");
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

async function withMockHerdrExec<T>(
	mock: HerdrExecForTest,
	run: () => Promise<T> | T,
): Promise<T> {
	const previous = swapHerdrExecForTest(mock);
	agentsTabs.clear();
	try {
		return await run();
	} finally {
		swapHerdrExecForTest(previous);
		agentsTabs.clear();
	}
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
	parseHerdrPaneList,
	parsePaneGetOutput,
	parsePaneGetError,
	parseHerdrPaneSnapshot,
	parsePaneProcessInfo,
	isHerdrShellReady,
	withMockHerdrExec,
};
