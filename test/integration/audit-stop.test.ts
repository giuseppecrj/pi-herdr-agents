/** A semantic .exit sidecar must not confirm a persistent process has exited. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cleanupTestEnv,
	createTestEnv,
	createTrackedSurface,
	getAvailableBackends,
	PI_TIMEOUT,
	shellQuote,
	sleep,
	startPi,
	uniqueId,
	waitForPaneReady,
} from "./harness.ts";
import { resetProviderRequests } from "./fake-provider.ts";
import type { ShutdownEvidence } from "./audit-stop-shutdown-fixture.ts";

type Entry = {
	type?: string;
	customType?: string;
	details?: { status?: string; facts?: { sessionFile?: string } };
	message?: {
		role?: string;
		toolName?: string;
		details?: { status?: string };
	};
};

function entries(path: string): Entry[] {
	if (!existsSync(path)) return [];
	// Ignore an unfinished last line while the real parent appends its journal.
	return readFileSync(path, "utf8")
		.split("\n")
		.slice(0, -1)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function stopNotices(path: string): Entry[] {
	return entries(path).filter(
		(entry) =>
			entry.type === "custom_message" && entry.customType === "subagent_stop",
	);
}

function childAlive(child: ShutdownEvidence): boolean {
	try {
		const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19] === child.startTime && !["Z", "X"].includes(fields[0]);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(20);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

for (const backend of getAvailableBackends()) {
	describe(`audit persistent stop exit ordering [${backend}]`, () => {
		it("delivers stopped only after the shutdown gate is released and Pi exits", {
			timeout: PI_TIMEOUT * 2,
			skip:
				process.platform !== "linux"
					? "requires Linux process identity"
					: false,
		}, async (t) => {
			const env = createTestEnv(backend);
			resetProviderRequests();
			const id = uniqueId();
			const parentSession = join(env.dir, "audit-stop-parent.jsonl");
			const entered = join(env.dir, "audit-stop-entered.json");
			const release = join(env.dir, "audit-stop-release");
			const released = join(env.dir, "audit-stop-released");
			let child: ShutdownEvidence | undefined;
			try {
				// startPi disables parent auto-discovery. Only the real child loads
				// this fixture from its isolated agent directory, alongside the host.
				const fixture = fileURLToPath(
					new URL("./audit-stop-shutdown-fixture.ts", import.meta.url),
				);
				writeFileSync(
					join(env.dir, ".pi/agent/extensions/audit-stop-shutdown.ts"),
					`export { default } from ${JSON.stringify(fixture)};\n`,
				);
				const configDir = join(env.dir, ".pi/agent/herdr-agents");
				mkdirSync(configDir, { recursive: true });
				writeFileSync(
					join(configDir, "config.json"),
					JSON.stringify({
						status: { enabled: true },
						supervision: { forcePolling: true },
					}),
				);
				const parent = createTrackedSurface(env, `audit-stop-${id}`);
				await waitForPaneReady(parent);
				startPi(
					parent,
					env.dir,
					[
						`INTEGRATION_PERSISTENT_SPECIALIST:${id}`,
						`PERSISTENT_START_FILE: ${join(env.dir, "audit-stop-task-start")}`,
						"Run the scripted persistent lifecycle through the real tools.",
					].join("\n"),
					{ extraArgs: `--session ${shellQuote(parentSession)}` },
				);

				await until(() => existsSync(entered), "child session_shutdown entry");
				// SAFETY: the child-only fixture above is the sole writer of this file.
				child = JSON.parse(readFileSync(entered, "utf8")) as ShutdownEvidence;
				assert.ok(
					childAlive(child),
					"shutdown handler must hold the original Pi process alive",
				);
				assert.equal(existsSync(release), false);
				assert.equal(existsSync(released), false);
				// Copy, rather than later reread, the semantic sidecar: the parent
				// consumes it. ENOENT in the fixture is possible if it won the race.
				if (child.exitSidecar !== null) {
					assert.equal(JSON.parse(child.exitSidecar).type, "done");
				}
				await until(
					() =>
						entries(parentSession).some(
							(entry) =>
								entry.message?.role === "toolResult" &&
								entry.message.toolName === "subagent_stop" &&
								entry.message.details?.status === "stop_requested",
						),
					"real parent subagent_stop acknowledgement",
				);
				t.diagnostic(
					`shutdown entered: pid=${child.pid}, startTime=${child.startTime}, semanticExit=${child.exitSidecar ?? "already consumed"}, alive=${childAlive(child)}`,
				);

				// Deliberate negative-observation window: three forced one-second
				// supervisor polls, comfortably below the 15-second stop timeout.
				const holdUntil = Date.now() + 3_000;
				while (Date.now() < holdUntil) {
					const notices = stopNotices(parentSession);
					assert.equal(
						notices.length,
						0,
						`parent delivered stopped before shutdown release: pid=${child.pid}, alive=${childAlive(child)}, released=${existsSync(released)}, statuses=${JSON.stringify(notices.map((notice) => notice.details?.status))}`,
					);
					await sleep(20);
				}
				assert.ok(
					childAlive(child),
					"child must not be terminated while shutdown is held",
				);
				writeFileSync(release, "release");
				await until(
					() => existsSync(released),
					"child observing shutdown release",
				);
				const identity = child;
				await until(() => {
					const alive = childAlive(identity);
					if (alive)
						assert.equal(
							stopNotices(parentSession).length,
							0,
							"stopped notice precedes actual Pi exit",
						);
					return !alive;
				}, "original Pi process exit");
				await until(
					() => stopNotices(parentSession).length > 0,
					"stopped delivery after exit",
				);
				await until(
					() =>
						readFileSync(parentSession, "utf8").includes(
							`PERSISTENT_LIFECYCLE_COMPLETE_${id}`,
						),
					"parent continuing after stopped delivery",
				);
				const notices = stopNotices(parentSession);
				assert.equal(notices.length, 1, "exactly one stopped notice");
				assert.equal(notices[0].details?.status, "stopped");
				assert.equal(notices[0].details?.facts?.sessionFile, child.sessionFile);
				assert.equal(
					existsSync(join(env.dir, "audit-stop-gate-timeout")),
					false,
				);
			} finally {
				// Release even on assertion failure before harness-owned pane teardown.
				writeFileSync(release, "cleanup release");
				try {
					if (child) {
						const identity = child;
						await until(
							() => !childAlive(identity),
							"test-owned child exit during cleanup",
						);
					}
				} finally {
					cleanupTestEnv(env);
				}
			}
		});
	});
}
