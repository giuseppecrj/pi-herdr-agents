import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadSidebarConfig,
	parseSidebarConfig,
} from "../../maestro/core/config/sidebar-config.ts";

describe("sidebar config", () => {
	it("is off unless explicitly enabled", () => {
		assert.deepEqual(parseSidebarConfig({}), { enabled: false });
		assert.deepEqual(parseSidebarConfig({ sidebar: {} }), { enabled: false });
		assert.deepEqual(parseSidebarConfig({ sidebar: { enabled: true } }), {
			enabled: true,
		});
	});

	it("rejects malformed values and unknown keys", () => {
		assert.throws(() => parseSidebarConfig([]), /root must be an object/);
		assert.throws(
			() => parseSidebarConfig({ sidebar: true }),
			/sidebar must be an object/,
		);
		assert.throws(
			() => parseSidebarConfig({ sidebar: { enabled: "yes" } }),
			/sidebar\.enabled must be a boolean/,
		);
		assert.throws(
			() => parseSidebarConfig({ sidebar: { enabled: true, ttlMs: 5 } }),
			/unsupported key\(s\): ttlMs/,
		);
	});

	it("loads the user config, then the example, then defaults to off", () => {
		const dir = mkdtempSync(join(tmpdir(), "sidebar-config-"));
		try {
			const example = join(dir, "example.json");
			assert.deepEqual(loadSidebarConfig(dir, example), { enabled: false });
			writeFileSync(example, JSON.stringify({ status: { enabled: true } }));
			assert.deepEqual(loadSidebarConfig(dir, example), { enabled: false });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({ sidebar: { enabled: true } }),
			);
			assert.deepEqual(loadSidebarConfig(dir, example), { enabled: true });
			writeFileSync(join(dir, "config.json"), "{");
			assert.throws(() => loadSidebarConfig(dir, example), /Invalid JSON/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
