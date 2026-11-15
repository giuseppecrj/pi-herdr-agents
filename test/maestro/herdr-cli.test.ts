import "../clean-host-env.ts";
import assert from "node:assert/strict";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { cleanupTestProcess } from "../helpers/process-cleanup.ts";
import {
	herdrExecAsync,
	HerdrClientError,
	HERDR_RPC_TIMEOUT_MS,
	HERDR_OUTPUT_BYTES,
} from "../../maestro/surfaces/herdr/herdr-cli.ts";

// The client under test may kill its process group, but fixture ownership must
// not depend on that behavior. Only signal PIDs recorded by these fixtures.
async function cleanupRecordedProcess(file: string) {
	let value: string;
	try {
		value = readFileSync(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return;
		throw error;
	}
	await cleanupTestProcess(Number(value));
}

/**
 * A PATH entry that `spawn("herdr")` can start. On Windows that is only a PE
 * `herdr.exe` (see herdr-cli `herdrExecutableNames`); a `.cmd` or extensionless
 * script is ENOENT. The Windows stub is a copy of this Node plus a `--require`
 * preload that runs `body.js` as the main module.
 */
async function client(script: string | undefined, run: () => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "async-herdr-client-"));
	const path = process.env.PATH;
	const previousNodeOptions = process.env.NODE_OPTIONS;
	const pidFile = join(dir, "client.pid");
	if (script) {
		const body = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const descendantPidFile = ${JSON.stringify(join(dir, "descendant.pid"))};
${script}
`;
		if (process.platform === "win32") {
			writeFileSync(join(dir, "body.js"), body);
			writeFileSync(
				join(dir, "preload.cjs"),
				`const path = require("node:path");
const Module = require("node:module");
const body = path.join(__dirname, "body.js");
const original = Module.runMain;
Module.runMain = function runMain() {
	const args = process.argv.slice(1);
	process.argv = [process.argv[0], body, ...args];
	return original.call(this, body);
};
`,
			);
			copyFileSync(process.execPath, join(dir, "herdr.exe"));
			const requireArg = `--require ${pathToFileURL(join(dir, "preload.cjs")).href}`;
			process.env.NODE_OPTIONS = previousNodeOptions
				? `${previousNodeOptions} ${requireArg}`
				: requireArg;
		} else {
			writeFileSync(join(dir, "herdr"), `#!${process.execPath}\n${body}`, {
				mode: 0o755,
			});
		}
	}
	process.env.PATH = dir;
	try {
		await run();
	} finally {
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
		if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = previousNodeOptions;
		try {
			try {
				await cleanupRecordedProcess(pidFile);
			} finally {
				await cleanupRecordedProcess(join(dir, "descendant.pid"));
			}
		} finally {
			rmSync(dir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 50,
			});
		}
	}
}

test("Herdr clients have finite defaults and reject zero before spawning", async () => {
	assert.equal(HERDR_RPC_TIMEOUT_MS, 10_000);
	assert.equal(HERDR_OUTPUT_BYTES, 1024 * 1024);
	await assert.rejects(herdrExecAsync([], 0), /finite and positive/);
});

test("slow Herdr client leaves parent timers responsive and expires without waiting for close", async () => {
	await client("setTimeout(() => console.log('late'), 5000)", async () => {
		let heartbeat = false;
		const timer = setTimeout(() => {
			heartbeat = true;
		}, 5);
		const started = performance.now();
		try {
			await assert.rejects(
				herdrExecAsync(["pane", "list"], 80),
				(error) =>
					error instanceof HerdrClientError && error.kind === "timeout",
			);
			assert.equal(heartbeat, true);
			assert.ok(performance.now() - started < 1500);
		} finally {
			clearTimeout(timer);
		}
	});
});

test("not-spawned, post-spawn exit, and bounded output overflow remain distinct", async () => {
	await client(undefined, async () => {
		await assert.rejects(
			herdrExecAsync([], 1000),
			(error) =>
				error instanceof HerdrClientError && error.kind === "not-spawned",
		);
	});
	await client(
		"process.stderr.write('remote refusal'); process.exitCode=3",
		async () => {
			await assert.rejects(
				herdrExecAsync([], 1000),
				(error) =>
					error instanceof HerdrClientError &&
					error.kind === "exit" &&
					error.stderr === "remote refusal",
			);
		},
	);
	await client(
		"process.stdout.write('x'.repeat(2*1024*1024)); setInterval(() => {}, 1000)",
		async () => {
			await assert.rejects(
				herdrExecAsync([], 1500),
				(error) =>
					error instanceof HerdrClientError &&
					error.kind === "overflow" &&
					error.stdout.length <= HERDR_OUTPUT_BYTES,
			);
		},
	);
});

test("a descendant holding inherited stdout cannot extend the client's deadline", async () => {
	await client(
		`
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore',1,2]});
require('node:fs').writeFileSync(descendantPidFile, String(child.pid));
child.unref();`,
		async () => {
			const started = performance.now();
			await assert.rejects(
				herdrExecAsync([], 150),
				(error) =>
					error instanceof HerdrClientError && error.kind === "timeout",
			);
			assert.ok(performance.now() - started < 1500);
		},
	);
});

test("worktree clients scrub repository-local Git environment without mutating the parent", async () => {
	const previous = process.env.GIT_DIR;
	process.env.GIT_DIR = "/poisoned";
	try {
		await client("console.log(process.env.GIT_DIR ?? 'absent')", async () => {
			assert.equal(
				(await herdrExecAsync(["worktree", "list"], 1000)).trim(),
				"absent",
			);
			assert.equal(process.env.GIT_DIR, "/poisoned");
		});
	} finally {
		if (previous === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = previous;
	}
});
