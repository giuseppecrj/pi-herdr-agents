import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSideColumnPane,
	loadSideColumnState,
	planSideColumnSplit,
	pruneSideChain,
	saveSideColumnState,
	sideColumnStateFile,
	type SideColumnDeps,
	type SideColumnState,
} from "../pi-extension/subagents/side-column.ts";
import { createSubagentPaneFactory } from "../pi-extension/subagents/pane-config.ts";

const OPTIONS = {
	firstDirection: "right" as const,
	ratio: 0.34,
	maxVisible: 3,
};

interface SplitCall {
	name: string;
	target: string;
	direction: string;
	ratio?: number;
}

function fakeDeps(
	overrides: Partial<{
		tabId: string;
		alive: string[] | null;
		stored: SideColumnState | null;
	}> = {},
) {
	const splits: SplitCall[] = [];
	let counter = 0;
	let saved: SideColumnState | null = null;
	const deps: SideColumnDeps = {
		tabId: overrides.tabId ?? "tab-1",
		listAlivePaneIds: () => overrides.alive ?? null,
		split: (name, plan) => {
			const target =
				plan.target.kind === "current" ? "current" : plan.target.paneId;
			splits.push({
				name,
				target,
				direction: plan.direction,
				ratio: plan.ratio,
			});
			counter += 1;
			return `side-${counter}`;
		},
		loadState: () => overrides.stored ?? saved,
		saveState: (state) => {
			saved = state;
		},
	};
	return { deps, splits, saved: () => saved };
}

describe("planSideColumnSplit", () => {
	it("splits the parent right on an empty chain", () => {
		assert.deepEqual(planSideColumnSplit([], "right", 0.34), {
			target: { kind: "current" },
			direction: "right",
		});
	});

	it("splits the last side pane down with ratio on the second slot", () => {
		assert.deepEqual(planSideColumnSplit(["p1"], "right", 0.34), {
			target: { kind: "pane", paneId: "p1" },
			direction: "down",
			ratio: 0.34,
		});
	});

	it("splits the last side pane down without ratio afterwards", () => {
		assert.deepEqual(planSideColumnSplit(["p1", "p2"], "right", 0.34), {
			target: { kind: "pane", paneId: "p2" },
			direction: "down",
		});
	});
});

describe("pruneSideChain", () => {
	it("drops dead panes and keeps order", () => {
		assert.deepEqual(pruneSideChain(["a", "b", "c"], ["c", "a"]), ["a", "c"]);
	});
});

describe("side-column state file", () => {
	it("round-trips and rejects corrupt files", () => {
		const dir = mkdtempSync(join(tmpdir(), "side-column-state-"));
		const path = sideColumnStateFile("wB:p2D", dir);
		assert.equal(loadSideColumnState(path), null);
		saveSideColumnState(path, { tabId: "t1", chain: ["a"] });
		assert.deepEqual(loadSideColumnState(path), { tabId: "t1", chain: ["a"] });
		const raw = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(raw.tabId, "t1");
		writeFileSync(path, "not json");
		assert.equal(loadSideColumnState(path), null);
	});
});

describe("createSideColumnPane", () => {
	it("stacks three panes: right, down+ratio, down", () => {
		const alive = ["parent"];
		const { deps, splits, saved } = fakeDeps({ alive });
		const first = createSideColumnPane("one", OPTIONS, deps);
		alive.push(first);
		const second = createSideColumnPane("two", OPTIONS, deps);
		alive.push(second);
		createSideColumnPane("three", OPTIONS, deps);
		assert.deepEqual(
			splits.map((s) => [s.target, s.direction, s.ratio]),
			[
				["current", "right", undefined],
				[first, "down", 0.34],
				[second, "down", undefined],
			],
		);
		assert.deepEqual(saved()?.chain, [first, second, "side-3"]);
	});

	it("refuses new panes when the column is full", () => {
		const { deps } = fakeDeps({
			alive: ["parent", "s1", "s2", "s3"],
			stored: { tabId: "tab-1", chain: ["s1", "s2", "s3"] },
		});
		assert.throws(
			() => createSideColumnPane("fourth", OPTIONS, deps),
			/Side column is full \(3\/3 visible panes\)/,
		);
	});

	it("frees slots for panes closed outside pi", () => {
		const { deps, splits } = fakeDeps({
			alive: ["parent", "s1", "s3"],
			stored: { tabId: "tab-1", chain: ["s1", "s2", "s3"] },
		});
		createSideColumnPane("next", OPTIONS, deps);
		assert.equal(splits[0].target, "s3");
	});

	it("starts a fresh column when the parent moved tabs", () => {
		const { deps, splits } = fakeDeps({
			tabId: "tab-2",
			alive: ["parent", "old-1"],
			stored: { tabId: "tab-1", chain: ["old-1"] },
		});
		createSideColumnPane("next", OPTIONS, deps);
		assert.equal(splits[0].target, "current");
	});

	it("fails closed when the live pane list is unavailable", () => {
		const { deps } = fakeDeps({
			alive: null,
			stored: { tabId: "tab-1", chain: ["s1", "s2", "s3"] },
		});
		assert.throws(
			() => createSideColumnPane("next", OPTIONS, deps),
			/Side column is full/,
		);
	});

	it("treats maxVisible 0 as unlimited", () => {
		const { deps, splits } = fakeDeps({
			alive: ["parent", "s1", "s2", "s3"],
			stored: { tabId: "tab-1", chain: ["s1", "s2", "s3"] },
		});
		createSideColumnPane("next", { ...OPTIONS, maxVisible: 0 }, deps);
		assert.equal(splits.length, 1);
	});
});

describe("side-column factory routing", () => {
	const config = {
		mode: "side-column" as const,
		direction: "right" as const,
		maxVisible: 0,
		sideColumnRatio: 0.34,
	};

	it("routes side-column mode to the side creator", () => {
		const factory = createSubagentPaneFactory(
			config,
			() => "tab-pane",
			() => "split-pane",
			() => "side-pane",
		);
		assert.equal(factory("Scout"), "side-pane");
	});

	it("falls back to a plain split without a side creator", () => {
		const factory = createSubagentPaneFactory(
			config,
			() => "tab-pane",
			(_name, direction) => `split-pane:${direction}`,
		);
		assert.equal(factory("Scout"), "split-pane:right");
	});
});
