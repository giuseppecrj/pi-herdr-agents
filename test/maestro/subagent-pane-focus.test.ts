import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { createLifecycle } from "@nubl/maestro/core/lifecycle";
import { createObservation } from "@nubl/maestro/pi/subagents/observation";
import type {
	RunningSubagent,
	SubagentRuntime,
} from "@nubl/maestro/pi/subagents/state";
import { focusHerdrPane } from "../../maestro/surfaces/herdr/herdr-socket.ts";
import { createWidgetController } from "../../pi-extension/subagents/widgets.ts";
import {
	replyError,
	replyResult,
	withFakeHerdrSocket,
	type ReceivedRequest,
} from "../fake-herdr-socket.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

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

function setup(socket?: string, viewport = true) {
	const first = makeRow("first", "w1:p2");
	const second = makeRow("second", "w3:p4");
	const runningSubagents = new Map([
		[first.id, first],
		[second.id, second],
	]);
	const notifications: string[] = [];
	let component: Component | undefined;
	let renders = 0;
	// SAFETY: the controller only uses the viewport brand and requestRender.
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
		// SAFETY: this widget does not read the theme.
		component = factory(tui, {} as Parameters<typeof factory>[1]);
	};
	// SAFETY: the controller only uses hasUI and the supplied UI methods.
	const ctx = {
		hasUI: true,
		ui: {
			setWidget,
			async select(_title: string, choices: string[]) {
				assert.deepEqual(choices, [
					"1. Same name · w1:p2",
					"2. Same name · w3:p4",
				]);
				return choices[1];
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as ExtensionContext;
	const runtime: SubagentRuntime = { latestCtx: ctx, runningSubagents };
	const mock = createMockExtensionApi();
	const controller = createWidgetController({
		runtime,
		statusConfig: { enabled: true, lineLimit: 6 },
		supervisionConfig: { forcePolling: false, hangWarningMinutes: 15 },
		...createObservation(runtime),
		getPaneActions: () =>
			socket
				? { focus: (paneId) => focusHerdrPane(socket, paneId) }
				: undefined,
	});
	controller.registerPaneFocusCommand(mock.api);
	controller.updateWidget();
	assert.ok(component);
	assert.equal(component.render(80).length, 4);
	const command = mock.registeredCommands.find(
		({ name }) => name === "subagent-focus",
	);
	return {
		controller,
		runningSubagents,
		component,
		notifications,
		renders: () => renders,
		command: () => command.handler("", ctx),
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

test("left click focuses the exact pane from the displayed row across refreshes", () => {
	let recordRequest: (value: ReceivedRequest) => void = () => {};
	const received = new Promise<ReceivedRequest>((resolve) => {
		recordRequest = resolve;
	});
	return withFakeHerdrSocket(
		(request, socket) => {
			replyResult({ pane: { pane_id: "w3:p4" } })(request, socket);
			recordRequest(request);
		},
		async (path) => {
			const { controller, component, renders } = setup(path);
			for (const [y, x] of [
				[0, 10],
				[3, 10],
				[1, 0],
				[1, 79],
			]) {
				assert.equal(component.handleMouse?.(mouse("press", y, x)), undefined);
				assert.equal(component.handleMouse?.(mouse("click", y, x)), undefined);
			}
			assert.equal(component.handleMouse?.(mouse("press", 2))?.handled, true);
			controller.updateWidget();
			assert.equal(renders(), 1);
			assert.doesNotMatch(component.render(80)[1], /›/);
			assert.match(component.render(80)[2], /›/);
			assert.equal(component.handleMouse?.(mouse("release", 2))?.handled, true);
			assert.doesNotMatch(component.render(80)[2], /›/);
			assert.equal(component.handleMouse?.(mouse("click", 2))?.handled, true);
			const { method, params } = await received;
			assert.equal(method, "pane.focus");
			assert.deepEqual(params, { pane_id: "w3:p4" });
		},
	);
});

test("a click cannot move to a different agent when the displayed rows shift", () => {
	const { component, runningSubagents } = setup("unused.sock");
	component.handleMouse?.(mouse("press", 1));
	runningSubagents.delete("first");
	assert.doesNotMatch(component.render(80)[1], /›/);
	component.handleMouse?.(mouse("release", 1));
	assert.equal(component.handleMouse?.(mouse("click", 1)), undefined);
});

test("dragging a pressed row cancels focus", () => {
	const { component } = setup("unused.sock");
	component.handleMouse?.(mouse("press", 2));
	assert.deepEqual(component.handleMouse?.(mouse("drag", 1)), {
		handled: true,
		render: true,
	});
	assert.doesNotMatch(component.render(80)[2], /›/);
	component.handleMouse?.(mouse("release", 2));
	assert.equal(component.handleMouse?.(mouse("click", 2)), undefined);
});

test("the keyboard picker is available without fullscreen and reports a closed pane", () =>
	withFakeHerdrSocket(
		replyError("pane_not_found", "pane gone"),
		async (path, requests) => {
			const { component, command, notifications } = setup(path, false);
			assert.equal(component.handleMouse?.(mouse("press", 2)), undefined);
			await command();
			assert.deepEqual(
				requests.map(({ method, params }) => [method, params]),
				[["pane.focus", { pane_id: "w3:p4" }]],
			);
			assert.deepEqual(notifications, [
				"That subagent pane is no longer open.",
			]);
		},
	));

test("without a legacy socket the widget is passive and the command explains why", async () => {
	const { component, command, notifications } = setup();
	assert.equal(component.handleMouse?.(mouse("press", 1)), undefined);
	await command();
	assert.deepEqual(notifications, [
		"Pane focus is only available inside legacy Herdr.",
	]);
});
