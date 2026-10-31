/** Child-only shutdown gate for audit-stop.test.ts; never installed outside its fixture. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

export interface ShutdownEvidence {
	pid: number;
	startTime: string;
	sessionFile: string;
	exitSidecar: string | null;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_PERSISTENT !== "1") return;
	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionFile = process.env.PI_SUBAGENT_SESSION!;
		const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
		// stat field 22; the command in parentheses may contain spaces.
		const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		let exitSidecar: string | null = null;
		try {
			exitSidecar = readFileSync(`${sessionFile}.exit`, "utf8");
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
			// The parent may already have consumed it. The test also checks the
			// actual stop tool result and captures early delivery independently.
		}
		writeFileSync(
			join(ctx.cwd, "audit-stop-entered.json"),
			JSON.stringify({ pid: process.pid, startTime, sessionFile, exitSidecar }),
		);
		const release = join(ctx.cwd, "audit-stop-release");
		const deadline = Date.now() + 30_000;
		while (!existsSync(release)) {
			if (Date.now() >= deadline) {
				writeFileSync(join(ctx.cwd, "audit-stop-gate-timeout"), "timeout");
				return;
			}
			await setTimeout(20);
		}
		writeFileSync(join(ctx.cwd, "audit-stop-released"), "released");
	});
}
