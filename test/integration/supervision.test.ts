/**
 * Deterministic component integration for the completion, file-wake, and
 * shared-reconciliation seams. Real parent/child lifecycle coverage remains in
 * subagent-lifecycle.test.ts and persistent-specialist.test.ts.
 *
 * A real Pi parent cannot deterministically publish an error or caller_ping
 * sidecar in the same event-loop turn as a terminal read. The unit reproducer
 * in test/test.ts covers that semantic race; this file verifies normal
 * supervision transport behavior without timing a provider response.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitForCompletion } from "../../pi-extension/subagents/completion.ts";
import {
	POLLING_INTERVAL_MS,
	RECONCILE_INTERVAL_MS,
	SupervisionCoordinator,
} from "../../pi-extension/subagents/supervision.ts";
import {
	appendPersistentTaskEvent,
	readPersistentTaskEvents,
} from "../../pi-extension/subagents/session.ts";

const RECONCILE_BUDGET_MS = RECONCILE_INTERVAL_MS + 700;

type SidecarPayload =
	| { type: "done" }
	| { type: "error"; errorMessage: string }
	| { type: "ping"; name: string; message: string };

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually(
	predicate: () => boolean,
	description: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function publishSidecar(sessionFile: string, payload: SidecarPayload): void {
	const temporary = `${sessionFile}.exit.tmp`;
	writeFileSync(temporary, JSON.stringify(payload));
	renameSync(temporary, `${sessionFile}.exit`);
}

function makeSupervisor(
	forcePolling = false,
	shouldFailList: () => boolean = () => false,
) {
	let fallbackCount = 0;
	return {
		supervisor: new SupervisionCoordinator(
			async () => {
				if (shouldFailList()) throw new Error("pane list unavailable");
				return {
					complete: true,
					panes: [
						{
							paneId: "child-pane",
							workspaceId: "test-workspace",
							inspection: {
								kind: "present",
								agentStatus: "idle",
								observedAt: Date.now(),
							},
						},
					],
				};
			},
			async () => {
				fallbackCount += 1;
				return {
					kind: "present",
					agentStatus: "idle",
					observedAt: Date.now(),
				};
			},
			forcePolling,
		),
		fallbackInspections: () => fallbackCount,
	};
}

async function watchOutcome(
	sessionFile: string,
	forcePolling: boolean,
	payload: SidecarPayload,
): Promise<{ reason: string; elapsedMs: number; mode: string }> {
	const { supervisor } = makeSupervisor(forcePolling);
	const registration = supervisor.register(sessionFile, "child-pane");
	try {
		const startedAt = Date.now();
		const completion = waitForCompletion(new AbortController().signal, {
			intervalMs: POLLING_INTERVAL_MS,
			sessionFile,
			readTerminalTail: async () => "",
			inspectPane: registration.inspectPane,
			waitForNextCheck: registration.wait,
		});
		await sleep(35);
		publishSidecar(sessionFile, payload);
		const result = await completion;
		return {
			reason: result.reason,
			elapsedMs: Date.now() - startedAt,
			mode: supervisor.diagnostics().mode,
		};
	} finally {
		registration.unregister();
		supervisor.close();
	}
}

describe("event-driven supervision integration", { timeout: 30_000 }, () => {
	it("delivers an ordinary child once despite duplicate late file wakes", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-supervision-integ-"));
		try {
			const sessionFile = join(root, "child.jsonl");
			const { supervisor } = makeSupervisor();
			const registration = supervisor.register(sessionFile, "child-pane");
			try {
				let deliveries = 0;
				const completion = waitForCompletion(new AbortController().signal, {
					intervalMs: POLLING_INTERVAL_MS,
					sessionFile,
					readTerminalTail: async () => "",
					inspectPane: registration.inspectPane,
					waitForNextCheck: registration.wait,
				});
				await sleep(35);
				publishSidecar(sessionFile, { type: "done" });
				assert.equal((await completion).reason, "done");
				deliveries += 1;

				// A second atomic publish is a legal late watcher event. The resolved
				// completion is never re-delivered.
				publishSidecar(sessionFile, { type: "done" });
				await sleep(50);
				assert.equal(deliveries, 1);
			} finally {
				registration.unregister();
				supervisor.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("folds persistent .tasks wakes while idle, then stops after task two", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-supervision-persistent-"));
		try {
			const sessionFile = join(root, "specialist.jsonl");
			writeFileSync(sessionFile, "{}\n");
			const { supervisor } = makeSupervisor();
			const registration = supervisor.register(sessionFile, "child-pane");
			try {
				const delivered: string[] = [];
				let observed = 0;
				const completion = waitForCompletion(new AbortController().signal, {
					intervalMs: POLLING_INTERVAL_MS,
					sessionFile,
					readTerminalTail: async () => "",
					inspectPane: registration.inspectPane,
					waitForNextCheck: registration.wait,
					onLocalEvidence: () => {
						const events = readPersistentTaskEvents(sessionFile);
						for (const event of events.slice(observed))
							delivered.push(event.task);
						observed = events.length;
					},
				});
				await sleep(35);
				appendPersistentTaskEvent(sessionFile, {
					type: "task-done",
					task: "task-1",
					generation: "generation",
				});
				await eventually(() => delivered.length === 1, "task 1 delivery");
				await sleep(50); // The specialist is idle, not terminal, between tasks.
				appendPersistentTaskEvent(sessionFile, {
					type: "task-done",
					task: "task-2",
					generation: "generation",
				});
				await eventually(() => delivered.length === 2, "task 2 delivery");
				publishSidecar(sessionFile, { type: "done" });
				assert.equal((await completion).reason, "done");
				assert.deepEqual(delivered, ["task-1", "task-2"]);
			} finally {
				registration.unregister();
				supervisor.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reconciles dropped file notifications within the five-second budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-supervision-reconcile-"));
		const oldRoot = `${root}-old`;
		try {
			const sessionFile = join(root, "child.jsonl");
			const { supervisor } = makeSupervisor();
			const registration = supervisor.register(sessionFile, "child-pane");
			try {
				// Consume the registration's initial snapshot. Replacing the watched
				// directory drops subsequent fs notifications without making pane
				// inspection evidence unavailable.
				await registration.wait(new AbortController().signal);
				await registration.inspectPane();
				renameSync(root, oldRoot);
				mkdirSync(root);
				const startedAt = Date.now();
				const completion = waitForCompletion(new AbortController().signal, {
					intervalMs: POLLING_INTERVAL_MS,
					sessionFile,
					readTerminalTail: async () => "",
					inspectPane: registration.inspectPane,
					waitForNextCheck: registration.wait,
				});
				publishSidecar(sessionFile, { type: "done" });
				assert.equal((await completion).reason, "done");
				assert.ok(Date.now() - startedAt < RECONCILE_BUDGET_MS);
			} finally {
				registration.unregister();
				supervisor.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(oldRoot, { recursive: true, force: true });
		}
	});

	it("falls back to polling after watcher failure without an extra parent steer", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-supervision-fallback-"));
		try {
			const sessionFile = join(root, "child.jsonl");
			let failLists = false;
			const { supervisor, fallbackInspections } = makeSupervisor(
				false,
				() => failLists,
			);
			const registration = supervisor.register(sessionFile, "child-pane");
			try {
				await registration.wait(new AbortController().signal);
				failLists = true;
				const parentSteers: string[] = [];
				const completion = waitForCompletion(new AbortController().signal, {
					intervalMs: POLLING_INTERVAL_MS,
					sessionFile,
					readTerminalTail: async () => "",
					inspectPane: registration.inspectPane,
					waitForNextCheck: registration.wait,
				});

				// The next batch failure switches this registration to the legacy
				// cadence. A transport transition is internal and has no parent API.
				await eventually(
					() => supervisor.diagnostics().mode === "polling(fallback)",
					"polling fallback",
					RECONCILE_INTERVAL_MS + 1_000,
				);
				await eventually(
					() => fallbackInspections() > 0,
					"legacy fallback inspection",
					POLLING_INTERVAL_MS + 1_000,
				);
				publishSidecar(sessionFile, { type: "done" });
				assert.equal((await completion).reason, "done");
				assert.deepEqual(parentSteers, []);
			} finally {
				registration.unregister();
				supervisor.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps forcePolling outcomes identical for done, error, and ping evidence", async () => {
		for (const forcePolling of [false, true]) {
			for (const payload of [
				{ type: "done" },
				{ type: "error", errorMessage: "provider failed" },
				{ type: "ping", name: "child", message: "help" },
			] as const) {
				const root = mkdtempSync(join(tmpdir(), "pi-supervision-outcome-"));
				try {
					const result = await watchOutcome(
						join(root, "child.jsonl"),
						forcePolling,
						payload,
					);
					assert.equal(result.reason, payload.type);
					assert.match(
						result.mode,
						forcePolling ? /polling\(forced\)/ : /wake\+batch/,
					);
					assert.ok(result.elapsedMs < 2_500);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}
		}
	});
});
