import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { test } from "node:test";
import { isHerdrAvailable } from "../../maestro/surfaces/herdr/herdr-cli.ts";

/** A temp directory holding empty executables, removed afterwards. */
function withBinDir(
	files: string[],
	run: (dir: string) => void,
	prefix = "herdr-available-",
): void {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	try {
		for (const name of files)
			writeFileSync(join(dir, name), "", { mode: 0o755 });
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Run with `dir` as the working directory. POSIX cases name it through a
 * relative PATH entry, because a Windows temp path contains the `:` that the
 * POSIX delimiter would split on.
 */
function inDir(dir: string, run: () => void): void {
	const previous = process.cwd();
	process.chdir(dir);
	try {
		run();
	} finally {
		process.chdir(previous);
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

test("Windows splits PATH on ';' whatever the host, reads Path in any case and strips quotes", () => {
	withBinDir(["herdr.exe"], (dir) => {
		// String.raw: a plain template would turn \n into a newline.
		const path = [String.raw`C:\nowhere`, `"${dir}"`].join(win32.delimiter);
		assert.equal(
			isHerdrAvailable({ HERDR_ENV: "1", Path: path }, "win32"),
			true,
		);
	});
});

test("Windows keeps a ';' that sits inside a quoted PATH entry", () => {
	withBinDir(
		["herdr.exe"],
		(dir) => {
			assert.ok(dir.includes(";"), "the fixture directory must contain ';'");
			for (const path of [`"${dir}"`, `C:\\nowhere;"${dir}";C:\\other`])
				assert.equal(
					isHerdrAvailable({ HERDR_ENV: "1", PATH: path }, "win32"),
					true,
					path,
				);
			// Unquoted, the same directory is two broken entries.
			assert.equal(
				isHerdrAvailable({ HERDR_ENV: "1", PATH: dir }, "win32"),
				false,
			);
		},
		"herdr;available-",
	);
});

test("Windows skips empty PATH entries", () => {
	withBinDir(["herdr.exe"], (dir) => {
		inDir(dir, () => {
			assert.equal(
				isHerdrAvailable({ HERDR_ENV: "1", PATH: ";;" }, "win32"),
				false,
			);
		});
	});
});

test("POSIX looks for an executable named herdr, not herdr.exe", () => {
	withBinDir(["herdr.exe"], (dir) => {
		inDir(dir, () => {
			assert.equal(
				isHerdrAvailable({ HERDR_ENV: "1", PATH: "." }, "linux"),
				false,
			);
		});
	});
	withBinDir(["herdr"], (dir) => {
		inDir(dir, () => {
			assert.equal(
				isHerdrAvailable({ HERDR_ENV: "1", PATH: "." }, "linux"),
				true,
			);
		});
	});
});

test("POSIX keeps an empty PATH entry, which means the current directory", () => {
	withBinDir(["herdr"], (dir) => {
		inDir(dir, () => {
			for (const path of [
				`/nowhere${posix.delimiter}`,
				`${posix.delimiter}/nowhere`,
			])
				assert.equal(
					isHerdrAvailable({ HERDR_ENV: "1", PATH: path }, "linux"),
					true,
					path,
				);
		});
	});
});

test("outside Herdr nothing is available, whatever the PATH holds", () => {
	withBinDir(["herdr.exe"], (dir) => {
		assert.equal(isHerdrAvailable({ PATH: dir }, "win32"), false);
	});
});
