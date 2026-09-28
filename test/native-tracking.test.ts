import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import subagentsExtension, {
	__test__,
} from "../pi-extension/subagents/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import {
	parseNativePane,
	parseNativePaneSnapshot,
	type NativeInspection,
} from "../pi-extension/subagents/native-herdr.ts";
import {
	NativeTracker,
	nativeWidgetStatus,
	type TrackedNativeAgent,
} from "../pi-extension/subagents/native-tracking.ts";

const paneId = "w1:p7";
function pane(overrides = {}) {
	return {
		pane_id: paneId,
		terminal_id: "term-7",
		workspace_id: "w1",
		agent: "codex",
		agent_status: "working",
		agent_session: {
			agent: "codex",
			kind: "id",
			source: "herdr:codex",
			value: "session-7",
		},
		...overrides,
	};
}
function inspection(overrides = {}): NativeInspection {
	return parseNativePane(
		JSON.stringify({ result: { pane: pane(overrides) } }),
		paneId,
	);
}
function fixture() {
	let next = inspection();
	const reads: string[] = [];
	const owned = new Set<string>();
	const rows = new Map<string, TrackedNativeAgent>();
	const tracker = new NativeTracker(
		rows,
		(id) => owned.has(id),
		() => {},
		{
			currentPane: async () => "w1:parent",
			snapshot: async () => new Map([[paneId, next]]),
			inspect: async (id) => {
				reads.push(id);
				return next;
			},
		},
	);
	return {
		tracker,
		rows,
		reads,
		owned,
		set: (value: NativeInspection) => {
			next = value;
		},
	};
}

describe("native Herdr observation", () => {
	it("requires exact native session evidence and normalizes unknown status", () => {
		for (const agent of ["claude", "codex"]) {
			const result = inspection({
				agent,
				agent_session: {
					agent,
					kind: "id",
					source: `herdr:${agent}`,
					value: "session",
				},
			});
			assert.equal(result.kind, "present");
		}
		for (const agent of ["pi", "aider", null, undefined])
			assert.equal(inspection({ agent }).kind, "unsupported");
		for (const overrides of [
			{ pane_id: "wrong" },
			{ terminal_id: "" },
			{ agent_session: null },
			{
				agent_session: {
					agent: "pi",
					kind: "id",
					source: "herdr:pi",
					value: "s",
				},
			},
			{
				agent_session: {
					agent: "codex",
					kind: "path",
					source: "herdr:codex",
					value: "s",
				},
			},
			{
				agent_session: {
					agent: "codex",
					kind: "id",
					source: "title",
					value: "s",
				},
			},
		])
			assert.equal(inspection(overrides).kind, "unavailable");
		const unknown = inspection({ agent_status: "future-state" });
		assert.equal(
			unknown.kind === "present" && unknown.identity.status,
			"unknown",
		);
		assert.equal(parseNativePane("broken", paneId).kind, "unavailable");
		assert.equal(
			parseNativePane('{"error":{"code":"pane_not_found"}}', paneId).kind,
			"missing",
		);
	});

	it("requires a complete unambiguous pane-list envelope before establishing absence", () => {
		const snapshot = (panes: unknown[]) =>
			JSON.stringify({ result: { type: "pane_list", panes } });
		assert.deepEqual(parseNativePaneSnapshot(snapshot([])), new Map());
		const valid = parseNativePaneSnapshot(
			snapshot([
				pane(),
				pane({ pane_id: "shell", agent: null, agent_session: null }),
			]),
		);
		assert.equal(valid?.get(paneId)?.kind, "present");
		assert.equal(valid?.get("shell")?.kind, "unsupported");
		assert.equal(
			parseNativePaneSnapshot(snapshot([pane({ agent_session: null })]))?.get(
				paneId,
			)?.kind,
			"unavailable",
		);
		for (const output of [
			"broken",
			"null",
			"{}",
			JSON.stringify({ result: { panes: [] } }),
			JSON.stringify({ result: { type: "pane_get", panes: [] } }),
			JSON.stringify({ result: { type: "pane_list", panes: null } }),
			JSON.stringify({
				error: { code: "unavailable" },
				result: { type: "pane_list", panes: [] },
			}),
			snapshot([pane(), pane()]),
			snapshot([pane(), null]),
			snapshot([{}]),
			...[{ pane_id: "" }, { workspace_id: "" }, { terminal_id: null }].map(
				(overrides) => snapshot([pane(overrides)]),
			),
		])
			assert.equal(parseNativePaneSnapshot(output), null, output);
	});

	it("uses one snapshot for multiple selected rows without adopting unrelated panes", async () => {
		const rows = new Map<string, TrackedNativeAgent>();
		let calls = 0;
		let gets = 0;
		let fail = false;
		let output = JSON.stringify({
			result: {
				type: "pane_list",
				panes: [
					pane({ agent_status: "done" }),
					pane({ pane_id: "second", agent_status: "idle" }),
					pane({ pane_id: "unselected" }),
				],
			},
		});
		const tracker = new NativeTracker(
			rows,
			() => false,
			() => {},
			{
				currentPane: async () => "parent",
				inspect: async (id) => {
					gets++;
					return parseNativePane(
						JSON.stringify({ result: { pane: pane({ pane_id: id }) } }),
						id,
					);
				},
				snapshot: async () => {
					calls++;
					if (fail) throw new Error("offline");
					return parseNativePaneSnapshot(output);
				},
			},
		);
		try {
			await tracker.track(paneId);
			await tracker.track("second");
			await tracker.refresh();
			assert.equal(calls, 1);
			assert.equal(gets, 2, "only explicit tracks use pane get");
			assert.deepEqual([...rows.keys()], [paneId, "second"]);
			assert.equal(rows.get(paneId)?.status, "done");
			assert.equal(rows.get("second")?.status, "idle");
			output = '{"result":{"panes":[]}}';
			await tracker.refresh();
			assert.equal(rows.size, 2);
			assert.ok([...rows.values()].every((row) => row.status === "unknown"));
			fail = true;
			await tracker.refresh();
			assert.equal(rows.size, 2);
			fail = false;
			output = '{"result":{"type":"pane_list","panes":[]}}';
			await tracker.refresh();
			assert.equal(rows.size, 0);
			assert.equal(gets, 2);
		} finally {
			tracker.stop(false);
		}
	});

	it("never carries a display label across changed terminal or session identity", async () => {
		const f = fixture();
		try {
			for (const change of [
				{ terminal_id: "replacement" },
				{
					agent_session: {
						agent: "codex",
						kind: "id",
						source: "herdr:codex",
						value: "replacement",
					},
				},
			]) {
				f.set(inspection());
				const old = await f.tracker.track(paneId, "Previous occupant");
				old.trackedAt = 1;
				f.set(inspection(change));
				const replacement = await f.tracker.track(paneId);
				assert.equal(replacement.name, paneId);
				assert.notEqual(replacement.trackedAt, old.trackedAt);
				assert.equal(
					(await f.tracker.track(paneId, "New occupant")).name,
					"New occupant",
				);
			}
		} finally {
			f.tracker.stop(false);
		}
	});

	it("uses only bounded read commands and distinguishes CLI absence from failure", () => {
		const dir = mkdtempSync(join(tmpdir(), "native-observer-"));
		try {
			const log = join(dir, "calls.jsonl");
			writeFileSync(
				join(dir, "herdr"),
				`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.join(" ") === "pane current --current") {
 console.log(JSON.stringify({result:{pane:{pane_id:"parent"}}}));
} else if (args[0] === "pane" && args[1] === "get") {
 if (args[2] === "gone") { console.error(JSON.stringify({error:{code:"pane_not_found"}})); process.exitCode=1; }
 else if (args[2] === "offline") { console.error("server offline"); process.exitCode=1; }
 else console.log(JSON.stringify({result:{pane:${JSON.stringify(pane())}}}));
} else if (args.join(" ") === "pane list") {
 console.log(JSON.stringify({result:{type:"pane_list",panes:[${JSON.stringify(pane())}]}}));
} else { throw new Error("Unexpected command"); }
`,
				{ mode: 0o755 },
			);
			const moduleUrl = new URL(
				"../pi-extension/subagents/native-herdr.ts",
				import.meta.url,
			).href;
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"-e",
					`
import assert from "node:assert/strict";
import {currentNativeObserverPane, inspectNativePane, inspectNativePanes} from ${JSON.stringify(moduleUrl)};
assert.equal((await inspectNativePanes()).get(${JSON.stringify(paneId)}).kind, "present");
assert.equal(await currentNativeObserverPane(), "parent");
assert.equal((await inspectNativePane(${JSON.stringify(paneId)})).kind, "present");
assert.equal((await inspectNativePane("gone")).kind, "missing");
assert.equal((await inspectNativePane("offline")).kind, "unavailable");
`,
				],
				{
					encoding: "utf8",
					env: { ...process.env, HERDR_ENV: "1", PATH: dir },
				},
			);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(
				readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
				[
					["pane", "list"],
					["pane", "current", "--current"],
					["pane", "get", paneId],
					["pane", "get", "gone"],
					["pane", "get", "offline"],
				],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tracks only an explicit selection, rejects parents and Pi children, and deduplicates", async () => {
		const f = fixture();
		try {
			await assert.rejects(f.tracker.track("w1:parent"), /parent pane/);
			f.owned.add(paneId);
			await assert.rejects(f.tracker.track(paneId), /Pi child/);
			f.owned.clear();
			assert.deepEqual(f.reads, []);
			for (const id of ["", "--current", "label with space"])
				await assert.rejects(f.tracker.track(id), /exact Herdr pane ID/);
			for (const kind of ["missing", "unsupported", "unavailable"] as const) {
				f.set({ kind });
				await assert.rejects(f.tracker.track(paneId), /Cannot verify/);
			}
			f.set(inspection());
			const first = await f.tracker.track(paneId, "Review\nAPI");
			const second = await f.tracker.track(paneId);
			assert.equal(first.trackedAt, second.trackedAt);
			assert.equal(second.name, "Review API");
			assert.equal(f.rows.size, 1);
			await f.tracker.refresh();
			assert.ok(f.reads.every((id) => id === paneId));
			assert.equal(f.tracker.untrack(paneId), true);
			assert.equal(f.tracker.untrack(paneId), false);
		} finally {
			f.tracker.stop(false);
		}
	});

	it("retains done and failed inspection, recovers, and forgets replaced/disappeared occupants", async () => {
		const f = fixture();
		try {
			await f.tracker.track(paneId);
			for (const status of ["idle", "blocked", "done", "unknown", "working"]) {
				f.set(inspection({ agent_status: status }));
				await f.tracker.refresh();
				assert.equal(f.rows.get(paneId)?.status, status);
			}
			f.set({ kind: "unavailable" });
			await f.tracker.refresh();
			assert.equal(f.rows.get(paneId)?.status, "unknown");
			for (const result of [
				inspection({ terminal_id: "replacement" }),
				inspection({
					agent_session: {
						agent: "codex",
						kind: "id",
						source: "herdr:codex",
						value: "replacement",
					},
				}),
				{ kind: "missing" },
				{ kind: "unsupported" },
			] satisfies NativeInspection[]) {
				f.set(inspection());
				await f.tracker.track(paneId);
				f.set(result);
				await f.tracker.refresh();
				assert.equal(f.rows.size, 0);
			}
		} finally {
			f.tracker.stop(false);
		}
	});

	it("does not resurrect rows or overwrite new tracks after delayed inspection or reload", async () => {
		const rows = new Map<string, TrackedNativeAgent>();
		let resolveRead: (value: Map<string, NativeInspection> | null) => void =
			() => {};
		let delayed = false;
		const ops = {
			currentPane: async () => "parent",
			inspect: async () => inspection(),
			snapshot: async () =>
				delayed
					? new Promise<Map<string, NativeInspection> | null>((resolve) => {
							resolveRead = resolve;
						})
					: new Map([[paneId, inspection()]]),
		};
		const tracker = new NativeTracker(
			rows,
			() => false,
			() => {},
			ops,
		);
		try {
			await tracker.track(paneId);
			delayed = true;
			const refresh = tracker.refresh();
			tracker.untrack(paneId);
			resolveRead(new Map([[paneId, inspection()]]));
			await refresh;
			assert.equal(rows.size, 0);
			delayed = false;
			await tracker.track(paneId);
			delayed = true;
			const oldRefresh = tracker.refresh();
			tracker.stop(true);
			delayed = false;
			const replacement = new NativeTracker(
				rows,
				() => false,
				() => {},
				ops,
			);
			await replacement.track(paneId, "New label");
			resolveRead(new Map());
			await oldRefresh;
			assert.equal(rows.get(paneId)?.name, "New label");
			replacement.stop(false);
			assert.equal(rows.size, 0);
		} finally {
			tracker.stop(false);
		}
	});

	it("untrack cancels a pending track without needing Herdr", async () => {
		let resolveRead: (value: NativeInspection) => void = () => {};
		const tracker = new NativeTracker(
			new Map(),
			() => false,
			() => {},
			{
				currentPane: async () => "parent",
				snapshot: async () => null,
				inspect: () =>
					new Promise((resolve) => {
						resolveRead = resolve;
					}),
			},
		);
		const pending = tracker.track(paneId);
		await Promise.resolve();
		tracker.untrack(paneId);
		resolveRead(inspection());
		await assert.rejects(pending, /cancelled/);
		assert.equal(tracker.rows.size, 0);
	});

	it("renders mixed Pi/native rows and counts without native lifecycle state", async () => {
		const f = fixture();
		try {
			const native = await f.tracker.track(paneId, "API review");
			const child = {
				id: "pi-child",
				name: "Scout",
				task: "",
				surface: "pi-pane",
				startTime: Date.now(),
				sessionFile: "pi.jsonl",
				lifecycle: createLifecycle(Date.now()),
				interactive: false,
				runtimePlan: undefined,
			};
			const lines = __test__.renderSubagentWidgetLines([child], 100, [native]);
			assert.match(lines[0], /2 active/);
			assert.match(lines.join("\n"), /Scout/);
			assert.match(lines.join("\n"), /\[native codex\] active/);
			for (const [status, label] of [
				["working", "active"],
				["idle", "waiting"],
				["done", "waiting"],
				["blocked", "blocked"],
				["unknown", "unknown"],
			] as const) {
				native.status = status;
				assert.equal(nativeWidgetStatus(native), label);
			}
			native.status = "done";
			assert.match(
				__test__.renderSubagentWidgetLines([], 100, [native]).join("\n"),
				/\[native codex\] waiting/,
			);
			assert.match(
				__test__.renderSubagentWidgetLines([child], 100, [native])[0],
				/1 active · 1 open/,
			);
			for (const width of [0, 1, 2, 16, 40, 80])
				for (const line of __test__.renderSubagentWidgetLines([], width, [
					native,
				]))
					assert.ok(visibleWidth(line) <= width);
		} finally {
			f.tracker.stop(false);
		}
	});

	it("registers only for parents, survives reload, and never delivers or controls native sessions", async () => {
		const inherited = process.env.PI_SUBAGENT_ID;
		const rows: string[] = [];
		let resolveSnapshot: (value: Map<string, NativeInspection> | null) => void =
			() => {};
		let delaySnapshot = false;
		function extension(factory = subagentsExtension) {
			const tools: any[] = [];
			const handlers = new Map<string, Function>();
			const api = {
				registerTool: (tool: any) => tools.push(tool),
				on: (event: string, fn: Function) => handlers.set(event, fn),
				registerCommand() {},
				registerMessageRenderer() {},
				registerShortcut() {},
				sendMessage() {
					assert.fail("native observation must not send a Pi message");
				},
			};
			// SAFETY: the fixture provides the registration hooks used by this extension.
			factory(api as any, {
				nativeOperations: {
					currentPane: async () => "parent",
					snapshot: async () =>
						delaySnapshot
							? new Promise<Map<string, NativeInspection> | null>((resolve) => {
									resolveSnapshot = resolve;
								})
							: new Map([[paneId, inspection()]]),
					inspect: async (id) => {
						rows.push(id);
						return inspection();
					},
				},
			});
			return {
				tools,
				handlers,
				native: tools.find((tool) => tool.name === "subagents_native"),
			};
		}
		let current: ReturnType<typeof extension> | undefined;
		let widget: any;
		const ctx = {
			hasUI: true,
			modelRegistry: { getAvailable: () => [] },
			ui: {
				setWidget: (_name: string, value: any) => {
					widget = value;
				},
			},
		};
		try {
			process.env.PI_SUBAGENT_ID = "child";
			assert.equal(extension().native, undefined);
			delete process.env.PI_SUBAGENT_ID;
			current = extension();
			assert.ok(current.native);
			assert.equal(current.tools.length, 10);
			await current.handlers.get("session_start")?.({}, ctx);
			const tracked = await current.native.execute("t1", {
				action: "track",
				paneId,
			});
			assert.deepEqual(Object.keys(tracked.details).sort(), [
				"agent",
				"name",
				"paneId",
				"status",
				"trackedAt",
			]);
			assert.ok(!JSON.stringify(tracked).includes("session-7"));
			assert.ok(!JSON.stringify(tracked).includes("term-7"));
			assert.equal(__test__.runningSubagents.size, 0);
			assert.match(widget().render(100).join("\n"), /\[native codex\] active/);
			for (const name of [
				"subagent_interrupt",
				"subagent_send",
				"subagent_stop",
			]) {
				const tool: any = current.tools.find((entry) => entry.name === name);
				const result: any = await tool.execute("t2", { id: paneId });
				assert.ok(result.details.error);
			}
			await current.handlers.get("session_shutdown")?.(
				{ reason: "reload" },
				{},
			);
			const reloaded = await import(
				new URL(
					"../pi-extension/subagents/index.ts?native-reload",
					import.meta.url,
				).href
			);
			current = extension(reloaded.default);
			delaySnapshot = true;
			widget = undefined;
			const started = current.handlers.get("session_start")?.({}, ctx);
			assert.match(widget().render(100).join("\n"), /\[native codex\] active/);
			let settled = false;
			void started.then(() => {
				settled = true;
			});
			await Promise.resolve();
			assert.equal(
				settled,
				true,
				"session_start must not wait for the native snapshot",
			);
			resolveSnapshot(
				new Map([[paneId, inspection({ agent_status: "done" })]]),
			);
			await new Promise((resolve) => setImmediate(resolve));
			assert.match(widget().render(100).join("\n"), /\[native codex\] waiting/);
			delaySnapshot = false;
			await current.handlers.get("session_start")?.({}, ctx);
			assert.match(widget().render(100).join("\n"), /\[native codex\] active/);
			for (const reason of ["new", "resume", "fork"]) {
				await current.handlers.get("session_shutdown")?.({ reason }, {});
				await current.handlers.get("session_start")?.({}, ctx);
				assert.match(
					widget().render(100).join("\n"),
					/\[native codex\] active/,
				);
			}
			const result = await current.native.execute("t3", {
				action: "untrack",
				paneId,
			});
			assert.equal(result.details.removed, true);
			assert.equal(widget, undefined);
			assert.ok(rows.every((id) => id === paneId));
		} finally {
			await current?.handlers.get("session_shutdown")?.({ reason: "quit" }, {});
			if (inherited === undefined) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = inherited;
		}
	});
});
