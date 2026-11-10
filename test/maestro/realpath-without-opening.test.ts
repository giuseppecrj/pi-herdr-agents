import "../clean-host-env.ts";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { test } from "node:test";
import { realpathWithoutOpening } from "../../maestro/core/realpath-without-opening.ts";

test("a filesystem root resolves to itself, whatever its form", () => {
	const root = parse(resolve(".")).root; // "/" on POSIX, "C:\\" on Windows
	assert.equal(realpathWithoutOpening(root), realpathSync.native(root));
});

test("an absolute path below a root keeps that root and resolves `..` lexically", () => {
	const path = resolve("maestro");
	assert.equal(realpathWithoutOpening(path), realpathSync.native(path));
	assert.equal(
		realpathWithoutOpening(join(path, "..", "maestro")),
		realpathSync.native(path),
	);
});

test("a directory link resolves to its target (junction on Windows)", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "realpath-link-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "target"));
	try {
		symlinkSync(join(dir, "target"), join(dir, "link"), "junction");
	} catch (error) {
		// SAFETY: symlinkSync only throws Node fs errors, which carry a code.
		if ((error as NodeJS.ErrnoException).code === "EPERM")
			return t.skip("cannot create links here");
		throw error;
	}
	assert.equal(
		realpathWithoutOpening(join(dir, "link")),
		realpathSync.native(join(dir, "target")),
	);
});
