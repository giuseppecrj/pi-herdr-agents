import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findLabBinary } from "./herdr-core-lab.ts";
import { DesktopLab } from "./herdr-desktop-lab.ts";

// This opens a private app on the operator's SHARED display and may take focus.
// It is never enabled merely by running the full integration suite.
const enabled = process.env.PI_TEST_DESKTOP_WINDOW === "1";
const core = process.env.HERDR_CORE_BIN ?? findLabBinary("herdr-core");
const pi = process.env.PI_BIN ?? findLabBinary("pi");
const bundle = process.env.HERDR_DESKTOP_BUNDLE ?? "/Applications/Herdr.app";

test("opt-in macOS Desktop lab captures its own window and shuts down its private services", {
	skip: !enabled
		? "requires explicit PI_TEST_DESKTOP_WINDOW=1 shared-display consent"
		: process.platform !== "darwin"
			? "macOS Desktop lab only"
			: false,
	timeout: 90_000,
}, async (t) => {
	assert.ok(
		core && pi && existsSync(bundle),
		"Desktop bundle, herdr-core and pi required",
	);
	const lab = new DesktopLab(bundle, core, pi);
	const evidence = mkdtempSync(join("/tmp", "piha-desktop-evidence-"));
	t.diagnostic(`Desktop fixture evidence (not parity acceptance): ${evidence}`);
	t.after(async () => {
		await lab.stop();
		lab.remove();
	});
	await lab.start({ allowWindow: enabled });
	const status = await lab.call({ status: true });
	assert.deepEqual(status.errors, []);
	assert.ok(Array.isArray((await lab.call({ ls: true })).spaces));
	await lab.capture(evidence);
	assert.ok(existsSync(join(evidence, "desktop.png")));
	await lab.stop();
	lab.remove();
	assert.equal(existsSync(lab.core.root), false);
});
