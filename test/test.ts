import "./isolated-agent-dir.ts";
import { describe, it, before, after } from "node:test";
import { cleanupFixture } from "./worktree-cleanup-fixture.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	getSubagentsConfigPath,
	getSubagentsConfigExamplePath,
	getSubagentsPackageRoot,
} from "../pi-extension/subagents/config-path.ts";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
	createEventBus,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "@sinclair/typebox/value";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
	isPlainObject,
	isRecord,
	isString,
} from "../pi-extension/subagents/type-guards.ts";
import rolePackExample from "../examples/role-pack/extension.ts";
import {
	cleanupSubagentsForShutdown,
	selectCompletionApi,
	shouldDeliverSubagentCompletion,
	shouldPreserveSubagentsOnShutdown,
} from "../pi-extension/subagents/index.ts";

import {
	getLeafId,
	getNewEntries,
	findLastAssistantMessage,
	inspectFinalAssistantMessage,
	inspectNoProgressSessionTail,
	findObservedSessionRuntime,
	appendBranchSummary,
	copySessionFile,
	mergeNewEntries,
	seedSubagentSessionFile,
	createBtwSessionSnapshot,
	createWorktreeSessionFork,
	getSubagentSessionPolicyFile,
	readSubagentSessionPolicy,
	writeSubagentSessionPolicy,
	appendPersistentTaskEvent,
	readPersistentTaskEvents,
	appendPersistentDeliveryLedger,
	readPersistentDeliveryLedger,
	writePersistentTaskInbox,
	consumePersistentTaskInbox,
	type SessionEntry,
} from "../pi-extension/subagents/session.ts";

import {
	isHerdrAvailable,
	waitForProcessesExit,
	__herdrTest__,
} from "../pi-extension/subagents/herdr.ts";
import {
	loadModelConfig,
	parseModelConfig,
	resolveModelDefault,
	writeTaskModelConfig,
} from "../pi-extension/subagents/model-config.ts";
import {
	loadRoleConfig,
	parseRoleConfig,
} from "../pi-extension/subagents/role-config.ts";
import {
	createSubagentPaneFactory,
	loadPaneConfig,
	parsePaneConfig,
} from "../pi-extension/subagents/pane-config.ts";
import {
	loadPersistentConfig,
	parsePersistentConfig,
} from "../pi-extension/subagents/persistent-config.ts";
import {
	loadSupervisionConfig,
	parseSupervisionConfig,
} from "../pi-extension/subagents/supervision-config.ts";
import { FileWakeRegistry } from "../pi-extension/subagents/wake.ts";
import {
	POLLING_INTERVAL_MS,
	SupervisionCoordinator,
} from "../pi-extension/subagents/supervision.ts";
import {
	advanceStatusState,
	capStatusLines,
	classifyStatus,
	createStatusState,
	forceStatusAfterInterrupt,
	formatStatusAggregate,
	formatStatusLine,
	formatTransitionLine,
	observeStatus,
	loadStatusConfig,
	parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
	createSubagentActivityRecorder,
	getSubagentActivityFile,
	readSubagentActivityFile,
	type SubagentActivityState,
} from "../pi-extension/subagents/activity.ts";
import subagentDoneExtension, {
	shouldMarkUserTookOver,
	shouldAutoExitOnAgentEnd,
	findLatestAssistantError,
	buildCompletionSidecar,
	buildPersistentTaskEvent,
	isPersistentStopDirective,
} from "../pi-extension/subagents/subagent-done.ts";
import {
	interpretExitSidecar,
	waitForCompletion,
} from "../pi-extension/subagents/completion.ts";
import {
	createLifecycle,
	lifecycleTransition,
	markCompleted,
	markCompletionDetected,
	markFailed,
	markInterruptRequested,
	observeActivity as observeLifecycleActivity,
	observePaneInspection,
	projectLifecycle,
	type SubagentLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";
import { launchPiSubagent } from "../pi-extension/subagents/launch.ts";
import {
	buildAuthenticatedModelCatalog,
	wrapPiModelRegistry,
} from "../pi-extension/subagents/runtime-routing.ts";

// Tool-registration behavior is environment-sensitive for child subagents.
// Isolate the unit suite from inherited parent/child capability variables.
const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
const inheritedDenyTools = process.env.PI_DENY_TOOLS;
before(() => {
	delete process.env.PI_SUBAGENT_ID;
	delete process.env.PI_DENY_TOOLS;
});
after(() => {
	if (inheritedSubagentId == null) delete process.env.PI_SUBAGENT_ID;
	else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
	if (inheritedDenyTools == null) delete process.env.PI_DENY_TOOLS;
	else process.env.PI_DENY_TOOLS = inheritedDenyTools;
});

// --- Helpers ---

function createTestDir(): string {
	return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
	const file = join(dir, "test-session.jsonl");
	const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(file, content);
	return file;
}

function withTempDir(run: (dir: string) => void) {
	const dir = createTestDir();
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function createMockExtensionApi(extensionEvents = createEventBus()) {
	const registeredTools: Array<any> = [];
	const registeredCommands: Array<any> = [];
	const registeredShortcuts: Array<any> = [];
	const registeredMessageRenderers: Array<any> = [];
	const eventHandlers = new Map<string, Array<Function>>();
	const sentUserMessages: string[] = [];
	const sentMessages: Array<any> = [];
	return {
		registeredTools,
		registeredCommands,
		registeredShortcuts,
		registeredMessageRenderers,
		eventHandlers,
		sentUserMessages,
		sentMessages,
		// SAFETY: this fixture implements only the ExtensionAPI members these
		// tests exercise; TypeScript cannot verify partial-mock compatibility
		// without also declaring every unused SDK method.
		api: {
			events: extensionEvents,
			on(event: string, handler: Function) {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
			registerTool(tool: any) {
				registeredTools.push(tool);
			},
			registerCommand(name: string, command: any) {
				registeredCommands.push({ name, ...command });
			},
			registerMessageRenderer(name: string, renderer: any) {
				registeredMessageRenderers.push({ name, renderer });
			},
			registerShortcut(key: string, shortcut: any) {
				registeredShortcuts.push({ key, ...shortcut });
			},
			sendUserMessage(message: string) {
				sentUserMessages.push(message);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			getAllTools() {
				return [];
			},
		} as any,
	};
}

function restoreEnvVar(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = originalNow;
	}
}

function writeAgentFile(
	agentsDir: string,
	name: string,
	frontmatter: string,
	body = "You are a test agent.",
) {
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\n${frontmatter}\n---\n\n${body}\n`,
	);
}

async function withIsolatedAgentEnv(
	fn: (paths: {
		projectDir: string;
		projectAgentsDir: string;
		globalDir: string;
		globalAgentsDir: string;
	}) => Promise<void> | void,
) {
	const root = createTestDir();
	const previousCwd = process.cwd();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const projectDir = join(root, "project");
	const projectAgentsDir = join(projectDir, ".pi", "agents");
	const globalDir = join(root, "global");
	const globalAgentsDir = join(globalDir, "agents");

	mkdirSync(projectAgentsDir, { recursive: true });
	mkdirSync(globalAgentsDir, { recursive: true });
	process.chdir(projectDir);
	process.env.PI_CODING_AGENT_DIR = globalDir;

	try {
		await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
	} finally {
		process.chdir(previousCwd);
		restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
		rmSync(root, { recursive: true, force: true });
	}
}
const SESSION_HEADER: SessionEntry = {
	type: "session",
	id: "sess-001",
	version: 3,
};
const MODEL_CHANGE: SessionEntry = {
	type: "model_change",
	id: "mc-001",
	parentId: null,
};
const USER_MSG: SessionEntry = {
	type: "message",
	id: "user-001",
	parentId: "mc-001",
	message: {
		role: "user",
		content: [{ type: "text", text: "Hello, plan something" }],
	},
};
const ASSISTANT_MSG: SessionEntry = {
	type: "message",
	id: "asst-001",
	parentId: "user-001",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Here is my plan..." }],
	},
};
const ASSISTANT_MSG_2: SessionEntry = {
	type: "message",
	id: "asst-002",
	parentId: "asst-001",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me think..." },
			{ type: "text", text: "Updated plan with details." },
		],
	},
};
const TOOL_RESULT: SessionEntry = {
	type: "message",
	id: "tool-001",
	parentId: "asst-001",
	message: {
		role: "toolResult",
		toolCallId: "tc-001",
		toolName: "bash",
		content: [{ type: "text", text: "output here" }],
	},
};

// --- Tests ---

describe("session.ts", () => {
	let dir: string;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("getLeafId", () => {
		it("returns last entry id", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			assert.equal(getLeafId(file), "asst-001");
		});

		it("returns null for empty file", () => {
			const file = join(dir, "empty.jsonl");
			writeFileSync(file, "");
			assert.equal(getLeafId(file), null);
		});
	});

	describe("getNewEntries", () => {
		it("returns entries after a given line", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 2);
			assert.equal(entries[0].id, "user-001");
			assert.equal(entries[1].id, "asst-001");
		});

		it("returns empty array when no new entries", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 0);
		});
	});

	describe("findLastAssistantMessage", () => {
		it("finds last assistant text", () => {
			const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Updated plan with details.");
		});

		it("skips thinking blocks, gets text only", () => {
			const entries = [ASSISTANT_MSG_2];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Updated plan with details.");
		});

		it("skips tool results", () => {
			const entries = [ASSISTANT_MSG, TOOL_RESULT];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Here is my plan...");
		});

		it("returns null when no assistant messages", () => {
			const entries = [USER_MSG];
			assert.equal(findLastAssistantMessage(entries), null);
		});

		it("returns null for empty array", () => {
			assert.equal(findLastAssistantMessage([]), null);
		});

		it("reports an empty final completion instead of reusing an earlier assistant message", () => {
			const realMsg: SessionEntry = {
				type: "message",
				id: "real",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Real summary content." }],
				},
			};
			const emptyMsg: SessionEntry = {
				type: "message",
				id: "empty",
				message: {
					role: "assistant",
					content: [],
					stopReason: "stop",
				},
			};
			const entries = [realMsg, emptyMsg];
			assert.equal(findLastAssistantMessage(entries), "Real summary content.");
			assert.deepEqual(inspectFinalAssistantMessage(entries), {
				text: null,
				contentLength: 0,
				stopReason: "stop",
			});
		});

		it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
			// Reproduces the overload-exhaustion case: an earlier turn looked
			// normal, then the provider went 529 and auto-retry gave up. Without
			// the errorMessage fallback we'd return the stale earlier summary and
			// the orchestrator would believe the subagent completed.
			const earlierGood: SessionEntry = {
				type: "message",
				id: "earlier-good",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Investigating the bug..." }],
				},
			};
			const overloadError: SessionEntry = {
				type: "message",
				id: "overload-error",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Anthropic 529 Overloaded after 3 retries",
				},
			};
			const entries = [earlierGood, overloadError];
			assert.equal(
				findLastAssistantMessage(entries),
				"Subagent error: Anthropic 529 Overloaded after 3 retries",
			);
		});

		it("prefers text content even when an error stopReason is set", () => {
			// If the model produced text before the error (rare but possible), we
			// prefer the actual content over the synthetic error fallback.
			const msg: SessionEntry = {
				type: "message",
				id: "partial",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Here is partial output." }],
					stopReason: "error",
					errorMessage: "stream interrupted",
				},
			};
			assert.equal(findLastAssistantMessage([msg]), "Here is partial output.");
		});

		it("does not invent a summary for a stop=error message with no errorMessage", () => {
			const msg: SessionEntry = {
				type: "message",
				id: "no-error-message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
				},
			};
			assert.equal(findLastAssistantMessage([msg]), null);
		});

		it("preserves an assistant record that starts exactly at the bounded tail", () => {
			withTempDir((dir) => {
				const session = join(dir, "exact-boundary.jsonl");
				const assistant = JSON.stringify({
					type: "message",
					id: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						stopReason: "toolUse",
					},
				});
				const tail = `${assistant}\n${"x".repeat(
					128 * 1024 - Buffer.byteLength(assistant) - 1,
				)}`;
				writeFileSync(session, `{"type":"session"}\n${tail}`);

				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});
			});
		});

		it("skips a mid-record cut before a multibyte character", () => {
			withTempDir((dir) => {
				const session = join(dir, "mid-record-boundary.jsonl");
				const assistant = JSON.stringify({
					type: "message",
					id: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						stopReason: "toolUse",
					},
				});
				const beforeBoundary = Buffer.from(`partial-${"é"}`);
				const afterBoundary = Buffer.from(`\n${assistant}\n`);
				const tail = Buffer.concat([
					beforeBoundary.subarray(-1),
					afterBoundary,
					Buffer.alloc(128 * 1024 - 1 - afterBoundary.length, "x"),
				]);
				writeFileSync(
					session,
					Buffer.concat([beforeBoundary.subarray(0, -1), tail]),
				);

				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});
			});
		});

		it("classifies bounded JSONL tails without trusting malformed trailing lines", () => {
			withTempDir((dir) => {
				const session = join(dir, "hang.jsonl");
				const writeTail = (entries: unknown[]) =>
					writeFileSync(
						session,
						`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{torn`,
					);
				const assistant = (content: unknown[], stopReason?: string) => ({
					type: "message",
					id: "assistant",
					message: { role: "assistant", content, stopReason },
				});

				writeTail([
					assistant(
						[{ type: "toolCall", id: "call-1", name: "bash" }],
						"toolUse",
					),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});

				writeTail([
					assistant(
						[{ type: "toolCall", id: "call-1", name: "bash" }],
						"toolUse",
					),
					{
						type: "message",
						id: "result",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "toolCall", id: "call-1", name: "bash" },
							{ type: "toolCall", id: "call-2", name: "read" },
						],
						"toolUse",
					),
					{
						type: "message",
						id: "result-1",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "toolCall", id: "call-1", name: "bash" },
							{ type: "toolCall", id: "call-2", name: "read" },
						],
						"toolUse",
					),
					{
						type: "message",
						id: "result-1",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
					{
						type: "message",
						id: "result-2",
						message: {
							role: "toolResult",
							toolCallId: "call-2",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "thinking", thinking: "need a tool" },
							{ type: "text", text: "Running it." },
						],
						"toolUse",
					),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "truncated-turn",
					lastEntryKind: "assistant",
				});

				writeTail([
					assistant([{ type: "text", text: "still working" }], "stop"),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "assistant",
				});
			});
		});
	});

	describe("findObservedSessionRuntime", () => {
		it("extracts the latest model and thinking entries", () => {
			assert.deepEqual(
				findObservedSessionRuntime([
					{ type: "model_change", id: "m1", provider: "fake", modelId: "old" },
					{ type: "thinking_level_change", id: "t1", thinkingLevel: "medium" },
					{ type: "model_change", id: "m2", provider: "other", modelId: "new" },
				]),
				{ provider: "other", modelId: "new", thinking: "medium" },
			);
		});
	});

	describe("appendBranchSummary", () => {
		it("appends valid branch_summary entry", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const id = appendBranchSummary(
				file,
				"user-001",
				"asst-001",
				"The plan was created.",
			);

			assert.ok(id, "should return an id");
			assert.ok(isString(id));

			// Read back and verify
			const lines = readFileSync(file, "utf8").trim().split("\n");
			assert.equal(lines.length, 4); // 3 original + 1 summary

			const summary = JSON.parse(lines[3]);
			assert.equal(summary.type, "branch_summary");
			assert.equal(summary.id, id);
			assert.equal(summary.parentId, "user-001");
			assert.equal(summary.fromId, "asst-001");
			assert.equal(summary.summary, "The plan was created.");
			assert.ok(summary.timestamp);
		});

		it("uses branchPointId as fromId fallback", () => {
			const file = createSessionFile(dir, [SESSION_HEADER]);
			appendBranchSummary(file, "branch-pt", null, "summary");

			const lines = readFileSync(file, "utf8").trim().split("\n");
			const summary = JSON.parse(lines[1]);
			assert.equal(summary.fromId, "branch-pt");
		});
	});

	describe("copySessionFile", () => {
		it("creates a copy with different path", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
			const copyDir = join(dir, "copies");
			mkdirSync(copyDir, { recursive: true });
			const copy = copySessionFile(file, copyDir);

			assert.notEqual(copy, file);
			assert.ok(copy.endsWith(".jsonl"));
			assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
		});
	});

	describe("subagent session policy", () => {
		it("persists an explicit allowlist separately from unrestricted launches", () => {
			const restricted = join(dir, "restricted-policy.jsonl");
			const unrestricted = join(dir, "unrestricted-policy.jsonl");
			writeSubagentSessionPolicy(restricted, {
				owner: "public",
				tools: "read, read, ",
				deniedTools: ["subagent", "subagent"],
			});
			writeSubagentSessionPolicy(unrestricted, {
				owner: "public",
				deniedTools: [],
			});

			const restrictedPolicy = readSubagentSessionPolicy(restricted);
			assert.equal(restrictedPolicy.version, 2);
			assert.equal(restrictedPolicy.owner, "public");
			assert.deepEqual(restrictedPolicy.tools, ["read"]);
			assert.deepEqual(restrictedPolicy.deniedTools, ["subagent"]);
			assert.equal(restrictedPolicy.persistent, false);
			assert.equal(readSubagentSessionPolicy(unrestricted).tools, null);
			assert.equal(existsSync(getSubagentSessionPolicyFile(restricted)), true);
		});

		it("fails closed for missing, malformed, and unsupported policies", () => {
			const sessionFile = join(dir, "policy-errors.jsonl");
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/saved launch policy is missing/,
			);

			const policyFile = getSubagentSessionPolicyFile(sessionFile);
			writeFileSync(policyFile, "not json", "utf8");
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/saved launch policy cannot be read/,
			);

			writeFileSync(
				policyFile,
				JSON.stringify({
					version: 3,
					owner: "public",
					tools: null,
					deniedTools: [],
				}),
				"utf8",
			);
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/launch policy version is unsupported/,
			);
		});
	});

	it("writes v2 persistent policies and reads v1 compatibility", () => {
		const persistent = join(dir, "persistent-policy.jsonl");
		writeSubagentSessionPolicy(persistent, {
			owner: "public",
			tools: ["read"],
			deniedTools: ["subagent"],
			persistent: true,
			logicalId: "logical-1",
			generationId: "generation-1",
		});
		const read = readSubagentSessionPolicy(persistent);
		assert.equal(read.version, 2);
		assert.equal(read.persistent, true);
		assert.equal(read.logicalId, "logical-1");
		assert.match(read.policyHash, /^[a-f0-9]{64}$/);

		const legacy = join(dir, "legacy-policy.jsonl");
		writeFileSync(
			getSubagentSessionPolicyFile(legacy),
			JSON.stringify({
				version: 1,
				owner: "public",
				tools: null,
				deniedTools: [],
			}),
		);
		assert.deepEqual(readSubagentSessionPolicy(legacy), {
			version: 1,
			owner: "public",
			tools: null,
			deniedTools: [],
			persistent: false,
		});
	});

	it("appends task events and ignores a torn tail", () => {
		const sessionFile = join(dir, "tasks.jsonl");
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "task-1",
			generation: "generation-1",
		});
		writeFileSync(`${sessionFile}.tasks`, '{"version":1', { flag: "a" });
		assert.deepEqual(
			readPersistentTaskEvents(sessionFile).map((event) => event.task),
			["task-1"],
		);
	});

	it("preserves invalid inbox claims as evidence and recovers interrupted claims", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "recover-inbox.jsonl");
			const invalid = writePersistentTaskInbox(sessionFile, 1, {
				task: "bad",
				message: "will be corrupted",
			});
			writeFileSync(invalid, "not json");
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			assert.equal(existsSync(`${invalid}.invalid`), true);

			const interrupted = writePersistentTaskInbox(sessionFile, 2, {
				task: "recovered",
				message: "finish this",
			});
			renameSync(interrupted, `${interrupted}.consuming`);
			assert.equal(consumePersistentTaskInbox(sessionFile)?.task, "recovered");
			assert.equal(existsSync(`${interrupted}.consuming`), false);
		});
	});

	it("records delivery outcomes and atomically consumes each inbox task once", () => {
		const sessionFile = join(dir, "inbox.jsonl");
		appendPersistentDeliveryLedger(sessionFile, {
			task: "task-1",
			outcome: "dispatched",
			generation: "generation-1",
			logicalId: "logical-1",
			policyHash: "a".repeat(64),
		});
		assert.equal(
			readPersistentDeliveryLedger(sessionFile)[0].outcome,
			"dispatched",
		);
		const inbox = writePersistentTaskInbox(sessionFile, 1, {
			task: "task-2",
			message: "next task",
		});
		assert.ok(existsSync(inbox));
		assert.equal(consumePersistentTaskInbox(sessionFile)?.task, "task-2");
		assert.equal(consumePersistentTaskInbox(sessionFile), null);
	});

	describe("seedSubagentSessionFile", () => {
		it("creates a lineage-only child session with parent linkage and no copied turns", () => {
			const parentFile = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const childFile = join(dir, "lineage-child.jsonl");

			seedSubagentSessionFile({
				mode: "lineage-only",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/child-cwd",
			});

			const lines = readFileSync(childFile, "utf8").trim().split("\n");
			assert.equal(lines.length, 1);

			const header = JSON.parse(lines[0]);
			assert.equal(header.type, "session");
			assert.equal(header.parentSession, parentFile);
			assert.equal(header.cwd, "/tmp/child-cwd");
		});

		it("creates a forked child session with copied context before the triggering user turn", () => {
			const parentFile = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const childFile = join(dir, "fork-child.jsonl");

			seedSubagentSessionFile({
				mode: "fork",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/fork-child-cwd",
			});

			const entries = readFileSync(childFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(entries.length, 2);
			assert.equal(entries[0].type, "session");
			assert.equal(entries[0].parentSession, parentFile);
			assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
			assert.equal(entries[1].type, "model_change");
			assert.equal(
				entries.some(
					(entry) =>
						entry.type === "session" && entry.parentSession !== parentFile,
				),
				false,
			);
			assert.equal(
				entries.some((entry) => entry.type === "message"),
				false,
			);
		});
	});

	describe("createWorktreeSessionFork", () => {
		it("preserves the active branch, target cwd, and parent immutability", () => {
			const timestamp = "2026-07-31T00:00:00.000Z";
			const parentFile = createSessionFile(dir, [
				{
					type: "session",
					version: 3,
					id: "handoff-parent",
					timestamp,
					cwd: dir,
				},
				{
					type: "message",
					id: "root-user",
					parentId: null,
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "root" }],
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "root-assistant",
					parentId: "root-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "base" }],
						timestamp: 2,
					},
				},
				{
					type: "message",
					id: "abandoned-user",
					parentId: "root-assistant",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "abandoned" }],
						timestamp: 3,
					},
				},
				{
					type: "message",
					id: "active-user",
					parentId: "root-assistant",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "active" }],
						timestamp: 4,
					},
				},
				{
					type: "message",
					id: "active-assistant",
					parentId: "active-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "current" }],
						timestamp: 5,
					},
				},
			]);
			const parentBefore = readFileSync(parentFile, "utf8");
			const childFile = join(dir, "handoff-child.jsonl");

			createWorktreeSessionFork({
				parentSessionFile: parentFile,
				leafId: "active-assistant",
				childSessionFile: childFile,
				childCwd: "/tmp/handoff-worktree",
				handoffMessage: "Continue in the worktree.",
			});

			const child = SessionManager.open(childFile);
			assert.equal(child.getHeader()?.cwd, "/tmp/handoff-worktree");
			assert.equal(child.getHeader()?.parentSession, parentFile);
			assert.deepEqual(
				child
					.getBranch()
					.map((entry) => entry.id)
					.slice(0, 4),
				["root-user", "root-assistant", "active-user", "active-assistant"],
			);
			assert.equal(readFileSync(parentFile, "utf8"), parentBefore);
			const leafEntry = child.getLeafEntry();
			if (leafEntry?.type !== "custom_message") {
				throw new Error("expected a custom_message leaf entry");
			}
			assert.equal(leafEntry.content, "Continue in the worktree.");
		});

		it("preserves compaction entries on the active branch", () => {
			const timestamp = "2026-07-31T00:00:00.000Z";
			const parentFile = createSessionFile(dir, [
				{
					type: "session",
					version: 3,
					id: "compaction-parent",
					timestamp,
					cwd: dir,
				},
				{
					type: "message",
					id: "compaction-user",
					parentId: null,
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "start" }],
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "compaction-assistant",
					parentId: "compaction-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "summary follows" }],
						timestamp: 2,
					},
				},
				{
					type: "compaction",
					id: "compaction-entry",
					parentId: "compaction-assistant",
					timestamp,
					summary: "Earlier context summary",
					firstKeptEntryId: "compaction-assistant",
					tokensBefore: 100,
				},
			]);
			const childFile = join(dir, "compaction-child.jsonl");

			createWorktreeSessionFork({
				parentSessionFile: parentFile,
				leafId: "compaction-entry",
				childSessionFile: childFile,
				childCwd: "/tmp/compaction-worktree",
				handoffMessage: "Continue after compaction.",
			});

			const child = SessionManager.open(childFile);
			assert.equal(child.getEntry("compaction-entry")?.type, "compaction");
			assert.equal(child.getHeader()?.cwd, "/tmp/compaction-worktree");
		});
	});

	describe("createBtwSessionSnapshot", () => {
		it("copies only the selected active branch without changing the parent", () => {
			const timestamp = "2026-07-31T00:00:00.000Z";
			const parentFile = createSessionFile(dir, [
				{ type: "session", version: 3, id: "btw-parent", timestamp, cwd: dir },
				{
					type: "message",
					id: "root-user",
					parentId: null,
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "root" }],
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "root-assistant",
					parentId: "root-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "base" }],
						timestamp: 2,
					},
				},
				{
					type: "message",
					id: "abandoned-user",
					parentId: "root-assistant",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "abandoned" }],
						timestamp: 3,
					},
				},
				{
					type: "message",
					id: "abandoned-assistant",
					parentId: "abandoned-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "old" }],
						timestamp: 4,
					},
				},
				{
					type: "message",
					id: "active-user",
					parentId: "root-assistant",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "active" }],
						timestamp: 5,
					},
				},
				{
					type: "message",
					id: "active-assistant",
					parentId: "active-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "current" }],
						timestamp: 6,
					},
				},
			]);
			const parentBefore = readFileSync(parentFile, "utf8");

			const childFile = createBtwSessionSnapshot(
				parentFile,
				"active-assistant",
			);
			const child = SessionManager.open(childFile);
			const childIds = child.getEntries().map((entry) => entry.id);

			assert.deepEqual(childIds, [
				"root-user",
				"root-assistant",
				"active-user",
				"active-assistant",
			]);
			assert.equal(child.getHeader()?.parentSession, parentFile);
			assert.equal(readFileSync(parentFile, "utf8"), parentBefore);
		});

		it("fails when Pi does not persist the child snapshot", () => {
			const timestamp = "2026-07-31T00:00:00.000Z";
			const parentFile = createSessionFile(dir, [
				{
					type: "session",
					version: 3,
					id: "btw-user-only",
					timestamp,
					cwd: dir,
				},
				{
					type: "message",
					id: "only-user",
					parentId: null,
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "hello" }],
						timestamp: 1,
					},
				},
			]);

			assert.throws(
				() => createBtwSessionSnapshot(parentFile, "only-user"),
				/did not persist/i,
			);
		});
	});

	describe("mergeNewEntries", () => {
		it("appends new entries from source to target", () => {
			// Source starts with same base (2 entries), then has 1 new entry
			const sourceFile = join(dir, "merge-source.jsonl");
			const targetFile = join(dir, "merge-target.jsonl");
			writeFileSync(
				sourceFile,
				[SESSION_HEADER, USER_MSG, ASSISTANT_MSG]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n",
			);
			writeFileSync(
				targetFile,
				[SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") +
					"\n",
			);

			// Merge entries after line 2 (the shared base)
			const merged = mergeNewEntries(sourceFile, targetFile, 2);
			assert.equal(merged.length, 1);
			assert.equal(merged[0].id, "asst-001");

			// Target should now have 3 entries
			const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
			assert.equal(targetLines.length, 3);
		});
	});
});

describe("subagent resume launch policy", () => {
	function runtimePlan() {
		return {
			provider: "test",
			modelId: "model",
			model: "test/model",
			thinking: "low" as const,
			modelSource: "request" as const,
			thinkingSource: "request" as const,
		};
	}

	function launchOperations(commands: string[], createPane = () => "pane") {
		return {
			createPane,
			createWorktree() {
				throw new Error("worktree creation is not expected");
			},
			async waitForShellReady() {},
			runScript(_surface: string, command: string) {
				commands.push(command);
				return "/tmp/launch.sh";
			},
			closePane() {},
		};
	}

	it("snapshots restricted tools and spawning denial for repeated public resumes", async () => {
		const dir = createTestDir();
		try {
			const commands: string[] = [];
			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify(SESSION_HEADER)}\n`,
				"utf8",
			);
			const fresh = await launchPiSubagent(
				{
					kind: "fresh",
					id: "fresh-id",
					name: "Restricted",
					task: "inspect",
					parent: {
						cwd: dir,
						sessionFile: parentSession,
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
						agentDir: join(dir, "agent"),
					},
					runtimePlan: runtimePlan(),
					behavior: {
						tools: "read",
						deniedTools: ["subagent", "subagent_resume"],
						autoExit: true,
						interactive: false,
						sessionMode: "standalone",
					},
				},
				launchOperations(commands),
			);
			// The mocked launch does not start Pi, which normally writes this header.
			writeFileSync(
				fresh.sessionFile,
				`${JSON.stringify({ ...SESSION_HEADER, cwd: dir })}\n`,
				"utf8",
			);
			const policy = readSubagentSessionPolicy(fresh.sessionFile);
			assert.equal(policy.version, 2);
			assert.equal(policy.owner, "public");
			assert.deepEqual(policy.tools, ["read"]);
			assert.deepEqual(policy.deniedTools, ["subagent", "subagent_resume"]);
			assert.equal(policy.persistent, false);

			await launchPiSubagent(
				{
					kind: "resume",
					name: "Restricted",
					sessionFile: fresh.sessionFile,
					parent: {
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
					},
					behavior: { autoExit: false },
				},
				launchOperations(commands),
			);
			await launchPiSubagent(
				{
					kind: "resume",
					name: "Restricted again",
					sessionFile: fresh.sessionFile,
					parent: {
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
					},
				},
				launchOperations(commands),
			);

			assert.match(
				commands[1],
				/PI_DENY_TOOLS='subagent,subagent_resume'.*--tools 'read,caller_ping,subagent_done'/,
			);
			assert.match(
				commands[2],
				/PI_DENY_TOOLS='subagent,subagent_resume'.*--tools 'read,caller_ping'/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects absent, malformed, unknown-owner, and worktree policies before pane creation", async () => {
		const dir = createTestDir();
		try {
			const sessionFile = join(dir, "resume.jsonl");
			let panes = 0;
			const operations = launchOperations([], () => {
				panes += 1;
				return "unexpected-pane";
			});
			const resume = () =>
				launchPiSubagent(
					{
						kind: "resume",
						name: "Resume",
						sessionFile,
						parent: { sessionId: "parent-id", sessionDir: dir },
					},
					operations,
				);

			await assert.rejects(resume, /saved launch policy is missing/);
			writeFileSync(getSubagentSessionPolicyFile(sessionFile), "{", "utf8");
			await assert.rejects(resume, /saved launch policy cannot be read/);
			for (const tools of [[], ["read,write"], [" read"]]) {
				writeFileSync(
					getSubagentSessionPolicyFile(sessionFile),
					JSON.stringify({
						version: 1,
						owner: "public",
						tools,
						deniedTools: [],
					}),
					"utf8",
				);
				await assert.rejects(resume, /saved launch tool policy is malformed/);
			}
			writeFileSync(
				getSubagentSessionPolicyFile(sessionFile),
				JSON.stringify({
					version: 1,
					owner: "workflow",
					tools: ["read"],
					deniedTools: [],
				}),
				"utf8",
			);
			await assert.rejects(resume, /saved launch policy owner is invalid/);
			writeSubagentSessionPolicy(sessionFile, {
				owner: "managed-worktree",
				tools: ["read"],
				deniedTools: [],
			});
			await assert.rejects(resume, /Cannot resume managed-worktree/);
			assert.equal(panes, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("status.ts", () => {
	it("parses strict config objects", () => {
		const disabled = parseStatusConfig({ status: { enabled: false } });

		assert.deepEqual(disabled, {
			enabled: false,
			lineLimit: 4,
		});
	});

	it("loads a valid config file", () => {
		const examplePath = fileURLToPath(
			new URL("../config.json.example", import.meta.url),
		);
		const config = loadStatusConfig(examplePath);

		assert.deepEqual(config, {
			enabled: true,
			lineLimit: 4,
		});
	});

	it("loads the shared example when local config is absent", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				examplePath,
				JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
			);

			const config = loadStatusConfig(join(dir, "config.json"), examplePath);

			assert.deepEqual(config, {
				enabled: true,
				lineLimit: 4,
			});
		});
	});

	it("fails fast for invalid config shapes", () => {
		assert.throws(
			() => parseStatusConfig({ status: { enabled: "false" } }),
			/status\.enabled must be a boolean/,
		);
		assert.throws(
			() =>
				parseStatusConfig({
					status: { enabled: true, defaultCadenceSeconds: 60 },
				}),
			/status has unsupported key\(s\): defaultCadenceSeconds/,
		);
	});

	it("reports when neither local nor shared config exists", () => {
		withTempDir((dir) => {
			assert.throws(
				() =>
					loadStatusConfig(
						join(dir, "config.json"),
						join(dir, "config.json.example"),
					),
				/Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
			);
		});
	});

	it("reports invalid JSON from the shared example path", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(examplePath, "{\n");

			assert.throws(
				() => loadStatusConfig(join(dir, "config.json"), examplePath),
				/Invalid JSON in subagent config .*config\.json\.example/,
			);
		});
	});

	it("fails on invalid local config instead of falling back to the shared example", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const examplePath = join(dir, "config.json.example");
			writeFileSync(configPath, "{\n");
			writeFileSync(
				examplePath,
				JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
			);

			assert.throws(
				() => loadStatusConfig(configPath, examplePath),
				/Invalid JSON in subagent config .*config\.json/,
			);
		});
	});

	it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(state, { snapshot: "missing" }, 1_000);

		assert.equal(classifyStatus(state, 60_999).kind, "starting");
		const stalled = classifyStatus(state, 61_000);
		assert.equal(stalled.kind, "stalled");
		assert.equal(stalled.statusLabel, null);
	});

	it("classifies active snapshots without aging into stalled", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
				latestEvent: "tool_execution_start",
			},
			5_000,
		);

		const snapshot = classifyStatus(state, 240_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.activityLabel, "bash");
		assert.equal(snapshot.activeDurationText, "3m");
	});

	it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 1,
				phase: "waiting",
				waitingSince: 10_000,
				latestEvent: "agent_end",
			},
			10_000,
		);

		const snapshot = classifyStatus(state, 240_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.waitingDurationText, "3m");
	});

	it("detects stalled transitions and recovery", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(state, { snapshot: "missing" }, 1_000);

		let advanced = advanceStatusState(state, 95_000);
		assert.equal(advanced.transition, "stalled");
		assert.equal(advanced.snapshot.kind, "stalled");

		state = observeStatus(
			advanced.nextState,
			{
				snapshot: "present",
				updatedAt: 96_000,
				sequence: 1,
				phase: "waiting",
				waitingSince: 96_000,
				latestEvent: "agent_end",
			},
			96_000,
		);
		advanced = advanceStatusState(state, 97_000);
		assert.equal(advanced.transition, "recovered");
		assert.equal(advanced.snapshot.kind, "waiting");
	});

	it("keeps the last healthy kind during transient snapshot loss", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "streaming",
				activeSince: 5_000,
			},
			5_000,
		);
		state = advanceStatusState(state, 6_000).nextState;
		state = observeStatus(state, { snapshot: "missing" }, 10_000);

		const snapshot = classifyStatus(state, 20_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.statusLabel, null);
	});

	it("forces an active state to waiting after interrupt", () => {
		const now = 20_000;
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);

		assert.equal(classifyStatus(state, now).kind, "active");

		const forced = forceStatusAfterInterrupt(state, now);
		const snapshot = classifyStatus(forced, now);

		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");
		assert.equal(snapshot.waitingDurationText, "0s");
		assert.equal(forced.activeNow, false);
	});

	it("orders same-millisecond snapshots by sequence", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 10_000,
				activityLabel: "bash",
			},
			10_000,
		);

		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 10_000,
				sequence: 3,
				phase: "waiting",
				waitingSince: 10_000,
				latestEvent: "agent_end",
			},
			10_001,
		);

		const snapshot = classifyStatus(state, 11_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.latestEvent, "agent_end");
	});

	it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);
		state = observeStatus(state, { snapshot: "missing" }, 10_000);
		assert.equal(classifyStatus(state, 10_000).statusLabel, null);

		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 2,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			11_000,
		);

		const snapshot = classifyStatus(state, 11_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(snapshot.statusLabel, null);
	});

	it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
		let state = createStatusState({ startTimeMs: 0 });
		state = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			5_000,
		);
		state = forceStatusAfterInterrupt(state, 20_000);

		const stale = observeStatus(
			state,
			{
				snapshot: "present",
				updatedAt: 5_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 5_000,
				activityLabel: "bash",
			},
			21_000,
		);
		let snapshot = classifyStatus(stale, 21_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");

		const sameTimestamp = observeStatus(
			stale,
			{
				snapshot: "present",
				updatedAt: 20_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 20_000,
				activityLabel: "bash",
			},
			22_000,
		);
		snapshot = classifyStatus(sameTimestamp, 22_000);
		assert.equal(snapshot.kind, "waiting");
		assert.equal(snapshot.activityLabel, "interrupted");

		const resumed = observeStatus(
			sameTimestamp,
			{
				snapshot: "present",
				sequence: 2,
				updatedAt: 25_000,
				phase: "active",
				active: true,
				activeScope: "streaming",
				activeSince: 25_000,
				activityLabel: "streaming",
			},
			25_000,
		);
		snapshot = classifyStatus(resumed, 25_000);
		assert.equal(snapshot.kind, "active");
		assert.equal(resumed.activeScope, "streaming");
	});

	it("normalizes and truncates long newline-heavy names", () => {
		const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
		const stalledState = observeStatus(
			createStatusState({ startTimeMs: 0 }),
			{ snapshot: "missing" },
			1_000,
		);
		const activeState = observeStatus(
			createStatusState({ startTimeMs: 0 }),
			{
				snapshot: "present",
				updatedAt: 299_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 299_000,
				activityLabel: "write",
			},
			299_000,
		);
		const line = formatStatusLine(
			longName,
			classifyStatus(stalledState, 240_000),
		);
		const recovered = formatTransitionLine(
			longName,
			classifyStatus(activeState, 300_000),
			"recovered",
		);

		assert.doesNotMatch(line, /\n/);
		assert.doesNotMatch(recovered, /\n/);
		assert.ok(
			line.length <= 120,
			`expected bounded line length, got ${line.length}`,
		);
		assert.ok(
			recovered.length <= 120,
			`expected bounded line length, got ${recovered.length}`,
		);
	});

	it("caps visible status lines and reports overflow consistently", () => {
		const waitingState = observeStatus(
			createStatusState({ startTimeMs: 0 }),
			{
				snapshot: "present",
				updatedAt: 180_000,
				sequence: 1,
				phase: "waiting",
				waitingSince: 180_000,
			},
			180_000,
		);
		const activeState = observeStatus(
			createStatusState({ startTimeMs: 0 }),
			{
				snapshot: "present",
				updatedAt: 419_000,
				sequence: 1,
				phase: "active",
				active: true,
				activeScope: "tool",
				activeSince: 419_000,
				activityLabel: "bash",
			},
			419_000,
		);
		const waitingLine = formatStatusLine(
			"Worker",
			classifyStatus(waitingState, 300_000),
		);
		const recoveredLine = formatTransitionLine(
			"Worker",
			classifyStatus(activeState, 420_000),
			"recovered",
		);
		const lines = [
			waitingLine,
			recoveredLine,
			"Scout running 2m.",
			"Reviewer running 4m.",
			"Planner running 6m.",
		];
		const capped = capStatusLines(lines, 3);
		const aggregate = formatStatusAggregate(lines, 3);

		assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
		assert.equal(
			recoveredLine,
			"Worker running 7m, recovered; active (bash 1s).",
		);
		assert.deepEqual(capped.visibleLines, [
			waitingLine,
			recoveredLine,
			"Scout running 2m.",
		]);
		assert.equal(capped.overflow, 2);
		assert.match(aggregate, /^Subagent status:/);
		assert.match(aggregate, /\+2 more running\./);
		assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
	});
});

describe("shared subagent configuration path", () => {
	it("resolves the user config under PI_CODING_AGENT_DIR and keeps the packaged example separate", () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
		try {
			assert.equal(
				getSubagentsConfigPath(),
				"/tmp/custom-pi-agent/herdr-agents/config.json",
			);
			assert.match(getSubagentsConfigExamplePath(), /config\.json\.example$/);
		} finally {
			restoreEnvVar("PI_CODING_AGENT_DIR", previous);
		}
	});

	it("keeps the packaged example strict JSON without task preferences", () => {
		const example = JSON.parse(
			readFileSync(getSubagentsConfigExamplePath(), "utf8"),
		);
		assert.equal(example.models.tasks, undefined);
	});

	it("ignores a decoy package-root config.json in every reader", () => {
		withTempDir((dir) => {
			const decoyPath = join(getSubagentsPackageRoot(), "config.json");
			const previousDecoy = existsSync(decoyPath)
				? readFileSync(decoyPath, "utf8")
				: undefined;
			const previous = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = dir;
			try {
				writeFileSync(
					decoyPath,
					JSON.stringify({
						status: { enabled: false },
						models: { default: "decoy/model" },
						roles: { bundled: false },
						panes: { mode: "tab" },
						supervision: { forcePolling: true },
						persistent: { maxAgents: 1 },
					}),
				);
				assert.deepEqual(loadModelConfig(), { agents: {} });
				assert.equal(loadRoleConfig().bundled, true);
				assert.equal(loadPaneConfig().mode, "grouped");
				assert.equal(loadSupervisionConfig().forcePolling, false);
				assert.equal(loadPersistentConfig().maxAgents, 3);
				assert.equal(loadStatusConfig().enabled, true);
			} finally {
				restoreEnvVar("PI_CODING_AGENT_DIR", previous);
				if (previousDecoy == null) rmSync(decoyPath, { force: true });
				else writeFileSync(decoyPath, previousDecoy);
			}
		});
	});

	it("routes every config reader through the user config path", () => {
		withTempDir((dir) => {
			const previous = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = dir;
			try {
				const configPath = getSubagentsConfigPath();
				mkdirSync(dirname(configPath), { recursive: true });
				writeFileSync(
					configPath,
					JSON.stringify({
						status: { enabled: false },
						models: { default: "fake/default" },
						roles: { bundled: false },
						panes: { mode: "tab" },
						supervision: { forcePolling: true },
						persistent: { maxAgents: 2 },
					}),
				);
				assert.equal(loadModelConfig().default, "fake/default");
				assert.equal(loadRoleConfig().bundled, false);
				assert.equal(loadPaneConfig().mode, "tab");
				assert.equal(loadSupervisionConfig().forcePolling, true);
				assert.equal(loadPersistentConfig().maxAgents, 2);
				assert.equal(loadStatusConfig().enabled, false);
			} finally {
				restoreEnvVar("PI_CODING_AGENT_DIR", previous);
			}
		});
	});
});

describe("pane configuration", () => {
	it("defaults to four grouped panes when panes are absent", () => {
		assert.deepEqual(parsePaneConfig({}), {
			mode: "grouped",
			maxPerTab: 4,
			direction: "right",
		});
	});

	it("parses split mode and direction", () => {
		assert.deepEqual(
			parsePaneConfig({ panes: { mode: "split", direction: "down" } }),
			{ mode: "split", direction: "down", maxPerTab: 4 },
		);
	});

	it("loads a strict grouped capacity independently of persistent capacity", () => {
		withTempDir((dir) => {
			const config = join(dir, "config.json");
			writeFileSync(
				config,
				JSON.stringify({
					panes: { maxPerTab: 2 },
					persistent: { maxAgents: 9 },
				}),
			);
			assert.deepEqual(loadPaneConfig(config), {
				mode: "grouped",
				direction: "right",
				maxPerTab: 2,
			});
			for (const maxPerTab of [
				0,
				-1,
				1.5,
				"4",
				null,
				true,
				Number.MAX_SAFE_INTEGER + 1,
			]) {
				writeFileSync(config, JSON.stringify({ panes: { maxPerTab } }));
				assert.throws(
					() => loadPaneConfig(config),
					/panes.maxPerTab must be a positive safe integer/,
				);
			}
		});
	});

	it("rejects invalid pane settings", () => {
		for (const panes of [null, [], "split"]) {
			assert.throws(
				() => parsePaneConfig({ panes }),
				/panes must be an object/,
			);
		}
		assert.throws(
			() => parsePaneConfig({ panes: { mode: "window" } }),
			/panes\.mode must be "grouped", "tab", or "split"/,
		);
		assert.throws(
			() => parsePaneConfig({ panes: { direction: "left" } }),
			/panes\.direction must be "right" or "down"/,
		);
		assert.throws(
			() => parsePaneConfig({ panes: { mode: "tab", extra: true } }),
			/panes has unsupported key\(s\): extra/,
		);
	});

	it("loads the shared example when local config is absent", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				examplePath,
				JSON.stringify({ panes: { mode: "split", direction: "down" } }),
			);

			assert.deepEqual(loadPaneConfig(join(dir, "config.json"), examplePath), {
				mode: "split",
				maxPerTab: 4,
				direction: "down",
			});
		});
	});

	it("uses tabs unchanged and passes split direction to the split creator", () => {
		const calls: string[] = [];
		const createTab = (name: string) => {
			calls.push(`tab:${name}`);
			return "tab-pane";
		};
		const createSplit = (name: string, direction: "right" | "down") => {
			calls.push(`split:${name}:${direction}`);
			return "split-pane";
		};

		assert.equal(
			createSubagentPaneFactory(
				{ mode: "tab", direction: "down", maxPerTab: 4 },
				createTab,
				createSplit,
			)("Scout"),
			"tab-pane",
		);
		assert.equal(
			createSubagentPaneFactory(
				{ mode: "split", direction: "right", maxPerTab: 4 },
				createTab,
				createSplit,
			)("Reviewer"),
			"split-pane",
		);
		assert.deepEqual(calls, ["tab:Scout", "split:Reviewer:right"]);
	});
});

describe("model configuration", () => {
	it("parses global and per-agent model defaults", () => {
		assert.deepEqual(
			parseModelConfig({
				models: {
					default: " anthropic/claude-sonnet-4-6 ",
					agents: { scout: " openai/gpt-5-mini " },
				},
			}),
			{
				default: "anthropic/claude-sonnet-4-6",
				agents: { scout: "openai/gpt-5-mini" },
			},
		);
	});

	it("loads no model overrides when config.json is absent", () => {
		const config = loadModelConfig(
			join(createTestDir(), "missing-config.json"),
		);
		assert.deepEqual(config, { agents: {} });
	});

	it("resolves frontmatter, per-agent, global, and parent fallback precedence", () => {
		const config = parseModelConfig({
			models: {
				default: "fake/global",
				agents: { scout: "fake/scout" },
			},
		});

		assert.equal(
			resolveModelDefault("scout", "fake/frontmatter", config),
			"fake/frontmatter",
		);
		assert.equal(resolveModelDefault("scout", undefined, config), "fake/scout");
		assert.equal(
			resolveModelDefault("reviewer", undefined, config),
			"fake/global",
		);
		assert.equal(
			resolveModelDefault(undefined, undefined, { agents: {} }),
			undefined,
		);
	});

	it("does not read inherited object properties as agent model defaults", () => {
		const config = parseModelConfig({ models: { agents: {} } });
		for (const agent of ["constructor", "toString", "__proto__"]) {
			assert.equal(resolveModelDefault(agent, undefined, config), undefined);
		}
	});

	it("supports reserved property names when explicitly configured", () => {
		const config = parseModelConfig(
			JSON.parse(
				'{"models":{"agents":{"constructor":"fake/constructor","__proto__":"fake/proto"}}}',
			),
		);
		assert.equal(
			resolveModelDefault("constructor", undefined, config),
			"fake/constructor",
		);
		assert.equal(
			resolveModelDefault("__proto__", undefined, config),
			"fake/proto",
		);
	});

	it("parses strict task preferences and metadata", () => {
		assert.deepEqual(
			parseModelConfig({
				models: {
					tasks: { coding: ["fake/worker"] },
					tasksMeta: {
						generatedAt: "2026-09-17T00:00:00Z",
						method: "research",
					},
				},
			}),
			{
				agents: {},
				tasks: { coding: ["fake/worker"] },
				tasksMeta: {
					generatedAt: "2026-09-17T00:00:00Z",
					method: "research",
				},
			},
		);
		for (const config of [
			{ models: { tasks: { debugging: ["fake/worker"] } } },
			{ models: { tasks: { coding: [] } } },
			{ models: { tasks: { coding: [1] } } },
			{ models: { tasksMeta: { generatedAt: "nope", method: "guesswork" } } },
		]) {
			assert.throws(
				() => parseModelConfig(config),
				/models\.tasks|models\.tasksMeta/,
			);
		}
		for (const config of [
			{ models: { default: "task:coding" } },
			{ models: { agents: { worker: "task:coding" } } },
		]) {
			assert.throws(
				() => parseModelConfig(config),
				/only valid in the subagent tool's model parameter/,
			);
		}
		assert.deepEqual(parseModelConfig({ models: { tasks: {} } }), {
			agents: {},
		});
	});

	it("rejects exact duplicate task candidates after trimming without changing case-sensitive IDs", () => {
		assert.throws(
			() =>
				parseModelConfig({
					models: { tasks: { coding: [" fake/Worker ", "fake/Worker"] } },
				}),
			/models\.tasks\.coding.*duplicate.*fake\/Worker/,
		);
		assert.deepEqual(
			parseModelConfig({
				models: {
					tasks: { coding: [" fake/Worker ", "fake/worker", "proxy/Worker"] },
				},
			}).tasks,
			{ coding: ["fake/Worker", "fake/worker", "proxy/Worker"] },
		);
	});

	it("returns normalized saved preferences and missing categories after atomic replacement", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const tasksMeta = {
				generatedAt: "2026-09-18T00:00:00Z",
				method: "registry-only" as const,
			};
			const result = writeTaskModelConfig(
				configPath,
				getSubagentsConfigExamplePath(),
				{ coding: [" fake/worker "] },
				tasksMeta,
				(candidate) => candidate === "fake/worker",
			);
			assert.deepEqual(result, {
				configPath,
				tasks: { coding: ["fake/worker"] },
				tasksMeta,
				missingCategories: ["review", "recon", "qa", "architecture", "docs"],
			});
			const before = readFileSync(configPath, "utf8");
			assert.throws(
				() =>
					writeTaskModelConfig(
						configPath,
						getSubagentsConfigExamplePath(),
						{ coding: ["fake/worker", " fake/worker "] },
						tasksMeta,
						() => true,
					),
				/duplicate/,
			);
			assert.equal(readFileSync(configPath, "utf8"), before);
		});
	});

	it("seeds from the packaged example and keeps every config section loadable", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "herdr-agents", "config.json");
			const examplePath = getSubagentsConfigExamplePath();
			writeTaskModelConfig(
				configPath,
				examplePath,
				{ coding: ["fake/worker"] },
				{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
				(candidate) => candidate === "fake/worker",
			);
			assert.equal(
				loadModelConfig(configPath).tasks?.coding?.[0],
				"fake/worker",
			);
			assert.equal(loadRoleConfig(configPath, examplePath).bundled, true);
			assert.equal(loadPaneConfig(configPath, examplePath).mode, "grouped");
			assert.equal(
				loadSupervisionConfig(configPath, examplePath).forcePolling,
				false,
			);
			assert.equal(loadPersistentConfig(configPath, examplePath).maxAgents, 3);
			assert.equal(loadStatusConfig(configPath, examplePath).enabled, true);
		});
	});

	it("writes only validated task preferences into a seeded user config", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "herdr-agents", "config.json");
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				examplePath,
				JSON.stringify({
					status: { enabled: true },
					roles: { bundled: false },
					models: { default: "fake/default" },
				}),
			);
			writeTaskModelConfig(
				configPath,
				examplePath,
				{ coding: ["fake/worker"] },
				{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
				(candidate) => candidate === "fake/worker",
			);
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
				status: { enabled: true },
				roles: { bundled: false },
				models: {
					default: "fake/default",
					tasks: { coding: ["fake/worker"] },
					tasksMeta: {
						generatedAt: "2026-09-17T00:00:00Z",
						method: "research",
					},
				},
			});
			const before = readFileSync(configPath, "utf8");
			assert.throws(
				() =>
					writeTaskModelConfig(
						configPath,
						examplePath,
						{ coding: ["missing/model"] },
						{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
						() => false,
					),
				/missing\/model/,
			);
			assert.equal(readFileSync(configPath, "utf8"), before);
		});
	});

	it("repairs invalid existing task preferences without rewriting other model keys", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					status: { enabled: false },
					models: { default: "fake/default", tasks: { coding: null } },
				}),
			);
			writeTaskModelConfig(
				configPath,
				getSubagentsConfigExamplePath(),
				{ coding: ["fake/worker"] },
				{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
				(candidate) => candidate === "fake/worker",
			);
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
				status: { enabled: false },
				models: {
					default: "fake/default",
					tasks: { coding: ["fake/worker"] },
					tasksMeta: {
						generatedAt: "2026-09-17T00:00:00Z",
						method: "research",
					},
				},
			});
		});
	});

	it("writes through an exclusive sibling temporary file before rename", () => {
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const writes: Array<{ path: string; options: unknown }> = [];
			const renames: Array<{ from: string; to: string }> = [];
			writeTaskModelConfig(
				configPath,
				getSubagentsConfigExamplePath(),
				{ coding: ["fake/worker"] },
				{ generatedAt: "2026-09-17T00:00:00Z", method: "research" },
				(candidate) => candidate === "fake/worker",
				{
					writeFileSync(path, data, options) {
						writes.push({ path: String(path), options });
						writeFileSync(path, data, options);
					},
					renameSync(from, to) {
						renames.push({ from: String(from), to: String(to) });
						renameSync(from, to);
					},
				},
			);
			assert.equal(writes.length, 1);
			assert.equal(dirname(writes[0].path), dirname(configPath));
			assert.match(writes[0].path, /-config\.tmp$/);
			assert.deepEqual(writes[0].options, { flag: "wx" });
			assert.deepEqual(renames, [{ from: writes[0].path, to: configPath }]);
			assert.equal(existsSync(writes[0].path), false);
		});
	});

	it("rejects invalid model configuration", () => {
		assert.throws(
			() => parseModelConfig({ models: { default: "" } }),
			/non-empty string/,
		);
		assert.throws(
			() => parseModelConfig({ models: { agents: [] } }),
			/must be an object/,
		);
		assert.throws(
			() => parseModelConfig({ models: { tasks: { debugging: ["fake/x"] } } }),
			/models\.tasks\.debugging.*supported categories: coding, review, recon, qa, architecture, docs/,
		);
		assert.throws(
			() => parseModelConfig({ models: { tasks: { coding: null } } }),
			/models\.tasks\.coding must be a non-empty list/,
		);
		assert.throws(
			() =>
				parseModelConfig({
					models: {
						tasksMeta: {
							generatedAt: "2026-09-17T00:00:00Z",
							method: "guesswork",
						},
					},
				}),
			/models\.tasksMeta\.method must be "research" or "registry-only"/,
		);
		assert.throws(
			() =>
				parseModelConfig({
					models: {
						tasksMeta: {
							generatedAt: "2026-09-17",
							method: "research",
						},
					},
				}),
			/models\.tasksMeta\.generatedAt must be an ISO-8601 string/,
		);
		assert.throws(
			() =>
				parseModelConfig({
					models: {
						tasksMeta: {
							generatedAt: "2026-09-17T00:00:00Z",
							method: "research",
							extra: true,
						},
					},
				}),
			/models\.tasksMeta has unsupported key\(s\): extra/,
		);
	});
});

describe("persistent specialist configuration", () => {
	it("defaults absent configuration to three specialists and rejects unknown keys", () => {
		assert.deepEqual(parsePersistentConfig({}), { maxAgents: 3 });
		assert.throws(
			() =>
				parsePersistentConfig({ persistent: { maxAgents: 3, extra: true } }),
			/persistent has unsupported key\(s\): extra/,
		);
		assert.throws(
			() => parsePersistentConfig({ persistent: { maxAgents: 0 } }),
			/persistent\.maxAgents must be a positive integer/,
		);
	});

	it("loads the shared example when local configuration is absent", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				examplePath,
				JSON.stringify({ persistent: { maxAgents: 2 } }),
			);
			assert.deepEqual(
				loadPersistentConfig(join(dir, "config.json"), examplePath),
				{ maxAgents: 2 },
			);
		});
	});
});

describe("supervision", () => {
	it("parses hang warning configuration strictly and loads the shared example", () => {
		assert.deepEqual(parseSupervisionConfig({}), {
			forcePolling: false,
			hangWarningMinutes: 15,
		});
		assert.deepEqual(
			parseSupervisionConfig({
				supervision: { forcePolling: true, hangWarningMinutes: 20 },
			}),
			{ forcePolling: true, hangWarningMinutes: 20 },
		);
		assert.deepEqual(
			parseSupervisionConfig({ supervision: { hangWarningMinutes: 0 } }),
			{ forcePolling: false, hangWarningMinutes: 0 },
		);
		for (const value of [-1, 1.5, "15"]) {
			assert.throws(
				() =>
					parseSupervisionConfig({
						supervision: { hangWarningMinutes: value },
					}),
				/supervision\.hangWarningMinutes must be a non-negative integer/,
			);
		}
		assert.throws(
			() => parseSupervisionConfig({ supervision: { extra: true } }),
			/supervision has unsupported key\(s\): extra/,
		);
		withTempDir((dir) => {
			const example = join(dir, "config.json.example");
			writeFileSync(
				example,
				JSON.stringify({ supervision: { hangWarningMinutes: 20 } }),
			);
			assert.deepEqual(
				loadSupervisionConfig(join(dir, "config.json"), example),
				{ forcePolling: false, hangWarningMinutes: 20 },
			);
		});
	});

	it("wakes every directory entry when fs.watch omits a filename", () => {
		let listener:
			| ((event: string, filename: string | Buffer | null) => void)
			| undefined;
		const watcher = {
			on() {
				return this;
			},
			close() {},
			unref() {
				return this;
			},
		};
		// SAFETY: The fake implements the fs.watch behavior used by FileWakeRegistry.
		const registry = new FileWakeRegistry(((
			_directory: string,
			callback: (event: string, filename: string | Buffer | null) => void,
		) => {
			listener = callback;
			return watcher;
		}) as any);
		let wakes = 0;
		const registration = registry.register(
			"/tmp/child.jsonl",
			() => {
				wakes += 1;
			},
			() => assert.fail("watcher unexpectedly fell back"),
		);
		listener?.("change", null);
		assert.equal(wakes, 1);
		registration.unregister();
		registry.close();
	});

	it("wakes on sidecar rename and releases registrations", async () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		let wakes = 0;
		const registry = new FileWakeRegistry();
		const registration = registry.register(
			sessionFile,
			() => {
				wakes += 1;
			},
			() => assert.fail("watcher unexpectedly fell back"),
		);
		try {
			const temporary = `${sessionFile}.exit.tmp`;
			writeFileSync(temporary, "{}");
			renameSync(temporary, `${sessionFile}.exit`);
			const deadline = Date.now() + 500;
			while (wakes === 0 && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(wakes, 1);
			registration.unregister();
			assert.equal(registry.watcherCount, 0);
		} finally {
			registry.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not apply an in-flight snapshot to a child registered after it began", async () => {
		let resolveList:
			| ((snapshot: {
					complete: boolean;
					panes: Array<{
						paneId: string;
						workspaceId: string;
					}>;
			  }) => void)
			| undefined;
		let fallbackInspections = 0;
		const supervisor = new SupervisionCoordinator(
			() =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
			async () => {
				fallbackInspections += 1;
				return { kind: "present", agentStatus: "idle", observedAt: Date.now() };
			},
		);
		const dir = createTestDir();
		try {
			const one = supervisor.register(join(dir, "one.jsonl"), "one");
			const two = supervisor.register(join(dir, "two.jsonl"), "two");
			resolveList?.({
				complete: true,
				panes: [{ paneId: "one", workspaceId: "workspace" }],
			});
			await Promise.all([
				one.wait(new AbortController().signal),
				two.wait(new AbortController().signal),
			]);
			assert.equal((await two.inspectPane()).kind, "present");
			assert.equal(fallbackInspections, 1);
			one.unregister();
			two.unregister();
		} finally {
			supervisor.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("confirms empty complete-list absence with a pane inspection", async () => {
		let fallbackInspections = 0;
		const supervisor = new SupervisionCoordinator(
			async () => ({ complete: true, panes: [] }),
			async () => {
				fallbackInspections += 1;
				return { kind: "present", agentStatus: "idle", observedAt: Date.now() };
			},
		);
		const dir = createTestDir();
		try {
			const registration = supervisor.register(
				join(dir, "child.jsonl"),
				"child",
			);
			await registration.wait(new AbortController().signal);
			assert.equal((await registration.inspectPane()).kind, "present");
			assert.equal(fallbackInspections, 1);
			registration.unregister();
		} finally {
			supervisor.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps watcherless entries on the legacy polling cadence", async () => {
		let fallbackInspections = 0;
		// SAFETY: This fake fs.watch always throws to model an unavailable watcher.
		const registry = new FileWakeRegistry((() => {
			throw new Error("watch unavailable");
		}) as any);
		const supervisor = new SupervisionCoordinator(
			async () => ({
				complete: true,
				panes: [{ paneId: "child", workspaceId: "workspace" }],
			}),
			async () => {
				fallbackInspections += 1;
				return { kind: "present", agentStatus: "idle", observedAt: Date.now() };
			},
			false,
			registry,
		);
		const dir = createTestDir();
		try {
			const registration = supervisor.register(
				join(dir, "child.jsonl"),
				"child",
			);
			await registration.wait(new AbortController().signal);
			assert.equal(supervisor.diagnostics().mode, "polling(fallback)");
			assert.equal((await registration.inspectPane()).kind, "present");
			await new Promise((resolve) => setImmediate(resolve));
			await registration.wait(new AbortController().signal);
			assert.equal((await registration.inspectPane()).kind, "present");
			const startedAt = Date.now();
			await registration.wait(new AbortController().signal);
			assert.ok(Date.now() - startedAt >= POLLING_INTERVAL_MS - 100);
			assert.equal((await registration.inspectPane()).kind, "present");
			assert.equal(fallbackInspections, 3);
			registration.unregister();
		} finally {
			supervisor.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears the unhealthy batch retry when closed", async () => {
		const timeouts: Array<() => void> = [];
		const cleared: Array<() => void> = [];
		const timers = {
			setTimeout(callback: () => void) {
				timeouts.push(callback);
				// SAFETY: clearTimeout receives this opaque token only in this test.
				return callback as any;
			},
			clearTimeout(timer: () => void) {
				cleared.push(timer);
			},
		};
		const supervisor = new SupervisionCoordinator(
			async () => {
				throw new Error("pane list unavailable");
			},
			async () => ({ kind: "unavailable" }),
			false,
			new FileWakeRegistry(),
			timers,
		);
		const registration = supervisor.register("/tmp/child.jsonl", "child");
		await new Promise((resolve) => setImmediate(resolve));
		supervisor.close();
		assert.equal(timeouts.length, 1);
		assert.deepEqual(cleared, timeouts);
		registration.unregister();
	});

	it("refuses malformed-list absence", async () => {
		for (const snapshot of [
			{ complete: false, panes: [] },
			{ complete: false, panes: [{ paneId: "one", workspaceId: "workspace" }] },
		]) {
			let fallbackInspections = 0;
			const supervisor = new SupervisionCoordinator(
				async () => snapshot,
				async () => {
					fallbackInspections += 1;
					return {
						kind: "present",
						agentStatus: "idle",
						observedAt: Date.now(),
					};
				},
			);
			const dir = createTestDir();
			try {
				const registration = supervisor.register(join(dir, "one.jsonl"), "one");
				await registration.wait(new AbortController().signal);
				assert.equal((await registration.inspectPane()).kind, "present");
				assert.equal(fallbackInspections, 1);
				registration.unregister();
			} finally {
				supervisor.close();
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("keeps a queued reconciliation when a wake arrives before the next wait", async () => {
		let listener:
			| ((event: string, filename: string | Buffer | null) => void)
			| undefined;
		const watcher = {
			on() {
				return this;
			},
			close() {},
			unref() {
				return this;
			},
		};
		// SAFETY: The fake implements the fs.watch behavior used by FileWakeRegistry.
		const registry = new FileWakeRegistry(((
			_directory: string,
			callback: (event: string, filename: string | Buffer | null) => void,
		) => {
			listener = callback;
			return watcher;
		}) as any);
		const supervisor = new SupervisionCoordinator(
			async () => ({
				complete: true,
				panes: [{ paneId: "one", workspaceId: "workspace" }],
			}),
			async () => ({
				kind: "present",
				agentStatus: "idle",
				observedAt: Date.now(),
			}),
			false,
			registry,
		);
		try {
			const registration = supervisor.register("/tmp/child.jsonl", "one");
			// Let the registration-triggered reconciliation settle and queue its
			// pending "reconcile" reason before any waiter exists.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
			listener?.("rename", null);
			assert.equal(
				await registration.wait(new AbortController().signal),
				"reconcile",
			);
			registration.unregister();
		} finally {
			supervisor.close();
		}
	});
});

describe("role configuration", () => {
	it("defaults bundled roles to enabled when omitted", () => {
		assert.deepEqual(parseRoleConfig({}), { bundled: true });
		assert.deepEqual(parseRoleConfig({ roles: {} }), { bundled: true });
	});

	it("rejects explicit null and non-object role settings", () => {
		for (const roles of [null, [], "roles"]) {
			assert.throws(
				() => parseRoleConfig({ roles }),
				/roles must be an object/,
			);
		}
		for (const bundled of [null, "false", []]) {
			assert.throws(
				() => parseRoleConfig({ roles: { bundled } }),
				/roles\.bundled must be a boolean/,
			);
		}
	});

	it("loads the shared example when local config is absent", () => {
		withTempDir((dir) => {
			const examplePath = join(dir, "config.json.example");
			writeFileSync(examplePath, JSON.stringify({ roles: { bundled: false } }));

			assert.deepEqual(loadRoleConfig(join(dir, "config.json"), examplePath), {
				bundled: false,
			});
		});
	});

	it("rejects malformed bundled-role settings without falling back", () => {
		assert.throws(
			() => parseRoleConfig({ roles: { bundled: "false" } }),
			/roles\.bundled must be a boolean/,
		);
		withTempDir((dir) => {
			const configPath = join(dir, "config.json");
			const examplePath = join(dir, "config.json.example");
			writeFileSync(
				configPath,
				JSON.stringify({ roles: { bundled: "false" } }),
			);
			writeFileSync(examplePath, JSON.stringify({ roles: { bundled: false } }));

			assert.throws(
				() => loadRoleConfig(configPath, examplePath),
				/roles\.bundled must be a boolean/,
			);
		});
	});
});

describe("subagent discovery", () => {
	const testApi = subagentsModule.__test__;

	it("excludes bundled roles while retaining role-pack and override roles", async () => {
		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const rolesDir = join(projectDir, "scout-pack", "roles");
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolesDir, "..", "package.json"),
					JSON.stringify({ name: "@acme/scout-pack", version: "1.0.0" }),
				);
				writeAgentFile(
					rolesDir,
					"scout",
					"description: Role-pack scout enabled without bundled roles",
				);

				const disabled = { bundled: false };
				const emptyCatalog = testApi.discoverAgentCatalog(undefined, disabled);
				assert.equal(
					emptyCatalog.agents.some((agent) => agent.name === "scout"),
					false,
					"listing excludes bundled scouts when disabled",
				);
				assert.equal(
					testApi.loadAgentDefaults("scout", undefined, disabled),
					null,
					"exact-name lookup cannot launch an omitted bundled scout",
				);

				const { api } = createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) =>
						request.register(rolesDir),
				);
				const catalog = testApi.discoverAgentCatalog(api, disabled);
				assert.equal(
					catalog.agents.find((agent) => agent.name === "scout")?.provider,
					"@acme/scout-pack",
					"a role pack may supply a name that no enabled bundled role owns",
				);
				assert.equal(
					catalog.diagnostics.some(
						(diagnostic) => diagnostic.code === "bundled-role-collision",
					),
					false,
				);
				assert.equal(
					testApi.loadAgentDefaults("worker", api, disabled),
					null,
					"exact-name lookup cannot launch an omitted bundled role",
				);

				writeAgentFile(
					globalAgentsDir,
					"global-scout",
					"description: Global scout",
				);
				assert.equal(
					testApi.loadAgentDefaults("global-scout", api, disabled)?.source,
					"global",
				);

				writeAgentFile(
					globalAgentsDir,
					"scout",
					"description: Global scout override",
				);
				assert.equal(
					testApi.loadAgentDefaults("scout", api, disabled)?.source,
					"global",
					"a global definition can supply a disabled bundled name",
				);
				writeAgentFile(
					projectAgentsDir,
					"scout",
					"description: Project scout override",
				);
				assert.equal(
					testApi.loadAgentDefaults("scout", api, disabled)?.source,
					"project",
					"a project definition retains precedence over a global definition",
				);
			},
		);
	});

	it("loads session-mode from frontmatter", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"lineage-mode-test-agent",
				[
					"name: lineage-mode-test-agent",
					"model: anthropic/test-lineage",
					"session-mode: lineage-only",
				].join("\n"),
			);

			const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
			assert.ok(loaded, "expected agent to load");
			assert.equal(loaded.sessionMode, "lineage-only");
		});
	});

	it("accepts only supported thinking levels from frontmatter", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"thinking-test-agent",
				["name: thinking-test-agent", "thinking: high"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"invalid-thinking-test-agent",
				["name: invalid-thinking-test-agent", "thinking: extreme"].join("\n"),
			);

			assert.equal(
				testApi.loadAgentDefaults("thinking-test-agent")?.thinking,
				"high",
			);
			assert.equal(
				testApi.loadAgentDefaults("invalid-thinking-test-agent")?.thinking,
				undefined,
			);
		});
	});

	it("loads explicit interactive flag from frontmatter", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"interactive-true-test-agent",
				[
					"name: interactive-true-test-agent",
					"model: anthropic/test-interactive-true",
					"interactive: true",
				].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"interactive-false-test-agent",
				[
					"name: interactive-false-test-agent",
					"model: anthropic/test-interactive-false",
					"interactive: false",
				].join("\n"),
			);

			const loadedTrue = testApi.loadAgentDefaults(
				"interactive-true-test-agent",
			);
			assert.equal(loadedTrue?.interactive, true);

			const loadedFalse = testApi.loadAgentDefaults(
				"interactive-false-test-agent",
			);
			assert.equal(loadedFalse?.interactive, false);
		});
	});

	it("leaves interactive undefined when not set in frontmatter", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"interactive-unset-test-agent",
				[
					"name: interactive-unset-test-agent",
					"model: anthropic/test-interactive-unset",
				].join("\n"),
			);

			const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
			assert.equal(loaded?.interactive, undefined);
		});
	});

	it("resolves auto-exit and interactive behavior for named and bare spawns", () => {
		// Autonomous named agents are not interactive, so the parent gets status pings.
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "A", task: "T" },
				{ autoExit: true },
			),
			true,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T" },
				{ autoExit: true },
			),
			false,
		);

		// Named agents without auto-exit preserve their interactive behavior.
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "A", task: "T" },
				{ autoExit: false },
			),
			false,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T" },
				{ autoExit: false },
			),
			true,
		);

		// Bare task spawns are autonomous by default. Otherwise a normal final
		// answer leaves the child open and no completion is delivered to the parent.
		assert.equal(
			testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, null),
			true,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
			false,
		);

		// A bare full-context fork invoked directly through the tool is still an
		// autonomous task. Forking only controls inherited conversation context.
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "A", task: "T", fork: true },
				null,
			),
			true,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T", fork: true },
				null,
			),
			false,
		);

		// Interactive fork workflows such as /iterate opt out explicitly.
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "A", task: "T", fork: true, interactive: true },
				null,
			),
			false,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T", fork: true, interactive: true },
				null,
			),
			true,
		);
	});

	it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
		// Autonomous agent that still wants to be treated as interactive.
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T" },
				{ autoExit: true, interactive: true },
			),
			true,
		);
		// Non-auto-exit agent that opts back into stall pings.
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T" },
				{ interactive: false },
			),
			false,
		);
	});

	it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T", interactive: false },
				{ autoExit: false, interactive: true },
			),
			false,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "A", task: "T", interactive: true },
				{ autoExit: true, interactive: false },
			),
			true,
		);
	});

	it("bundled agents inherit the parent runtime and preserve interaction modes", async () => {
		await withIsolatedAgentEnv(async () => {
			const expectedInteraction = {
				scout: false,
				worker: false,
				reviewer: false,
				planner: true,
				"visual-tester": false,
			} as const;

			for (const [name, interactive] of Object.entries(expectedInteraction)) {
				const defs = testApi.loadAgentDefaults(name);
				assert.ok(defs, `expected bundled agent ${name} to load`);
				assert.equal(
					defs.model,
					undefined,
					`${name} should inherit the parent model`,
				);
				assert.equal(
					defs.thinking,
					undefined,
					`${name} should inherit the parent thinking level`,
				);
				assert.equal(
					testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
					interactive,
					`${name} should preserve its interaction mode`,
				);
			}

			assert.equal(
				testApi.loadAgentDefaults("visual-tester")?.skills,
				"chrome-cdp",
			);

			assert.equal(testApi.loadAgentDefaults("claude-reviewer"), null);
		});
	});

	it("keeps singular skill frontmatter compatible for existing agent definitions", async () => {
		await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
			writeAgentFile(
				globalAgentsDir,
				"legacy-skill-test-agent",
				["name: legacy-skill-test-agent", "skill: legacy-skill"].join("\n"),
			);

			assert.equal(
				testApi.loadAgentDefaults("legacy-skill-test-agent")?.skills,
				"legacy-skill",
			);
		});
	});

	it("gives bundled orchestrators the subagent tool they require", () => {
		const poteto = testApi.loadAgentDefaults("poteto");
		assert.ok(poteto, "expected bundled poteto agent to be discoverable");
		assert.equal(poteto.spawning, true);
		assert.ok(
			new Set(
				(poteto.tools ?? "").split(",").map((tool: string) => tool.trim()),
			).has("subagent"),
			"poteto must expose the subagent tool used by its workflow",
		);

		const adversarial = testApi.loadAgentDefaults("adversarial-reviewer");
		assert.ok(
			adversarial,
			"expected bundled adversarial reviewer to be discoverable",
		);

		assert.equal(adversarial.spawning, true);
		assert.equal(
			adversarial.autoExit,
			false,
			"multi-wave coordinator must remain open after each child-result steer",
		);
		assert.equal(
			adversarial.interactive,
			false,
			"automatic completion steers must wake the multi-wave coordinator",
		);
		assert.equal(
			testApi.resolveEffectiveAutoExit(
				{ name: "Adversarial review", task: "Review" },
				adversarial,
			),
			false,
		);
		assert.equal(
			testApi.resolveEffectiveInteractive(
				{ name: "Adversarial review", task: "Review" },
				adversarial,
			),
			false,
		);
		const adversarialTools = new Set(
			(adversarial.tools ?? "").split(",").map((tool: string) => tool.trim()),
		);
		assert.equal(adversarialTools.has("subagent"), true);
		for (const tool of ["read", "bash", "grep", "find", "ls"]) {
			assert.equal(
				adversarialTools.has(tool),
				true,
				`adversarial reviewer must expose ${tool}`,
			);
		}
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "Adversarial review", task: "Review", fork: false },
				adversarial,
			),
			"standalone",
		);

		const instructions = adversarial.body ?? "";
		assert.match(instructions, /model-catalog source/i);
		assert.match(instructions, /how authentication was\s+confirmed/i);
		assert.doesNotMatch(
			instructions,
			/model:\s*["'][^"']+\/[^"']+["']/,
			"adversarial reviewer must not hard-code provider model IDs",
		);
		assert.match(instructions, /project review rules/i);
		assert.match(
			instructions,
			/Routine\s+risk uses two distinct eligible\s+exact model IDs/i,
		);
		assert.match(
			instructions,
			/High risk uses three distinct eligible IDs with lenses/i,
		);
		assert.match(instructions, /candidate-dependent/i);
		assert.match(instructions, /different provider\/model family/i);
		assert.doesNotMatch(
			instructions,
			/same-family.*fallback/i,
			"adversarial reviewer must not allow same-family fallback",
		);
		assert.match(instructions, /fresh reviewer carrying alias\s+`S1`/i);
		assert.match(instructions, /subagent_ping.*not a review report/is);
		assert.match(instructions, /nonzero exit, provider error, launch error/i);
		assert.match(instructions, /Never silently replace a\s+runtime/i);
		assert.match(instructions, /16,000 characters/i);
		assert.match(instructions, /call\s+`subagent_done`/i);
		assert.match(
			instructions,
			/Never call it[\s\S]*lacks a terminal envelope/i,
		);
		assert.match(
			instructions,
			/Do not run verification that can generate\s+artifacts/i,
		);
		assert.doesNotMatch(instructions, /tools:\s*["']read,bash,write["']/);
	});

	it("ignores invalid session-mode values", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"invalid-mode-test-agent",
				[
					"name: invalid-mode-test-agent",
					"model: anthropic/test-invalid",
					"session-mode: sideways",
				].join("\n"),
			);

			const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
			assert.ok(loaded, "expected agent to load");
			assert.equal(loaded.sessionMode, undefined);
		});
	});

	it("resolves session mode with fork override precedence", () => {
		assert.equal(
			testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null),
			"standalone",
		);
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "A", task: "T" },
				{ sessionMode: "lineage-only" },
			),
			"lineage-only",
		);
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "A", task: "T", fork: true },
				{ sessionMode: "lineage-only" },
			),
			"fork",
		);
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "A", task: "T", fork: false },
				{ sessionMode: "fork" },
			),
			"standalone",
			"fork: false must force standalone even when role declares fork",
		);
		assert.equal(
			testApi.resolveEffectiveSessionMode(
				{ name: "A", task: "T" },
				{ sessionMode: "fork" },
			),
			"fork",
			"omitted fork must inherit role session-mode",
		);
	});

	it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
		assert.deepEqual(
			testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null),
			{
				sessionMode: "standalone",
				seededSessionMode: null,
				inheritsConversationContext: false,
				taskDelivery: "artifact",
			},
		);
		assert.deepEqual(
			testApi.resolveLaunchBehavior(
				{ name: "A", task: "T" },
				{ sessionMode: "lineage-only" },
			),
			{
				sessionMode: "lineage-only",
				seededSessionMode: "lineage-only",
				inheritsConversationContext: false,
				taskDelivery: "artifact",
			},
		);
		assert.deepEqual(
			testApi.resolveLaunchBehavior(
				{ name: "A", task: "T" },
				{ sessionMode: "fork" },
			),
			{
				sessionMode: "fork",
				seededSessionMode: "fork",
				inheritsConversationContext: true,
				taskDelivery: "direct",
			},
		);
		assert.deepEqual(
			testApi.resolveLaunchBehavior(
				{ name: "A", task: "T", fork: true },
				{ sessionMode: "lineage-only" },
			),
			{
				sessionMode: "fork",
				seededSessionMode: "fork",
				inheritsConversationContext: true,
				taskDelivery: "direct",
			},
		);
		assert.deepEqual(
			testApi.resolveLaunchBehavior(
				{ name: "A", task: "T", fork: false },
				{ sessionMode: "fork" },
			),
			{
				sessionMode: "standalone",
				seededSessionMode: null,
				inheritsConversationContext: false,
				taskDelivery: "artifact",
			},
			"fork: false must produce standalone behavior despite role fork mode",
		);
	});

	it("buildSubagentToolAllowlist keeps explicit completion for interactive children", () => {
		assert.equal(
			testApi.buildSubagentToolAllowlist("read,bash,web_search"),
			"read,bash,web_search,caller_ping,subagent_done",
		);
	});

	it("buildSubagentToolAllowlist omits explicit completion for auto-exit children", () => {
		assert.equal(
			testApi.buildSubagentToolAllowlist(
				"read,bash,web_search,subagent_done",
				true,
			),
			"read,bash,web_search,caller_ping",
		);
	});

	it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
		assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
		assert.equal(testApi.buildSubagentToolAllowlist(""), null);
	});

	it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
		assert.deepEqual(
			testApi.buildPiPromptArgs({
				effectiveSkills: "review,lint",
				taskDelivery: "artifact",
				taskArg: "@artifact.md",
			}),
			["", "/skill:review", "/skill:lint", "@artifact.md"],
		);
	});

	it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
		assert.deepEqual(
			testApi.buildPiPromptArgs({
				effectiveSkills: undefined,
				taskDelivery: "artifact",
				taskArg: "@artifact.md",
			}),
			["@artifact.md"],
		);
	});

	it("buildPiPromptArgs omits separator for direct launches with skills", () => {
		assert.deepEqual(
			testApi.buildPiPromptArgs({
				effectiveSkills: "review",
				taskDelivery: "direct",
				taskArg: "do the task",
			}),
			["/skill:review", "do the task"],
		);
	});

	it("discovers and launches a Pi package role pack without repeated role names", async () => {
		await withIsolatedAgentEnv(async ({ projectDir }) => {
			const rolePackDir = join(projectDir, "security-role-pack");
			const rolesDir = join(rolePackDir, "roles");
			mkdirSync(rolesDir, { recursive: true });
			writeFileSync(
				join(rolePackDir, "package.json"),
				JSON.stringify({ name: "@acme/security-roles", version: "1.2.3" }),
			);
			writeAgentFile(
				rolesDir,
				"security-reviewer",
				[
					"description: Reviews changes for concrete security vulnerabilities",
					"tools: read, bash",
					"spawning: false",
					"auto-exit: true",
				].join("\n"),
			);

			const { api, registeredTools, registeredCommands, sentUserMessages } =
				createMockExtensionApi();
			api.events.on(
				"pi-herdr-subagents:roles:discover:v1",
				(request: { register(path: string): void }) =>
					request.register(rolesDir),
			);
			subagentsModule.default(api);

			const listTool = registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);
			assert.ok(listTool, "expected subagents_list to be registered");
			const result = await listTool.execute();
			const role = result.details.agents.find(
				(agent: any) => agent.name === "security-reviewer",
			);
			assert.ok(role, "expected role-pack definition to be listed");
			assert.equal(role.source, "package");
			assert.equal(role.provider, "@acme/security-roles");
			assert.equal(role.providerVersion, "1.2.3");
			assert.match(
				result.content[0].text,
				/security-reviewer \(package:@acme\/security-roles\)/,
			);

			const command = registeredCommands.find(
				(command) => command.name === "subagent",
			);
			assert.ok(command, "expected /subagent to be registered");
			await command.handler("security-reviewer Review this branch", {
				ui: { notify() {} },
			});
			assert.match(sentUserMessages.at(-1) ?? "", /security-reviewer/);
			const loaded = testApi.loadAgentDefaults("security-reviewer", api);
			assert.equal(loaded?.description, role.description);
			assert.equal(loaded?.body, "You are a test agent.");
		});
	});

	it("removes role-pack listeners when their extension instance shuts down", async () => {
		await withIsolatedAgentEnv(async () => {
			const eventBus = createEventBus();
			const plugin = createMockExtensionApi(eventBus);
			rolePackExample(plugin.api);
			const host = createMockExtensionApi(eventBus);
			subagentsModule.default(host.api);
			const listTool = host.registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);

			let result = await listTool.execute();
			assert.equal(
				result.details.agents.some(
					(agent: any) => agent.name === "example-reviewer",
				),
				true,
			);

			const shutdown = plugin.eventHandlers.get("session_shutdown")?.[0];
			assert.ok(shutdown, "expected role-pack cleanup handler");
			await shutdown({ reason: "reload" }, {});
			result = await listTool.execute();
			assert.equal(
				result.details.agents.some(
					(agent: any) => agent.name === "example-reviewer",
				),
				false,
				"stale role-pack listener must not survive reload",
			);

			const replacement = createMockExtensionApi(eventBus);
			rolePackExample(replacement.api);
			result = await listTool.execute();
			assert.equal(
				result.details.agents.some(
					(agent: any) => agent.name === "example-reviewer",
				),
				true,
			);
		});
	});

	it("rejects ambiguous package-layer role names with actionable diagnostics", async () => {
		await withIsolatedAgentEnv(async ({ projectDir }) => {
			const firstRoles = join(projectDir, "first-pack", "roles");
			const secondRoles = join(projectDir, "second-pack", "roles");
			for (const [rolesDir, packageName] of [
				[firstRoles, "@acme/first-roles"],
				[secondRoles, "@acme/second-roles"],
			] as const) {
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolesDir, "..", "package.json"),
					JSON.stringify({ name: packageName, version: "1.0.0" }),
				);
				writeAgentFile(
					rolesDir,
					"duplicate-reviewer",
					"description: Duplicate package role",
				);
			}
			writeAgentFile(
				firstRoles,
				"scout",
				"description: Attempts to replace the bundled scout",
			);

			const { api, registeredTools, registeredCommands } =
				createMockExtensionApi();
			api.events.on(
				"pi-herdr-subagents:roles:discover:v1",
				(request: { register(path: string): void }) => {
					request.register(firstRoles);
					request.register(secondRoles);
				},
			);
			subagentsModule.default(api);

			const listTool = registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);
			const result = await listTool.execute();
			assert.equal(
				result.details.agents.some(
					(agent: any) => agent.name === "duplicate-reviewer",
				),
				false,
			);
			assert.equal(
				result.details.agents.find((agent: any) => agent.name === "scout")
					?.provider,
				undefined,
			);
			assert.deepEqual(
				new Set(
					result.details.diagnostics.map((diagnostic: any) => diagnostic.code),
				),
				new Set(["duplicate-package-role", "bundled-role-collision"]),
			);
			assert.match(result.content[0].text, /multiple role packs/i);
			assert.match(result.content[0].text, /cannot replace bundled role/i);

			const notifications: string[] = [];
			const command = registeredCommands.find(
				(command) => command.name === "subagent",
			);
			await command.handler("duplicate-reviewer Review this", {
				ui: {
					notify(message: string) {
						notifications.push(message);
					},
				},
			});
			assert.match(notifications.at(-1) ?? "", /multiple role packs/i);
		});
	});

	it("keeps project and global overrides above contributed role packs", async () => {
		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const rolesDir = join(projectDir, "override-pack", "roles");
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolesDir, "..", "package.json"),
					JSON.stringify({ name: "@acme/override-roles" }),
				);
				writeAgentFile(
					rolesDir,
					"override-reviewer",
					["description: Package role", "model: anthropic/package"].join("\n"),
				);
				writeAgentFile(
					globalAgentsDir,
					"override-reviewer",
					["description: Global role", "model: anthropic/global"].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"override-reviewer",
					["description: Project role", "model: anthropic/project"].join("\n"),
				);

				const { api, registeredTools } = createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) =>
						request.register(rolesDir),
				);
				subagentsModule.default(api);

				const listTool = registeredTools.find(
					(tool) => tool.name === "subagents_list",
				);
				const result = await listTool.execute();
				const role = result.details.agents.find(
					(agent: any) => agent.name === "override-reviewer",
				);
				assert.equal(role.source, "project");
				assert.equal(role.model, "anthropic/project");
				assert.equal(role.provider, undefined);
			},
		);
	});

	it("labels visible package, global, and project agents by source", async () => {
		await withIsolatedAgentEnv(
			async ({ projectAgentsDir, globalAgentsDir }) => {
				writeAgentFile(
					globalAgentsDir,
					"global-discovery-test-agent",
					[
						"name: global-discovery-test-agent",
						"description: Global test agent",
					].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"project-discovery-test-agent",
					[
						"name: project-discovery-test-agent",
						"description: Project test agent",
					].join("\n"),
				);

				const { api, registeredTools } = createMockExtensionApi();
				subagentsModule.default(api);

				const tool = registeredTools.find(
					(tool) => tool.name === "subagents_list",
				);
				assert.ok(tool, "expected subagents_list to be registered");

				const result = await tool.execute();
				const agents = result.details?.agents ?? [];
				const sourceByName = new Map(
					agents.map((agent: any) => [agent.name, agent.source]),
				);

				assert.equal(sourceByName.get("scout"), "package");
				assert.equal(sourceByName.get("global-discovery-test-agent"), "global");
				assert.equal(
					sourceByName.get("project-discovery-test-agent"),
					"project",
				);
				assert.match(result.content[0].text, /scout \(package\)/);
				assert.match(
					result.content[0].text,
					/global-discovery-test-agent \(global\)/,
				);
				assert.match(
					result.content[0].text,
					/project-discovery-test-agent \(project\)/,
				);
			},
		);
	});

	it("rejects malformed capability declarations without widening role tools", async () => {
		await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir }) => {
			const rolePackDir = join(projectDir, "invalid-capability-pack");
			const rolesDir = join(rolePackDir, "roles");
			mkdirSync(rolesDir, { recursive: true });
			writeFileSync(
				join(rolePackDir, "package.json"),
				JSON.stringify({ name: "@acme/invalid-capability-pack" }),
			);
			writeAgentFile(
				rolesDir,
				"multiline-tools",
				["description: Invalid multiline tools", "tools:", "  - read"].join(
					"\n",
				),
			);
			writeAgentFile(
				projectAgentsDir,
				"empty-tools",
				["description: Invalid empty tools", "tools:"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"duplicate-tools",
				[
					"description: Invalid duplicate tools",
					"tools: read",
					"tools: grep",
				].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"invalid-deny-tools",
				[
					"description: Invalid multiline deny tools",
					"deny-tools:",
					"  - subagent",
				].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"invalid-spawning",
				["description: Invalid spawning boolean", "spawning: maybe"].join("\n"),
			);
			for (const [name, frontmatter] of [
				[
					"quoted-deny-tools",
					["description: Quoted deny tools", 'deny-tools: "subagent"'].join(
						"\n",
					),
				],
				[
					"comment-deny-tools",
					[
						"description: Commented deny tools",
						"deny-tools: subagent # prevent recursion",
					].join("\n"),
				],
				[
					"quoted-tools",
					["description: Quoted tools", 'tools: "read"'].join("\n"),
				],
				[
					"comment-tools",
					["description: Commented tools", "tools: read # inspection"].join(
						"\n",
					),
				],
				[
					"indented-tools",
					["description: Indented tools", "  tools: read"].join("\n"),
				],
				[
					"spaced-tools",
					["description: Spaced tools", "tools : read"].join("\n"),
				],
				[
					"quoted-key-tools",
					["description: Quoted key tools", '"tools": read'].join("\n"),
				],
			] as const) {
				writeAgentFile(projectAgentsDir, name, frontmatter);
			}
			writeAgentFile(
				projectAgentsDir,
				"scout",
				["description: Invalid bundled override", "tools: []"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"valid-comma-tools",
				["description: Valid comma tools", "tools: read, grep"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"valid-deny-tools",
				["description: Valid deny tools", "deny-tools: subagent"].join("\n"),
			);
			writeAgentFile(
				projectAgentsDir,
				"omitted-tools",
				"description: Intentionally unrestricted",
			);

			const { api, registeredTools } = createMockExtensionApi();
			api.events.on(
				"pi-herdr-subagents:roles:discover:v1",
				(request: { register(path: string): void }) =>
					request.register(rolesDir),
			);
			subagentsModule.default(api);

			const listTool = registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);
			assert.ok(listTool, "expected subagents_list to be registered");
			const result = await listTool.execute();
			const names = new Set(
				result.details.agents.map((agent: any) => agent.name),
			);
			for (const name of [
				"multiline-tools",
				"empty-tools",
				"duplicate-tools",
				"invalid-deny-tools",
				"invalid-spawning",
				"quoted-deny-tools",
				"comment-deny-tools",
				"quoted-tools",
				"comment-tools",
				"indented-tools",
				"spaced-tools",
				"quoted-key-tools",
				"scout",
			]) {
				assert.equal(names.has(name), false, `${name} must be rejected`);
			}
			assert.equal(
				result.details.agents.find(
					(agent: any) => agent.name === "valid-comma-tools",
				)?.tools,
				"read, grep",
			);
			assert.equal(
				result.details.agents.find(
					(agent: any) => agent.name === "omitted-tools",
				)?.tools,
				undefined,
			);
			assert.equal(
				testApi
					.resolveDenyTools(testApi.loadAgentDefaults("valid-deny-tools"))
					.has("subagent"),
				true,
				"a valid deny-tools scalar must resolve the actual tool name",
			);
			assert.equal(
				result.details.diagnostics.filter(
					(diagnostic: any) =>
						diagnostic.code === "invalid-capability-declaration",
				).length,
				13,
			);
			assert.match(result.content[0].text, /tools must use a non-empty/i);
			assert.match(result.content[0].text, /spawning must be true or false/i);
			assert.match(
				result.content[0].text,
				/comments and quotes are unsupported/i,
			);
			assert.match(result.content[0].text, /unquoted, unindented key/i);

			const subagentTool = registeredTools.find(
				(tool) => tool.name === "subagent",
			);
			assert.ok(subagentTool, "expected subagent to be registered");
			const previousHerdrEnv = process.env.HERDR_ENV;
			delete process.env.HERDR_ENV;
			try {
				const launch = await subagentTool.execute(
					"call-1",
					{ name: "Malformed", task: "Review this branch", agent: "scout" },
					new AbortController().signal,
					() => {},
					{},
				);
				assert.equal(launch.details.error, "invalid-capability-declaration");
				assert.match(launch.content[0].text, /tools/i);
			} finally {
				restoreEnvVar("HERDR_ENV", previousHerdrEnv);
			}
		});
	});

	it("uses the effective higher-precedence role before launch diagnostics", async () => {
		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const rolePackDir = join(projectDir, "precedence-capability-pack");
				const rolesDir = join(rolePackDir, "roles");
				mkdirSync(rolesDir, { recursive: true });
				writeFileSync(
					join(rolePackDir, "package.json"),
					JSON.stringify({ name: "@acme/precedence-capability-pack" }),
				);
				writeAgentFile(
					globalAgentsDir,
					"global-invalid-project-valid",
					["description: Invalid global", "tools: []"].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"global-invalid-project-valid",
					["description: Valid project", "tools: read"].join("\n"),
				);
				writeAgentFile(
					rolesDir,
					"pack-invalid-project-valid",
					["description: Invalid pack", "tools: []"].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"pack-invalid-project-valid",
					["description: Valid project", "tools: read"].join("\n"),
				);
				writeAgentFile(
					globalAgentsDir,
					"invalid-hidden-project-valid",
					["description: Invalid global", "tools: []"].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"invalid-hidden-project-valid",
					[
						"description: Valid hidden project",
						"tools: read",
						"disable-model-invocation: true",
					].join("\n"),
				);

				const { api, registeredTools } = createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) =>
						request.register(rolesDir),
				);
				subagentsModule.default(api);

				const catalog = testApi.discoverAgentCatalog(api);
				assert.equal(
					catalog.diagnostics.filter(
						(diagnostic) =>
							diagnostic.code === "invalid-capability-declaration",
					).length,
					3,
					"invalid lower-precedence roles remain visible as diagnostics",
				);
				for (const name of [
					"global-invalid-project-valid",
					"pack-invalid-project-valid",
					"invalid-hidden-project-valid",
				]) {
					const agent = catalog.agents.find(
						(candidate) => candidate.name === name,
					);
					assert.equal(agent?.source, "project");
					assert.equal(agent?.tools, "read");
				}

				const subagentTool = registeredTools.find(
					(tool) => tool.name === "subagent",
				);
				assert.ok(subagentTool, "expected subagent to be registered");
				const previousHerdrEnv = process.env.HERDR_ENV;
				delete process.env.HERDR_ENV;
				try {
					for (const agent of [
						"global-invalid-project-valid",
						"pack-invalid-project-valid",
						"invalid-hidden-project-valid",
					]) {
						const launch = await subagentTool.execute(
							"call-1",
							{ name: "Valid override", task: "Inspect", agent },
							new AbortController().signal,
							() => {},
							{},
						);
						assert.equal(launch.details.error, "herdr not available");
						assert.doesNotMatch(
							launch.content[0].text,
							/invalid capability declaration/i,
						);
					}
				} finally {
					restoreEnvVar("HERDR_ENV", previousHerdrEnv);
				}
			},
		);
	});

	it("rejects legacy external CLI roles before launch", async () => {
		await withIsolatedAgentEnv(
			async ({ globalAgentsDir, projectAgentsDir }) => {
				writeAgentFile(
					globalAgentsDir,
					"external-cli-reviewer",
					[
						"description: Legacy external CLI review adapter",
						"cli: claude",
						"cli-model: sonnet",
						"disable-model-invocation: true",
					].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"scout",
					["description: Legacy scout override", "cli: claude"].join("\n"),
				);
				const { api, registeredTools } = createMockExtensionApi();
				subagentsModule.default(api);

				const tool = registeredTools.find(
					(tool) => tool.name === "subagents_list",
				);
				assert.ok(tool, "expected subagents_list to be registered");

				const result = await tool.execute();
				assert.equal(
					result.details.agents.some(
						(agent: any) =>
							agent.name === "external-cli-reviewer" || agent.name === "scout",
					),
					false,
				);
				assert.equal(
					result.details.diagnostics.some(
						(diagnostic: any) =>
							diagnostic.agentName === "external-cli-reviewer" &&
							diagnostic.code === "external-cli-unsupported",
					),
					true,
				);
				assert.match(result.content[0].text, /Pi-only/i);
				assert.match(result.content[0].text, /remove.*cli/i);
				assert.equal(testApi.loadAgentDefaults("external-cli-reviewer"), null);

				const subagentTool = registeredTools.find(
					(tool) => tool.name === "subagent",
				);
				assert.ok(subagentTool, "expected subagent to be registered");
				const previousHerdrEnv = process.env.HERDR_ENV;
				delete process.env.HERDR_ENV;
				try {
					const launch = await subagentTool.execute(
						"call-1",
						{
							name: "Legacy",
							task: "Review this branch",
							agent: "external-cli-reviewer",
							worktree: { branch: "must-not-be-created" },
						},
						new AbortController().signal,
						() => {},
						{},
					);
					assert.equal(launch.details.error, "external-cli-unsupported");
					assert.match(launch.content[0].text, /Pi-only/i);
				} finally {
					restoreEnvVar("HERDR_ENV", previousHerdrEnv);
				}
			},
		);
	});

	it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			writeAgentFile(
				projectAgentsDir,
				"hidden-discovery-test-agent",
				[
					"name: hidden-discovery-test-agent",
					"description: Hidden test agent",
					"model: anthropic/test-hidden",
					"disable-model-invocation: true",
				].join("\n"),
				"You are the hidden agent.",
			);

			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);

			const tool = registeredTools.find(
				(tool) => tool.name === "subagents_list",
			);
			assert.ok(tool, "expected subagents_list to be registered");

			const result = await tool.execute();
			const agents = result.details?.agents ?? [];

			assert.equal(
				agents.some(
					(agent: any) => agent.name === "hidden-discovery-test-agent",
				),
				false,
			);
			assert.doesNotMatch(
				result.content[0].text,
				/hidden-discovery-test-agent/,
			);

			const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
			assert.ok(loaded, "expected hidden agent to remain directly loadable");
			assert.equal(loaded.model, "anthropic/test-hidden");
			assert.equal(loaded.body, "You are the hidden agent.");
			assert.equal(loaded.disableModelInvocation, true);
		});
	});

	it("lets a hidden project agent shadow a visible global agent", async () => {
		await withIsolatedAgentEnv(
			async ({ projectAgentsDir, globalAgentsDir }) => {
				writeAgentFile(
					globalAgentsDir,
					"shadowed-discovery-test-agent",
					[
						"name: shadowed-discovery-test-agent",
						"description: Global visible agent",
						"model: anthropic/test-global",
					].join("\n"),
					"You are the global visible agent.",
				);
				writeAgentFile(
					projectAgentsDir,
					"shadowed-discovery-test-agent",
					[
						"name: shadowed-discovery-test-agent",
						"description: Project hidden agent",
						"model: anthropic/test-project",
						"disable-model-invocation: true",
					].join("\n"),
					"You are the project hidden agent.",
				);

				const { api, registeredTools } = createMockExtensionApi();
				subagentsModule.default(api);

				const tool = registeredTools.find(
					(tool) => tool.name === "subagents_list",
				);
				assert.ok(tool, "expected subagents_list to be registered");

				const result = await tool.execute();
				const agents = result.details?.agents ?? [];

				assert.equal(
					agents.some(
						(agent: any) => agent.name === "shadowed-discovery-test-agent",
					),
					false,
				);
				assert.doesNotMatch(
					result.content[0].text,
					/shadowed-discovery-test-agent/,
				);

				const loaded = testApi.loadAgentDefaults(
					"shadowed-discovery-test-agent",
				);
				assert.ok(
					loaded,
					"expected project override to remain directly loadable",
				);
				assert.equal(loaded.model, "anthropic/test-project");
				assert.equal(loaded.body, "You are the project hidden agent.");
				assert.equal(loaded.disableModelInvocation, true);
			},
		);
	});
});
describe("subagent-done.ts", () => {
	it("builds a persistent task completion event", () => {
		const event = buildPersistentTaskEvent("task-1", "generation-1");
		assert.equal(event.version, 1);
		assert.equal(event.type, "task-done");
		assert.equal(event.task, "task-1");
		assert.equal(event.generation, "generation-1");
		assert.ok(event.at);
	});

	it("registers no keyboard shortcut and renders no Ctrl+J hint", () => {
		const previousAgent = process.env.PI_SUBAGENT_AGENT;
		const previousDenyTools = process.env.PI_DENY_TOOLS;
		process.env.PI_SUBAGENT_AGENT = "shortcut-test-agent";
		process.env.PI_DENY_TOOLS = "browser_navigate, subagent";
		try {
			const { api, registeredShortcuts, eventHandlers } =
				createMockExtensionApi();
			api.getAllTools = () => [{ name: "read" }, { name: "bash" }];
			subagentDoneExtension(api);
			assert.deepEqual(registeredShortcuts, []);

			const theme = {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			let widgetFactory: Function | undefined;
			const ctx = {
				ui: {
					setWidget(_name: string, factory: Function) {
						widgetFactory = factory;
					},
				},
			};
			for (const handler of eventHandlers.get("session_start") ?? []) {
				handler({}, ctx);
			}
			assert.deepEqual(
				registeredShortcuts,
				[],
				"session start must not register keyboard shortcuts",
			);
			assert.ok(widgetFactory, "tools widget should still be rendered");
			const widget = widgetFactory?.({}, theme);
			const lines: string[] = widget.render(80);
			assert.equal(
				lines.length,
				1,
				`widget must render one compact line: ${JSON.stringify(lines)}`,
			);
			const rendered = lines[0];
			assert.ok(
				rendered.includes("[shortcut-test-agent] — 2 tools · 2 denied"),
				`widget must show tool and denied counts: ${JSON.stringify(rendered)}`,
			);
			assert.equal(
				rendered.includes("Ctrl+J"),
				false,
				`widget must not mention Ctrl+J: ${JSON.stringify(rendered)}`,
			);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AGENT", previousAgent);
			restoreEnvVar("PI_DENY_TOOLS", previousDenyTools);
		}
	});

	it("does not register subagent_done for auto-exit children", () => {
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "caller_ping"),
				true,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_done"),
				false,
			);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
		}
	});

	it("restarts persistent inbox polling after reload when the initial task is already done", async () => {
		const dir = createTestDir();
		const previousPersistent = process.env.PI_SUBAGENT_PERSISTENT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousTask = process.env.PI_SUBAGENT_TASK_ID;
		const previousGeneration = process.env.PI_SUBAGENT_GENERATION_ID;
		const sessionFile = join(dir, "persistent-reload.jsonl");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "initial-task";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "initial-task",
			generation: "generation",
		});
		writePersistentTaskInbox(sessionFile, 1, {
			task: "next-task",
			message: "next",
		});
		let shutdown: Function | undefined;
		try {
			const { api, eventHandlers, sentUserMessages } = createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, ["next"]);
		} finally {
			shutdown?.({ reason: "reload" });
			restoreEnvVar("PI_SUBAGENT_PERSISTENT", previousPersistent);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_TASK_ID", previousTask);
			restoreEnvVar("PI_SUBAGENT_GENERATION_ID", previousGeneration);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps polling paused after reload while a dispatched follow-up remains unsettled", async () => {
		const dir = createTestDir();
		const previousPersistent = process.env.PI_SUBAGENT_PERSISTENT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousTask = process.env.PI_SUBAGENT_TASK_ID;
		const previousGeneration = process.env.PI_SUBAGENT_GENERATION_ID;
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const sessionFile = join(dir, "persistent-follow-up-reload.jsonl");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "initial-task";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		appendPersistentDeliveryLedger(sessionFile, {
			task: "initial-task",
			outcome: "dispatched",
			generation: "generation",
			logicalId: "logical",
			policyHash: "a".repeat(64),
		});
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "initial-task",
			generation: "generation",
		});
		appendPersistentDeliveryLedger(sessionFile, {
			task: "follow-up-task",
			outcome: "dispatched",
			generation: "generation",
			logicalId: "logical",
			policyHash: "a".repeat(64),
		});
		writePersistentTaskInbox(sessionFile, 2, {
			task: "next-task",
			message: "next",
		});
		let shutdown: Function | undefined;
		try {
			const { api, eventHandlers, registeredTools, sentUserMessages } =
				createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, []);

			const done = registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(done);
			await done.execute("call", {}, undefined, undefined, {});
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, ["next"]);
		} finally {
			shutdown?.({ reason: "reload" });
			restoreEnvVar("PI_SUBAGENT_PERSISTENT", previousPersistent);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_TASK_ID", previousTask);
			restoreEnvVar("PI_SUBAGENT_GENERATION_ID", previousGeneration);
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers subagent_done for interactive children", () => {
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_done"),
				true,
			);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
		}
	});

	it("waits for settlement after a transient compaction error", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const agentEnd = eventHandlers.get("agent_end")?.[0];
				const agentSettled = eventHandlers.get("agent_settled")?.[0];
				assert.ok(agentEnd);
				assert.ok(agentSettled);

				let shutdowns = 0;
				let branch: any[] = [];
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: { getBranch: () => branch },
				};
				const transientError = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				};
				agentEnd({ messages: [transientError] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);

				const completed = {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Completed after compaction." }],
				};
				branch = [
					{ type: "message", message: transientError },
					{ type: "compaction", summary: "Compacted" },
					{ type: "message", message: completed },
				];
				agentEnd({ messages: [completed] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);

				agentSettled({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{
						type: "done",
					},
				);
				assert.equal(shutdowns, 1);
				agentSettled({}, ctx);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("uses the settled branch instead of a stale agent_end error", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const cachedError = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				};
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => [
							{ type: "message", message: cachedError },
							{
								type: "message",
								message: { role: "assistant", stopReason: "stop" },
							},
						],
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [cachedError] }, ctx);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{ type: "done" },
				);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("reports a provider error that remains after settlement", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const error = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "provider failed",
				};
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => {
							throw new Error("session branch unavailable");
						},
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [error] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{
						type: "error",
						errorMessage: "provider failed",
						stopReason: "error",
					},
				);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("stays open when the settled assistant turn was aborted", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const aborted = { role: "assistant", stopReason: "aborted" };
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => [{ type: "message", message: aborted }],
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [aborted] }, ctx);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("preserves caller_ping completion when the agent later settles", async () => {
		const dir = createTestDir();
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousName = process.env.PI_SUBAGENT_NAME;
		const sessionFile = join(dir, "child.jsonl");
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_NAME = "test-child";
		try {
			const { api, eventHandlers, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			let shutdowns = 0;
			const ctx = {
				shutdown: () => shutdowns++,
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							message: { role: "assistant", stopReason: "stop" },
						},
					],
				},
			};
			const callerPing = registeredTools.find(
				(tool) => tool.name === "caller_ping",
			);
			assert.ok(callerPing);

			await callerPing.execute(
				"call",
				{ message: "Need input" },
				null,
				null,
				ctx,
			);
			eventHandlers.get("agent_end")?.[0](
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.deepEqual(
				JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
				{
					type: "ping",
					name: "test-child",
					message: "Need input",
				},
			);
			assert.equal(shutdowns, 1);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_NAME", previousName);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves non-auto-exit coordinators open until subagent_done", async () => {
		const dir = createTestDir();
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const sessionFile = join(dir, "child.jsonl");
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			const { api, eventHandlers, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			let shutdowns = 0;
			const ctx = {
				shutdown: () => shutdowns++,
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							message: { role: "assistant", stopReason: "stop" },
						},
					],
				},
			};

			eventHandlers.get("agent_end")?.[0](
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.equal(existsSync(`${sessionFile}.exit`), false);
			assert.equal(shutdowns, 0);

			const subagentDone = registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(subagentDone);
			await subagentDone.execute("call", {}, null, null, ctx);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.deepEqual(
				JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
				{
					type: "done",
				},
			);
			assert.equal(shutdowns, 1);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("shouldMarkUserTookOver", () => {
		it("ignores the initial injected task before the first agent run", () => {
			assert.equal(shouldMarkUserTookOver(false), false);
		});

		it("treats later input as manual takeover", () => {
			assert.equal(shouldMarkUserTookOver(true), true);
		});
	});

	describe("shouldAutoExitOnAgentEnd", () => {
		it("auto-exits after normal completion when there was no takeover", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
		});

		it("auto-exits after normal completion even when the user sent the prompt", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
		});

		it("stays open after Escape aborts the run", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
		});

		it("still exits when the latest turn ended with stopReason=error", () => {
			// Auto-exit subagents must shut down on retry-exhaustion errors so the
			// parent is woken. The error sidecar (written separately) carries the
			// failure detail; staying open would just strand the worker.
			const messages = [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "529 overloaded",
				},
			];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
		});
	});

	describe("findLatestAssistantError", () => {
		it("returns the error info from a stopReason=error message", () => {
			const messages = [
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "ok" }],
				},
				{ role: "toolResult", content: [] },
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "Anthropic 529 Overloaded",
				},
			];
			assert.deepEqual(findLatestAssistantError(messages), {
				errorMessage: "Anthropic 529 Overloaded",
				stopReason: "error",
			});
		});

		it("returns null when the latest assistant turn completed normally", () => {
			const messages = [
				{ role: "assistant", stopReason: "error", errorMessage: "old failure" },
				{ role: "user", content: [] },
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "done" }],
				},
			];
			assert.equal(findLatestAssistantError(messages), null);
		});

		it("returns null when the latest assistant turn was aborted by the user", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(findLatestAssistantError(messages), null);
		});

		it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
			const messages = [{ role: "assistant", stopReason: "error" }];
			const info = findLatestAssistantError(messages);
			assert.ok(info);
			assert.equal(info!.stopReason, "error");
			assert.match(info!.errorMessage, /stopReason=error/);
		});

		it("returns null when messages is undefined or empty", () => {
			assert.equal(findLatestAssistantError(undefined), null);
			assert.equal(findLatestAssistantError([]), null);
		});
	});

	describe("buildCompletionSidecar", () => {
		it("emits done immediately for a normal auto-exit completion", () => {
			assert.deepEqual(
				buildCompletionSidecar([
					{
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "done" }],
					},
				]),
				{ type: "done" },
			);
		});

		it("preserves provider errors in the immediate completion sidecar", () => {
			assert.deepEqual(
				buildCompletionSidecar([
					{
						role: "assistant",
						stopReason: "error",
						errorMessage: "provider failed",
					},
				]),
				{
					type: "error",
					errorMessage: "provider failed",
					stopReason: "error",
				},
			);
		});
	});
});

describe("lifecycle.ts", () => {
	const activity = (overrides: Partial<SubagentActivityState> = {}) => ({
		version: 1 as const,
		runningChildId: "child",
		createdAt: 1_000,
		updatedAt: 2_000,
		sequence: 1,
		latestEvent: "agent_start" as const,
		phase: "active" as const,
		agentActive: true,
		turnActive: true,
		providerActive: false,
		toolActive: false,
		activeScope: "agent" as const,
		activeSince: 2_000,
		...overrides,
	});

	it("interrupts only the turn and keeps process runtime open", () => {
		const running = observeLifecycleActivity(
			createLifecycle(1_000),
			{ ok: true, activity: activity() },
			2_000,
		);
		const interrupted = markInterruptRequested(running, 3_000);
		const projection = projectLifecycle(interrupted, 8_000);
		assert.equal(interrupted.process.kind, "running");
		assert.equal(interrupted.turn.kind, "interrupted");
		assert.equal(projection.runtimeEndedAt, undefined);
	});

	it("rejects stale activity after interrupt and accepts a newer sequence", () => {
		const running = observeLifecycleActivity(
			createLifecycle(1_000),
			{ ok: true, activity: activity() },
			2_000,
		);
		const interrupted = markInterruptRequested(running, 3_000);
		const stale = observeLifecycleActivity(
			interrupted,
			{ ok: true, activity: activity({ updatedAt: 3_000 }) },
			3_100,
		);
		assert.equal(stale.turn.kind, "interrupted");
		const resumed = observeLifecycleActivity(
			stale,
			{
				ok: true,
				activity: activity({
					updatedAt: 3_000,
					sequence: 2,
					activeSince: 3_000,
				}),
			},
			3_100,
		);
		assert.equal(resumed.turn.kind, "active");
	});

	it("makes finalizing and terminal process states irreversible", () => {
		const running = observeLifecycleActivity(
			createLifecycle(1_000),
			{ ok: true, activity: activity() },
			2_000,
		);
		const finalizing = markCompletionDetected(
			running,
			{ reason: "done", exitCode: 0 },
			4_000,
		);
		const ignored = observeLifecycleActivity(
			finalizing,
			{
				ok: true,
				activity: activity({ updatedAt: 5_000, sequence: 9 }),
			},
			5_000,
		);
		assert.equal(ignored.process.kind, "finalizing");
		assert.deepEqual(projectLifecycle(ignored, 9_000), {
			kind: "finalizing",
			runtimeEndedAt: 4_000,
		});
		const completed = markCompleted(ignored, 6_000);
		assert.equal(
			markFailed(completed, "late failure", 7_000).process.kind,
			"completed",
		);
	});

	it("projects confirmed running without turn detail as running, not starting", () => {
		const started = createLifecycle(1_000);
		const running = {
			...started,
			process: {
				kind: "running" as const,
				startedAt: 1_000,
				confirmedAt: 1_500,
			},
		};
		assert.deepEqual(projectLifecycle(running, 3_000), { kind: "running" });
	});

	it("detects stalled and recovered transitions from lifecycle projections", () => {
		assert.equal(lifecycleTransition("active", "stalled"), "stalled");
		assert.equal(lifecycleTransition("stalled", "waiting"), "recovered");
		assert.equal(lifecycleTransition("stalled", "active"), "recovered");
		assert.equal(lifecycleTransition("stalled", "blocked"), "recovered");
		assert.equal(lifecycleTransition("stalled", "interrupted"), "recovered");
		assert.equal(lifecycleTransition("waiting", "active"), null);
	});

	it("does not interpret initial idle as completion", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "idle" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 3_000).kind, "starting");
		assert.equal(lifecycle.turn.kind, "starting");
	});

	it("treats working then idle as waiting", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 2_500).kind, "active");
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("preserves state entry time across repeated herdr observations", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "working" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).stateDurationSince, 2_000);

		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 5_000, agentStatus: "blocked" },
			5_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 6_000, agentStatus: "blocked" },
			6_000,
		);
		assert.equal(projectLifecycle(lifecycle, 7_000).stateDurationSince, 5_000);

		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 8_000, agentStatus: "idle" },
			8_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 9_000, agentStatus: "done" },
			9_000,
		);
		assert.equal(projectLifecycle(lifecycle, 10_000).stateDurationSince, 8_000);
	});

	it("does not enter finalizing from herdr idle/done", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "done" },
			3_000,
		);
		assert.equal(lifecycle.process.kind, "running");
		assert.notEqual(projectLifecycle(lifecycle, 4_000).kind, "finalizing");
	});

	it("projects blocked when herdr reports blocked", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "blocked" },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 3_000).kind, "blocked");
	});

	it("treats missing pane as pane observation but not immediate failure", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "missing", error: "pane_not_found" },
			3_000,
		);
		assert.equal(lifecycle.pane.kind, "missing");
		assert.equal(lifecycle.process.kind, "running");
	});

	it("preserves local interrupt over stale herdr statuses", () => {
		for (const agentStatus of ["working", "blocked", "idle", "done"] as const) {
			let lifecycle = createLifecycle(1_000);
			lifecycle = observePaneInspection(
				lifecycle,
				{ kind: "present", observedAt: 2_000, agentStatus: "working" },
				2_000,
			);
			lifecycle = markInterruptRequested(lifecycle, 3_000);
			lifecycle = observePaneInspection(
				lifecycle,
				{ kind: "present", observedAt: 3_100, agentStatus },
				3_100,
			);
			assert.equal(
				projectLifecycle(lifecycle, 4_000).kind,
				"interrupted",
				agentStatus,
			);
		}
	});

	it("preserves hasWorked across unavailable observations", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "unavailable", error: "socket" },
			2_500,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "unavailable", error: "socket" },
			2_600,
		);
		assert.equal(lifecycle.pane.kind, "read-error");
		assert.equal(
			lifecycle.pane.kind === "read-error"
				? lifecycle.pane.consecutiveFailures
				: 0,
			2,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("does not let missing activity detail stall healthy herdr working", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{ ok: false, reason: "missing" },
			3_000,
		);
		assert.equal(projectLifecycle(lifecycle, 120_000).kind, "active");
	});

	it("uses activity as a fallback after a status-unknown pane snapshot", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "unknown" },
			2_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{ ok: true, activity: activity() },
			2_000,
		);
		assert.equal(projectLifecycle(lifecycle, 3_000).kind, "active");
	});

	it("uses activity only as detail and does not override herdr waiting", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 3_000, agentStatus: "idle" },
			3_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{ ok: true, activity: activity({ updatedAt: 3_100, sequence: 2 }) },
			3_100,
		);
		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
	});

	it("preserves activity detail duration across repeated updates", () => {
		let lifecycle = createLifecycle(1_000);
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt: 2_000, agentStatus: "working" },
			2_000,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					updatedAt: 2_100,
					sequence: 1,
					activeSince: 2_000,
					activeScope: "tool",
					toolName: "bash",
					toolStartedAt: 2_000,
				}),
			},
			2_100,
		);
		lifecycle = observeLifecycleActivity(
			lifecycle,
			{
				ok: true,
				activity: activity({
					updatedAt: 3_000,
					sequence: 2,
					activeSince: 2_000,
					activeScope: "tool",
					toolName: "bash",
					toolStartedAt: 2_000,
				}),
			},
			3_000,
		);
		const projection = projectLifecycle(lifecycle, 4_000);
		assert.equal(projection.kind, "active");
		assert.equal(projection.label, "bash");
		assert.equal(projection.stateDurationSince, 2_000);
	});
});

describe("no-progress advisories", () => {
	function activeRunning(sessionFile: string, interactive = false) {
		return {
			id: "child",
			name: "Worker",
			task: "",
			surface: "pane",
			startTime: 0,
			sessionFile,
			interactive,
			runtimePlan: undefined,
			lifecycle: observePaneInspection(
				createLifecycle(0),
				{ kind: "present", observedAt: 1, agentStatus: "working" },
				1,
			),
		};
	}

	it("warns once per active no-progress episode and rearms after durable progress", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call", name: "bash" }],
						stopReason: "toolUse",
					},
				}) + "\n",
			);
			utimesSync(sessionFile, 0, 0);
			const running = activeRunning(sessionFile);
			const now = 120_000;
			const first = subagentsModule.__test__.evaluateNoProgressAdvisory(
				running,
				projectLifecycle(running.lifecycle, now),
				now,
				1,
			);
			assert.equal(first?.kind, "warning");
			assert.equal(first?.classification, "blocked-tool");
			assert.equal(first?.lastEntryKind, "assistant");
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					running,
					projectLifecycle(running.lifecycle, now + 1_000),
					now + 1_000,
					1,
				),
				undefined,
			);

			const recoveredAt = 5 * 60 * 60_000;
			utimesSync(sessionFile, 0, recoveredAt / 1_000);
			const recovered = subagentsModule.__test__.evaluateNoProgressAdvisory(
				running,
				projectLifecycle(running.lifecycle, recoveredAt),
				recoveredAt,
				1,
			);
			assert.equal(recovered?.kind, "recovered");
			assert.equal(recovered?.idleMs, recoveredAt);
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					running,
					projectLifecycle(running.lifecycle, recoveredAt + 130_000),
					recoveredAt + 130_000,
					1,
				)?.kind,
				"warning",
			);
		});
	});

	it("formats evidence-based recovery guidance for every child policy", () => {
		const event = {
			kind: "warning" as const,
			idleMs: 60_000,
			classification: "generic-no-progress" as const,
			lastEntryKind: "assistant" as const,
			notify: true,
		};
		const running = activeRunning("/tmp/child.jsonl");
		const worktree = {
			path: "/tmp/worktree",
			workspaceId: "workspace",
			paneId: "pane",
			branch: "branch",
			baseRef: "HEAD",
			baseSha: "sha",
			manifestFile: "manifest",
		};
		const cases = [
			{
				name: "ordinary",
				running,
				expected:
					"interrupt, or after manual termination use subagent_resume or a new spawn",
				forbidden: undefined,
			},
			{
				name: "persistent",
				running: { ...running, persistent: true },
				expected:
					"interrupt, or use subagent_stop then replace with a new persistent specialist",
				forbidden: /subagent_resume/,
			},
			{
				name: "worktree",
				running: { ...running, worktree },
				expected:
					"interrupt, or retain the workspace and continue there after confirming the previous process exited",
				forbidden: /subagent_resume|new spawn/,
			},
			{
				name: "persistent worktree",
				running: { ...running, persistent: true, worktree },
				expected:
					"interrupt, or retain the workspace and continue there after confirming the previous process exited",
				forbidden: /subagent_resume|new persistent specialist/,
			},
		];

		for (const testCase of cases) {
			const line = subagentsModule.__test__.formatNoProgressAdvisoryLine(
				testCase.running,
				event,
			);
			assert.ok(line.includes(`Recovery options: ${testCase.expected}`));
			if (testCase.forbidden) assert.doesNotMatch(line, testCase.forbidden);
			assert.doesNotMatch(line, /cannot self-heal/);
		}

		const truncated = subagentsModule.__test__.formatNoProgressAdvisoryLine(
			running,
			{ ...event, classification: "truncated-turn" },
		);
		assert.match(
			truncated,
			/truncated-turn; observed toolUse stop with no tool call; cause unknown/,
		);

		for (const classification of [
			"blocked-tool",
			"truncated-turn",
			"generic-no-progress",
		] as const) {
			assert.doesNotMatch(
				subagentsModule.__test__.formatNoProgressAdvisoryLine(running, {
					...event,
					classification,
				}),
				/cannot self-heal/,
			);
		}
	});

	it("skips idle runs, resets on fresh heartbeats, and suppresses interactive steers", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "{}\n");
			utimesSync(sessionFile, 0, 0);
			const now = 20 * 60_000;
			const waiting = activeRunning(sessionFile);
			waiting.lifecycle = observePaneInspection(
				waiting.lifecycle,
				{ kind: "present", observedAt: 2, agentStatus: "idle" },
				2,
			);
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					waiting,
					projectLifecycle(waiting.lifecycle, now),
					now,
					1,
				),
				undefined,
			);

			const heartbeating = activeRunning(sessionFile);
			utimesSync(sessionFile, 0, (now - 1) / 1_000);
			assert.equal(
				subagentsModule.__test__.evaluateNoProgressAdvisory(
					heartbeating,
					projectLifecycle(heartbeating.lifecycle, now),
					now,
					1,
				),
				undefined,
			);

			utimesSync(sessionFile, 0, 0);
			const interactive = activeRunning(sessionFile, true);
			const event = subagentsModule.__test__.evaluateNoProgressAdvisory(
				interactive,
				projectLifecycle(interactive.lifecycle, now),
				now,
				1,
			);
			assert.equal(event?.kind, "warning");
			assert.equal(event?.notify, false);
		});
	});
});

describe("completion.ts", () => {
	it("decodes ping payloads", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "ping",
				name: "Worker",
				message: "need help",
			}),
			{
				reason: "ping",
				exitCode: 0,
				ping: { name: "Worker", message: "need help" },
			},
		);
	});

	it("decodes done payloads", () => {
		assert.deepEqual(interpretExitSidecar({ type: "done" }), {
			reason: "done",
			exitCode: 0,
		});
	});

	it("decodes error payloads and propagates the message with a non-zero exit code", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "error",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
				stopReason: "error",
			}),
			{
				reason: "error",
				exitCode: 1,
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			},
		);
	});

	it("falls back to a placeholder when error payload has no errorMessage", () => {
		const result = interpretExitSidecar({ type: "error" });
		assert.equal(result.reason, "error");
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /no errorMessage/);
	});

	it("rejects unknown completion sidecar payloads", () => {
		for (const payload of [{}, null]) {
			const result = interpretExitSidecar(payload);
			assert.equal(result.reason, "error");
			assert.equal(result.exitCode, 1);
			assert.match(
				result.errorMessage ?? "",
				/Invalid subagent completion sidecar/,
			);
		}
	});

	it("consumes a sidecar and removes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-"));
		const sessionFile = join(dir, "session.jsonl");
		const exitFile = `${sessionFile}.exit`;
		writeFileSync(
			exitFile,
			JSON.stringify({ type: "ping", name: "Scout", message: "ready" }),
		);
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
			});
			assert.deepEqual(result, {
				reason: "ping",
				exitCode: 0,
				ping: { name: "Scout", message: "ready" },
			});
			assert.equal(existsSync(exitFile), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the terminal sentinel exit code", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => "output\n__SUBAGENT_DONE_17__\n",
		});
		assert.deepEqual(result, { reason: "sentinel", exitCode: 17 });
	});

	it("prefers an error sidecar published during the terminal read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sentinel-race-"));
		const sessionFile = join(dir, "child.jsonl");
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => {
					await Promise.resolve();
					writeFileSync(
						`${sessionFile}.exit`,
						JSON.stringify({
							type: "error",
							errorMessage: "account/model rejected",
							stopReason: "error",
						}),
					);
					return "output\n__SUBAGENT_DONE_1__\n";
				},
			});
			assert.deepEqual(result, {
				reason: "error",
				exitCode: 1,
				errorMessage: "account/model rejected",
			});
			assert.equal(existsSync(`${sessionFile}.exit`), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers semantic sidecars published during a zero-exit terminal read", async () => {
		for (const [payload, expected] of [
			[
				{ type: "ping", name: "Scout", message: "need input" },
				{
					reason: "ping",
					exitCode: 0,
					ping: { name: "Scout", message: "need input" },
				},
			],
			[
				{ type: "error", errorMessage: "late semantic failure" },
				{
					reason: "error",
					exitCode: 1,
					errorMessage: "late semantic failure",
				},
			],
		] as const) {
			const dir = mkdtempSync(join(tmpdir(), "completion-zero-race-"));
			const sessionFile = join(dir, "child.jsonl");
			try {
				const result = await waitForCompletion(new AbortController().signal, {
					intervalMs: 1,
					sessionFile,
					readTerminalTail: async () => {
						writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
						return "__SUBAGENT_DONE_0__";
					},
				});
				assert.deepEqual(result, expected);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("retries transient terminal read failures and reports ticks", async () => {
		let reads = 0;
		let ticks = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("pane temporarily unavailable");
				return "__SUBAGENT_DONE_0__";
			},
			onTick: () => {
				ticks += 1;
			},
		});
		assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
		assert.equal(reads, 2);
		assert.equal(ticks, 1);
	});

	it("returns a failure when the pane explicitly disappears", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				throw new Error("pane read failed");
			},
			inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
			paneDisappearanceGraceMs: 0,
		});
		assert.deepEqual(result, {
			reason: "error",
			exitCode: 1,
			errorMessage:
				"Subagent pane disappeared before completion evidence was recorded.",
		});
	});

	it("lets a sidecar win the pane-disappearance race", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-race-"));
		const sessionFile = join(dir, "child.jsonl");
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
				inspectPane: async () => {
					writeFileSync(
						`${sessionFile}.exit`,
						JSON.stringify({ type: "done" }),
					);
					return { kind: "missing", error: "pane_not_found" };
				},
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("waits briefly for delayed sidecar publication after pane disappearance", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-delayed-race-"));
		const sessionFile = join(dir, "child.jsonl");
		const timer = setTimeout(() => {
			writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
		}, 30);
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
				inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
				paneDisappearanceGraceMs: 150,
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
		} finally {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps an ambiguous pane read failure retryable while the pane exists", async () => {
		let reads = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("socket unavailable");
				return "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => ({
				kind: "present",
				observedAt: 0,
				agentStatus: "working",
			}),
		});
		assert.equal(result.exitCode, 0);
		assert.equal(reads, 2);
	});

	it("treats presence-check throws as unknown and keeps polling", async () => {
		let reads = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("pane read failed");
				return "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => {
				throw new Error("herdr list failed");
			},
		});
		assert.equal(result.exitCode, 0);
		assert.equal(reads, 2);
	});

	it("inspects herdr status even when terminal reads succeed", async () => {
		let reads = 0;
		const inspections: string[] = [];
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				return reads === 1 ? "shell output" : "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => ({
				kind: "present",
				observedAt: 2_000,
				agentStatus: "blocked",
			}),
			onPaneInspection: (inspection) =>
				inspections.push(
					inspection.kind === "present"
						? inspection.agentStatus
						: inspection.kind,
				),
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(inspections, ["blocked"]);
	});

	it("rejects promptly when aborted", async () => {
		const controller = new AbortController();
		const completion = waitForCompletion(controller.signal, {
			intervalMs: 10_000,
			readTerminalTail: async () => "",
		});
		controller.abort();
		await assert.rejects(
			completion,
			/Aborted while waiting for subagent to finish/,
		);
	});
});

describe("commands", () => {
	it("/subagent list labels every visible agent source without spawning one", async () => {
		await withIsolatedAgentEnv(
			async ({ projectAgentsDir, globalAgentsDir }) => {
				writeAgentFile(
					globalAgentsDir,
					"global-command-list-test-agent",
					[
						"name: global-command-list-test-agent",
						"description: Global command test agent",
					].join("\n"),
				);
				writeAgentFile(
					projectAgentsDir,
					"project-command-list-test-agent",
					[
						"name: project-command-list-test-agent",
						"description: Project command test agent",
					].join("\n"),
				);

				const { api, registeredCommands, sentUserMessages } =
					createMockExtensionApi();
				subagentsModule.default(api);
				const subagent = registeredCommands.find(
					(command) => command.name === "subagent",
				);
				assert.ok(subagent, "expected /subagent to be registered");

				const notifications: Array<{ message: string; level: string }> = [];
				await subagent.handler("list", {
					ui: {
						notify: (message: string, level: string) =>
							notifications.push({ message, level }),
					},
				});

				assert.equal(notifications.length, 1);
				assert.equal(notifications[0].level, "info");
				assert.match(notifications[0].message, /scout \(package\)/);
				assert.match(
					notifications[0].message,
					/global-command-list-test-agent \(global\)/,
				);
				assert.match(
					notifications[0].message,
					/project-command-list-test-agent \(project\)/,
				);
				assert.equal(sentUserMessages.length, 0);
			},
		);
	});

	it("registers /worktree with list and explicit remove usage", async () => {
		const { api, registeredCommands } = createMockExtensionApi();
		subagentsModule.default(api);

		const worktree = registeredCommands.find(
			(command) => command.name === "worktree",
		);
		assert.ok(worktree, "expected /worktree to be registered");
		assert.equal(
			registeredCommands.some((command) => command.name === "handoff-worktree"),
			false,
		);

		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			ui: {
				notify: (message: string, level: string) =>
					notifications.push({ message, level }),
			},
		};
		await worktree.handler("", ctx);
		await worktree.handler("list extra", ctx);
		assert.deepEqual(notifications, [
			{
				message:
					"Usage: /worktree <name> [task] | /worktree list | /worktree remove <target> [--preserve]",
				level: "warning",
			},
			{
				message:
					"Usage: /worktree <name> [task] | /worktree list | /worktree remove <target> [--preserve]",
				level: "warning",
			},
		]);
	});

	it("registers /subagents-init with registry research and reload guidance", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		const init = registeredCommands.find(
			(command) => command.name === "subagents-init",
		);
		assert.ok(init, "expected /subagents-init to be registered");
		await init.handler("", {
			modelRegistry: { find: () => undefined, getAvailable: () => [] },
		});
		assert.equal(sentUserMessages.length, 1);
		assert.match(sentUserMessages[0], /registry object/);
		assert.match(sentUserMessages[0], /web search/);
		assert.match(sentUserMessages[0], /registry-only/);
		assert.match(sentUserMessages[0], /subagents_write_task_models/);
		assert.match(sentUserMessages[0], /\/reload/);
	});

	it("injects every live available model with sanitized facts, preferences, and category definitions", async () => {
		const dir = createTestDir();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const { api, registeredCommands, sentUserMessages } =
				createMockExtensionApi();
			subagentsModule.default(api);
			// Written after registration: init must read the current saved preferences, not the module snapshot.
			const configPath = getSubagentsConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					privateSetting: "secret-unrelated-config",
					models: {
						default: "plain/old",
						agents: { worker: "plain/old" },
						tasks: { coding: ["plain/old"] },
						tasksMeta: {
							generatedAt: "2026-09-17T00:00:00Z",
							method: "registry-only",
						},
					},
				}),
			);
			const before = readFileSync(configPath, "utf8");
			const models = Array.from({ length: 30 }, (_, i) => ({
				provider: i === 29 ? "extension-bridge" : "plain",
				id: `model-${String(i).padStart(2, "0")}`,
				name: "Upstream model display name",
				api: "openai-completions",
				baseUrl: "https://secret-endpoint",
				headers: { authorization: "secret-header" },
				apiKey: "secret-key",
				token: "secret-token",
				reasoning: i === 29,
				thinkingLevelMap: {
					minimal: null,
					low: null,
					medium: null,
					high: "secret-effort-value",
					xhigh: null,
					max: "max",
				},
				input: i === 29 ? ["text", "image"] : ["text"],
				contextWindow: 200001 + i,
				maxTokens: 16001 + i,
				cost:
					i === 0
						? undefined
						: { input: 0, output: 2, cacheRead: 0, secret: "secret-cost" },
			}));
			const registry = {
				getAvailable: () => models.slice().reverse(),
				find: (provider: string, id: string) =>
					models.find((m) => m.provider === provider && m.id === id),
				getAll: () => {
					throw new Error("init must not read the unauthenticated catalog");
				},
				getRegisteredProviderIds: () => ["extension-bridge"],
				getProviderAuthStatus: (provider: string) => ({
					configured: true,
					source: provider === "plain" ? "stored" : "secret-auth-source",
					label: "secret-auth-label",
				}),
			};
			const init = registeredCommands.find(
				(command) => command.name === "subagents-init",
			)!;
			await init.handler(
				"  Prefer capability over price; keep\nexisting coding choices.  ",
				{ modelRegistry: registry },
			);
			assert.equal(sentUserMessages.length, 1);
			const message = sentUserMessages[0];
			assert.doesNotMatch(
				message,
				/secret-|baseUrl|apiKey|authorization|thinkingLevelMap/,
			);
			const json = message.match(/```json\n([\s\S]*?)\n```/);
			assert.ok(json, "init must supply a structured registry brief");
			const brief = JSON.parse(json[1]);
			assert.equal(
				brief.operatorPreferences,
				"Prefer capability over price; keep\nexisting coding choices.",
			);
			assert.deepEqual(brief.categories, {
				coding: "Implementation workers",
				review: "Code reviewers",
				recon: "Reconnaissance scouts",
				qa: "Software and test runners",
				architecture: "Planning and diagnosis",
				docs: "Documentation workers",
			});
			assert.deepEqual(brief.current, {
				default: "plain/old",
				agents: { worker: "plain/old" },
				tasks: { coding: ["plain/old"] },
				tasksMeta: {
					generatedAt: "2026-09-17T00:00:00Z",
					method: "registry-only",
				},
			});
			assert.equal(brief.models.length, 30);
			assert.deepEqual(
				brief.models.map((m: any) => m.ref),
				[
					"extension-bridge/model-29",
					...Array.from(
						{ length: 29 },
						(_, i) => `plain/model-${String(i).padStart(2, "0")}`,
					),
				],
			);
			assert.deepEqual(brief.models[0], {
				ref: "extension-bridge/model-29",
				provider: "extension-bridge",
				id: "model-29",
				name: "Upstream model display name",
				extensionRegistered: true,
				auth: { configured: true },
				reasoning: true,
				supportedThinkingLevels: ["off", "high", "max"],
				input: ["text", "image"],
				contextWindow: 200030,
				maxTokens: 16030,
				cost: { input: 0, output: 2, cacheRead: 0 },
			});
			assert.equal(Object.hasOwn(brief.models[1], "cost"), false);
			assert.deepEqual(brief.models[1].auth, {
				configured: true,
				source: "stored",
			});
			assert.deepEqual(brief.models[1].supportedThinkingLevels, ["off"]);
			assert.equal(Object.hasOwn(brief.models[2].cost, "cacheWrite"), false);
			assert.equal(
				readFileSync(configPath, "utf8"),
				before,
				"init must not save a draft itself",
			);
			for (const rule of [
				/capability-first/,
				/efficiency/,
				/complexity/,
				/notable exclusions/,
				/primary sources/,
				/no usable evidence/,
				/same upstream/,
				/different.*family/,
				/context-isolated/,
				/not cross-family independent/,
				/[Ww]hen no other.*family is available/,
				/[Oo]rdinary review/,
				/before\/after/,
				/launch-time/,
				/first authenticated/,
				/not commands/,
				/parent model/,
			])
				assert.match(message, rule);
			const normalizedPrompt = message.replace(/\s+/g, " ").trim();
			for (const clause of [
				"Cross-family independent review requires a reviewer from a different model family than the author.",
				"For ordinary review, prefer a different authenticated model family.",
				"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
				"Disclose that this review is context-isolated, not cross-family independent.",
				"Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.",
			])
				assert.ok(
					normalizedPrompt.includes(clause),
					`task-model init prompt must include: ${clause}`,
				);
		} finally {
			restoreEnvVar("PI_CODING_AGENT_DIR", previous);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a large init catalog complete in compact JSON and reports snapshot limits", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		const models = Array.from({ length: 350 }, (_, i) => ({
			provider: "gateway",
			id: `alias-${i}`,
			name: `Upstream ${i}`,
			reasoning: false,
		}));
		await registeredCommands
			.find((command) => command.name === "subagents-init")!
			.handler("", {
				modelRegistry: { getAvailable: () => models },
			});
		const message = sentUserMessages[0];
		const json = message.match(/```json\n([\s\S]*?)\n```/);
		assert.ok(json);
		const brief = JSON.parse(json[1]);
		assert.deepEqual(
			new Set(brief.models.map((model: any) => model.ref)),
			new Set(models.map((model) => `${model.provider}/${model.id}`)),
		);
		assert.equal(brief.models.length, models.length);
		assert.equal(
			json[1],
			JSON.stringify(brief),
			"catalog JSON must not add indentation or formatting whitespace",
		);
		assert.ok(message.includes(`${models.length} models`));
		assert.ok(message.includes(`${json[1].length} JSON characters`));
		assert.match(message, /synchronous snapshot/);
		assert.match(message, /initial catalog refresh/);
	});

	it("tolerates an optional auth-status method returning undefined", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		await registeredCommands
			.find((command) => command.name === "subagents-init")!
			.handler("", {
				modelRegistry: {
					getAvailable: () => [
						{ provider: "dynamic", id: "model", reasoning: false },
					],
					getProviderAuthStatus: () => undefined,
				},
			});
		const json = sentUserMessages[0].match(/```json\n([\s\S]*?)\n```/);
		assert.ok(json);
		assert.deepEqual(JSON.parse(json[1]).models[0].auth, { configured: true });
	});

	it("rejects empty task maps through the writer schema but accepts partial categories", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);
		const writer = registeredTools.find(
			(tool) => tool.name === "subagents_write_task_models",
		)!;
		const tasksMeta = {
			generatedAt: "2026-09-18T00:00:00Z",
			method: "registry-only",
		};
		assert.equal(
			Value.Check(writer.parameters, { tasks: {}, tasksMeta }),
			false,
		);
		assert.equal(
			Value.Check(writer.parameters, {
				tasks: { coding: ["fake/worker"] },
				tasksMeta,
			}),
			true,
		);
	});

	it("supplies an honest empty init brief without inventing models or writing configuration", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);
		await registeredCommands
			.find((command) => command.name === "subagents-init")!
			.handler("   ", {
				modelRegistry: {
					find: () => undefined,
					getAvailable: () => [],
					getAll: () => {
						throw new Error("no fallback catalog");
					},
				},
			});
		const json = sentUserMessages[0].match(/```json\n([\s\S]*?)\n```/);
		assert.ok(json);
		const brief = JSON.parse(json[1]);
		assert.equal(brief.operatorPreferences, "");
		assert.deepEqual(brief.models, []);
		assert.deepEqual(brief.current, { agents: {} });
		assert.match(sentUserMessages[0], /no available models.*do not write/i);
		assert.match(sentUserMessages[0], /not proof of.*successful.*request/i);
	});

	it("returns saved tool details and text from normalized config while preserving unrelated preferences", async () => {
		const dir = createTestDir();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);
			const configPath = getSubagentsConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					status: { enabled: false },
					models: {
						default: "fake/default",
						agents: { scout: "fake/scout" },
						tasks: { review: ["fake/old"] },
					},
				}),
			);
			const writer = registeredTools.find(
				(tool) => tool.name === "subagents_write_task_models",
			)!;
			assert.deepEqual(
				Object.keys(writer.parameters.properties.tasks.properties),
				["coding", "review", "recon", "qa", "architecture", "docs"],
			);
			assert.equal(
				writer.parameters.properties.tasks.additionalProperties,
				false,
			);
			assert.equal(writer.parameters.properties.tasks.required?.length ?? 0, 0);
			const tasksMeta = {
				generatedAt: "2026-09-18T00:00:00Z",
				method: "registry-only",
			};
			const model = { provider: "fake", id: "worker", reasoning: false };
			const result = await writer.execute(
				"init-write",
				{ tasks: { coding: [" fake/worker "] }, tasksMeta },
				undefined,
				undefined,
				{
					modelRegistry: {
						find: (provider: string, id: string) =>
							provider === "fake" && id === "worker" ? model : undefined,
						getAvailable: () => [model],
						hasConfiguredAuth: () => true,
					},
				},
			);
			assert.deepEqual(result.details, {
				configPath,
				tasks: { coding: ["fake/worker"] },
				tasksMeta,
				missingCategories: ["review", "recon", "qa", "architecture", "docs"],
			});
			assert.match(result.content[0].text, /Reload required/);
			assert.ok(
				result.content[0].text.includes(
					JSON.stringify(result.details, null, 2),
				),
			);
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
				status: { enabled: false },
				models: {
					default: "fake/default",
					agents: { scout: "fake/scout" },
					tasks: { coding: ["fake/worker"] },
					tasksMeta,
				},
			});
		} finally {
			restoreEnvVar("PI_CODING_AGENT_DIR", previous);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers direct BTW commands without steering the parent", async () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();
		subagentsModule.default(api);

		const btw = registeredCommands.find((command) => command.name === "btw");
		const close = registeredCommands.find(
			(command) => command.name === "btw-close",
		);
		assert.ok(btw, "expected /btw to be registered");
		assert.ok(close, "expected /btw-close to be registered");

		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			ui: {
				notify: (message: string, level: string) =>
					notifications.push({ message, level }),
			},
		};
		await btw.handler("  ", ctx);
		await close.handler("", ctx);

		assert.deepEqual(notifications, [
			{ message: "Usage: /btw <question>", level: "warning" },
			{ message: "No BTW session is open.", level: "info" },
		]);
		assert.equal(sentUserMessages.length, 0);
	});

	it("builds a standalone BTW command without worker control machinery", () => {
		const command = subagentsModule.__test__.buildBtwLaunchCommand({
			cwd: "/tmp/project path",
			sessionFile: "/tmp/btw.jsonl",
			question: "What does that API do?",
			model: "openai-codex/gpt-5.6-sol",
			thinking: "high",
			agentDir: "/tmp/pi-agent",
		});

		assert.match(command, /--session/);
		assert.match(command, /--no-extensions/);
		assert.match(command, /openai-codex\/gpt-5\.6-sol/);
		assert.match(command, /BTW question:/);
		assert.match(command, /What does that API do\?/);
		assert.match(command, /PI_CODING_AGENT_DIR=/);
		assert.doesNotMatch(command, /subagent-done|PI_SUBAGENT_|subagent_result/);
	});

	it("/iterate always emits a full-context fork tool call", () => {
		const { api, registeredCommands, sentUserMessages } =
			createMockExtensionApi();

		subagentsModule.default(api);

		const iterate = registeredCommands.find(
			(command) => command.name === "iterate",
		);
		assert.ok(iterate, "expected /iterate to be registered");

		iterate.handler("Fix the bug", {});

		assert.equal(sentUserMessages.length, 1);
		assert.match(sentUserMessages[0], /fork: true/);
		assert.match(sentUserMessages[0], /interactive: true/);
		assert.match(sentUserMessages[0], /name: "Iterate"/);
	});
});

describe("worktree cleanup public surface", () => {
	it("skips startup inventory outside Herdr", async (t) => {
		const previousHerdr = process.env.HERDR_ENV;
		t.after(() => restoreEnvVar("HERDR_ENV", previousHerdr));
		for (const herdrEnv of [undefined, "0"]) {
			restoreEnvVar("HERDR_ENV", herdrEnv);
			const f = cleanupFixture();
			const scan = t.mock.method(f.operations, "scan");
			const { api, eventHandlers } = createMockExtensionApi();
			subagentsModule.default(api, { cleanupOperations: () => f.operations });
			const notices: string[] = [];
			await eventHandlers.get("session_start")![0](
				{},
				{
					cwd: "/repo",
					hasUI: true,
					modelRegistry: { find: () => undefined, getAvailable: () => [] },
					ui: { notify: (text: string) => notices.push(text) },
				},
			);
			assert.deepEqual(notices, []);
			assert.equal(scan.mock.callCount(), 0);
		}
	});
	it("delivers process warnings through tool inventory, successful results, and Pi error messages", async () => {
		for (const status of ["removed", "blocked", "failed"] as const) {
			const f = cleanupFixture();
			const warnings = [
				"Incomplete process coverage: a protected process could hold the checkout undetected.",
			];
			f.operations.holders = async () => ({
				blockers:
					status === "blocked" ? ["Live process 202 holds the checkout"] : [],
				warnings,
			});
			if (status === "failed")
				f.operations.removeCheckout = () => {
					throw new Error("remove refused");
				};
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api, { cleanupOperations: () => f.operations });
			const ctx = { cwd: "/repo" };
			const inventory = await registeredTools
				.find((tool) => tool.name === "worktree_list")!
				.execute("id", {}, undefined, undefined, ctx);
			assert.deepEqual(inventory.details.entries[0].warnings, warnings);
			assert.match(inventory.content[0].text, /Warning:.*protected process/);
			const remove = () =>
				registeredTools
					.find((tool) => tool.name === "worktree_remove")!
					.execute("id", { target: "task" }, undefined, undefined, ctx);
			if (status === "removed") {
				const result = await remove();
				assert.deepEqual(result.details.warnings, warnings);
				assert.match(result.content[0].text, /Warning:.*protected process/);
			} else {
				await assert.rejects(remove, /Warning:.*protected process/);
				assert.deepEqual(f.calls, []);
			}
		}
	});
	it("registers parent tools, dispatches list/remove, and reports session-start inventory once", async (t) => {
		const previousHerdr = process.env.HERDR_ENV;
		process.env.HERDR_ENV = "1";
		t.mock.method(childProcess, "execSync", () => "/fixture/herdr\n");
		syncBuiltinESMExports();
		t.after(() => {
			restoreEnvVar("HERDR_ENV", previousHerdr);
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
		const f = cleanupFixture();
		const { api, registeredTools, registeredCommands, eventHandlers } =
			createMockExtensionApi();
		subagentsModule.default(api, { cleanupOperations: () => f.operations });
		const notices: string[] = [];
		const ctx = {
			cwd: "/repo",
			hasUI: true,
			modelRegistry: { find: () => undefined, getAvailable: () => [] },
			ui: { notify: (text: string) => notices.push(text) },
		};
		const list = registeredTools.find((tool) => tool.name === "worktree_list");
		const remove = registeredTools.find(
			(tool) => tool.name === "worktree_remove",
		);
		assert.ok(list);
		assert.ok(remove);
		const result = await list.execute("id", {}, undefined, undefined, ctx);
		assert.equal(result.details.entries[0].classification, "eligible");
		await eventHandlers.get("session_start")![0]({}, ctx);
		assert.equal(notices.length, 1);
		assert.match(notices[0], /1 present · 1 eligible · 0 blocked/);
		assert.deepEqual(f.calls, []);
		const command = registeredCommands.find(
			(item) => item.name === "worktree",
		)!;
		await command.handler("remove task", ctx);
		assert.match(notices.at(-1)!, /Removed/);
		assert.deepEqual(f.calls, ["git:/repo:/managed/repo/task", "prune:/repo"]);
		const count = notices.length;
		await eventHandlers.get("session_start")![0]({}, ctx);
		assert.equal(notices.length, count);
	});
	it("dispatches preserve explicitly from the tool and command", async () => {
		for (const surface of ["tool", "command"]) {
			const f = cleanupFixture();
			f.state.dirtyFiles = 1;
			const { api, registeredTools, registeredCommands } =
				createMockExtensionApi();
			subagentsModule.default(api, { cleanupOperations: () => f.operations });
			const ctx = { cwd: "/repo", ui: { notify: () => {} } };
			if (surface === "tool")
				await registeredTools
					.find((tool) => tool.name === "worktree_remove")!
					.execute(
						"id",
						{ target: "task", preserve: true },
						undefined,
						undefined,
						ctx,
					);
			else
				await registeredCommands
					.find((item) => item.name === "worktree")!
					.handler("remove task --preserve", ctx);
			assert.equal(f.calls[0], "preserve");
		}
	});
	it("keeps child Herdr list formatting, handoff dispatch, and silent startup", async (t) => {
		const dir = createTestDir();
		const previousId = process.env.PI_SUBAGENT_ID;
		const previousHerdr = process.env.HERDR_ENV;
		process.env.PI_SUBAGENT_ID = "child";
		process.env.HERDR_ENV = "1";
		let worktrees: object[] = [
			{
				branch: "feature/topic",
				path: "/checkout/topic",
				is_linked_worktree: true,
				open_workspace_id: "w9",
			},
			{ branch: "main", path: "/repo", is_linked_worktree: false },
			{
				is_detached: true,
				path: "/checkout/detached",
				is_linked_worktree: true,
			},
		];
		const effects: string[][] = [];
		const availability = t.mock.method(
			childProcess,
			"execSync",
			(command: string) => {
				assert.equal(command, "command -v herdr");
				return "/fixture/herdr\n";
			},
		);
		const mocked = t.mock.method(
			childProcess,
			"execFileSync",
			(file: string, args: string[], options: { cwd?: string }) => {
				effects.push([file, ...args]);
				if (file === "herdr" && args[0] === "worktree" && args[1] === "list") {
					assert.deepEqual(args, ["worktree", "list", "--cwd", "/repo"]);
					return JSON.stringify({
						result: { type: "worktree_list", worktrees },
					});
				}
				if (file === "git") {
					assert.deepEqual(args, ["rev-parse", "--verify", "HEAD^{commit}"]);
					assert.equal(options.cwd, "/repo");
					return "a".repeat(40);
				}
				assert.equal(file, "herdr");
				assert.deepEqual(args, [
					"worktree",
					"create",
					"--cwd",
					"/repo",
					"--branch",
					"feature/followup",
					"--base",
					"a".repeat(40),
					"--label",
					"wt: feature/followup",
					"--no-focus",
				]);
				// Stop at the external creation boundary: no real workspace is created.
				throw new Error("fixture handoff creation stopped");
			},
		);
		syncBuiltinESMExports();
		try {
			const { api, registeredCommands, eventHandlers } =
				createMockExtensionApi();
			api.getThinkingLevel = () => "medium";
			subagentsModule.default(api, {
				cleanupOperations: () => {
					throw new Error("child must not inspect cleanup inventory");
				},
			});
			const notices: string[] = [];
			const model = { provider: "fake", id: "test", reasoning: true };
			let idleWaits = 0;
			const ctx = {
				cwd: "/repo",
				hasUI: true,
				model,
				modelRegistry: {
					find: () => model,
					getAvailable: () => [model],
					hasConfiguredAuth: () => true,
				},
				ui: { notify: (text: string) => notices.push(text) },
				waitForIdle: async () => {
					idleWaits++;
				},
				sessionManager: {
					getSessionFile: () => join(dir, "parent.jsonl"),
					getLeafId: () => "active-leaf",
					getSessionId: () => "child",
					getSessionDir: () => dir,
				},
			};
			await eventHandlers.get("session_start")![0]({}, ctx);
			assert.deepEqual(notices, []);
			assert.deepEqual(effects, []);
			const command = registeredCommands.find(
				(command) => command.name === "worktree",
			)!;
			await command.handler("list", ctx);
			assert.equal(
				notices.at(-1),
				"feature/topic — /checkout/topic (w9)\nmain — /repo\n(detached HEAD) — /checkout/detached",
			);
			worktrees = [];
			await command.handler("list", ctx);
			assert.equal(notices.at(-1), "No worktrees found.");
			await command.handler("feature/followup", ctx);
			assert.equal(idleWaits, 1);
			assert.equal(
				notices.at(-1),
				"Worktree launch failed: fixture handoff creation stopped",
			);
			assert.equal(effects.length, 4);
			const manifestDir = join(dir, "artifacts", "child", "worktree-runs");
			const manifests = readdirSync(manifestDir);
			assert.equal(manifests.length, 1);
			const manifest = JSON.parse(
				readFileSync(join(manifestDir, manifests[0]), "utf8"),
			);
			assert.equal(manifest.branch, "feature/followup");
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.sourceCwd, "/repo");
		} finally {
			mocked.mock.restore();
			availability.mock.restore();
			syncBuiltinESMExports();
			restoreEnvVar("PI_SUBAGENT_ID", previousId);
			restoreEnvVar("HERDR_ENV", previousHerdr);
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("keeps the child worktree command but rejects removal and hides cleanup tools", async () => {
		process.env.PI_SUBAGENT_ID = "child";
		try {
			const { api, registeredTools, registeredCommands } =
				createMockExtensionApi();
			subagentsModule.default(api);
			assert.equal(
				registeredTools.some((tool) =>
					["worktree_list", "worktree_remove"].includes(tool.name),
				),
				false,
			);
			const command = registeredCommands.find(
				(command) => command.name === "worktree",
			)!;
			assert.ok(command);
			assert.doesNotMatch(command.description, /remove/);
			const notices: string[] = [];
			const ctx = {
				cwd: "/repo",
				ui: { notify: (text: string) => notices.push(text) },
			};
			await command.handler("", ctx);
			assert.match(notices.at(-1)!, /<name>.*worktree list/);
			assert.doesNotMatch(notices.at(-1)!, /remove/);
			await command.handler("remove task --preserve", ctx);
			assert.match(notices.at(-1)!, /parent-only/);
		} finally {
			delete process.env.PI_SUBAGENT_ID;
		}
	});
});

describe("tool registration", () => {
	it("refreshes subagent routing guidance from the live authenticated model registry", () => {
		const { api, registeredTools, eventHandlers } = createMockExtensionApi();
		subagentsModule.default(api);

		const subagent = registeredTools.find((tool) => tool.name === "subagent");
		assert.ok(subagent);
		const sessionStart = eventHandlers.get("session_start")?.[0];
		assert.ok(sessionStart);
		sessionStart(
			{},
			{
				hasUI: false,
				modelRegistry: {
					find: (provider: string, id: string) => ({
						provider,
						id,
						reasoning: true,
					}),
					getAvailable: () => [
						{
							provider: "fake",
							id: "fast",
							reasoning: true,
							input: ["text"],
							contextWindow: 128_000,
							maxTokens: 16_000,
							cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						},
					],
					hasConfiguredAuth: () => true,
				},
			},
		);

		assert.match(subagent.promptGuidelines.join("\n"), /fake\/fast/);
		assert.match(
			subagent.promptGuidelines.join("\n"),
			/explicitly set both model and thinking for every child/,
		);
		assert.match(
			subagent.promptGuidelines.join("\n"),
			/For ordinary review, prefer a different authenticated model family/,
		);
		assert.match(
			subagent.promptGuidelines.join("\n"),
			/context-isolated/,
			"injected routing guidelines must describe context-isolated same-family fallback",
		);
		assert.match(
			subagent.promptGuidelines.join("\n"),
			/Omitting model and thinking still inherits the parent runtime, but this is a discouraged fallback/,
		);
		assert.match(subagent.promptGuidelines.join("\n"), /login-test2/);
	});

	it("distinguishes ordinary context-isolated review from strict cross-family review", () => {
		const registry = wrapPiModelRegistry({
			find: (p: string, id: string) => ({ provider: p, id, reasoning: true }),
			getAvailable: () => [
				{
					provider: "fake",
					id: "worker",
					reasoning: true,
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 16_000,
				},
			],
			getAll: () => {
				throw new Error("must not call getAll");
			},
		});
		const clauses = [
			"For ordinary review, prefer a different authenticated model family.",
			"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
			"Disclose that this review is context-isolated, not cross-family independent.",
			"Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.",
		];
		for (const [label, taskPreferences] of [
			["shortlist", { coding: ["fake/worker"] }],
			["generic", {}],
		] as const) {
			const catalog = buildAuthenticatedModelCatalog(
				registry,
				24,
				taskPreferences,
			);
			const combined = subagentsModule.__test__
				.buildSubagentRoutingGuidelines(catalog, taskPreferences)
				.join("\n")
				.replace(/\s+/g, " ")
				.trim();
			for (const clause of clauses)
				assert.ok(
					combined.includes(clause),
					`${label} combined guidance must include: ${clause}`,
				);
			if (label === "generic") {
				const orchestratedLine = catalog
					.split("\n")
					.find((line) => line.startsWith("For orchestrated children"));
				assert.ok(orchestratedLine);
				assert.doesNotMatch(
					orchestratedLine,
					/ordinary|same-family|context-isolated/i,
				);
			}
		}
	});

	it("states the complete ordinary-review taxonomy in routing guidelines", () => {
		const guidelines = subagentsModule.__test__
			.buildSubagentRoutingGuidelines("catalog", { coding: ["fake/worker"] })
			.join("\n")
			.replace(/\s+/g, " ")
			.trim();
		for (const clause of [
			"For ordinary review, prefer a different authenticated model family.",
			"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
			"Disclose that this review is context-isolated, not cross-family independent.",
			"Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.",
		])
			assert.ok(
				guidelines.includes(clause),
				`routing guidelines must include: ${clause}`,
			);
	});

	it("renders generic routing tiers only when no authenticated shortlist is available", () => {
		const configured = subagentsModule.__test__
			.buildSubagentRoutingGuidelines("catalog", { coding: ["fake/worker"] })
			.join("\n");
		assert.match(configured, /prefer the configured task-category shortlists/);
		assert.doesNotMatch(configured, /first choose a fast, mid, or frontier/);

		const generic = subagentsModule.__test__
			.buildSubagentRoutingGuidelines("catalog", {})
			.join("\n");
		assert.match(generic, /first choose a fast, mid, or frontier/);
		assert.doesNotMatch(
			generic,
			/prefer the configured task-category shortlists/,
		);
	});

	it("ignores an inherited deny list in a parent process", () => {
		delete process.env.PI_SUBAGENT_ID;
		process.env.PI_DENY_TOOLS =
			"subagent,subagent_interrupt,subagent_resume,subagents_list";
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentsModule.default(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent"),
				true,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_interrupt"),
				true,
			);
		} finally {
			delete process.env.PI_DENY_TOOLS;
		}
	});

	it("applies the deny list inside a child subagent process", () => {
		process.env.PI_SUBAGENT_ID = "child-test";
		process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt";
		try {
			const { api, registeredTools, registeredCommands } =
				createMockExtensionApi();
			subagentsModule.default(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent"),
				false,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_interrupt"),
				false,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagents_list"),
				true,
			);
			assert.equal(
				registeredTools.some(
					(tool) => tool.name === "subagents_write_task_models",
				),
				false,
			);
			assert.equal(
				registeredCommands.some((command) => command.name === "subagents-init"),
				false,
			);
		} finally {
			delete process.env.PI_SUBAGENT_ID;
			delete process.env.PI_DENY_TOOLS;
		}
	});

	it("expands spawning false to deny subagent interruption", () => {
		const testApi = subagentsModule.__test__;
		const denied = testApi.resolveDenyTools({ spawning: false });

		assert.equal(denied.has("subagent"), true);
		assert.equal(denied.has("subagent_interrupt"), true);
		assert.equal(denied.has("subagent_resume"), true);
		assert.equal(denied.has("subagents_write_task_models"), true);
	});

	it("exposes a nullable worktree with branch and optional base", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);

		const subagentTool = registeredTools.find(
			(tool) => tool.name === "subagent",
		);
		const worktreeSchema = subagentTool.parameters.properties.worktree;
		const [objectSchema, nullSchema] = worktreeSchema.anyOf;

		assert.deepEqual(objectSchema.required, ["branch"]);
		assert.equal(objectSchema.properties.branch.minLength, 1);
		assert.equal(objectSchema.properties.base.type, "string");
		assert.equal(nullSchema.type, "null");
		assert.match(worktreeSchema.description, /omit or pass null/i);
		assert.match(subagentTool.description, /retain.*parent review/i);
	});

	it("describes the complete ordinary-review taxonomy in the model parameter", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);
		const subagentTool = registeredTools.find(
			(tool) => tool.name === "subagent",
		);
		const modelDesc = (
			subagentTool.parameters.properties.model.description ?? ""
		)
			.replace(/\s+/g, " ")
			.trim();
		for (const clause of [
			"For ordinary review, prefer a different authenticated model family.",
			"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
			"Disclose that this review is context-isolated, not cross-family independent.",
			"Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.",
		])
			assert.ok(
				modelDesc.includes(clause),
				`model description must include: ${clause}`,
			);
		assert.doesNotMatch(
			modelDesc,
			/when unavailable/i,
			"model description must use the authenticated-family availability gate",
		);
	});

	it("strict surfaces never permit same-family fallback", () => {
		const orchestrateSkill = readFileSync(
			join(getSubagentsPackageRoot(), "skills/orchestrate/SKILL.md"),
			"utf8",
		);
		const adversarialProcedure = readFileSync(
			join(
				getSubagentsPackageRoot(),
				"skills/orchestrate/adversarial-review.md",
			),
			"utf8",
		);
		const adversarialAgent = readFileSync(
			join(getSubagentsPackageRoot(), "agents/adversarial-reviewer.md"),
			"utf8",
		);
		const forbiddenOrdinaryReviewClauses = [
			"For ordinary review, prefer a different authenticated model family.",
			"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
			"Disclose that this review is context-isolated, not cross-family independent.",
			"Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.",
		];
		for (const [label, content] of [
			["skills/orchestrate/SKILL.md", orchestrateSkill],
			["skills/orchestrate/adversarial-review.md", adversarialProcedure],
			["agents/adversarial-reviewer.md", adversarialAgent],
		] as const) {
			assert.doesNotMatch(
				content,
				/same-family[\s\S]{0,100}fallback/i,
				`${label} must not contain same-family fallback language`,
			);
			assert.doesNotMatch(
				content,
				/context-isolated[\s\S]{0,60}review/i,
				`${label} must not describe context-isolated review`,
			);
			assert.match(
				content,
				/different.*family/i,
				`${label} must require different-family review`,
			);
			const compact = content.replace(/\s+/g, " ").trim();
			for (const clause of forbiddenOrdinaryReviewClauses)
				assert.ok(
					!compact.includes(clause),
					`${label} must not contain ordinary-review fallback clause: ${clause}`,
				);
		}
	});

	it("adversarial reviewer agent rejects multiline same-family fallback bypass", () => {
		const agent = readFileSync(
			join(getSubagentsPackageRoot(), "agents/adversarial-reviewer.md"),
			"utf8",
		);
		assert.doesNotMatch(
			agent,
			/ordinary[\s\S]{0,200}same-family[\s\S]{0,200}fallback/i,
			"adversarial reviewer must not contain any ordinary same-family fallback path",
		);
		assert.doesNotMatch(
			agent,
			/[Ww]hen no other.*family[\s\S]{0,200}same-family/,
			"adversarial reviewer must not contain same-family availability gate",
		);
		assert.match(
			agent,
			/no model or tool fallback/,
			"adversarial reviewer must explicitly state no fallback",
		);
	});

	it("warns only when the resolved role is bundled", async () => {
		const testApi = subagentsModule.__test__;
		const worktree = { branch: "review/unneeded-worktree" };

		await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
			for (const [agent, expected] of [
				["scout", /bundled scout role is read-only/i],
				["reviewer", /bundled reviewer role is read-only/i],
				[
					"adversarial-reviewer",
					/bundled adversarial-reviewer coordinates read-only reviewers/i,
				],
			] as const) {
				assert.match(
					testApi.resolveWorktreeLaunchWarning({ agent, worktree }) ?? "",
					expected,
				);
			}

			writeAgentFile(
				projectAgentsDir,
				"reviewer",
				"description: Project-specific reviewer\ntools: read, bash",
			);
			assert.equal(
				testApi.resolveWorktreeLaunchWarning({
					agent: "reviewer",
					worktree,
				}),
				undefined,
			);
		});

		await withIsolatedAgentEnv(
			async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
				const namedRolesDir = join(projectDir, "named-pack", "roles");
				const namelessRolesDir = join(projectDir, "nameless-pack", "roles");
				mkdirSync(namedRolesDir, { recursive: true });
				mkdirSync(namelessRolesDir, { recursive: true });
				writeFileSync(
					join(namedRolesDir, "..", "package.json"),
					JSON.stringify({ name: "@acme/writing-roles" }),
				);
				writeAgentFile(
					namedRolesDir,
					"scout",
					"description: Writing scout\ntools: write",
				);
				writeAgentFile(
					namelessRolesDir,
					"reviewer",
					"description: Writing reviewer\ntools: write",
				);
				writeAgentFile(
					namelessRolesDir,
					"adversarial-reviewer",
					"description: Writing adversarial reviewer\ntools: write",
				);

				const { api } = createMockExtensionApi();
				api.events.on(
					"pi-herdr-subagents:roles:discover:v1",
					(request: { register(path: string): void }) => {
						request.register(namedRolesDir);
						request.register(namelessRolesDir);
					},
				);
				const disabled = { bundled: false };
				for (const agent of ["scout", "reviewer", "adversarial-reviewer"]) {
					assert.equal(
						testApi.resolveWorktreeLaunchWarning(
							{ agent, worktree },
							api,
							disabled,
						),
						undefined,
					);
				}

				writeAgentFile(
					globalAgentsDir,
					"scout",
					"description: Global writing scout\ntools: write",
				);
				writeAgentFile(
					projectAgentsDir,
					"reviewer",
					"description: Project writing reviewer\ntools: write",
				);
				assert.equal(
					testApi.resolveWorktreeLaunchWarning(
						{ agent: "scout", worktree },
						api,
						disabled,
					),
					undefined,
				);
				assert.equal(
					testApi.resolveWorktreeLaunchWarning(
						{ agent: "reviewer", worktree },
						api,
						disabled,
					),
					undefined,
				);
				assert.equal(
					testApi.resolveWorktreeLaunchWarning(
						{ agent: "unknown", worktree },
						api,
						disabled,
					),
					undefined,
				);
				assert.equal(
					testApi.resolveWorktreeLaunchWarning(
						{ agent: "scout" },
						api,
						disabled,
					),
					undefined,
				);
			},
		);
	});

	it("renders partial subagent tool-call args without throwing", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);

		const subagentTool = registeredTools.find(
			(tool) => tool.name === "subagent",
		);
		assert.ok(subagentTool, "expected subagent tool to be registered");

		const theme = {
			fg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		};
		const rendered = subagentTool.renderCall({}, theme);
		const output = rendered.render(80).join("\n");

		assert.match(output, /\(unnamed\)/);
	});

	it("registers subagent_resume with an autoExit override", () => {
		const { api, registeredTools } = createMockExtensionApi();
		subagentsModule.default(api);

		const resumeTool = registeredTools.find(
			(tool) => tool.name === "subagent_resume",
		);
		assert.ok(resumeTool, "expected subagent_resume tool to be registered");

		const autoExitSchema = resumeTool.parameters.properties.autoExit;
		assert.equal(autoExitSchema.type, "boolean");
		assert.match(autoExitSchema.description, /Defaults to true/);
	});
});

describe("subagent parent lifecycle", () => {
	it("preserves active subagents while replacing the parent session", () => {
		for (const reason of ["reload", "new", "resume", "fork"]) {
			const abortController = new AbortController();
			const agents = new Map([
				[
					"child",
					{
						abortController,
						lifecycle: createLifecycle(1_000),
					},
				],
			]);

			cleanupSubagentsForShutdown(reason, agents);

			assert.equal(shouldPreserveSubagentsOnShutdown(reason), true);
			assert.equal(abortController.signal.aborted, false);
			assert.equal(shouldDeliverSubagentCompletion(agents.get("child")!), true);
			assert.equal(agents.size, 1);
		}
	});

	it("aborts and clears active subagents during final shutdown", () => {
		for (const reason of ["quit", undefined]) {
			const abortController = new AbortController();
			const running = { abortController, lifecycle: createLifecycle(1_000) };
			const agents = new Map([["child", running]]);

			cleanupSubagentsForShutdown(reason, agents);

			assert.equal(shouldPreserveSubagentsOnShutdown(reason), false);
			assert.equal(abortController.signal.aborted, true);
			// Delivery is suppressed before the map is cleared so a racing watcher
			// that still holds a reference cannot deliver after shutdown.
			assert.equal(running.lifecycle.delivery, "suppressed");
			assert.equal(shouldDeliverSubagentCompletion(running), false);
			assert.equal(agents.size, 0);
		}
	});

	it("treats lifecycle.delivery as the authoritative completion gate", () => {
		const pending = { lifecycle: createLifecycle(1_000) };
		assert.equal(shouldDeliverSubagentCompletion(pending), true);

		const delivered = {
			lifecycle: { ...createLifecycle(1_000), delivery: "delivered" as const },
		};
		assert.equal(shouldDeliverSubagentCompletion(delivered), false);

		const suppressed = {
			lifecycle: { ...createLifecycle(1_000), delivery: "suppressed" as const },
		};
		assert.equal(shouldDeliverSubagentCompletion(suppressed), false);

		// Pre-lifecycle fixtures without a lifecycle field still default to pending.
		// SAFETY: intentionally simulates legacy data missing the (typed as
		// required) `lifecycle` field; the implementation reads it optionally.
		assert.equal(shouldDeliverSubagentCompletion({} as any), true);
	});

	it("delivers completion through the reloaded extension API", () => {
		const previous = { id: "previous" };
		const current = { id: "current" };

		assert.equal(selectCompletionApi(previous, current), current);
		assert.equal(selectCompletionApi(previous, undefined), previous);
	});
});

describe("subagent activity snapshots", () => {
	function validActivity(overrides: any = {}) {
		return {
			version: 1,
			runningChildId: "child-1",
			createdAt: 1_000,
			updatedAt: 1_000,
			sequence: 1,
			latestEvent: "session_start",
			phase: "starting",
			agentActive: false,
			turnActive: false,
			providerActive: false,
			toolActive: false,
			...overrides,
		};
	}

	it("writes and validates activity files by running child id", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-1");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-1",
				activityFile,
				now: () => 1_000,
			});

			recorder.sessionStart();
			recorder.toolExecutionStart("tool-1", "bash");

			const read = readSubagentActivityFile(activityFile, "child-1");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "active");
			assert.equal(read.activity.activeScope, "tool");
			assert.equal(read.activity.toolName, "bash");

			assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
				ok: false,
				reason: "wrong-id",
			});
		});
	});

	it("records waiting and final done states", () => {
		withTempDir((dir) => {
			let currentNow = 2_000;
			const activityFile = getSubagentActivityFile(dir, "child-2");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-2",
				activityFile,
				now: () => currentNow,
			});

			recorder.sessionStart();
			currentNow = 3_000;
			recorder.agentEndWaiting();
			let read = readSubagentActivityFile(activityFile, "child-2");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "waiting");
			assert.equal(read.activity.waitingSince, 3_000);

			currentNow = 4_000;
			recorder.subagentDone();
			read = readSubagentActivityFile(activityFile, "child-2");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "done");
			assert.equal(read.activity.agentActive, false);
		});
	});

	it("rejects malformed activity fields used by classification and rendering", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, "subagent-activity"), { recursive: true });
			const cases = [
				{ activeSince: "bad" },
				{ waitingSince: "bad" },
				{ activeScope: "database" },
				{ latestEvent: "unknown" },
				{ runningChildId: 42 },
				{ toolActive: "yes" },
				{ toolName: "bad\nname" },
			];

			for (const [index, overrides] of cases.entries()) {
				const activityFile = getSubagentActivityFile(dir, `child-${index}`);
				const activity = validActivity({
					runningChildId: `child-${index}`,
					...overrides,
				});
				writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

				const read = readSubagentActivityFile(activityFile, `child-${index}`);
				if (read.ok) throw new Error("expected an invalid activity read");
				assert.equal(read.reason, "invalid");
			}
		});
	});

	it("does not let tool_result resurrect finished tool activity", () => {
		withTempDir((dir) => {
			let currentNow = 1_000;
			const activityFile = getSubagentActivityFile(dir, "child-3");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-3",
				activityFile,
				now: () => currentNow,
			});

			recorder.sessionStart();
			recorder.agentStart();
			recorder.turnStart(1);
			currentNow = 2_000;
			recorder.toolExecutionStart("tool-1", "bash");
			currentNow = 3_000;
			recorder.toolExecutionEnd("tool-1", "bash");
			currentNow = 4_000;
			recorder.toolResult("tool-1", "bash");

			const read = readSubagentActivityFile(activityFile, "child-3");
			assert.ok(read.ok);
			assert.equal(read.activity.toolActive, false);
			assert.equal(read.activity.activeScope, "turn");
		});
	});

	it("does not mark reload shutdown as the final done snapshot", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-4");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-4",
				activityFile,
				now: () => 1_000,
			});

			recorder.sessionStart();
			recorder.sessionShutdown("reload");

			const read = readSubagentActivityFile(activityFile, "child-4");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "starting");
			assert.equal(read.activity.latestEvent, "session_start");
		});
	});

	it("cancels pending throttled writes on reload shutdown", async () => {
		const dir = createTestDir();
		try {
			await new Promise<void>((resolve) => {
				let currentNow = 1_000;
				const activityFile = getSubagentActivityFile(dir, "child-5");
				const recorder = createSubagentActivityRecorder({
					runningChildId: "child-5",
					activityFile,
					now: () => currentNow,
				});

				recorder.sessionStart();
				currentNow = 1_100;
				recorder.messageUpdate("delta");
				recorder.sessionShutdown("reload");

				setTimeout(() => {
					const read = readSubagentActivityFile(activityFile, "child-5");
					assert.ok(read.ok);
					assert.equal(read.activity.phase, "starting");
					assert.equal(read.activity.latestEvent, "session_start");
					resolve();
				}, 650);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("persistent subagent send", () => {
	const testApi = subagentsModule.__test__;

	it("rejects a follow-up while its dispatched task is logically active", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "active-task.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-active",
				generationId: "generation-active",
			});
			const now = Date.now();
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set("logical-active", {
				id: "logical-active",
				name: "Persistent active",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-active",
				generationId: "generation-active",
				policyHash: policy.policyHash,
				tasksCompleted: 1,
				taskId: "task-1",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			});
			const first = testApi.handleSubagentSend({
				id: "logical-active",
				message: "second",
			});
			const second = testApi.handleSubagentSend({
				id: "logical-active",
				message: "third",
			});
			assert.equal(first.details.outcome, "rejected-busy");
			assert.equal(second.details.outcome, "rejected-busy");
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			testApi.runningSubagents.clear();
		});
	});

	it("marks a dispatched follow-up busy and accepts sends after help", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "dispatch.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-dispatch",
				generationId: "generation-dispatch",
			});
			const now = Date.now();
			testApi.runningSubagents.clear();
			const running = {
				id: "logical-dispatch",
				name: "Persistent dispatch",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-dispatch",
				generationId: "generation-dispatch",
				policyHash: policy.policyHash,
				tasksCompleted: 1,
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting" as const, startedAt: now },
				},
			};
			testApi.runningSubagents.set(running.id, running);
			const dispatched = testApi.handleSubagentSend({
				id: running.id,
				message: "second",
			});
			assert.equal(dispatched.details.outcome, "dispatched");
			assert.equal(
				testApi.runningSubagents.get(running.id)?.taskId,
				dispatched.details.task,
			);
			assert.equal(
				testApi.handleSubagentSend({ id: running.id, message: "third" }).details
					.outcome,
				"rejected-busy",
			);
			appendPersistentTaskEvent(sessionFile, {
				type: "help-request",
				task: dispatched.details.task!,
				generation: running.generationId,
			});
			testApi.deliverPersistentTaskEvent(
				testApi.runningSubagents.get(running.id),
				readPersistentTaskEvents(sessionFile)[0],
				{ sendMessage() {} },
			);
			assert.equal(testApi.runningSubagents.get(running.id)?.taskId, undefined);
			assert.equal(
				testApi.handleSubagentSend({ id: running.id, message: "reply" }).details
					.outcome,
				"dispatched",
			);
			testApi.runningSubagents.clear();
		});
	});

	it("keeps a help-request task active until its steer and ledger append succeed", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "help-delivery.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-help-delivery",
				generationId: "generation-help-delivery",
			});
			const now = Date.now();
			const running: any = {
				id: "logical-help-delivery",
				name: "Persistent help delivery",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-help-delivery",
				generationId: "generation-help-delivery",
				policyHash: policy.policyHash,
				taskId: "task-1",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			};
			const event = appendPersistentTaskEvent(sessionFile, {
				type: "help-request",
				task: "task-1",
				generation: running.generationId,
				message: "Need direction.",
			});
			assert.throws(
				() =>
					testApi.deliverPersistentTaskEvent(running, event, {
						sendMessage() {
							throw new Error("stale API");
						},
					}),
				/stale API/,
			);
			assert.equal(running.taskId, "task-1");
			assert.equal(readPersistentDeliveryLedger(sessionFile).length, 0);

			const messages: any[] = [];
			testApi.deliverPersistentTaskEvent(running, event, {
				sendMessage(message: any) {
					messages.push(message);
				},
			});
			assert.equal(running.taskId, undefined);
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).filter(
					(entry) => entry.outcome === "help-requested",
				).length,
				1,
			);
			assert.equal(messages.length, 1);
		});
	});

	it("records a task delivery only after its result steer succeeds", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "delivery.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-delivery",
				generationId: "generation-delivery",
			});
			const now = Date.now();
			const running: any = {
				id: "logical-delivery",
				name: "Persistent delivery",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-delivery",
				generationId: "generation-delivery",
				policyHash: policy.policyHash,
				taskId: "task-1",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			};
			const event = appendPersistentTaskEvent(sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: running.generationId,
			});
			assert.throws(
				() =>
					testApi.deliverPersistentTaskEvent(running, event, {
						sendMessage() {
							throw new Error("stale API");
						},
					}),
				/stale API/,
			);
			assert.equal(readPersistentDeliveryLedger(sessionFile).length, 0);
			const messages: any[] = [];
			testApi.deliverPersistentTaskEvent(running, event, {
				sendMessage(message: any) {
					messages.push(message);
				},
			});
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).at(-1)?.outcome,
				"delivered",
			);
			assert.equal(messages[0].details.logicalId, running.logicalId);
			assert.equal(messages[0].details.generationId, running.generationId);
			assert.equal(messages[0].details.policyHash, running.policyHash);
		});
	});

	it("drains final task events before sending a persistent crash notice", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "crash-drain.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-crash-drain",
				generationId: "generation-crash-drain",
			});
			const now = Date.now();
			const running: any = {
				id: "logical-crash-drain",
				name: "Persistent crash drain",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-crash-drain",
				generationId: "generation-crash-drain",
				policyHash: policy.policyHash,
				taskId: "task-1",
				observedTaskEvents: 0,
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			};
			appendPersistentTaskEvent(sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: running.generationId,
			});
			const { api, sentMessages } = createMockExtensionApi();
			subagentsModule.default(api);
			testApi.notifyPersistentCrash(running, api);

			assert.equal(
				readPersistentDeliveryLedger(sessionFile).at(-1)?.outcome,
				"delivered",
			);
			assert.equal(sentMessages.length, 2);
			assert.equal(sentMessages[0].message.details.task, "task-1");
			assert.equal(sentMessages[1].message.details.error, "persistent-crash");
			assert.match(sentMessages[1].message.content, /task-1=delivered/);
		});
	});

	it("rejects sends after a stop request", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "stopping.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stopping",
				generationId: "generation-stopping",
			});
			const now = Date.now();
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set("logical-stopping", {
				id: "logical-stopping",
				name: "Persistent stopping",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-stopping",
				generationId: "generation-stopping",
				policyHash: policy.policyHash,
				tasksCompleted: 1,
				stopState: "requested",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			});
			assert.equal(
				testApi.handleSubagentSend({ id: "logical-stopping", message: "nope" })
					.details.outcome,
				"rejected-busy",
			);
			testApi.runningSubagents.clear();
		});
	});

	it("fails closed after an unconfirmed stop without dispatching", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "unconfirmed-stop.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-unconfirmed-stop",
				generationId: "generation-unconfirmed-stop",
			});
			const now = Date.now();
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set("logical-unconfirmed-stop", {
				id: "logical-unconfirmed-stop",
				name: "Persistent unconfirmed stop",
				task: "first",
				surface: "pane",
				startTime: now,
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-unconfirmed-stop",
				generationId: "generation-unconfirmed-stop",
				policyHash: policy.policyHash,
				tasksCompleted: 1,
				stopState: "failed",
				lifecycle: {
					...createLifecycle(now),
					turn: { kind: "waiting", startedAt: now },
				},
			});

			const result = testApi.handleSubagentSend({
				id: "logical-unconfirmed-stop",
				message: "next",
			});

			assert.equal(result.details.outcome, "rejected-busy");
			assert.match(result.details.error!, /unconfirmed-stop state/);
			assert.match(result.details.error!, new RegExp(sessionFile));
			assert.match(result.details.error!, /subagent_stop again/);
			assert.match(result.details.error!, /spawn a new specialist/);
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).some(
					(entry) => entry.outcome === "dispatched",
				),
				false,
			);
			testApi.runningSubagents.clear();
		});
	});

	it("records one busy rejection without creating an inbox", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "persistent.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-1",
				generationId: "generation-1",
			});
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set("logical-1", {
				id: "logical-1",
				name: "Persistent",
				task: "first",
				surface: "pane",
				startTime: Date.now(),
				sessionFile,
				interactive: false,
				runtimePlan: undefined,
				persistent: true,
				logicalId: "logical-1",
				generationId: "generation-1",
				policyHash: policy.policyHash,
				lifecycle: {
					...createLifecycle(Date.now()),
					turn: { kind: "active", startedAt: Date.now(), source: "fallback" },
				},
			});
			const result = testApi.handleSubagentSend({
				id: "logical-1",
				message: "second",
			});
			assert.equal(result.details.outcome, "rejected-busy");
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).filter(
					(entry) => entry.outcome === "rejected-busy",
				).length,
				1,
			);
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			testApi.runningSubagents.clear();
		});
	});
});

describe("type guard aliases", () => {
	it("keeps both object predicate names equivalent", () => {
		assert.equal(isPlainObject({ value: true }), true);
		assert.equal(isRecord({ value: true }), true);
		assert.equal(isPlainObject(null), false);
	});
});

describe("persistent subagent stop", () => {
	const testApi = subagentsModule.__test__;

	function persistentFixture(
		sessionFile: string,
		policyHash: string,
		active = false,
	) {
		const now = Date.now();
		return {
			id: "logical-stop",
			name: "Persistent stop",
			task: "first",
			surface: "pane",
			startTime: now,
			sessionFile,
			interactive: false,
			runtimePlan: undefined,
			persistent: true,
			logicalId: "logical-stop",
			generationId: "generation-stop",
			policyHash,
			taskId: "task-1",
			inboxSequence: 0,
			lifecycle: {
				...createLifecycle(now),
				process: { kind: "running" as const, startedAt: now, confirmedAt: now },
				turn: active
					? {
							kind: "active" as const,
							startedAt: now,
							source: "fallback" as const,
						}
					: { kind: "waiting" as const, startedAt: now },
			},
		};
	}

	it("records stop-pending for an active task and never abandons it", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "stop-pending.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			testApi.runningSubagents.set(
				"logical-stop",
				persistentFixture(sessionFile, policy.policyHash, true),
			);
			const result = testApi.handleSubagentStop(
				{ id: "logical-stop" },
				{ sendMessage() {} },
				60_000,
			);
			assert.equal(result.details.status, "stop_pending");
			assert.equal(
				testApi.runningSubagents.get("logical-stop")?.taskId,
				"task-1",
			);
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).at(-1)?.outcome,
				"stop-pending",
			);
			testApi.runningSubagents.clear();
		});
	});

	it("starts the stop timeout after its active task settles", async () => {
		const dir = createTestDir();
		try {
			const sessionFile = join(dir, "delayed-stop.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			const running = persistentFixture(sessionFile, policy.policyHash, true);
			testApi.runningSubagents.set(running.id, running);
			const messages: any[] = [];
			const api = {
				sendMessage(message: any) {
					messages.push(message);
				},
			};
			testApi.handleSubagentStop({ id: running.id }, api, 0);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(running.stopState, "pending");
			const event = appendPersistentTaskEvent(sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: running.generationId!,
			});
			testApi.deliverPersistentTaskEvent(running, event, api);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(running.stopState, "failed");
			assert.equal(
				messages.filter((message) =>
					/exit was not confirmed/.test(message.content),
				).length,
				1,
			);
		} finally {
			testApi.runningSubagents.clear();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rearms a bounded stop timeout after a prior timeout fails", async () => {
		const dir = createTestDir();
		try {
			const sessionFile = join(dir, "retry-stop-timeout.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			const running = persistentFixture(sessionFile, policy.policyHash);
			running.taskId = undefined;
			running.tasksCompleted = 1;
			testApi.runningSubagents.set(running.id, running);
			const messages: any[] = [];
			const api = {
				sendMessage(message: any) {
					messages.push(message);
				},
			};

			testApi.handleSubagentStop({ id: running.id }, api, 0);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(running.stopState, "failed");
			assert.equal(running.stopTimeout, undefined);

			testApi.handleSubagentStop({ id: running.id }, api, 0);
			assert.equal(running.stopState, "requested");
			assert.ok(running.stopTimeout);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(running.stopState, "failed");
			assert.equal(running.stopTimeout, undefined);
			assert.equal(messages.length, 2);
		} finally {
			testApi.runningSubagents.clear();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries a failed stop after an active task settles", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "retry-active-stop.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			const running = persistentFixture(sessionFile, policy.policyHash, true);
			running.stopState = "failed";
			testApi.runningSubagents.set(running.id, running);

			const result = testApi.handleSubagentStop(
				{ id: running.id },
				{ sendMessage() {} },
				60_000,
			);

			assert.equal(result.details.status, "stop_pending");
			assert.equal(running.stopState, "pending");
			assert.equal(running.stopTimeout, undefined);
			assert.equal(
				readPersistentDeliveryLedger(sessionFile).at(-1)?.outcome,
				"stop-pending",
			);
			const event = appendPersistentTaskEvent(sessionFile, {
				type: "task-done",
				task: "task-1",
				generation: running.generationId!,
			});
			testApi.deliverPersistentTaskEvent(running, event, { sendMessage() {} });
			assert.ok(running.stopTimeout);
			clearTimeout(running.stopTimeout);
			running.stopTimeout = undefined;
			testApi.runningSubagents.clear();
		});
	});

	it("projects an unconfirmed stop as stalled instead of idle", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "failed-stop-state.jsonl");
			const policy = writeSubagentSessionPolicy(sessionFile, {
				owner: "public",
				tools: ["read"],
				deniedTools: [],
				persistent: true,
				logicalId: "logical-stop",
				generationId: "generation-stop",
			});
			testApi.runningSubagents.clear();
			const running = persistentFixture(sessionFile, policy.policyHash);
			running.taskId = undefined;
			running.tasksCompleted = 1;
			running.stopState = "failed";
			testApi.runningSubagents.set(running.id, running);
			assert.equal(testApi.persistentSpecialistState(running), "stalled");
			assert.match(
				testApi.formatLivePersistentSpecialists().join("\n"),
				/Persistent stop .*\| stalled \|/,
			);
			testApi.runningSubagents.clear();
		});
	});

	it("fails closed when bounded stop exit confirmation is unavailable", async () => {
		await new Promise<void>((resolve, reject) =>
			withTempDir((dir) => {
				const sessionFile = join(dir, "stop-timeout.jsonl");
				const policy = writeSubagentSessionPolicy(sessionFile, {
					owner: "public",
					tools: ["read"],
					deniedTools: [],
					persistent: true,
					logicalId: "logical-stop",
					generationId: "generation-stop",
				});
				const messages: any[] = [];
				testApi.runningSubagents.clear();
				const running = persistentFixture(sessionFile, policy.policyHash);
				running.taskId = undefined;
				testApi.runningSubagents.set("logical-stop", running);
				testApi.handleSubagentStop(
					{ id: "logical-stop" },
					{
						sendMessage(message: any) {
							messages.push(message);
						},
					},
					0,
				);
				setTimeout(() => {
					try {
						assert.equal(
							testApi.runningSubagents.get("logical-stop")?.stopState,
							"failed",
						);
						assert.equal(messages.length, 1);
						assert.match(messages[0].content, /exit was not confirmed/);
						resolve();
					} catch (error) {
						reject(error);
					} finally {
						testApi.runningSubagents.clear();
					}
				}, 5);
			}),
		);
	});

	it("rejects a persistent spawn at the cap before resource creation", () => {
		testApi.runningSubagents.clear();
		try {
			for (let index = 0; index < 3; index++) {
				const fixture = persistentFixture(`session-${index}`, "a".repeat(64));
				fixture.taskId = undefined;
				testApi.runningSubagents.set(`logical-${index}`, {
					...fixture,
					id: `logical-${index}`,
					name: `Specialist ${index}`,
					tasksCompleted: index,
				});
			}
			assert.match(
				testApi.persistentCapacityError({ maxAgents: 3 }),
				/Specialist 0 \(idle, 0 completed\)/,
			);
		} finally {
			testApi.runningSubagents.clear();
		}
	});

	it("recognizes only explicit child stop directives", () => {
		assert.equal(
			isPersistentStopDirective({
				version: 1,
				type: "stop",
				task: "stop",
				message: "",
				at: "now",
			}),
			true,
		);
		assert.equal(
			isPersistentStopDirective({
				version: 1,
				task: "task",
				message: "next",
				at: "now",
			}),
			false,
		);
	});
});

describe("subagent interruption", () => {
	interface RunningFixtureOverrides {
		id?: string;
		name?: string;
		surface?: string;
		sessionFile?: string;
		lifecycle?: SubagentLifecycle;
		activityFile?: string;
		abortController?: Pick<AbortController, "abort">;
	}

	function makeRunning(overrides: RunningFixtureOverrides = {}) {
		return {
			id: "a1",
			name: "Worker",
			task: "",
			surface: "pane-1",
			startTime: 0,
			sessionFile: "worker.jsonl",
			interactive: false,
			lifecycle: createLifecycle(0),
			...overrides,
		};
	}

	it("registers subagent_interrupt in the main session extension", () => {
		const { api, registeredTools } = createMockExtensionApi();

		subagentsModule.default(api);

		assert.equal(
			registeredTools.some((tool) => tool.name === "subagent_interrupt"),
			true,
		);
	});

	it("resolves interrupt targets by exact id and reports name ambiguity", () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		runningMap.clear();

		try {
			runningMap.set(
				"a1",
				makeRunning({
					id: "a1",
					name: "Worker",
					surface: "a1",
					sessionFile: "a1.jsonl",
				}),
			);
			runningMap.set(
				"b2",
				makeRunning({
					id: "b2",
					name: "Worker",
					surface: "b2",
					sessionFile: "b2.jsonl",
				}),
			);
			runningMap.set(
				"c3",
				makeRunning({
					id: "c3",
					name: "Scout",
					surface: "c3",
					sessionFile: "c3.jsonl",
				}),
			);

			const byId = testApi.resolveInterruptTarget({ id: "c3", name: "Worker" });
			assert.equal(byId.running.id, "c3");

			const ambiguous = testApi.resolveInterruptTarget({ name: "Worker" });
			assert.match(ambiguous.error, /Ambiguous subagent name/);
		} finally {
			runningMap.clear();
		}
	});

	it("returns an explicit error when Escape delivery fails", () => {
		const testApi = subagentsModule.__test__;
		let aborted = false;
		const running = makeRunning({
			abortController: {
				abort() {
					aborted = true;
				},
			},
		});

		const result = testApi.requestSubagentInterrupt(running, () => {
			throw new Error("mux write failed");
		});

		assert.match(result.error, /Failed to send Escape/);
		assert.equal(aborted, false);
		assert.equal("interruptRequested" in running, false);
	});

	it("leaves status unchanged when Escape delivery fails in the tool path", () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		runningMap.clear();

		const activeLifecycle = observeLifecycleActivity(
			createLifecycle(0),
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: "a1",
					createdAt: 0,
					updatedAt: 5_000,
					sequence: 1,
					latestEvent: "tool_execution_start",
					phase: "active",
					agentActive: true,
					turnActive: true,
					providerActive: false,
					toolActive: true,
					activeScope: "tool",
					activeSince: 5_000,
					toolName: "bash",
				},
			},
			5_000,
		);

		try {
			runningMap.set("a1", makeRunning({ lifecycle: activeLifecycle }));

			const result = withMockedNow(20_000, () =>
				testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
					throw new Error("mux write failed");
				}),
			);

			assert.match(result.content[0].text, /Failed to send Escape/);
			assert.equal(
				projectLifecycle(runningMap.get("a1").lifecycle, 20_000).kind,
				"active",
			);
		} finally {
			runningMap.clear();
		}
	});

	it("sends Escape without aborting or mutating running state", () => {
		const testApi = subagentsModule.__test__;
		let aborted = false;
		let sentSurface = "";
		const running = makeRunning({
			abortController: {
				abort() {
					aborted = true;
				},
			},
		});

		const result = testApi.requestSubagentInterrupt(
			running,
			(surface: string) => {
				sentSurface = surface;
			},
		);

		assert.deepEqual(result, { ok: true });
		assert.equal(sentSurface, "pane-1");
		assert.equal(aborted, false);
		assert.equal("interruptRequested" in running, false);
	});

	it("refreshes the latest activity snapshot before forcing local interrupt waiting", () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		let sentSurface = "";
		runningMap.clear();

		withTempDir((dir) => {
			mkdirSync(join(dir, "subagent-activity"), { recursive: true });
			const activityFile = getSubagentActivityFile(dir, "a1");
			const activity = {
				version: 1,
				runningChildId: "a1",
				createdAt: 1_000,
				updatedAt: 19_000,
				sequence: 7,
				latestEvent: "tool_execution_start",
				phase: "active",
				agentActive: true,
				turnActive: true,
				providerActive: false,
				toolActive: true,
				activeScope: "tool",
				activeSince: 19_000,
				toolName: "bash",
			};
			writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

			try {
				runningMap.set("a1", makeRunning({ activityFile }));

				withMockedNow(20_000, () =>
					testApi.handleSubagentInterrupt(
						{ name: "Worker" },
						(surface: string) => {
							sentSurface = surface;
						},
					),
				);

				assert.equal(sentSurface, "pane-1");
				const lifecycle = runningMap.get("a1").lifecycle;
				const projection = projectLifecycle(lifecycle, 20_000);
				assert.equal(projection.kind, "interrupted");
				assert.equal(lifecycle.turn.kind, "interrupted");
				assert.equal(lifecycle.lastActivitySequence, 7);
				assert.equal(lifecycle.turn.previousActivitySequence, 7);
			} finally {
				runningMap.clear();
			}
		});
	});

	it("acknowledges Pi-backed interrupt requests and forces local status waiting", () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		let sentSurface = "";
		runningMap.clear();

		const activeLifecycle = observeLifecycleActivity(
			createLifecycle(0),
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: "a1",
					createdAt: 0,
					updatedAt: 5_000,
					sequence: 1,
					latestEvent: "tool_execution_start",
					phase: "active",
					agentActive: true,
					turnActive: true,
					providerActive: false,
					toolActive: true,
					activeScope: "tool",
					activeSince: 5_000,
					toolName: "bash",
				},
			},
			5_000,
		);

		try {
			runningMap.set("a1", makeRunning({ lifecycle: activeLifecycle }));

			const result = withMockedNow(20_000, () =>
				testApi.handleSubagentInterrupt(
					{ name: "Worker" },
					(surface: string) => {
						sentSurface = surface;
					},
				),
			);

			assert.equal(sentSurface, "pane-1");
			assert.equal(
				result.content[0].text,
				'Interrupt requested for subagent "Worker".',
			);
			assert.deepEqual(result.details, {
				id: "a1",
				name: "Worker",
				status: "interrupt_requested",
			});
			const projection = projectLifecycle(
				runningMap.get("a1").lifecycle,
				20_000,
			);
			assert.equal(projection.kind, "interrupted");
			assert.equal(runningMap.has("a1"), true);
		} finally {
			runningMap.clear();
		}
	});

	it("sends Escape again for repeated interrupt requests", () => {
		const testApi = subagentsModule.__test__;
		const runningMap = testApi.runningSubagents;
		const surfaces: string[] = [];
		runningMap.clear();

		try {
			runningMap.set("a1", makeRunning());

			testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
				surfaces.push(surface);
			});
			testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
				surfaces.push(surface);
			});

			assert.deepEqual(surfaces, ["pane-1", "pane-1"]);
			assert.equal(runningMap.has("a1"), true);
		} finally {
			runningMap.clear();
		}
	});

	it("formats exit code 130 as an ordinary failure", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 130,
				elapsed: 61,
				summary: "Sub-agent exited with code 130",
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Worker",
		);

		assert.match(presentation, /failed \(exit code 130\)/);
		assert.doesNotMatch(presentation, /interrupted/);
		assert.match(presentation, /Resume: pi --session/);
	});

	it("renders a clear provider/agent error when errorMessage is set", () => {
		// Previously, an overload retry-exhaustion produced exitCode 0 with a
		// stale summary — the orchestrator thought the subagent finished
		// quickly. With the error sidecar plumbed through, the presentation
		// must call out the failure, include the underlying error, and tell the
		// orchestrator how to recover.
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 14,
				summary: "ignored when errorMessage is present",
				sessionFile: "/tmp/subagent.jsonl",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			},
			"Worker",
		);

		assert.match(presentation, /Sub-agent "Worker" failed/);
		assert.match(presentation, /provider\/agent error/);
		assert.doesNotMatch(presentation, /auto-retry exhausted/);
		assert.match(
			presentation,
			/Error: Anthropic 529 Overloaded after 3 retries/,
		);
		assert.match(presentation, /subagent_resume/);
		assert.match(presentation, /Resume: pi --session/);
		assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
	});

	it("does not advance fallback for a valid negative task result", () => {
		const testApi = subagentsModule.__test__;
		assert.equal(
			testApi.shouldAdvanceToFallback({ errorMessage: undefined }, 1),
			false,
		);
		assert.equal(
			testApi.shouldAdvanceToFallback({ errorMessage: "provider failed" }, 1),
			true,
		);
		assert.equal(
			testApi.shouldAdvanceToFallback({ errorMessage: "provider failed" }, 0),
			false,
		);
		assert.equal(
			testApi.shouldAdvanceToFallback(
				{ errorMessage: "provider failed" },
				1,
				true,
			),
			false,
		);
	});

	it("preserves raw account/model errors and model evidence without retry claims", () => {
		const testApi = subagentsModule.__test__;
		const modelRef = "openai-codex/gpt-5.4";
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 5,
				summary: "ignored",
				sessionFile: "/tmp/subagent.jsonl",
				errorMessage:
					"Codex error: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
				fallbackAttempts: [modelRef],
				runtimePlan: {
					provider: "openai-codex",
					modelId: "gpt-5.4",
					model: modelRef,
					thinking: "medium",
					modelSource: "request",
					thinkingSource: "request",
				},
			},
			"Worker",
		);

		assert.match(presentation, /Requested model: openai-codex\/gpt-5\.4/);
		assert.match(presentation, /Model used: openai-codex\/gpt-5\.4/);
		assert.match(
			presentation,
			/Error: Codex error: The 'gpt-5\.4' model is not supported.*ChatGPT account/,
		);
		assert.match(presentation, /Next action: check the raw provider reason/);
		assert.doesNotMatch(presentation, /auto-retry exhausted|permanent failure/);
	});

	it("reports ordered fallback causes, attempted models, and the model used on success", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 6,
				summary: "Useful result",
				fallbackAttempts: ["fake/primary", "fake/middle", "fake/secondary"],
				fallbackFailures: [
					{ model: "fake/primary", error: "provider rejected fake/primary" },
					{ model: "fake/middle", error: "provider rejected fake/middle" },
				],
				runtimePlan: {
					provider: "fake",
					modelId: "secondary",
					model: "fake/secondary",
					thinking: "medium",
					modelSource: "request",
					thinkingSource: "request",
				},
			},
			"Worker",
		);

		assert.match(presentation, /Requested model: fake\/primary/);
		assert.match(
			presentation,
			/Models attempted: fake\/primary, fake\/middle, fake\/secondary/,
		);
		assert.match(presentation, /Model used: fake\/secondary/);
		assert.match(
			presentation,
			/Model failures .*fake\/primary: provider rejected fake\/primary.*fake\/middle: provider rejected fake\/middle/s,
		);
		assert.doesNotMatch(presentation, /auto-retry exhausted/);
	});

	it("reports every rejected fallback candidate without inventing retry counts", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 7,
				summary: "ignored",
				errorMessage: "provider rejected fake/secondary",
				fallbackAttempts: ["fake/primary", "fake/middle", "fake/secondary"],
				fallbackFailures: [
					{ model: "fake/primary", error: "provider rejected fake/primary" },
					{ model: "fake/middle", error: "provider rejected fake/middle" },
					{
						model: "fake/secondary",
						error: "provider rejected fake/secondary",
					},
				],
				runtimePlan: {
					provider: "fake",
					modelId: "secondary",
					model: "fake/secondary",
					thinking: "medium",
					modelSource: "request",
					thinkingSource: "request",
				},
			},
			"Worker",
		);

		assert.match(
			presentation,
			/Models attempted: fake\/primary, fake\/middle, fake\/secondary/,
		);
		assert.match(presentation, /Model used: fake\/secondary/);
		assert.match(
			presentation,
			/Model failures .*fake\/primary: provider rejected fake\/primary.*fake\/middle: provider rejected fake\/middle.*fake\/secondary: provider rejected fake\/secondary/s,
		);
		assert.doesNotMatch(presentation, /auto-retry exhausted|after \d+ retries/);
	});

	it("leaves small completion presentations unchanged", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: "Useful result",
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Reviewer",
		);

		assert.equal(
			presentation,
			'Sub-agent "Reviewer" completed (5s).\n\nUseful result\n\n' +
				"Session: /tmp/subagent.jsonl\nResume: pi --session /tmp/subagent.jsonl",
		);
	});

	it("includes a reviewable worktree handoff in completion presentations", () => {
		const testApi = subagentsModule.__test__;
		const worktree = {
			path: "/tmp/worktrees/ticket-123",
			workspaceId: "w9",
			paneId: "w9:p1",
			branch: "ticket/123",
			baseSha: "1111111",
			headSha: "2222222",
			commitsAhead: 2,
			clean: false,
			conflicted: false,
			changedFiles: ["src/auth.ts", "test/auth.test.ts"],
			untrackedFiles: ["notes.txt"],
		};

		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: "Implemented ticket 123",
				sessionFile: "/tmp/subagent.jsonl",
				worktree,
			},
			"Worker",
		);

		assert.match(presentation, /Worktree: \/tmp\/worktrees\/ticket-123/);
		assert.match(presentation, /Branch: ticket\/123/);
		assert.match(presentation, /Base\/head: 1111111 -> 2222222/);
		assert.match(presentation, /State: dirty · 2 commits ahead/);
		assert.match(presentation, /Changed: src\/auth\.ts, test\/auth\.test\.ts/);
		assert.match(presentation, /Untracked: notes\.txt/);
		assert.match(
			presentation,
			/After review and preservation, explicitly remove/,
		);
		assert.match(presentation, /herdr worktree remove --workspace w9/);
		assert.match(presentation, /\/worktree remove w9/);
		assert.match(presentation, /worktree_remove/);
		assert.equal(testApi.shouldRetainSubagentSurface({ worktree }), true);
		assert.equal(testApi.shouldRetainSubagentSurface({}), false);
	});

	it("captures committed and uncommitted worktree state for the parent", () => {
		withTempDir((dir) => {
			execFileSync("git", ["init", "-q"], { cwd: dir });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: dir,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: dir,
			});
			writeFileSync(join(dir, "tracked.txt"), "base\n");
			execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: dir,
				encoding: "utf8",
			}).trim();

			writeFileSync(join(dir, "committed.txt"), "committed\n");
			execFileSync("git", ["add", "committed.txt"], { cwd: dir });
			execFileSync("git", ["commit", "-qm", "ticket"], { cwd: dir });
			writeFileSync(join(dir, "tracked.txt"), "dirty\n");
			writeFileSync(join(dir, "untracked.txt"), "new\n");

			const handoff = subagentsModule.__test__.captureWorktreeHandoff({
				path: dir,
				workspaceId: "w9",
				paneId: "w9:p1",
				branch: "ticket/123",
				baseRef: "HEAD",
				baseSha,
				manifestFile: join(dir, "manifest.json"),
			});

			assert.equal(handoff.baseSha, baseSha);
			assert.equal(handoff.commitsAhead, 1);
			assert.equal(handoff.clean, false);
			assert.equal(handoff.conflicted, false);
			assert.deepEqual(handoff.changedFiles, [
				"committed.txt",
				"tracked.txt",
				"untracked.txt",
			]);
			assert.deepEqual(handoff.untrackedFiles, ["untracked.txt"]);
			assert.match(handoff.headSha, /^[0-9a-f]{40}$/);
		});
	});

	it("reports unknown state when worktree Git inspection fails", () => {
		withTempDir((dir) => {
			const worktree = {
				path: join(dir, "missing"),
				workspaceId: "w9",
				paneId: "w9:p1",
				branch: "ticket/123",
				baseRef: "HEAD",
				baseSha: "1111111",
				manifestFile: join(dir, "manifest.json"),
			};
			const testApi = subagentsModule.__test__;
			const handoff = testApi.captureWorktreeHandoff(worktree);

			assert.equal(handoff.headSha, null);
			assert.equal(handoff.commitsAhead, null);
			assert.equal(handoff.clean, null);
			assert.equal(handoff.conflicted, null);
			assert.equal(handoff.changedFiles, null);
			assert.equal(handoff.untrackedFiles, null);
			assert.match(handoff.gitError, /ENOENT|no such file/i);

			const presentation = testApi.resolveResultPresentation(
				{
					exitCode: 1,
					elapsed: 1,
					summary: "Launch failed",
					worktree: handoff,
				},
				"Worker",
			);
			assert.match(
				presentation,
				/State: inspection unknown · commits ahead unknown/,
			);
			assert.match(presentation, /Base\/head: 1111111 -> unknown/);
		});
	});

	it("marks launch failures as failed while retaining explicit ownership", () => {
		withTempDir((dir) => {
			const testApi = subagentsModule.__test__;
			const manifestFile = join(dir, "worktree-run.json");
			const worktree = {
				path: join(dir, "retained-worktree"),
				workspaceId: "w9",
				paneId: "w9:p1",
				branch: "ticket/123",
				baseRef: "HEAD",
				baseSha: "1111111",
				manifestFile,
			};
			testApi.writeWorktreeManifest(manifestFile, {
				state: "provisioning",
				id: "run-1",
			});

			assert.throws(
				() =>
					testApi.runSubagentScript(
						worktree.paneId,
						"pi",
						undefined,
						worktree,
						() => {
							throw new Error("pane rejected command");
						},
					),
				/worktree retained.*pane rejected command/i,
			);

			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.owner, "pi-herdr-subagents");
			assert.equal(manifest.kind, "worktree-run");
			assert.equal(manifest.id, "run-1");
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.path, worktree.path);
			assert.match(manifest.gitError, /ENOENT|no such file/i);
		});
	});

	it("abbreviates large completion presentations while preserving their head, tail, and session path", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: `HEAD-${"h".repeat(9_000)}-MIDDLE-${"t".repeat(9_000)}-TAIL`,
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Reviewer",
		);

		assert.ok(presentation.length <= 16_000);
		assert.match(presentation, /HEAD-/);
		assert.doesNotMatch(presentation, /-MIDDLE-/);
		assert.match(presentation, /-TAIL/);
		assert.match(presentation, /result abbreviated/i);
		assert.match(presentation, /Session: \/tmp\/subagent\.jsonl/);
		assert.match(presentation, /Resume: pi --session \/tmp\/subagent\.jsonl/);
	});

	it("abbreviates oversized provider errors without losing recovery guidance", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 5,
				summary: "ignored",
				sessionFile: "/tmp/subagent.jsonl",
				errorMessage: `ERROR-HEAD-${"x".repeat(18_000)}-ERROR-TAIL`,
			},
			"Reviewer",
		);

		assert.ok(presentation.length <= 16_000);
		assert.match(presentation, /ERROR-HEAD/);
		assert.match(presentation, /ERROR-TAIL/);
		assert.match(presentation, /result abbreviated/i);
		assert.match(presentation, /subagent_resume/);
		assert.match(presentation, /Resume: pi --session \/tmp\/subagent\.jsonl/);
	});

	it("keeps presentations bounded even when a session reference exceeds filesystem limits", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: "Useful result",
				sessionFile: `/tmp/${"x".repeat(20_000)}/subagent.jsonl`,
			},
			"Reviewer",
		);

		assert.ok(presentation.length <= 16_000);
		assert.match(presentation, /session reference abbreviated/i);
	});

	it("bounds unexpected errors from both fresh and resumed delivery paths", () => {
		const testApi = subagentsModule.__test__;
		const error = new Error(`ERROR-HEAD-${"x".repeat(18_000)}-ERROR-TAIL`);

		for (const prefix of ['Sub-agent "Reviewer" error', "Resume error"]) {
			const presentation = testApi.resolveUnexpectedErrorPresentation(
				prefix,
				error,
				"/tmp/subagent.jsonl",
			);

			assert.ok(presentation.length <= 16_000);
			assert.match(presentation, /ERROR-HEAD/);
			assert.match(presentation, /ERROR-TAIL/);
			assert.match(presentation, /Session: \/tmp\/subagent\.jsonl/);
		}
	});

	it("preserves the existing session-before-runtime-warning order for small results", () => {
		const testApi = subagentsModule.__test__;
		const presentation = testApi.resolveResultPresentation(
			{
				exitCode: 0,
				elapsed: 5,
				summary: "Useful result",
				sessionFile: "/tmp/subagent.jsonl",
			},
			"Reviewer",
			"requested model unavailable",
		);

		assert.equal(
			presentation,
			'Sub-agent "Reviewer" completed (5s).\n\nUseful result\n\n' +
				"Session: /tmp/subagent.jsonl\nResume: pi --session /tmp/subagent.jsonl\n\n" +
				"Runtime warning: requested model unavailable",
		);
	});

	it("delivers bounded fresh and resumed results through one custom message", () => {
		const testApi = subagentsModule.__test__;

		for (const name of ["fresh", "resumed"]) {
			const { api, sentMessages, sentUserMessages } = createMockExtensionApi();
			const sessionFile = `/tmp/${name}.jsonl`;
			const details = {
				name,
				sessionFile,
				fallbackAttempts: ["fake/primary", "fake/secondary"],
				errorMessage: "provider failed",
				runtimePlan: { model: "fake/secondary" },
				worktree: { path: "/tmp/worktree" },
			};
			testApi.sendSubagentResult(
				api,
				`HEAD-${"x".repeat(18_000)}-TAIL\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}`,
				details,
			);

			assert.equal(sentMessages.length, 1);
			const delivered = sentMessages[0];
			assert.equal(delivered.message.customType, "subagent_result");
			assert.ok(delivered.message.content.length <= 16_000);
			assert.match(delivered.message.content, /HEAD-/);
			assert.match(delivered.message.content, /-TAIL/);
			assert.match(
				delivered.message.content,
				/Parent action: Continue the parent task using this result/,
			);
			const resultContent = delivered.message.details.resultContent;
			assert.ok(resultContent.length <= 16_000);
			assert.match(resultContent, /HEAD-/);
			assert.match(resultContent, /-TAIL/);
			assert.match(
				resultContent,
				new RegExp(`Session: ${sessionFile.replace(".", "\\.")}`),
			);
			assert.doesNotMatch(resultContent, /Parent action:/);
			assert.deepEqual(delivered.message.details, {
				...details,
				resultContent,
			});
			assert.deepEqual(delivered.options, {
				triggerTurn: true,
				deliverAs: "steer",
			});
			assert.equal(sentUserMessages.length, 0);
		}
	});
});

describe("subagent status renderer", () => {
	function createTheme() {
		return {
			fg(_color: string, text: string) {
				return text;
			},
			bg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		};
	}

	it("keeps recovery session details in expanded unexpected-error results", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);

		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_result",
		);
		assert.ok(
			rendererEntry,
			"expected subagent_result renderer to be registered",
		);

		const rendered = rendererEntry
			.renderer(
				{
					customType: "subagent_result",
					content:
						'Sub-agent "Reviewer" error: failed\n\nSession: /tmp/subagent.jsonl\n' +
						"Resume: pi --session /tmp/subagent.jsonl",
					details: {
						name: "Reviewer",
						error: "failed",
						sessionFile: "/tmp/subagent.jsonl",
					},
				},
				{ expanded: true },
				createTheme(),
			)
			.render(120)
			.join("\n");

		assert.match(rendered, /Session: \/tmp\/subagent\.jsonl/);
		assert.match(rendered, /Resume:\s+pi --session \/tmp\/subagent\.jsonl/);
	});

	it("recognizes the neutral provider error header when rendering expanded results", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);
		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_result",
		);
		assert.ok(rendererEntry);

		const rendered = rendererEntry
			.renderer(
				{
					customType: "subagent_result",
					content:
						'Sub-agent "Worker" failed after 5s (provider/agent error).\n\n' +
						"Error: account/model rejected\n\n" +
						"Requested model: openai-codex/gpt-5.4\n" +
						"Model used: openai-codex/gpt-5.4",
					details: {
						name: "Worker",
						exitCode: 1,
						errorMessage: "account/model rejected",
						resultContent:
							'Sub-agent "Worker" failed after 5s (provider/agent error).\n\n' +
							"Error: account/model rejected\n\n" +
							"Requested model: openai-codex/gpt-5.4\n" +
							"Model used: openai-codex/gpt-5.4",
					},
				},
				{ expanded: true },
				createTheme(),
			)
			.render(120)
			.join("\n");

		assert.match(rendered, /account\/model rejected/);
		assert.match(rendered, /Requested model: openai-codex\/gpt-5\.4/);
		assert.doesNotMatch(rendered, /auto-retry exhausted/);
	});

	it("renders result details while keeping the custom message context small", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);

		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_result",
		);
		assert.ok(
			rendererEntry,
			"expected subagent_result renderer to be registered",
		);

		const rendered = rendererEntry
			.renderer(
				{
					customType: "subagent_result",
					content:
						'Sub-agent "Reviewer" completed (1s).\n\nDECISIVE_RESULT\n\n' +
						"Parent action: Continue the parent task using this result.",
					details: {
						name: "Reviewer",
						elapsed: 1,
						resultContent:
							'Sub-agent "Reviewer" completed (1s).\n\nDECISIVE_RESULT',
					},
				},
				{ expanded: true },
				createTheme(),
			)
			.render(120)
			.join("\n");

		assert.match(rendered, /DECISIVE_RESULT/);
		assert.doesNotMatch(rendered, /Parent action:/);
	});

	it("renders only capped lines plus overflow", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);

		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_status",
		);
		assert.ok(
			rendererEntry,
			"expected subagent_status renderer to be registered",
		);

		const visibleLines = [
			"Worker running 5m, active (bash 2m).",
			"Scout running 3m, waiting 1m.",
			"Reviewer running 2m, active (streaming 30s).",
			"Planner running 4m, waiting 2m.",
		];
		const rendered = rendererEntry.renderer(
			{
				customType: "subagent_status",
				content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
				details: {
					lines: visibleLines,
					overflow: 2,
				},
			},
			{ expanded: true },
			createTheme(),
		);
		const output = rendered.render(80).join("\n");

		assert.match(output, /Subagent status/);
		for (const line of visibleLines) {
			assert.match(
				output,
				new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
		}
		assert.match(output, /\+2 more running\./);
	});

	it("stays within narrow widths", () => {
		const { api, registeredMessageRenderers } = createMockExtensionApi();
		subagentsModule.default(api);

		const rendererEntry = registeredMessageRenderers.find(
			(entry) => entry.name === "subagent_status",
		);
		assert.ok(
			rendererEntry,
			"expected subagent_status renderer to be registered",
		);

		const rendered = rendererEntry.renderer(
			{
				customType: "subagent_status",
				content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
				details: {
					lines: ["Worker running 5m, active (bash 2m)."],
					overflow: 0,
				},
			},
			{ expanded: true },
			createTheme(),
		);

		for (const width of [4, 5, 6]) {
			for (const line of rendered.render(width)) {
				assert.ok(
					visibleWidth(line) <= width,
					`expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
				);
			}
		}
	});
});

describe("subagents widget rendering", () => {
	it("shows interrupted agents as open while process runtime continues", () => {
		const testApi = subagentsModule.__test__;
		const interruptedAt = 20_000;
		const lifecycle = markInterruptRequested(
			{
				...createLifecycle(5_000),
				process: { kind: "running", startedAt: 5_000, confirmedAt: 5_000 },
			},
			interruptedAt,
		);

		const originalNow = Date.now;
		Date.now = () => 30_000;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Worker",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						lifecycle,
						interactive: false,
					},
				],
				64,
			);

			assert.match(lines[0], /1 open/);
			assert.ok(lines[0].includes("\x1b[38;2;214;158;46m"));
			assert.match(lines[1], /00:25\s+Worker/);
			assert.match(lines[1], /interrupted 10s/);
			assert.doesNotMatch(lines.join("\n"), /running|active/);
		} finally {
			Date.now = originalNow;
		}
	});

	it("hydrates legacy activity done as waiting, not finalizing", () => {
		const testApi = subagentsModule.__test__;
		const doneAt = 20_000;
		const legacyDone = observeStatus(
			createStatusState({ startTimeMs: 5_000 }),
			{
				snapshot: "present",
				updatedAt: doneAt,
				sequence: 1,
				phase: "done",
				latestEvent: "subagent_done",
			},
			doneAt,
		);
		const originalNow = Date.now;
		Date.now = () => 30_000;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "legacy",
						name: "Legacy",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						statusState: legacyDone,
						interactive: false,
					},
				],
				64,
			);
			assert.match(lines[1], /waiting/);
			assert.doesNotMatch(lines[1], /finalizing/);
		} finally {
			Date.now = originalNow;
		}
	});

	it("freezes runtime when the subagent reports done", () => {
		const testApi = subagentsModule.__test__;
		const doneAt = 20_000;
		const lifecycle = markCompletionDetected(
			createLifecycle(5_000),
			{ reason: "done", exitCode: 0 },
			doneAt,
		);

		const originalNow = Date.now;
		Date.now = () => 30_000;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Reviewer",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "sess1",
						lifecycle,
						interactive: false,
					},
				],
				64,
			);

			assert.match(lines[0], /1 open/);
			assert.match(lines[1], /00:15\s+Reviewer/);
			assert.match(lines[1], /finalizing…/);
			assert.doesNotMatch(lines[1], /00:25/);
		} finally {
			Date.now = originalNow;
		}
	});

	it("keeps a blue border and summarizes mixed active and open agents", () => {
		const testApi = subagentsModule.__test__;
		const now = 30_000;
		const active = observeLifecycleActivity(
			createLifecycle(5_000),
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: "a1",
					createdAt: 5_000,
					updatedAt: 29_000,
					sequence: 1,
					latestEvent: "agent_start",
					phase: "active",
					agentActive: true,
					turnActive: true,
					providerActive: false,
					toolActive: false,
					activeScope: "agent",
					activeSince: 29_000,
				},
			},
			29_000,
		);
		const interrupted = markInterruptRequested(
			{
				...createLifecycle(10_000),
				process: { kind: "running", startedAt: 10_000, confirmedAt: 10_000 },
			},
			20_000,
		);

		const originalNow = Date.now;
		Date.now = () => now;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "Active",
						task: "",
						surface: "s1",
						startTime: 5_000,
						sessionFile: "s1",
						lifecycle: active,
						interactive: false,
					},
					{
						id: "a2",
						name: "Open",
						task: "",
						surface: "s2",
						startTime: 10_000,
						sessionFile: "s2",
						lifecycle: interrupted,
						interactive: false,
					},
				],
				72,
			);

			assert.match(lines[0], /1 active · 1 open/);
			assert.ok(lines[0].includes("\x1b[38;2;77;163;255m"));
		} finally {
			Date.now = originalNow;
		}
	});

	it("keeps every rendered line within a very narrow width", () => {
		const testApi = subagentsModule.__test__;
		assert.ok(testApi, "expected subagents test helpers to be exported");
		assert.ok(testApi.renderSubagentWidgetLines instanceof Function);

		const originalNow = Date.now;
		Date.now = () => 1_000_000;
		try {
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "A",
						task: "",
						surface: "s1",
						startTime: 1_000_000 - 13_000,
						sessionFile: "sess1",
						lifecycle: createLifecycle(1_000_000 - 13_000),
					},
					{
						id: "a2",
						name: "B",
						task: "",
						surface: "s2",
						startTime: 1_000_000 - 21_000,
						sessionFile: "sess2",
						lifecycle: createLifecycle(1_000_000 - 21_000),
					},
					{
						id: "a3",
						name: "C",
						task: "",
						surface: "s3",
						startTime: 1_000_000 - 27_000,
						sessionFile: "sess3",
						lifecycle: createLifecycle(1_000_000 - 27_000),
					},
				],
				16,
			);

			assert.deepEqual(
				lines.map((line: string) => visibleWidth(line)),
				[16, 16, 16, 16, 16],
			);
		} finally {
			Date.now = originalNow;
		}
	});

	it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
		const testApi = subagentsModule.__test__;
		assert.ok(testApi, "expected subagents test helpers to be exported");
		assert.ok(testApi.borderLine instanceof Function);

		const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
		assert.equal(visibleWidth(line), 16);
	});

	it("handles ultra-narrow widths without exceeding the width contract", () => {
		const testApi = subagentsModule.__test__;
		assert.ok(testApi, "expected subagents test helpers to be exported");
		assert.ok(testApi.renderSubagentWidgetLines instanceof Function);

		const widths = [0, 1, 2];
		for (const width of widths) {
			const startTime = Date.now() - 5_000;
			const lines = testApi.renderSubagentWidgetLines(
				[
					{
						id: "a1",
						name: "A",
						task: "",
						surface: "s1",
						startTime,
						sessionFile: "sess1",
						lifecycle: createLifecycle(startTime),
					},
				],
				width,
			);

			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
				);
			}
		}
	});
});

describe("herdr.ts", () => {
	it("captures failed CLI stderr without leaking it to the parent terminal", () => {
		const dir = createTestDir();
		try {
			writeFileSync(
				join(dir, "herdr"),
				'#!/bin/sh\nprintf \'{"error":{"code":"server_not_running"}}\\n\' >&2\nexit 1\n',
				{ mode: 0o755 },
			);
			const moduleUrl = new URL(
				"../pi-extension/subagents/herdr.ts",
				import.meta.url,
			).href;
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"-e",
					`
				import { listHerdrWorktrees } from ${JSON.stringify(moduleUrl)};
				try {
					listHerdrWorktrees();
					process.exitCode = 2;
				} catch (error) {
					if (error.status !== 1 || !String(error.stderr).includes("server_not_running")) throw error;
				}
			`,
				],
				{
					encoding: "utf8",
					env: { ...process.env, PATH: dir, NODE_NO_WARNINGS: "1" },
				},
			);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stderr, "");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	describe("isHerdrAvailable", () => {
		it("returns boolean based on HERDR_ENV", () => {
			const result = isHerdrAvailable();
			assert.ok(result === true || result === false);
		});
	});

	describe("herdr command construction", () => {
		it("parses worktree list results", () => {
			assert.deepEqual(
				__herdrTest__.parseHerdrWorktreeList(
					JSON.stringify({
						result: {
							type: "worktree_list",
							worktrees: [
								{
									branch: "main",
									path: "/repo",
									is_linked_worktree: false,
								},
								{
									branch: "feature/auth",
									path: "/tmp/auth",
									label: "Auth",
									open_workspace_id: "w9",
									is_linked_worktree: true,
								},
							],
						},
					}),
				),
				[
					{ branch: "main", path: "/repo", isLinkedWorktree: false },
					{
						branch: "feature/auth",
						path: "/tmp/auth",
						label: "Auth",
						workspaceId: "w9",
						isLinkedWorktree: true,
					},
				],
			);
		});

		it("accepts detached entries without a branch but rejects malformed identities", () => {
			const parse = (
				row: {
					path?: string | number | null;
					branch?: string | number | null;
					is_detached?: boolean | string;
					is_linked_worktree?: boolean;
				} | null,
			) =>
				__herdrTest__.parseHerdrWorktreeList(
					JSON.stringify({
						result: { type: "worktree_list", worktrees: [row] },
					}),
				);
			assert.deepEqual(
				parse({
					path: "/detached",
					is_detached: true,
					is_linked_worktree: true,
				}),
				[{ branch: "", path: "/detached", isLinkedWorktree: true }],
			);
			for (const row of [
				null,
				{ path: "/missing-branch" },
				{ path: "/wrong-flag", is_detached: "true" },
				{ path: "/wrong-branch", branch: 42, is_detached: true },
				{ path: "/null-branch", branch: null, is_detached: true },
				{ path: 42, is_detached: true },
				{ branch: "main", path: null },
			])
				assert.throws(() => parse(row), /Unexpected herdr worktree list entry/);
		});

		it("accepts only complete, unique pane snapshots", () => {
			const snapshot = (
				panes: Array<{ pane_id?: string; workspace_id?: string } | null>,
			) => JSON.stringify({ result: { type: "pane_list", panes } });
			assert.deepEqual(__herdrTest__.parseHerdrPaneSnapshot(snapshot([])), []);
			assert.equal(__herdrTest__.parseHerdrPaneSnapshot('{"result":{}}'), null);
			assert.equal(
				__herdrTest__.parseHerdrPaneSnapshot(
					snapshot([
						{ pane_id: "p1", workspace_id: "w1" },
						{ pane_id: "p1", workspace_id: "w1" },
					]),
				),
				null,
			);
			assert.equal(
				__herdrTest__.parseHerdrPaneSnapshot(snapshot([{ pane_id: "p1" }])),
				null,
			);
			assert.equal(
				__herdrTest__.parseHerdrPaneSnapshot(snapshot([null, {}])),
				null,
			);
		});

		it("parses the recovered root pane for a worktree workspace", () => {
			assert.deepEqual(
				__herdrTest__.parseHerdrPaneList(
					JSON.stringify({
						result: {
							type: "pane_list",
							panes: [
								{ pane_id: "w9:p1", workspace_id: "w9" },
								{ pane_id: "other:p1", workspace_id: "other" },
							],
						},
					}),
					"w9",
				),
				["w9:p1"],
			);
		});

		it("uses caller context when discovering the current pane", () => {
			assert.deepEqual(__herdrTest__.buildCurrentPaneArgs(), [
				"pane",
				"current",
				"--current",
			]);
		});

		it("targets an explicit stable parent when splitting without focus", () => {
			assert.deepEqual(
				__herdrTest__.buildPaneSplitArgs("parent-pane", "down", "/repo"),
				[
					"pane",
					"split",
					"parent-pane",
					"--direction",
					"down",
					"--no-focus",
					"--cwd",
					"/repo",
				],
			);
		});

		it("targets the current workspace when creating a subagent tab", () => {
			assert.deepEqual(
				__herdrTest__.buildTabCreateArgs("reviewer", "/repo", "workspace-2"),
				[
					"tab",
					"create",
					"--workspace",
					"workspace-2",
					"--label",
					"reviewer",
					"--cwd",
					"/repo",
					"--no-focus",
				],
			);
		});

		it("creates a background worktree from an exact base commit", () => {
			assert.deepEqual(
				__herdrTest__.buildWorktreeCreateArgs(
					"Ticket 123",
					"/repo",
					"ticket/123",
					"abc123",
				),
				[
					"worktree",
					"create",
					"--cwd",
					"/repo",
					"--branch",
					"ticket/123",
					"--base",
					"abc123",
					"--label",
					"Ticket 123",
					"--no-focus",
				],
			);
		});
	});

	describe("herdr response parsing", () => {
		it("extracts pane id from a pane split response", () => {
			const output = JSON.stringify({
				result: {
					pane: {
						pane_id: "1-3",
						tab_id: "1:2",
						workspace_id: "1",
					},
				},
			});
			assert.equal(
				__herdrTest__.extractHerdrPaneId(output, "pane split"),
				"1-3",
			);
		});

		it("extracts root pane id from a tab create response", () => {
			const output = JSON.stringify({
				result: {
					tab: { tab_id: "1:2" },
					root_pane: { pane_id: "1-2" },
				},
			});
			assert.equal(
				__herdrTest__.extractHerdrRootPaneId(output, "tab create"),
				"1-2",
			);
		});

		it("extracts the worktree and root surface from a worktree create response", () => {
			const output = JSON.stringify({
				result: {
					type: "worktree_created",
					workspace: { workspace_id: "w9" },
					root_pane: { pane_id: "w9:p1" },
					worktree: {
						path: "/tmp/worktrees/ticket-123",
						branch: "ticket/123",
						label: "Ticket 123",
						is_bare: false,
						is_detached: false,
						is_linked_worktree: true,
						is_prunable: false,
						open_workspace_id: "w9",
					},
				},
			});

			assert.deepEqual(__herdrTest__.extractHerdrWorktree(output), {
				path: "/tmp/worktrees/ticket-123",
				branch: "ticket/123",
				workspaceId: "w9",
				paneId: "w9:p1",
			});
		});

		it("throws on malformed herdr JSON", () => {
			assert.throws(
				() => __herdrTest__.extractHerdrPaneId("not json", "pane split"),
				/Unexpected herdr pane split output/,
			);
		});

		it("parses pane-not-found JSON from stderr-shaped errors", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: JSON.stringify({
					error: { code: "pane_not_found", message: "pane gone" },
				}),
				stdout: "",
			});
			assert.deepEqual(result, { kind: "missing", error: "pane gone" });
		});

		it("continues from non-JSON stderr to structured stdout", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "warning: connection closed",
				stdout: JSON.stringify({
					error: { code: "pane_not_found", message: "pane gone" },
				}),
			});
			assert.deepEqual(result, { kind: "missing", error: "pane gone" });
		});

		it("returns unavailable when both error streams are non-JSON", () => {
			const result = __herdrTest__.parsePaneGetError({
				message: "command failed",
				stderr: "warning: connection closed",
				stdout: "not json either",
			});
			assert.deepEqual(result, {
				kind: "unavailable",
				error: "command failed",
			});
		});

		it("recognizes plain-text pane_not_found on stderr", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "pane_not_found: pane w1:p1 not found",
				stdout: "unrelated output",
			});
			assert.deepEqual(result, {
				kind: "missing",
				error: "pane_not_found: pane w1:p1 not found",
			});
		});

		it("recognizes plain-text not_found on stdout after malformed stderr", () => {
			const result = __herdrTest__.parsePaneGetError({
				stderr: "{malformed json",
				stdout: "not_found: pane w1:p1",
			});
			assert.deepEqual(result, {
				kind: "missing",
				error: "not_found: pane w1:p1",
			});
		});

		it("normalizes unknown agent_status values", () => {
			const result = __herdrTest__.parsePaneGetOutput(
				JSON.stringify({
					result: {
						pane: { pane_id: "w1:p1", agent: "pi", agent_status: "paused" },
					},
				}),
				"w1:p1",
			);
			assert.deepEqual(result, {
				kind: "present",
				agent: "pi",
				agentStatus: "unknown",
			});
		});

		it("recognizes an interactive shell as ready", () => {
			assert.equal(
				__herdrTest__.isHerdrShellReady({
					paneId: "w1:p9",
					shellPid: 100,
					foregroundProcessGroupId: 100,
					pids: [100],
					foregroundProcesses: [],
				}),
				true,
			);
			assert.equal(
				__herdrTest__.isHerdrShellReady({
					paneId: "w1:p9",
					shellPid: 100,
					foregroundProcessGroupId: 200,
					pids: [100, 200],
					foregroundProcesses: [],
				}),
				false,
			);
		});

		it("matches only the expected Pi session and cwd", () => {
			const process = {
				pid: 200,
				name: "pi",
				argv: ["pi", "--session", "/tmp/session.jsonl"],
				cwd: "/tmp/worktree",
			};
			assert.equal(
				__herdrTest__.isExpectedPiProcess(
					process,
					"/tmp/session.jsonl",
					"/tmp/worktree",
				),
				true,
			);
			assert.equal(
				__herdrTest__.isExpectedPiProcess(
					process,
					"/tmp/other.jsonl",
					"/tmp/worktree",
				),
				false,
			);
		});

		it("parses pane process-info identities", () => {
			const result = __herdrTest__.parsePaneProcessInfo(
				JSON.stringify({
					result: {
						process_info: {
							pane_id: "w1:p9",
							shell_pid: 100,
							foreground_process_group_id: 200,
							foreground_processes: [
								{
									pid: 200,
									name: "pi",
									argv0: "pi",
									argv: ["pi", "--session", "/tmp/session.jsonl"],
									cwd: "/tmp/worktree",
								},
								{ pid: 201 },
							],
						},
					},
				}),
				"w1:p9",
			);
			assert.deepEqual(result, {
				paneId: "w1:p9",
				shellPid: 100,
				foregroundProcessGroupId: 200,
				pids: [100, 200, 201],
				foregroundProcesses: [
					{
						pid: 200,
						name: "pi",
						argv0: "pi",
						argv: ["pi", "--session", "/tmp/session.jsonl"],
						cwd: "/tmp/worktree",
					},
					{ pid: 201 },
				],
			});
		});
	});

	describe("process exit confirmation", () => {
		it("returns survivors after the bounded wait", async () => {
			const alive = new Set([11, 22]);
			const survivors = await waitForProcessesExit([11, 22, 33], {
				timeoutMs: 80,
				intervalMs: 10,
				isAlive: (pid) => alive.has(pid),
			});
			assert.deepEqual(survivors.sort(), [11, 22]);
		});
	});
});
