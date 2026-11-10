import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	createLinuxProcessEnvironmentReader,
	readLinuxProcessEnvironment,
} from "../../maestro/adapters/pi/process-identity.ts";

const linux = process.platform === "linux";
const errno = (code: string) =>
	Object.assign(new Error(`${code}: test`), { code });

describe("process environment", () => {
	it("keeps the first value per name and throws on non-missing read errors", () => {
		const reader = createLinuxProcessEnvironmentReader(
			() => "A=1\0B=x=y\0A=2\0=bad\0noequals\0",
		);
		if (!linux) {
			assert.throws(() => reader(20), /unreadable on/);
			return;
		}
		assert.deepEqual(
			[...(reader(20) ?? [])],
			[
				["A", "1"],
				["B", "x=y"],
			],
		);
		const failing = (code: string) =>
			createLinuxProcessEnvironmentReader(() => {
				throw errno(code);
			});
		for (const code of ["ENOENT", "ESRCH"])
			assert.equal(failing(code)(20), undefined, code);
		for (const code of ["EACCES", "EIO"])
			assert.throws(() => failing(code)(20), new RegExp(code));
	});

	it("a live process's exec-time environment survives its title rewrite", async (t) => {
		if (!linux) return t.skip("Linux /proc only");
		const child = spawn(
			process.execPath,
			[
				"-e",
				"process.title = 'pi'; console.log('ready'); setInterval(() => {}, 1e3)",
			],
			{
				env: { ...process.env, MARKER: "/s.jsonl" },
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		try {
			await once(child.stdout!, "data");
			const pid = child.pid!;
			assert.doesNotMatch(readFileSync(`/proc/${pid}/cmdline`, "utf8"), /-e/);
			assert.equal(readLinuxProcessEnvironment(pid)?.get("MARKER"), "/s.jsonl");
		} finally {
			child.kill("SIGKILL");
		}
		assert.equal(readLinuxProcessEnvironment(2 ** 22 + 1), undefined);
	});
});
