import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
	isBoolean,
	isPlainObject,
	isRecord,
	isString,
	type JsonObject,
	type JsonValue,
} from "./type-guards.ts";

export interface SessionEntry {
	type: string;
	id: string;
	parentId?: string;
	[key: string]: JsonValue | undefined;
}

export interface MessageEntry extends SessionEntry {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		content: Array<{
			type: string;
			text?: string;
			[key: string]: JsonValue | undefined;
		}>;
		stopReason?: string;
		errorMessage?: string;
	};
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

export interface WorktreeSessionFork {
	sessionFile: string;
	sourceSessionFile: string;
	handoffMessage: string;
}

const SUBAGENT_POLICY_VERSION = 2;
const SUBAGENT_POLICY_SUFFIX = ".pi-herdr-subagent-policy.json";

export type SubagentSessionOwner = "public" | "managed-worktree";

interface PolicyWorktree {
	path: string;
	workspaceId: string;
	branch: string;
	baseSha: string;
}

export interface SubagentSessionPolicyV1 {
	version: 1;
	owner: SubagentSessionOwner;
	tools: string[] | null;
	deniedTools: string[];
	persistent: false;
}

export interface SubagentSessionPolicyV2 {
	version: 2;
	owner: SubagentSessionOwner;
	/** null deliberately means Pi's unrestricted default tool selection. */
	tools: string[] | null;
	deniedTools: string[];
	persistent: boolean;
	logicalId: string;
	generationId: string;
	policyHash: string;
	worktree?: PolicyWorktree;
}

export type SubagentSessionPolicy =
	| SubagentSessionPolicyV1
	| SubagentSessionPolicyV2;

export interface PersistentTaskEvent {
	version: 1;
	type: "task-done" | "help-request";
	task: string;
	generation: string;
	at: string;
	message?: string;
}

export interface PersistentDeliveryLedgerEntry {
	task: string;
	outcome:
		| "dispatched"
		| "delivered"
		| "rejected-busy"
		| "help-requested"
		| "stop-pending"
		| "stopped";
	generation: string;
	logicalId: string;
	policyHash: string;
	at: string;
}

export interface PersistentTaskInboxEntry {
	version: 1;
	type?: "task" | "stop";
	task: string;
	message: string;
	at: string;
}

export function getSubagentSessionPolicyFile(sessionFile: string): string {
	return `${sessionFile}${SUBAGENT_POLICY_SUFFIX}`;
}

export function getPersistentTaskEventsFile(sessionFile: string): string {
	return `${sessionFile}.tasks`;
}

export function getPersistentDeliveryLedgerFile(sessionFile: string): string {
	return `${sessionFile}.ledger`;
}

function normalizePolicyToolNames(
	tools: string | readonly string[] | undefined,
): string[] | null {
	const values = isString(tools)
		? tools.split(",")
		: tools === undefined
			? []
			: [...tools];
	const normalized = [
		...new Set(values.map((tool) => tool.trim()).filter(Boolean)),
	];
	return normalized.length > 0 ? normalized : null;
}

function canonicalPolicyJson(
	policy: Omit<SubagentSessionPolicyV2, "policyHash">,
): string {
	const canonical = {
		version: policy.version,
		owner: policy.owner,
		tools: policy.tools,
		deniedTools: policy.deniedTools,
		persistent: policy.persistent,
		logicalId: policy.logicalId,
		generationId: policy.generationId,
	};
	return JSON.stringify(
		policy.worktree ? { ...canonical, worktree: policy.worktree } : canonical,
	);
}

export function writeSubagentSessionPolicy(
	sessionFile: string,
	policy: {
		owner: SubagentSessionOwner;
		tools?: string | readonly string[];
		deniedTools: readonly string[];
		persistent?: boolean;
		logicalId?: string;
		generationId?: string;
		worktree?: PolicyWorktree;
	},
): SubagentSessionPolicyV2 {
	const unsigned: Omit<SubagentSessionPolicyV2, "policyHash"> = {
		version: SUBAGENT_POLICY_VERSION,
		owner: policy.owner,
		tools: normalizePolicyToolNames(policy.tools),
		deniedTools: normalizePolicyToolNames(policy.deniedTools) ?? [],
		persistent: policy.persistent ?? false,
		logicalId: policy.logicalId ?? randomUUID(),
		generationId: policy.generationId ?? randomUUID(),
	};
	if (policy.worktree) unsigned.worktree = policy.worktree;
	const value: SubagentSessionPolicyV2 = {
		...unsigned,
		policyHash: createHash("sha256")
			.update(canonicalPolicyJson(unsigned))
			.digest("hex"),
	};
	writeFileSync(
		getSubagentSessionPolicyFile(sessionFile),
		`${JSON.stringify(value)}\n`,
		"utf8",
	);
	return value;
}

function policyError(sessionFile: string, reason: string): Error {
	return new Error(
		`Cannot safely resume ${sessionFile}: ${reason}. ` +
			"Start a new subagent with the required restrictions, or manually resume it only after choosing an explicit Pi tool policy.",
	);
}

function isPolicyRecord(value: JsonValue): value is JsonObject {
	return isPlainObject(value);
}

export function readSubagentSessionPolicy(
	sessionFile: string,
): SubagentSessionPolicy {
	const path = getSubagentSessionPolicyFile(sessionFile);
	let value: JsonValue;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason =
			error instanceof Error && "code" in error && error.code === "ENOENT"
				? "the saved launch policy is missing"
				: "the saved launch policy cannot be read";
		throw policyError(sessionFile, reason);
	}
	if (!isPolicyRecord(value))
		throw policyError(sessionFile, "the saved launch policy is malformed");
	const version = value.version;
	if (version !== 1 && version !== SUBAGENT_POLICY_VERSION) {
		throw policyError(
			sessionFile,
			"the saved launch policy version is unsupported",
		);
	}
	const expected =
		version === 1
			? new Set(["version", "owner", "tools", "deniedTools"])
			: new Set([
					"version",
					"owner",
					"tools",
					"deniedTools",
					"persistent",
					"logicalId",
					"generationId",
					"policyHash",
					"worktree",
				]);
	if (Object.keys(value).some((key) => !expected.has(key))) {
		throw policyError(
			sessionFile,
			"the saved launch policy has unsupported fields",
		);
	}
	const owner = value.owner;
	if (owner !== "public" && owner !== "managed-worktree") {
		throw policyError(sessionFile, "the saved launch policy owner is invalid");
	}
	const validateTools = (
		tools: JsonValue | undefined,
		allowNull: boolean,
		allowEmpty: boolean,
	): string[] | null => {
		if (tools === null) {
			if (allowNull) return null;
			throw policyError(
				sessionFile,
				"the saved denied-tool policy is malformed",
			);
		}
		if (!Array.isArray(tools)) {
			throw policyError(
				sessionFile,
				"the saved launch tool policy is malformed",
			);
		}
		const names: string[] = [];
		for (const tool of tools) {
			if (!isString(tool) || tool === "" || /[,\s]/.test(tool)) {
				throw policyError(
					sessionFile,
					"the saved launch tool policy is malformed",
				);
			}
			names.push(tool);
		}
		if (
			(!allowEmpty && names.length === 0) ||
			new Set(names).size !== names.length
		) {
			throw policyError(
				sessionFile,
				"the saved launch tool policy is malformed",
			);
		}
		return names;
	};
	const tools = validateTools(value.tools, true, false);
	const deniedTools = validateTools(value.deniedTools, false, true);
	if (deniedTools === null) {
		throw policyError(sessionFile, "the saved denied-tool policy is malformed");
	}
	if (version === 1) {
		return { version: 1, owner, tools, deniedTools, persistent: false };
	}
	if (
		!isBoolean(value.persistent) ||
		!isString(value.logicalId) ||
		!isString(value.generationId) ||
		!isString(value.policyHash) ||
		!/^[a-f0-9]{64}$/.test(value.policyHash)
	) {
		throw policyError(
			sessionFile,
			"the saved persistent launch policy is malformed",
		);
	}
	let worktree: PolicyWorktree | undefined;
	const persistedWorktree = value.worktree;
	if (persistedWorktree !== undefined) {
		if (!isRecord(persistedWorktree))
			throw policyError(
				sessionFile,
				"the saved persistent worktree policy is malformed",
			);
		const path = persistedWorktree.path;
		const workspaceId = persistedWorktree.workspaceId;
		const branch = persistedWorktree.branch;
		const baseSha = persistedWorktree.baseSha;
		if (
			Object.keys(persistedWorktree).some(
				(key) => !["path", "workspaceId", "branch", "baseSha"].includes(key),
			) ||
			!isString(path) ||
			!path ||
			!isString(workspaceId) ||
			!workspaceId ||
			!isString(branch) ||
			!branch ||
			!isString(baseSha) ||
			!baseSha
		) {
			throw policyError(
				sessionFile,
				"the saved persistent worktree policy is malformed",
			);
		}
		worktree = { path, workspaceId, branch, baseSha };
	}
	const unsigned: Omit<SubagentSessionPolicyV2, "policyHash"> = {
		version: 2,
		owner,
		tools,
		deniedTools,
		persistent: value.persistent,
		logicalId: value.logicalId,
		generationId: value.generationId,
	};
	if (worktree) unsigned.worktree = worktree;
	if (
		createHash("sha256").update(canonicalPolicyJson(unsigned)).digest("hex") !==
		value.policyHash
	) {
		throw policyError(
			sessionFile,
			"the saved persistent launch policy hash is invalid",
		);
	}
	const policy: SubagentSessionPolicyV2 = {
		...unsigned,
		policyHash: value.policyHash,
	};
	return policy;
}

export function appendPersistentTaskEvent(
	sessionFile: string,
	event: Omit<PersistentTaskEvent, "version" | "at"> & { at?: string },
): PersistentTaskEvent {
	const value: PersistentTaskEvent = {
		version: 1,
		type: event.type,
		task: event.task,
		generation: event.generation,
		at: event.at ?? new Date().toISOString(),
	};
	if (event.message !== undefined) value.message = event.message;
	appendFileSync(
		getPersistentTaskEventsFile(sessionFile),
		`${JSON.stringify(value)}\n`,
		"utf8",
	);
	return value;
}

export function readPersistentTaskEvents(
	sessionFile: string,
): PersistentTaskEvent[] {
	if (!existsSync(getPersistentTaskEventsFile(sessionFile))) return [];
	return readFileSync(getPersistentTaskEventsFile(sessionFile), "utf8")
		.split("\n")
		.flatMap((line) => {
			if (!line.trim()) return [];
			try {
				const value: unknown = JSON.parse(line);
				if (
					!isRecord(value) ||
					value.version !== 1 ||
					(value.type !== "task-done" && value.type !== "help-request") ||
					!isString(value.task) ||
					!isString(value.generation) ||
					!isString(value.at) ||
					(value.message !== undefined && !isString(value.message))
				)
					return [];
				const event: PersistentTaskEvent = {
					version: 1,
					type: value.type,
					task: value.task,
					generation: value.generation,
					at: value.at,
				};
				if (value.message !== undefined) event.message = value.message;
				return [event];
			} catch {
				return [];
			}
		});
}

export function appendPersistentDeliveryLedger(
	sessionFile: string,
	entry: Omit<PersistentDeliveryLedgerEntry, "at"> & { at?: string },
): PersistentDeliveryLedgerEntry {
	const value: PersistentDeliveryLedgerEntry = {
		...entry,
		at: entry.at ?? new Date().toISOString(),
	};
	appendFileSync(
		getPersistentDeliveryLedgerFile(sessionFile),
		`${JSON.stringify(value)}\n`,
		"utf8",
	);
	return value;
}

function parsePersistentLedgerOutcome(
	value: JsonValue | undefined,
): PersistentDeliveryLedgerEntry["outcome"] | null {
	if (value === "dispatched") return value;
	if (value === "delivered") return value;
	if (value === "rejected-busy") return value;
	if (value === "help-requested") return value;
	if (value === "stop-pending") return value;
	if (value === "stopped") return value;
	return null;
}

export function readPersistentDeliveryLedger(
	sessionFile: string,
): PersistentDeliveryLedgerEntry[] {
	if (!existsSync(getPersistentDeliveryLedgerFile(sessionFile))) return [];
	return readFileSync(getPersistentDeliveryLedgerFile(sessionFile), "utf8")
		.split("\n")
		.flatMap((line) => {
			try {
				const value: unknown = JSON.parse(line);
				if (
					!isRecord(value) ||
					!isString(value.task) ||
					!isString(value.generation) ||
					!isString(value.logicalId) ||
					!isString(value.policyHash) ||
					!/^[a-f0-9]{64}$/.test(value.policyHash) ||
					!isString(value.at)
				)
					return [];
				const outcome = parsePersistentLedgerOutcome(value.outcome);
				if (!outcome) return [];
				return [
					{
						task: value.task,
						outcome,
						generation: value.generation,
						logicalId: value.logicalId,
						policyHash: value.policyHash,
						at: value.at,
					},
				];
			} catch {
				return [];
			}
		});
}

export function writePersistentTaskInbox(
	sessionFile: string,
	sequence: number,
	entry: Omit<PersistentTaskInboxEntry, "version" | "at"> & { at?: string },
): string {
	const path = `${sessionFile}.task-inbox.${String(sequence).padStart(12, "0")}.json`;
	const temporary = `${path}.tmp`;
	writeFileSync(
		temporary,
		`${JSON.stringify({ version: 1, type: "task", ...entry, at: entry.at ?? new Date().toISOString() })}\n`,
		"utf8",
	);
	renameSync(temporary, path);
	return path;
}

export function consumePersistentTaskInbox(
	sessionFile: string,
): PersistentTaskInboxEntry | null {
	const directory = dirname(sessionFile);
	const prefix = `${sessionFile.split("/").pop()}.task-inbox.`;
	for (const name of readdirSync(directory)) {
		if (!name.startsWith(prefix) || !name.endsWith(".json.consuming")) continue;
		const claimed = join(directory, name);
		try {
			renameSync(claimed, claimed.slice(0, -".consuming".length));
		} catch {
			// Another poller owns this claim, or recovery cannot safely proceed.
		}
	}
	const inbox = readdirSync(directory)
		.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
		.sort()[0];
	if (!inbox) return null;
	const path = join(directory, inbox);
	const claimed = `${path}.consuming`;
	try {
		renameSync(path, claimed);
	} catch {
		return null;
	}
	try {
		const value: unknown = JSON.parse(readFileSync(claimed, "utf8"));
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			(value.type !== undefined &&
				value.type !== "task" &&
				value.type !== "stop") ||
			!isString(value.task) ||
			!isString(value.message) ||
			!isString(value.at)
		)
			throw new Error("invalid persistent task inbox entry");
		const entry: PersistentTaskInboxEntry = {
			version: 1,
			task: value.task,
			message: value.message,
			at: value.at,
		};
		if (value.type === "task" || value.type === "stop") entry.type = value.type;
		rmSync(claimed, { force: true });
		return entry;
	} catch {
		try {
			renameSync(claimed, `${path}.invalid`);
		} catch {
			// Keep the claimed file when it cannot be moved; never silently delete it.
		}
		return null;
	}
}

function getForkContentLines(parentSessionFile: string): string[] {
	const raw = readFileSync(parentSessionFile, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim());

	let truncateAt = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type === "message" && entry.message?.role === "user") {
				truncateAt = i;
				break;
			}
		} catch {
			// ignore malformed lines
		}
	}

	return lines.slice(0, truncateAt).filter((line) => {
		try {
			return JSON.parse(line).type !== "session";
		} catch {
			return true;
		}
	});
}

export function createBtwSessionSnapshot(
	parentSessionFile: string,
	leafId: string,
): string {
	const detached = SessionManager.open(parentSessionFile);
	const childSessionFile = detached.createBranchedSession(leafId);
	if (!childSessionFile || !existsSync(childSessionFile)) {
		throw new Error("Pi did not persist the BTW child session");
	}
	return childSessionFile;
}

export function seedSubagentSessionFile(params: {
	mode: SeededSubagentSessionMode;
	parentSessionFile: string;
	childSessionFile: string;
	childCwd: string;
}): void {
	const header = {
		type: "session",
		version: 3,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		cwd: params.childCwd,
		parentSession: params.parentSessionFile,
	};
	const contentLines =
		params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
	const lines = [JSON.stringify(header), ...contentLines];

	mkdirSync(dirname(params.childSessionFile), { recursive: true });
	writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/**
 * Copy only the active Pi branch into a session rooted at another cwd.
 * Pi's native branched-session writer supplies compaction and label fidelity;
 * the temporary source-directory file is rewritten with the target cwd.
 */
export function createWorktreeSessionFork(params: {
	parentSessionFile: string;
	leafId: string;
	childSessionFile: string;
	childCwd: string;
	handoffMessage: string;
}): WorktreeSessionFork {
	const source = SessionManager.open(params.parentSessionFile);
	const temporaryFile = source.createBranchedSession(params.leafId);
	if (!temporaryFile || !existsSync(temporaryFile)) {
		throw new Error("Pi did not persist the worktree session fork");
	}

	try {
		const lines = readFileSync(temporaryFile, "utf8")
			.split("\n")
			.filter((line) => line.trim());
		const header = JSON.parse(lines[0]);
		header.cwd = params.childCwd;
		header.parentSession = params.parentSessionFile;
		mkdirSync(dirname(params.childSessionFile), { recursive: true });
		writeFileSync(
			params.childSessionFile,
			[JSON.stringify(header), ...lines.slice(1)].join("\n") + "\n",
			"utf8",
		);
	} finally {
		rmSync(temporaryFile, { force: true });
	}

	SessionManager.open(params.childSessionFile).appendCustomMessageEntry(
		"pi-herdr-worktree-handoff",
		params.handoffMessage,
		true,
		{
			sourceSessionFile: params.parentSessionFile,
			childCwd: params.childCwd,
		},
	);
	return {
		sessionFile: params.childSessionFile,
		sourceSessionFile: params.parentSessionFile,
		handoffMessage: params.handoffMessage,
	};
}

function parseEntry(line: string): SessionEntry {
	try {
		return JSON.parse(line);
	} catch (error) {
		throw new Error(
			`Invalid session entry: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function readEntries(sessionFile: string): SessionEntry[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map(parseEntry);
}

export type NoProgressClassification =
	| "blocked-tool"
	| "truncated-turn"
	| "generic-no-progress";

export interface NoProgressSessionTail {
	classification: NoProgressClassification;
	lastEntryKind: "assistant" | "tool-result" | "message" | "other" | "none";
}

const NO_PROGRESS_TAIL_BYTES = 128 * 1024;

/**
 * Read only the final portion of a session when a no-progress warning is due.
 * Torn or malformed JSONL lines are ignored because Pi can be writing the tail.
 */
export function inspectNoProgressSessionTail(
	sessionFile: string,
): NoProgressSessionTail {
	const fd = openSync(sessionFile, "r");
	let raw: string;
	let truncated = false;
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - NO_PROGRESS_TAIL_BYTES);
		truncated = start > 0;
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		raw = buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}

	const lines = raw.split("\n");
	if (truncated) lines.shift();
	const entries = lines.flatMap((line) => {
		if (!line.trim()) return [];
		try {
			const value: unknown = JSON.parse(line);
			return isRecord(value) ? [value] : [];
		} catch {
			return [];
		}
	});
	const last = entries.at(-1);
	const lastEntryKind: NoProgressSessionTail["lastEntryKind"] = !last
		? "none"
		: last.type === "message" && isRecord(last.message)
			? last.message.role === "assistant"
				? "assistant"
				: last.message.role === "toolResult"
					? "tool-result"
					: "message"
			: "other";

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		const hasToolCall =
			Array.isArray(content) &&
			content.some((block) => isRecord(block) && block.type === "toolCall");
		const hasToolResultAfter = entries
			.slice(index + 1)
			.some(
				(entry) =>
					entry.type === "message" &&
					isRecord(entry.message) &&
					entry.message.role === "toolResult",
			);
		if (hasToolCall && !hasToolResultAfter) {
			return { classification: "blocked-tool", lastEntryKind };
		}
		if (entry.message.stopReason === "toolUse" && !hasToolCall) {
			return { classification: "truncated-turn", lastEntryKind };
		}
		break;
	}

	return { classification: "generic-no-progress", lastEntryKind };
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
	const entries = readEntries(sessionFile);
	return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(
	sessionFile: string,
	afterLine: number,
): SessionEntry[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.slice(afterLine)
		.map(parseEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export interface ObservedSessionRuntime {
	provider?: string;
	modelId?: string;
	thinking?: string;
}

/** Read the effective model and thinking entries recorded by Pi at session startup. */
export function findObservedSessionRuntime(
	entries: SessionEntry[],
): ObservedSessionRuntime {
	const observed: ObservedSessionRuntime = {};
	for (const entry of entries) {
		if (entry.type === "model_change") {
			if (isString(entry.provider)) observed.provider = entry.provider;
			if (isString(entry.modelId)) observed.modelId = entry.modelId;
		} else if (
			entry.type === "thinking_level_change" &&
			isString(entry.thinkingLevel)
		) {
			observed.thinking = entry.thinkingLevel;
		}
	}
	return observed;
}

export interface FinalAssistantMessage {
	text: string | null;
	contentLength: number;
	stopReason?: string;
}

/** Inspect only the final assistant message for completion evidence. */
export function inspectFinalAssistantMessage(
	entries: SessionEntry[],
): FinalAssistantMessage {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		// SAFETY: entries with type "message" always carry a `message` field;
		// SessionEntry's index signature can't express this per-variant guarantee.
		const msg = entry as MessageEntry;
		if (msg.message.role !== "assistant") continue;

		const texts = msg.message.content.flatMap((block) =>
			block.type === "text" && isString(block.text) ? [block.text] : [],
		);
		const text = texts.join("\n");
		const stopReason = msg.message.stopReason;
		const result: FinalAssistantMessage = {
			text: text.trim() ? text : null,
			contentLength: text.length,
		};
		if (isString(stopReason)) result.stopReason = stopReason;
		return result;
	}
	return { text: null, contentLength: 0 };
}

export function findLastAssistantMessage(
	entries: SessionEntry[],
): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		// SAFETY: entries with type "message" always carry a `message` field;
		// SessionEntry's index signature can't express this per-variant guarantee.
		const msg = entry as MessageEntry;
		if (msg.message.role !== "assistant") continue;

		const texts = msg.message.content.flatMap((block) =>
			block.type === "text" && isString(block.text) && block.text.trim() !== ""
				? [block.text]
				: [],
		);

		if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

		const stopReason = msg.message.stopReason;
		const errorMessage = msg.message.errorMessage;
		if (
			stopReason === "error" &&
			isString(errorMessage) &&
			errorMessage.trim() !== ""
		) {
			return `Subagent error: ${errorMessage.trim()}`;
		}
	}
	return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
	sessionFile: string,
	branchPointId: string,
	fromId: string | null,
	summary: string,
): string {
	const id = randomBytes(4).toString("hex");
	const entry = {
		type: "branch_summary",
		id,
		parentId: branchPointId,
		timestamp: new Date().toISOString(),
		fromId: fromId ?? branchPointId,
		summary,
	};
	appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
	return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
	const id = randomBytes(4).toString("hex");
	const dest = join(destDir, `subagent-${id}.jsonl`);
	copyFileSync(sessionFile, dest);
	return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
	sourceFile: string,
	targetFile: string,
	afterLine: number,
): SessionEntry[] {
	const entries = getNewEntries(sourceFile, afterLine);
	for (const entry of entries) {
		appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
	}
	return entries;
}
