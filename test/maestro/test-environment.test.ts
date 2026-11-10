import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Every unit-test entry file must import the host-environment scrub before
// anything else, so a single-file `node --test` run inside a Pi subagent or a
// Herdr pane behaves like `npm test` in CI.
const SCRUB =
	/^import "(\.\/|\.\.\/)(clean-host-env|isolated-agent-dir)\.ts";$/;

describe("unit-test environment isolation", () => {
	const manifest: { scripts: { test: string } } = JSON.parse(
		readFileSync("package.json", "utf8"),
	);
	const entries = manifest.scripts.test
		.split(/\s+/)
		.filter((word) => word.startsWith("test/"))
		.flatMap((pattern) => globSync(pattern))
		.sort();

	it("runs the unit suite from known entry files", () => {
		assert.ok(entries.length > 40, entries.join("\n"));
	});

	for (const file of entries)
		it(`${file} scrubs the inherited Pi and Herdr environment first`, () => {
			const firstImport = readFileSync(file, "utf8")
				.split("\n")
				.find((line) => line.startsWith("import "));
			assert.match(firstImport ?? "", SCRUB);
		});
});
