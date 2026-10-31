import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	herdrExecAsync,
	HerdrClientError,
	HERDR_RPC_TIMEOUT_MS,
	HERDR_OUTPUT_BYTES,
} from "../../maestro/surfaces/herdr/herdr-cli.ts";

async function client(script: string | undefined, run: () => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "async-herdr-client-"));
	const path = process.env.PATH;
	if (script)
		writeFileSync(join(dir, "herdr"), `#!${process.execPath}\n${script}\n`, {
			mode: 0o755,
		});
	process.env.PATH = dir;
	try {
		await run();
	} finally {
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
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
		`require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore',1,2]}).unref();`,
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
