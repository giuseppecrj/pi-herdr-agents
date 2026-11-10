import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
	cleanupTestProcess,
	linuxProcessExited,
} from "../helpers/process-cleanup.ts";

const stat = (state: string) =>
	`123 (node -e x) ${state} 1 123 123 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 98765 0`;

test("linuxProcessExited treats zombie, dead and absent PIDs as exited", () => {
	assert.equal(
		linuxProcessExited(123, () => stat("Z")),
		true,
	);
	assert.equal(
		linuxProcessExited(123, () => stat("X")),
		true,
	);
	assert.equal(
		linuxProcessExited(123, () => {
			throw Object.assign(new Error("gone"), { code: "ENOENT" });
		}),
		true,
	);
	for (const state of ["R", "S", "D", "T"])
		assert.equal(
			linuxProcessExited(123, () => stat(state)),
			false,
			state,
		);
	assert.throws(
		() =>
			linuxProcessExited(123, () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			}),
		/denied/,
	);
});

// An unreaped zombie still answers kill(pid, 0). `sh` backgrounds `true`, then
// execs `sleep`, which never reaps it, so `true` stays a zombie until `sleep`
// ends. Cleanup must accept it as exited instead of failing after 5 s.
test("cleanupTestProcess accepts an unreaped zombie as exited", {
	skip:
		process.platform !== "linux" && "zombie states are read from Linux /proc",
}, async (t) => {
	const parent = spawn("sh", ["-c", "true & echo $!; exec sleep 30"], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	t.after(() => cleanupTestProcess(parent.pid));
	const lines = createInterface({ input: parent.stdout! });
	t.after(() => lines.close());
	const [line] = await once(lines, "line");
	const zombie = Number(line);
	assert.ok(Number.isSafeInteger(zombie) && zombie > 0, line);
	const deadline = performance.now() + 5_000;
	while (!readFileSync(`/proc/${zombie}/stat`, "utf8").includes(") Z ")) {
		assert.ok(
			performance.now() < deadline,
			"the fixture never became a zombie",
		);
		await delay(10);
	}
	assert.doesNotThrow(() => process.kill(zombie, 0));
	const started = performance.now();
	await cleanupTestProcess(zombie);
	assert.ok(performance.now() - started < 1_000);
});
