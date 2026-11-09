import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { isHerdrAvailable } from "../../maestro/surfaces/herdr/herdr-cli.ts";

function withBinDir(files: string[], run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "herdr-available-"));
	try {
		for (const name of files)
			writeFileSync(join(dir, name), "", { mode: 0o755 });
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("Windows finds herdr.exe, the only form spawn can start", () => {
	withBinDir(["herdr.exe"], (dir) => {
		assert.equal(
			isHerdrAvailable({ HERDR_ENV: "1", PATH: dir }, "win32"),
			true,
		);
	});
});

test("Windows ignores an extensionless herdr script that spawn cannot start", () => {
	withBinDir(["herdr"], (dir) => {
		assert.equal(
			isHerdrAvailable({ HERDR_ENV: "1", PATH: dir }, "win32"),
			false,
		);
	});
});

test("Windows reads Path in any case and strips quotes around an entry", () => {
	withBinDir(["herdr.exe"], (dir) => {
		assert.equal(
			isHerdrAvailable(
				{ HERDR_ENV: "1", Path: `C:\nowhere${delimiter}"${dir}"` },
				"win32",
			),
			true,
		);
	});
});

test("POSIX still looks for an executable named herdr, not herdr.exe", () => {
	withBinDir(["herdr.exe"], (dir) => {
		assert.equal(
			isHerdrAvailable({ HERDR_ENV: "1", PATH: dir }, "linux"),
			false,
		);
	});
	if (process.platform === "win32") return; // no executable bit to test
	withBinDir(["herdr"], (dir) => {
		assert.equal(
			isHerdrAvailable({ HERDR_ENV: "1", PATH: dir }, "linux"),
			true,
		);
	});
});

test("outside Herdr nothing is available, whatever the PATH holds", () => {
	withBinDir(["herdr.exe"], (dir) => {
		assert.equal(isHerdrAvailable({ PATH: dir }, "win32"), false);
	});
});
