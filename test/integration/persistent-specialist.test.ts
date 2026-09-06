/** Deterministic end-to-end coverage for persistent specialist turns. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAvailableBackends,
	setBackend,
	restoreBackend,
	createTestEnv,
	cleanupTestEnv,
	createTrackedSurface,
	waitForPaneReady,
	startPi,
	waitForFile,
	waitForScreen,
	uniqueId,
	trackTempFile,
	PI_TIMEOUT,
	sleep,
	shellQuote,
	type TestEnv,
} from "./harness.ts";
import { resetProviderRequests } from "./fake-provider.ts";

function workspacePanes(workspaceId: string): string[] {
	const result = JSON.parse(
		execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], {
			encoding: "utf8",
		}),
	);
	return result.result.panes.map((pane: { pane_id: string }) => pane.pane_id);
}

type SessionEntry = {
	type?: string;
	customType?: string;
	content?: string;
	details?: {
		name?: string;
		task?: string;
		sessionFile?: string;
		status?: string;
		facts?: { sessionFile?: string };
	};
	message?: { role?: string; content?: unknown };
};

function readEntries(path: string): SessionEntry[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function waitForEntries(
	path: string,
	predicate: (entries: SessionEntry[]) => boolean,
): Promise<SessionEntry[]> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) {
		const entries = readEntries(path);
		if (predicate(entries)) return entries;
		await sleep(100);
	}
	throw new Error(`Timed out waiting for session entries in ${path}`);
}

async function waitForCondition(
	predicate: () => boolean,
	message: string,
): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(100);
	}
	throw new Error(message);
}

const backends = getAvailableBackends();

for (const backend of backends) {
	describe(`persistent-specialist [${backend}]`, {
		timeout: PI_TIMEOUT * 2,
	}, () => {
		let previousBackend: string | undefined;
		let env: TestEnv;

		beforeEach(() => {
			previousBackend = setBackend(backend);
			env = createTestEnv(backend);
			resetProviderRequests();
		});

		afterEach(() => {
			cleanupTestEnv(env);
			restoreBackend(previousBackend);
		});

		it("delivers sequential tasks, rejects busy work, and stops cleanly", async () => {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-persistent-${id}.txt`;
			const parentSession = join(env.dir, `persistent-parent-${id}.jsonl`);
			trackTempFile(env, startFile);
			const parent = createTrackedSurface(env, `persistent-parent-${id}`);
			await waitForPaneReady(parent);
			const baselinePanes = new Set(workspacePanes(env.workspaceId));

			startPi(
				parent,
				env.dir,
				[
					`INTEGRATION_PERSISTENT_SPECIALIST:${id}`,
					`PERSISTENT_START_FILE: ${startFile}`,
					"Spawn the persistent specialist and follow the scripted lifecycle.",
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);

			// The deterministic child spends task 1 in a real bash command. This
			// proves the busy rejection happens while the process is mid-task.
			const started = await waitForFile(
				startFile,
				PI_TIMEOUT,
				/PERSISTENT_START/,
			);
			assert.match(started, /PERSISTENT_START/);
			assert.doesNotMatch(started, /PERSISTENT_DONE/);

			const taskOneEntries = await waitForEntries(parentSession, (entries) =>
				entries.some(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result" &&
						entry.details?.name === `Persistent-${id}`,
				),
			);
			const taskOneResult = taskOneEntries.find(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "subagent_result" &&
					entry.details?.name === `Persistent-${id}`,
			);
			assert.ok(
				taskOneResult?.details?.task,
				"task 1 result must carry its task ID",
			);
			assert.equal(
				taskOneEntries.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result" &&
						entry.details?.name === `Persistent-${id}`,
				).length,
				1,
				"task 1 must be delivered exactly once",
			);

			// SAFETY: the result contract requires a retained child session path.
			const sessionFile = taskOneResult.details?.sessionFile as string;
			assert.ok(sessionFile && existsSync(sessionFile));
			assert.equal(
				existsSync(`${sessionFile}.exit`),
				false,
				"persistent child must not write an exit sidecar after task 1",
			);
			assert.ok(
				workspacePanes(env.workspaceId).length > baselinePanes.size,
				"persistent child pane must remain open after delivery",
			);

			const taskTwoResult = await waitForEntries(
				parentSession,
				(entries) =>
					entries.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "subagent_result" &&
							entry.details?.name === `Persistent-${id}`,
					).length === 2,
			);
			const resultMessages = taskTwoResult.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "subagent_result" &&
					entry.details?.name === `Persistent-${id}`,
			);
			assert.equal(
				resultMessages.length,
				2,
				"task 2 must be delivered exactly once",
			);
			assert.notEqual(
				resultMessages[0].details?.task,
				resultMessages[1].details?.task,
			);

			const sessionText = readFileSync(sessionFile, "utf8");
			const parentText = readFileSync(parentSession, "utf8");
			assert.match(parentText, /rejected-busy/);
			assert.doesNotMatch(sessionText, new RegExp(`REJECTED_TASK_${id}`));
			assert.match(sessionText, new RegExp(`PERSISTENT_TASK_2_RESULT_${id}`));
			assert.match(parentText, /1 completed/);

			const ledger = readFileSync(`${sessionFile}.ledger`, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			assert.equal(
				ledger.filter((entry) => entry.outcome === "rejected-busy").length,
				1,
			);
			assert.equal(
				ledger.filter((entry) => entry.outcome === "delivered").length,
				2,
			);
			assert.equal(
				ledger.filter((entry) => entry.outcome === "dispatched").length,
				2,
			);
			assert.ok(
				ledger.some((entry) => entry.task === resultMessages[0].details?.task),
			);

			const policy = JSON.parse(
				readFileSync(`${sessionFile}.pi-herdr-subagent-policy.json`, "utf8"),
			);
			assert.equal(policy.version, 2);
			assert.equal(policy.persistent, true);

			await waitForEntries(
				parentSession,
				(entries) =>
					entries.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "subagent_stop",
					).length === 1 &&
					entries.some((entry) =>
						JSON.stringify(entry).includes("PERSISTENT_LIFECYCLE_COMPLETE"),
					),
			);
			await waitForCondition(() => {
				const panes = workspacePanes(env.workspaceId);
				return (
					panes.length === baselinePanes.size &&
					panes.every((pane) => baselinePanes.has(pane))
				);
			}, "persistent child pane did not close after confirmed stop");

			const finalEntries = readEntries(parentSession);
			const stopped = finalEntries.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "subagent_stop",
			);
			assert.equal(stopped.length, 1, "parent must receive one stopped steer");
			assert.equal(stopped[0].details?.status, "stopped");
			assert.equal(stopped[0].details?.facts?.sessionFile, sessionFile);
			assert.match(stopped[0].content ?? "", /Task outcomes:/);
			assert.equal(
				existsSync(sessionFile),
				true,
				"stopped session must be retained",
			);
			assert.equal(
				existsSync(`${sessionFile}.pi-herdr-subagent-policy.json`),
				true,
				"stopped policy must be retained",
			);
			assert.doesNotMatch(
				finalEntries
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "subagents_list",
					)
					.map((entry) => entry.content)
					.join("\n"),
				new RegExp(`Persistent-${id}`),
			);
			await waitForScreen(
				parent,
				new RegExp(`PERSISTENT_LIFECYCLE_COMPLETE_${id}`),
				PI_TIMEOUT,
			);
		});
	});
}
