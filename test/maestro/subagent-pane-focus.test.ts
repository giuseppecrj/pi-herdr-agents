import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	createLifecycle,
	markInterruptRequested,
	observePaneInspection,
} from "@nubl/maestro/core/lifecycle";
import { createObservation } from "@nubl/maestro/pi/subagents/observation";
import type {
	RunningSubagent,
	SubagentRuntime,
} from "@nubl/maestro/pi/subagents/state";
import {
	focusHerdrPane,
	renameHerdrPane,
} from "../../maestro/surfaces/herdr/herdr-socket.ts";
import { createWidgetController } from "../../pi-extension/subagents/widgets.ts";
import {
	replyError,
	replyResult,
	withFakeHerdrSocket,
	type ReceivedRequest,
} from "../fake-herdr-socket.ts";

function makeRow(id: string, surface: string): RunningSubagent {
	return {
		id,
		name: "Same name",
		task: "",
		surface,
		startTime: 0,
		sessionFile: "",
		lifecycle: createLifecycle(0),
		interactive: false,
		runtimePlan: undefined,
	};
}

const SELECTED_BG = "\x1b[44m";

function setup(
	socket?: string,
	viewport = false,
	onNotify?: (message: string) => void,
) {
	const first = makeRow("first", "w1:p2");
	const second = makeRow("second", "w3:p4");
	const runningSubagents = new Map([
		[first.id, first],
		[second.id, second],
	]);
	const notifications: string[] = [];
	let component: Component | undefined;
	let renders = 0;
	let input: ExtensionContext["ui"]["input"] = async () => undefined;
	// SAFETY: the controller uses the viewport brand and requestRender only.
	const tui = {
		requestRender() {
			renders++;
		},
	} as TUI;
	Object.defineProperty(tui, Symbol.for("@earendil-works/pi-tui/viewport"), {
		value: viewport,
	});
	const setWidget: ExtensionContext["ui"]["setWidget"] = (
		key,
		factory,
		options,
	) => {
		assert.equal(key, "subagent-status");
		assert.deepEqual(options, { placement: "aboveEditor" });
		assert.ok(factory instanceof Function);
		const theme: Pick<Parameters<typeof factory>[1], "fg" | "bg" | "bold"> = {
			fg: (_color, text) => text,
			bg: (color, text) => {
				assert.equal(color, "selectedBg");
				return `${SELECTED_BG}${text}\x1b[49m`;
			},
			bold: (text) => text,
		};
		// SAFETY: the widget uses only fg, bg, and bold on its theme.
		component = factory(tui, theme as Parameters<typeof factory>[1]);
	};
	// SAFETY: the controller only uses hasUI and the supplied UI methods.
	const ctx = {
		hasUI: true,
		ui: {
			setWidget,
			input(title: string) {
				return input(title);
			},
			notify(message: string) {
				notifications.push(message);
				onNotify?.(message);
			},
		},
	} as ExtensionContext;
	const runtime: SubagentRuntime = { latestCtx: ctx, runningSubagents };
	const createController = () =>
		createWidgetController({
			runtime,
			statusConfig: { enabled: true, lineLimit: 6 },
			supervisionConfig: { forcePolling: false, hangWarningMinutes: 15 },
			...createObservation(runtime),
			getPaneActions: () =>
				socket
					? {
							focus: (paneId) => focusHerdrPane(socket, paneId),
							rename: (paneId, label) => renameHerdrPane(socket, paneId, label),
						}
					: undefined,
		});
	const controller = createController();
	controller.updateWidget();
	assert.ok(component);
	assert.equal(component.render(80).length, 4);
	return {
		controller,
		runningSubagents,
		component,
		notifications,
		renders: () => renders,
		setInput(fn: typeof input) {
			input = fn;
		},
		reloadWidget() {
			createController().updateWidget();
			assert.ok(component);
			return component;
		},
	};
}

function mouse(type: TuiMouseEvent["type"], y: number, x = 10): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 4,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

test("left click focuses the pane from the displayed row, across widget refreshes", () => {
	let recordRequest: (value: ReceivedRequest) => void = () => {};
	const received = new Promise<ReceivedRequest>((resolve) => {
		recordRequest = resolve;
	});
	return withFakeHerdrSocket(
		(request, socket) => {
			recordRequest(request);
			replyResult({ pane: { pane_id: "w3:p4" } })(request, socket);
		},
		async (path) => {
			const { controller, component, renders } = setup(path, true);
			const rowEnd = visibleWidth(component.render(80)[1]);
			for (const [y, x] of [
				[0, 10],
				[3, 10],
				[1, 0],
				[1, rowEnd - 1],
				[1, rowEnd],
				[1, 79],
			]) {
				assert.equal(component.handleMouse?.(mouse("press", y, x)), undefined);
				assert.equal(component.handleMouse?.(mouse("click", y, x)), undefined);
			}
			const x = rowEnd - 3; // Padding at the old edit position still focuses the row.
			assert.deepEqual(component.handleMouse?.(mouse("press", 2, x)), {
				handled: true,
				render: true,
			});
			controller.updateWidget();
			assert.equal(renders(), 1);
			const highlighted = component.render(80);
			assert.equal(highlighted[1].includes(SELECTED_BG), false);
			assert.ok(highlighted[2].includes(SELECTED_BG));
			assert.match(highlighted[2], /› Same name/);
			assert.deepEqual(component.handleMouse?.(mouse("release", 2, x)), {
				handled: true,
				render: true,
			});
			assert.equal(component.render(80)[2].includes(SELECTED_BG), false);
			assert.deepEqual(component.handleMouse?.(mouse("click", 2, x)), {
				handled: true,
				render: false,
			});
			const { method, params } = await received;
			assert.equal(method, "pane.focus");
			assert.deepEqual(params, { pane_id: "w3:p4" });
		},
	);
});

function clickPencil(component: Component, y: number) {
	const row = component.render(80)[y];
	const pencil = row.lastIndexOf("✎");
	assert.notEqual(pencil, -1);
	const x = visibleWidth(row.slice(0, pencil));
	for (const event of ["press", "release", "click"] as const) {
		assert.equal(component.handleMouse?.(mouse(event, y, x))?.handled, true);
	}
}

test("a pencil click updates only presentation and renames the exact Herdr pane", async () => {
	let recordRequest: (value: ReceivedRequest) => void = () => {};
	const received = new Promise<ReceivedRequest>((resolve) => {
		recordRequest = resolve;
	});
	await withFakeHerdrSocket(
		(request, socket) => {
			assert.equal(request.method, "pane.rename");
			replyResult({ pane: { pane_id: "w3:p4" } })(request, socket);
			recordRequest(request);
		},
		async (path) => {
			const { component, runningSubagents, setInput, reloadWidget } = setup(
				path,
				true,
			);
			const original = structuredClone(runningSubagents.get("second"));
			setInput(async (title) => {
				assert.match(title, /Nickname for Same name/);
				return "  登录审查  ";
			});
			clickPencil(component, 2);
			assert.deepEqual((await received).params, {
				pane_id: "w3:p4",
				label: "登录审查",
			});
			const [, first, second] = component.render(80);
			assert.match(first, /Same name ✎/);
			assert.doesNotMatch(first, /登录审查/);
			assert.match(second, /Same name · 登录审查 ✎/);
			const firstState = first.indexOf("starting");
			const secondState = second.indexOf("starting");
			assert.ok(firstState > 0 && secondState > 0);
			assert.equal(
				visibleWidth(first.slice(0, firstState)),
				visibleWidth(second.slice(0, secondState)),
			);
			assert.match(component.render(120)[2], /Same name · 登录审查 ✎/);
			assert.deepEqual(runningSubagents.get("second"), original);
			const reloaded = reloadWidget();
			assert.match(reloaded.render(80)[2], /Same name · 登录审查 ✎/);
			let reopened = false;
			setInput(async (title) => {
				assert.match(title, /now: 登录审查/);
				reopened = true;
				return undefined;
			});
			clickPencil(reloaded, 2);
			assert.equal(reopened, true);
		},
	);
});

test("a nickname can be reset or cancelled without a legacy pane", async () => {
	const { component, setInput, notifications } = setup(undefined, true);
	setInput(async () => "Research");
	clickPencil(component, 1);
	await setImmediate();
	assert.match(component.render(80)[1], /Same name · Research ✎/);
	setInput(async () => undefined);
	clickPencil(component, 1);
	await setImmediate();
	assert.match(component.render(80)[1], /Research/);
	setInput(async () => "  ");
	clickPencil(component, 1);
	await setImmediate();
	assert.match(component.render(80)[1], /Same name/);
	assert.doesNotMatch(component.render(80)[1], /Research/);
	assert.deepEqual(notifications, []);
});

test("status, time, model, and role align across labels and wide names", () => {
	const { component, runningSubagents } = setup();
	const now = Date.now();
	for (const [id, name, agent, modelId, status] of [
		["first", "审查", "review", "long-model", "working"],
		["second", "Scout", "research", "small", "done"],
	] as const) {
		const row = runningSubagents.get(id);
		assert.ok(row);
		row.name = name;
		row.agent = agent;
		row.startTime = now - 25_000;
		row.lifecycle = observePaneInspection(
			createLifecycle(row.startTime),
			{ kind: "present", agentStatus: status, observedAt: now },
			now,
		);
		row.runtimePlan = {
			provider: "test",
			modelId,
			model: `test/${modelId}`,
			thinking: "off",
			modelSource: "request",
			thinkingSource: "request",
		};
	}
	const [, working, waiting] = component.render(100);
	function column(line: string, value: string | RegExp) {
		const index = line.search(value);
		assert.ok(index >= 0, `${value} missing from ${line}`);
		return visibleWidth(line.slice(0, index));
	}
	assert.match(working, /● 审查/);
	assert.match(waiting, /○ Scout/);
	for (const [left, right] of [
		["agent working", "waiting"],
		[/\d+:\d{2}/, /\d+:\d{2}/],
		["long-model/off", "small/off"],
		["review", "research"],
	] as const) {
		assert.equal(column(working, left), column(waiting, right));
	}
	const [, narrowWorking, narrowWaiting] = component.render(28);
	assert.equal(
		column(narrowWorking, "agent working"),
		column(narrowWaiting, "waiting"),
	);
	assert.doesNotMatch(narrowWorking, /long-model|review/);
	assert.doesNotMatch(narrowWaiting, /small\/off|research/);

	const first = runningSubagents.get("first");
	assert.ok(first);
	first.name = "审查登录、注册、会话和权限等所有功能";
	const [, longName, shortName] = component.render(64);
	assert.match(longName, /审查.*…/);
	assert.equal(column(longName, "agent working"), column(shortName, "waiting"));
	assert.equal(
		column(longName, /\d{2}:\d{2}/),
		column(shortName, /\d{2}:\d{2}/),
	);
	assert.equal(
		column(longName, "long-model/off"),
		column(shortName, "small/off"),
	);
	assert.equal(column(longName, "review"), column(shortName, "research"));

	const [, truncatedModel, fullModel] = component.render(56);
	assert.equal(
		column(truncatedModel, "long-mode"),
		column(fullModel, "small/off"),
	);
	assert.equal(column(truncatedModel, "review"), column(fullModel, "resea"));
});

test("blocked, stalled, interrupted, and cancelling have distinct markers", () => {
	const { component, runningSubagents } = setup();
	const first = runningSubagents.get("first");
	const second = runningSubagents.get("second");
	assert.ok(first && second);
	const now = Date.now();
	first.lifecycle = observePaneInspection(
		first.lifecycle,
		{ kind: "present", agentStatus: "blocked", observedAt: now },
		now,
	);
	second.lifecycle = observePaneInspection(
		second.lifecycle,
		{ kind: "unavailable" },
		now - 120_000,
	);
	const [, blocked, stalled] = component.render(80);
	assert.match(blocked, /! Same name  blocked/);
	assert.match(stalled, /\? Same name  stalled/);
	first.lifecycle = markInterruptRequested(first.lifecycle, now);
	second.cancelState = "requested";
	const [, interrupted, cancelling] = component.render(80);
	assert.match(interrupted, /‖ Same name  interrupted/);
	assert.match(cancelling, /− Same name  cancelling…/);
	second.cancelState = "unconfirmed";
	assert.match(component.render(80)[2], /× Same name  cancel unconfirmed/);
});

test("a click cannot move to a different agent when the displayed rows shift", () => {
	const { component, runningSubagents } = setup("unused.sock", true);
	component.handleMouse?.(mouse("press", 1));
	runningSubagents.delete("first");
	const lines = component.render(80);
	assert.equal(
		lines.some((line) => line.includes(SELECTED_BG)),
		false,
	);
	component.handleMouse?.(mouse("release", 1));
	assert.equal(component.handleMouse?.(mouse("click", 1)), undefined);
});

test("dragging a pressed row clears its highlight and cancels focus", () => {
	const { component } = setup("unused.sock", true);
	component.handleMouse?.(mouse("press", 2));
	assert.deepEqual(component.handleMouse?.(mouse("drag", 1)), {
		handled: true,
		render: true,
	});
	assert.equal(component.render(80)[2].includes(SELECTED_BG), false);
	component.handleMouse?.(mouse("release", 2));
	assert.equal(component.handleMouse?.(mouse("click", 2)), undefined);
});

test("clicking a closed pane shows a warning", { timeout: 3_000 }, () =>
	withFakeHerdrSocket(
		replyError("pane_not_found", "pane gone"),
		async (path) => {
			let notify: (message: string) => void = () => {};
			const warning = new Promise<string>((resolve) => {
				notify = resolve;
			});
			const { component } = setup(path, true, notify);
			for (const type of ["press", "release", "click"] as const) {
				assert.equal(component.handleMouse?.(mouse(type, 2, 5))?.handled, true);
			}
			assert.equal(await warning, "That subagent pane is no longer open.");
		},
	),
);

test("row clicks do not focus panes without fullscreen or a legacy socket", () => {
	for (const { component } of [
		setup("unused.sock", false),
		setup(undefined, true),
	]) {
		assert.equal(component.handleMouse?.(mouse("press", 1, 5)), undefined);
		assert.equal(component.handleMouse?.(mouse("click", 1, 5)), undefined);
	}
});
