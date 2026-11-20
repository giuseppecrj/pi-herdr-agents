import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	createLifecycle,
	observePaneInspection,
} from "@nubl/maestro/core/lifecycle";
import {
	readGlobalSlot,
	STATUS_INTERVAL_KEY,
	WIDGET_INTERVAL_KEY,
	type SubagentRuntime,
} from "@nubl/maestro/pi/subagents/state";
import { createWidgetController } from "../../pi-extension/subagents/widgets.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

const STALE_CONTEXT =
	"This extension ctx is stale after session replacement or reload.";

function context() {
	let stale = false;
	let mounts = 0;
	let component: Component | undefined;
	const setWidget: ExtensionContext["ui"]["setWidget"] = (_key, factory) => {
		assert.equal(stale, false);
		mounts++;
		if (factory === undefined) {
			component = undefined;
			return;
		}
		assert.ok(factory instanceof Function);
		// SAFETY: the terminal widget factory does not access the TUI.
		const tui = {} as Parameters<typeof factory>[0];
		// SAFETY: the widget uses only these theme methods.
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as Parameters<typeof factory>[1];
		component = factory(tui, theme);
	};
	const ui = { setWidget };
	// SAFETY: this lifecycle fixture needs only hasUI and ui. Both use Pi's
	// invalidation behavior: even reading a context property after shutdown throws.
	const ctx = {
		get hasUI() {
			if (stale) throw new Error(STALE_CONTEXT);
			return true;
		},
		get ui() {
			if (stale) throw new Error(STALE_CONTEXT);
			return ui;
		},
	} as ExtensionContext;
	return {
		ctx,
		invalidate() {
			stale = true;
		},
		mounts: () => mounts,
		component: () => component,
	};
}

function setup() {
	const now = Date.now();
	const runtime: SubagentRuntime = {
		runningSubagents: new Map([
			[
				"child",
				{
					id: "child",
					name: "Research",
					task: "bounded",
					surface: "w1:p2",
					startTime: now,
					sessionFile: "",
					interactive: false,
					runtimePlan: undefined,
					lifecycle: observePaneInspection(
						createLifecycle(now),
						{ kind: "present", agentStatus: "blocked", observedAt: now },
						now,
					),
					lastProjectedKind: "active",
				},
			],
		]),
	};
	const createController = () =>
		createWidgetController({
			runtime,
			statusConfig: { enabled: true, lineLimit: 6 },
			supervisionConfig: { forcePolling: false, hangWarningMinutes: 0 },
			observeRunningSubagent() {},
			evaluateNoProgressAdvisory: () => undefined,
		});
	return { runtime, createController };
}

test("shutdown makes retained widget callbacks inert before reading an invalid context", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { runtime, createController } = setup();
	const old = context();
	runtime.latestCtx = old.ctx;
	const controller = createController();
	t.after(() => controller.stopRefresh());
	controller.startWidgetRefresh();
	assert.match(
		old.component()?.render(80).join("\n") ?? "",
		/Subagents.*\n.*Research/,
	);
	controller.stopRefresh();
	old.invalidate();

	assert.doesNotThrow(() => controller.updateWidget());
	assert.doesNotThrow(() => controller.startWidgetRefresh());
	t.mock.timers.tick(1000);
	assert.equal(old.mounts(), 1);
});

test("a late spawn during replacement cannot restart a stopped controller's status timer", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { runtime, createController } = setup();
	const old = context();
	const oldApi = createMockExtensionApi();
	runtime.latestCtx = old.ctx;
	const controller = createController();
	t.after(() => controller.stopRefresh());
	controller.startWidgetRefresh();
	controller.startStatusRefresh(oldApi.api);
	controller.stopRefresh();
	runtime.latestCtx = undefined;
	old.invalidate();
	oldApi.invalidate();
	// A preserved launch can finish while no replacement context is bound.
	controller.startWidgetRefresh();
	controller.startStatusRefresh(oldApi.api);
	assert.equal(readGlobalSlot(WIDGET_INTERVAL_KEY), null);
	assert.equal(readGlobalSlot(STATUS_INTERVAL_KEY), null);

	const replacement = context();
	runtime.latestCtx = replacement.ctx;
	assert.doesNotThrow(() => t.mock.timers.tick(1000));
	assert.equal(replacement.mounts(), 0);
	assert.equal(oldApi.sentMessages.length, 0);
});

test("late observations and cleanup from an old load leave the replacement widget intact", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { runtime, createController } = setup();
	const old = context();
	runtime.latestCtx = old.ctx;
	const previous = createController();
	t.after(() => previous.stopRefresh());
	previous.startWidgetRefresh();
	previous.stopRefresh();
	old.invalidate();
	runtime.latestCtx = undefined;

	const replacement = context();
	runtime.latestCtx = replacement.ctx;
	const current = createController();
	t.after(() => current.stopRefresh());
	current.startWidgetRefresh();
	previous.updateWidget();
	previous.stopRefresh();
	assert.equal(replacement.mounts(), 1);
	t.mock.timers.tick(1000);
	assert.equal(replacement.mounts(), 2);
	assert.match(
		replacement.component()?.render(80).join("\n") ?? "",
		/Research/,
	);

	runtime.runningSubagents.clear();
	previous.updateWidget();
	assert.equal(
		replacement.mounts(),
		2,
		"old completion cannot remove the current widget",
	);
	current.updateWidget();
	assert.equal(replacement.mounts(), 3);
	assert.equal(replacement.component(), undefined);
});
