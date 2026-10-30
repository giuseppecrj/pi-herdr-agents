import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import subagentDoneExtension from "../../maestro/adapters/pi/child/subagent-done.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

/** SIGTERM grace plus settle margin at shutdown, with slack for reaping. */
const SHUTDOWN_BOUND_MS = 2_500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(ready: () => boolean, what: string, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (!ready()) {
		assert.ok(Date.now() < deadline, what);
		await delay(20);
	}
}

function groupGone(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return false;
	} catch (error) {
		// SAFETY: process.kill throws only Node system errors, which carry `code`.
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** The pid a check wrote, which leads its process group; 0 until written. */
function readPid(file: string): number {
	return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0;
}

describe("accept check shutdown ownership", () => {
	let dir = "";
	let pidFile = "";
	// The check ignores SIGTERM, and so does its sleep.
	let run = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "accept-shutdown-"));
		pidFile = join(dir, "check.pid");
		run = `trap '' TERM; echo $$ > ${pidFile}; sleep 30`;
	});
	afterEach(() => {
		const pgid = readPid(pidFile);
		if (pgid > 0)
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				/* already gone */
			}
		rmSync(dir, { recursive: true, force: true });
	});

	it("the child's session_shutdown terminates its running check within the bound", async () => {
		const specFile = join(dir, "spec.json");
		writeFileSync(specFile, JSON.stringify({ version: 1, run }));
		const previous = {
			auto: process.env.PI_SUBAGENT_AUTO_EXIT,
			file: process.env.PI_SUBAGENT_ACCEPT_FILE,
		};
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		process.env.PI_SUBAGENT_ACCEPT_FILE = specFile;
		try {
			const { api, eventHandlers } = createMockExtensionApi();
			subagentDoneExtension(api);
			const [settle] = eventHandlers.get("agent_before_settle") ?? [];
			assert.ok(settle, "the child registered its accept loop");
			const pending = settle(
				{ outcome: "completed", entries: [] },
				{ signal: new AbortController().signal },
			);
			await until(() => readPid(pidFile) > 0, "the check never started");
			const pgid = readPid(pidFile);
			const began = Date.now();
			for (const handler of eventHandlers.get("session_shutdown") ?? [])
				await handler({ reason: "quit" }, {});
			await until(
				() => groupGone(pgid),
				"the check's group outlived the child's shutdown",
				Math.max(0, SHUTDOWN_BOUND_MS - (Date.now() - began)),
			);
			assert.equal(await pending, undefined, "a stopped check is no try");
		} finally {
			for (const [key, value] of [
				["PI_SUBAGENT_AUTO_EXIT", previous.auto],
				["PI_SUBAGENT_ACCEPT_FILE", previous.file],
			] as const)
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
		}
	});

	it("an owner that aborts its check and exits at once leaves no group behind", async () => {
		const runner = new URL(
			"../../maestro/adapters/pi/accept-runner.ts",
			import.meta.url,
		).href;
		// The owner exits before the SIGKILL grace could run out.
		const code = `
import { existsSync, readFileSync } from "node:fs";
import { runAcceptCommand } from ${JSON.stringify(runner)};
const controller = new AbortController();
void runAcceptCommand({ run: ${JSON.stringify(run)}, cwd: ${JSON.stringify(dir)}, timeoutMs: 60_000, signal: controller.signal });
setInterval(() => {
	const file = ${JSON.stringify(pidFile)};
	if (!existsSync(file) || !readFileSync(file, "utf8").trim()) return;
	controller.abort();
	process.exit(0);
}, 10);
`;
		const owner = spawn(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", code],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		const [exitCode] = await once(owner, "exit");
		assert.equal(exitCode, 0);
		const pgid = readPid(pidFile);
		assert.ok(pgid > 0, "the check never started");
		await until(
			() => groupGone(pgid),
			"the check's group outlived its owner's exit",
			1_000,
		);
	});
});
