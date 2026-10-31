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
import {
	AcquisitionUncertainError,
	isAcquisitionUncertainError,
	WorktreeProvisioningError,
	type AcquisitionControl,
	type RecoveredWorktreeProvisioning,
	type UncertainAcquisition,
} from "../../core/surface-provider.ts";
import { Deadline } from "../../core/deadline.ts";
import {
	herdrExec,
	herdrExecAsync,
	HerdrClientError,
	HERDR_PLACEMENT_TIMEOUT_MS,
	HERDR_WORKTREE_TIMEOUT_MS,
	HERDR_RECONCILE_TIMEOUT_MS,
	HERDR_COSMETIC_TIMEOUT_MS,
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

async function getHerdrCurrentPaneInfo(
	timeout?: number,
): Promise<HerdrCurrentPaneInfo> {
	// Inherited IDs go stale after a pane moves. Herdr resolves the calling
	// terminal's original identity to its live pane, tab, and workspace.
	const output = await herdrExecAsync(buildCurrentPaneArgs(), timeout);
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

async function mutate<T>(
	args: string[],
	deadline: Deadline,
	uncertainty: UncertainAcquisition,
	parse: (output: string) => T,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const timeout = deadline.remainingMs();
	let output: string | undefined;
	try {
		output = await herdrExecAsync(args, timeout);
		return parse(output);
	} catch (error) {
		if (error instanceof HerdrClientError) {
			if (error.kind === "not-spawned") throw error;
			output ??= error.stdout;
		}
		// Untimely/partial receipts can name retained resources, never authorize
		// late dispatch, adoption by label, or automatic deletion.
		const result = parseHerdrJson(output ?? "")?.result;
		const paneId = result?.root_pane?.pane_id ?? result?.pane?.pane_id;
		if (uncertainty.kind === "surface-create" && isNonEmptyString(paneId))
			uncertainty = { ...uncertainty, observedSurfaceId: paneId };
		if (
			uncertainty.kind === "worktree-create" &&
			isNonEmptyString(result?.worktree?.path) &&
			isNonEmptyString(result?.worktree?.branch)
		) {
			const recovered: RecoveredWorktreeProvisioning = {
				path: result.worktree.path,
				branch: result.worktree.branch,
			};
			if (isNonEmptyString(result.workspace?.workspace_id))
				recovered.workspaceId = result.workspace.workspace_id;
			if (isNonEmptyString(paneId)) {
				recovered.paneId = paneId;
				placement.retained.add(paneId);
			}
			uncertainty = { ...uncertainty, recovered };
		}
		throw new AcquisitionUncertainError(
			`Herdr acquisition uncertain; no fallback is safe. Observed acquisition: ${JSON.stringify(uncertainty)}. ${error instanceof Error ? error.message : String(error)}`,
			uncertainty,
			{ cause: error },
		);
	}
}

async function renamePane(paneId: string, name: string): Promise<void> {
	try {
		await herdrExecAsync(
			["pane", "rename", paneId, name],
			HERDR_COSMETIC_TIMEOUT_MS,
		);
	} catch {
		/* cosmetic; never lose returned ownership */
	}
}

export async function createHerdrSurface(
	name: string,
	cwd = process.cwd(),
	control?: AcquisitionControl,
): Promise<string> {
	const deadline = Deadline.after(HERDR_PLACEMENT_TIMEOUT_MS);
	const paneId = await withPlacement(deadline, control?.signal, async () => {
		const { workspace_id: workspaceId } = await getHerdrCurrentPaneInfo(
			deadline.remainingMs(),
		);
		return mutate(
			buildTabCreateArgs(name, cwd, workspaceId),
			deadline,
			{ kind: "surface-create", placement: "tab", workspaceId },
			(output) => extractHerdrRootPaneId(output, "tab create"),
			control?.signal,
		);
	});
	await renamePane(paneId, name);
	return paneId;
}

interface OwnedAgentsTab {
	workspaceId: string;
	panes: Set<string>;
	retainedPaneId?: string;
	/** An unproven split may still consume capacity; never reuse this tab. */
	uncertainSplit?: AcquisitionUncertainError;
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

const placementKey = Symbol.for("pi-herdr-subagents:placement-queue");
// SAFETY: only this module owns this reload-surviving queue and retention set.
const queueGlobal = globalThis as typeof globalThis & {
	[placementKey]?: { tail: Promise<void>; retained: Set<string> };
};
const placement = (queueGlobal[placementKey] ??= {
	tail: Promise.resolve(),
	retained: new Set<string>(),
});

/** Queue time counts. A cancelled/expired queued job can never dispatch later. */
function withPlacement<T>(
	deadline: Deadline,
	signal: AbortSignal | undefined,
	action: () => Promise<T>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let abandoned = false;
		const abandon = () => {
			abandoned = true;
			reject(signal?.reason ?? new Error("Placement deadline exceeded"));
		};
		const timer = setTimeout(abandon, deadline.remainingMs());
		signal?.addEventListener("abort", abandon, { once: true });
		if (signal?.aborted) abandon();
		const job = placement.tail.then(async () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abandon);
			if (abandoned) return;
			try {
				deadline.remainingMs();
				signal?.throwIfAborted();
				resolve(await action());
			} catch (error) {
				reject(error);
			}
		});
		placement.tail = job.catch(() => {});
	});
}

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

async function placementPanes(timeout?: number): Promise<
	Array<{
		pane_id: string;
		tab_id: string;
		workspace_id: string;
	}>
> {
	const parsed = parseHerdrJson(
		await herdrExecAsync(["pane", "list"], timeout),
	);
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

export async function createHerdrGroupedSurface(
	name: string,
	cwd: string,
	maxPerTab: number,
	direction: "right" | "down",
	control?: AcquisitionControl,
): Promise<string> {
	const deadline = Deadline.after(HERDR_PLACEMENT_TIMEOUT_MS);
	const acquired = await withPlacement(deadline, control?.signal, async () => {
		const callerWorkspace = (
			await getHerdrCurrentPaneInfo(deadline.remainingMs())
		).workspace_id;
		const parsed = parseHerdrJson(
			await herdrExecAsync(["workspace", "list"], deadline.remainingMs()),
		);
		const workspaces = parsed?.result?.workspaces;
		if (
			parsed?.result?.type !== "workspace_list" ||
			!Array.isArray(workspaces)
		) {
			throw new Error("Unexpected herdr workspace list output for placement");
		}
		const panes = await placementPanes(deadline.remainingMs());
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

		// Only inspect/create/record holds the reload-shared placement reservation.
		let paneId: string | undefined;
		for (const [tabId, owned] of agentsTabs) {
			if (owned.workspaceId !== workspaceId || owned.uncertainSplit) continue;
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
			try {
				paneId = await mutate(
					buildPaneSplitArgs(anchor.pane_id, direction, cwd),
					deadline,
					{
						kind: "surface-create",
						placement: "split",
						workspaceId,
						anchorSurfaceId: anchor.pane_id,
					},
					(output) => extractHerdrPaneId(output, "pane split"),
					control?.signal,
				);
			} catch (error) {
				if (isAcquisitionUncertainError(error)) owned.uncertainSplit = error;
				throw error;
			}
			owned.panes.add(paneId);
			break;
		}
		if (!paneId) {
			const count = [...agentsTabs.values()].filter(
				(tab) => tab.workspaceId === workspaceId,
			).length;
			const label = count === 0 ? "Agents" : `Agents ${count + 1}`;
			const created = await mutate(
				buildTabCreateArgs(label, cwd, workspaceId),
				deadline,
				{ kind: "surface-create", placement: "tab", workspaceId },
				(output) => ({
					paneId: extractHerdrRootPaneId(output, "tab create"),
					tabId: parseHerdrJson(output)?.result?.tab?.tab_id,
				}),
				control?.signal,
			);
			paneId = created.paneId;
			// A known pane remains owned even when optional grouping metadata is absent.
			if (isString(created.tabId) && created.tabId)
				agentsTabs.set(created.tabId, {
					workspaceId,
					panes: new Set([paneId]),
				});
		}
		return paneId;
	});
	await renamePane(acquired, name);
	return acquired;
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

export async function removeHerdrWorktree(
	workspaceId: string,
	timeout?: number,
): Promise<void> {
	await herdrExecAsync(buildWorktreeRemoveArgs(workspaceId), timeout);
}

export async function listHerdrWorktrees(
	cwd?: string,
	timeout?: number,
): Promise<HerdrWorktreeInfo[]> {
	const args = ["worktree", "list"];
	if (cwd) args.push("--cwd", cwd);
	return parseHerdrWorktreeList(await herdrExecAsync(args, timeout));
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

async function recoverHerdrWorktree(
	cwd: string,
	branch: string,
): Promise<HerdrWorktreeSurface | HerdrWorktreeInfo | undefined> {
	const deadline = Deadline.after(HERDR_RECONCILE_TIMEOUT_MS);
	const matches = (
		await listHerdrWorktrees(cwd, deadline.cappedAt(3_000).remainingMs())
	).filter((worktree) => worktree.branch === branch);
	if (matches.length !== 1) return undefined;
	const worktree = matches[0];
	if (!worktree.workspaceId) return worktree;
	const panes = parseHerdrPaneList(
		await herdrExecAsync(
			["pane", "list", "--workspace", worktree.workspaceId],
			deadline.cappedAt(3_000).remainingMs(),
		),
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

async function retainWorktreeTab(
	worktree: HerdrWorktreeSurface,
	output: string,
	diagnostics: string[],
	deadline: Deadline,
): Promise<void> {
	// Protect the root before the first await, independently of optional grouping.
	placement.retained.add(worktree.paneId);
	try {
		const tabId = await withPlacement(deadline, undefined, async () => {
			const returned = parseHerdrJson(output)?.result?.tab?.tab_id;
			const id =
				isString(returned) && returned
					? returned
					: (await placementPanes(deadline.remainingMs())).find(
							(pane) =>
								pane.pane_id === worktree.paneId &&
								pane.workspace_id === worktree.workspaceId,
						)?.tab_id;
			if (id) {
				const owned = agentsTabs.get(id) ?? {
					workspaceId: worktree.workspaceId,
					panes: new Set<string>(),
				};
				owned.panes.add(worktree.paneId);
				owned.retainedPaneId = worktree.paneId;
				agentsTabs.set(id, owned);
			}
			return id;
		});
		if (tabId) {
			try {
				await herdrExecAsync(
					["tab", "rename", tabId, "Agents"],
					deadline.cappedAt(HERDR_COSMETIC_TIMEOUT_MS).remainingMs(),
				);
			} catch {
				/* cosmetic */
			}
		}
	} catch (error) {
		diagnostics.push(
			`Retained worktree grouping unavailable: ${String(error)}`,
		);
	}
}

/** Each launch snapshot: `worktree list` before and after create, and the opened workspace's `pane list`. */
export const OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS = 3_000;
export const OPENED_PRIMARY_SNAPSHOT_CALLS = 3;
/** Snapshot wall time if every read runs to its timeout; the event loop stays responsive. */
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

async function readHerdrWorktreeSource(
	cwd: string,
	timeout: number,
	phase: SnapshotPhase,
	diagnostics: string[],
): Promise<HerdrWorktreeSource | undefined> {
	try {
		return parseHerdrWorktreeSource(
			await herdrExecAsync(["worktree", "list", "--cwd", cwd], timeout),
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

async function readPrimaryTerminalId(
	workspaceId: string,
	timeout: number,
	diagnostics: string[],
): Promise<string | undefined> {
	try {
		const panes = parseClaimedPanes(
			await herdrExecAsync(
				["pane", "list", "--workspace", workspaceId],
				timeout,
			),
			workspaceId,
		);
		return panes.length === 1 ? panes[0].terminalId : undefined;
	} catch (error) {
		snapshotFailure("opened workspace", error, diagnostics);
		return undefined;
	}
}

async function openedPrimaryClaim(
	source: HerdrWorktreeSource | undefined,
	timeout: number,
	diagnostics: string[],
): Promise<PrimaryWorkspaceClaim | undefined> {
	if (!source?.primaryWorkspaceId || !source.repoKey || !source.checkoutPath)
		return undefined;
	const terminalId = await readPrimaryTerminalId(
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

export async function createHerdrWorktree(
	name: string,
	cwd: string,
	branch: string,
	base: string,
	snapshotTimeoutMs = OPENED_PRIMARY_SNAPSHOT_TIMEOUT_MS,
	control?: AcquisitionControl,
): Promise<HerdrWorktreeSurface> {
	const deadline = Deadline.after(HERDR_WORKTREE_TIMEOUT_MS);
	const diagnostics: string[] = [];
	const before = await readHerdrWorktreeSource(
		cwd,
		deadline.cappedAt(snapshotTimeoutMs).remainingMs(),
		"before create",
		diagnostics,
	);
	let created: { worktree: HerdrWorktreeSurface; output: string };
	try {
		created = await mutate(
			buildWorktreeCreateArgs(name, cwd, branch, base),
			deadline,
			{ kind: "worktree-create", sourceCwd: cwd, branch },
			(output) => {
				const worktree = extractHerdrWorktree(output);
				if (worktree.branch !== branch)
					throw new Error("Herdr returned a different worktree branch");
				return { worktree, output };
			},
			control?.signal,
		);
	} catch (error) {
		if (!isAcquisitionUncertainError(error)) throw error;
		let recovered: HerdrWorktreeSurface | HerdrWorktreeInfo | undefined;
		try {
			recovered = await recoverHerdrWorktree(cwd, branch);
		} catch {
			/* original error remains authoritative */
		}
		if (recovered && "paneId" in recovered)
			placement.retained.add(recovered.paneId);
		// Reconciliation is retention evidence, never permission for late Pi dispatch.
		throw new AcquisitionUncertainError(
			`${error.message}${recovered ? `; recovery evidence (not permission to relaunch): ${JSON.stringify(recovered)}` : ""}`,
			{
				kind: "worktree-create",
				sourceCwd: cwd,
				branch,
				recovered:
					error.uncertainty.kind === "worktree-create"
						? (error.uncertainty.recovered ?? recovered)
						: recovered,
			},
			{ cause: error },
		);
	}
	placement.retained.add(created.worktree.paneId);
	try {
		const after =
			before && !before.primaryWorkspaceId
				? await readHerdrWorktreeSource(
						cwd,
						deadline.cappedAt(snapshotTimeoutMs).remainingMs(),
						"after create",
						diagnostics,
					)
				: undefined;
		const claim = await openedPrimaryClaim(
			after,
			deadline.cappedAt(snapshotTimeoutMs).remainingMs(),
			diagnostics,
		);
		if (claim) rememberOpenedPrimaryWorkspace(claim);
	} catch (error) {
		snapshotFailure("after create", error, diagnostics);
	}
	await retainWorktreeTab(
		created.worktree,
		created.output,
		diagnostics,
		deadline,
	);
	return withDiagnostics(created.worktree, diagnostics);
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

export async function createHerdrSurfaceSplit(
	name: string,
	direction: "right" | "down",
	cwd = process.cwd(),
	control?: AcquisitionControl,
): Promise<string> {
	const deadline = Deadline.after(HERDR_PLACEMENT_TIMEOUT_MS);
	const parentPaneId = getHerdrParentPaneId();
	const paneId = await withPlacement(deadline, control?.signal, () =>
		mutate(
			buildPaneSplitArgs(parentPaneId, direction, cwd),
			deadline,
			{
				kind: "surface-create",
				placement: "split",
				anchorSurfaceId: parentPaneId,
			},
			(output) => extractHerdrPaneId(output, "pane split"),
			control?.signal,
		),
	);
	await renamePane(paneId, name);
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

export async function sendHerdrCommand(
	surface: string,
	command: string,
): Promise<void> {
	// Dispatch is a mutation, not a best-effort cosmetic operation.
	await mutate(
		["pane", "run", surface, command],
		Deadline.after(10_000),
		{ kind: "command-dispatch", surfaceId: surface },
		(output) => {
			const response = parseHerdrJson(output);
			if (
				(!isNonEmptyString(response?.result?.type) &&
					response?.result?.ok !== true) ||
				response.error
			)
				throw new Error(`Unexpected herdr pane run output: ${output}`);
		},
	);
}

export async function sendHerdrKeys(
	surface: string,
	keys: string,
): Promise<void> {
	await herdrExecAsync(["pane", "send-keys", surface, keys]);
}

export function sendHerdrEscape(surface: string): Promise<void> {
	return sendHerdrKeys(surface, "Escape");
}

export async function closeHerdrSurface(surface: string): Promise<void> {
	await withPlacement(
		Deadline.after(HERDR_PLACEMENT_TIMEOUT_MS),
		undefined,
		async () => {
			if (
				placement.retained.has(surface) ||
				[...agentsTabs.values()].some(
					(owned) => owned.retainedPaneId === surface,
				)
			)
				return;
			// Never close a whole tab: user-added panes must survive.
			await herdrExecAsync(["pane", "close", surface]);
			for (const owned of agentsTabs.values()) owned.panes.delete(surface);
		},
	);
}

export async function renameHerdrTab(title: string): Promise<void> {
	const { tab_id: tabId } = await getHerdrCurrentPaneInfo();
	await herdrExecAsync(["tab", "rename", tabId, title]);
}

export async function renameHerdrWorkspace(title: string): Promise<void> {
	const { workspace_id: workspaceId } = await getHerdrCurrentPaneInfo();
	await herdrExecAsync(["workspace", "rename", workspaceId, title]);
}

export async function focusHerdrWorkspace(workspaceId: string): Promise<void> {
	await herdrExecAsync(["workspace", "focus", workspaceId]);
}

async function withMockHerdrExec<T>(
	mock: HerdrExecForTest,
	run: () => Promise<T> | T,
): Promise<T> {
	await placement.tail;
	const previous = swapHerdrExecForTest(mock);
	agentsTabs.clear();
	placement.retained.clear();
	try {
		return await run();
	} finally {
		await placement.tail;
		swapHerdrExecForTest(previous);
		agentsTabs.clear();
		placement.retained.clear();
	}
}

export const __herdrTest__ = {
	withPlacement,
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
