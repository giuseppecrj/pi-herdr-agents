import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isNonEmptyString, isPlainObject } from "./type-guards.ts";

/**
 * Side-column layout: the parent session keeps the left side of the tab
 * while subagents stack in a narrow right column (top/middle/bottom).
 *
 * - 1st pane: split the parent to the right (full-height column).
 * - 2nd pane: split the last side pane downward with `ratio`.
 * - 3rd+ pane: split the last side pane downward (even halves).
 *
 * Splitting the last side pane — never the parent — keeps the parent wide
 * no matter how many side panes open. A file-backed chain (one per parent
 * pane) tracks the column so the layout survives pi reloads; dead panes are
 * pruned against the live pane list on every launch.
 */

export type SideColumnTarget =
	| { kind: "current" }
	| { kind: "pane"; paneId: string };

export interface SideColumnSplitPlan {
	target: SideColumnTarget;
	direction: "right" | "down";
	ratio?: number;
}

export interface SideColumnState {
	tabId: string;
	chain: string[];
}

export interface SideColumnOptions {
	/** Direction of the first split (the column side). */
	firstDirection: "right" | "down";
	/** Ratio for the second pane's split. */
	ratio: number;
	/** Max side panes per tab (0 = unlimited). */
	maxVisible: number;
}

/** Pure: decide the next split from the pruned chain. */
export function planSideColumnSplit(
	chain: string[],
	firstDirection: "right" | "down",
	ratio: number,
): SideColumnSplitPlan {
	if (chain.length === 0) {
		return { target: { kind: "current" }, direction: firstDirection };
	}
	const plan: SideColumnSplitPlan = {
		target: { kind: "pane", paneId: chain[chain.length - 1] },
		direction: "down",
	};
	if (chain.length === 1) plan.ratio = ratio;
	return plan;
}

/** Pure: drop chain entries that are no longer alive. */
export function pruneSideChain(
	chain: string[],
	aliveIds: Set<string> | string[],
): string[] {
	const alive = Array.isArray(aliveIds) ? new Set(aliveIds) : aliveIds;
	return chain.filter((id) => alive.has(id));
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function sideColumnStateDir(
	dir = join(agentDir(), "tmp", "side-column"),
): string {
	return dir;
}

export function sideColumnStateFile(
	parentPaneId: string,
	dir = sideColumnStateDir(),
): string {
	const safe = parentPaneId.replace(/[^A-Za-z0-9_-]/g, "_");
	return join(dir, `${safe}.json`);
}

export function loadSideColumnState(path: string): SideColumnState | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!isPlainObject(parsed)) return null;
		if (!isNonEmptyString(parsed.tabId)) return null;
		if (!Array.isArray(parsed.chain)) return null;
		const chain: string[] = [];
		for (const id of parsed.chain) {
			if (isNonEmptyString(id)) chain.push(id);
		}
		return { tabId: parsed.tabId, chain };
	} catch {
		return null;
	}
}

export function saveSideColumnState(
	path: string,
	state: SideColumnState,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), "utf8");
	try {
		renameSync(tmp, path);
	} catch {
		writeFileSync(path, JSON.stringify(state), "utf8");
		try {
			unlinkSync(tmp);
		} catch {}
	}
}

export interface SideColumnDeps {
	tabId: string;
	listAlivePaneIds(): string[] | null;
	split(name: string, plan: SideColumnSplitPlan): string;
	loadState(): SideColumnState | null;
	saveState(state: SideColumnState): void;
}

/**
 * Resolve the next side-column split, enforce maxVisible, and persist the
 * chain. Throws when the column is full so the caller can surface the
 * refusal to the model before Herdr creates anything.
 */
export function createSideColumnPane(
	name: string,
	options: SideColumnOptions,
	deps: SideColumnDeps,
): string {
	const stored = deps.loadState();
	const previous = stored && stored.tabId === deps.tabId ? stored.chain : [];
	const alive = deps.listAlivePaneIds();
	// Fail closed: when the live list is unavailable, keep the stored chain
	// so a blind launch cannot silently overflow the tab.
	const chain = alive === null ? previous : pruneSideChain(previous, alive);
	if (options.maxVisible > 0 && chain.length >= options.maxVisible) {
		throw new Error(
			`Side column is full (${chain.length}/${options.maxVisible} visible panes). ` +
				`Wait for a running subagent to finish, or stop one, then retry.`,
		);
	}
	const plan = planSideColumnSplit(
		chain,
		options.firstDirection,
		options.ratio,
	);
	const paneId = deps.split(name, plan);
	deps.saveState({ tabId: deps.tabId, chain: [...chain, paneId] });
	return paneId;
}
