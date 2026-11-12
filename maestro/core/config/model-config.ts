import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isPlainObject, isString } from "./type-guards.ts";
import { isThinkingLevel, THINKING_LEVELS } from "../routing.ts";

import {
	type RankingBasis,
	type ResearchSource,
	TASK_CATEGORIES,
	type TaskCategory,
	type TaskPreferences,
	type TaskPreferencesMeta,
	type TaskThinkingPreferences,
} from "./task-model-types.ts";

export interface ModelConfig {
	default?: string;
	agents: Record<string, string>;
	tasks?: TaskPreferences;
	tasksThinking?: TaskThinkingPreferences;
	tasksMeta?: TaskPreferencesMeta;
}

function invalidModelConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent model config in ${source}: ${message}`);
}

function rejectTaskReference(
	value: string,
	field: string,
	source: string,
): void {
	if (value.trim().toLowerCase().startsWith("task:")) {
		invalidModelConfig(
			source,
			`${field} cannot use task: references; task: references are only valid in the subagent tool's model parameter`,
		);
	}
}

function parseTasks(value: any, source: string): TaskPreferences | undefined {
	if (value == null) return undefined;
	if (!isPlainObject(value))
		invalidModelConfig(source, "models.tasks must be an object");
	const keys = Object.keys(value);
	if (keys.length === 0) return undefined;
	const unsupported = keys.filter(
		// SAFETY: this check only compares strings against the fixed category set.
		(key) => !TASK_CATEGORIES.includes(key as TaskCategory),
	);
	if (unsupported.length > 0) {
		invalidModelConfig(
			source,
			`models.tasks.${unsupported[0]} is unsupported; supported categories: ${TASK_CATEGORIES.join(", ")}`,
		);
	}
	const tasks: TaskPreferences = {};
	for (const category of TASK_CATEGORIES) {
		if (!Object.hasOwn(value, category)) continue;
		const candidates = value[category];
		if (!Array.isArray(candidates) || candidates.length === 0) {
			invalidModelConfig(
				source,
				`models.tasks.${category} must be a non-empty list`,
			);
		}
		const seen = new Set<string>();
		tasks[category] = candidates.map((candidate, index) => {
			if (!isString(candidate) || candidate.trim() === "") {
				invalidModelConfig(
					source,
					`models.tasks.${category}[${index}] must be a non-empty string`,
				);
			}
			const reference = candidate.trim();
			if (seen.has(reference)) {
				invalidModelConfig(
					source,
					`models.tasks.${category} has duplicate candidate ${JSON.stringify(reference)}`,
				);
			}
			seen.add(reference);
			return reference;
		});
	}
	return tasks;
}

function parseTasksThinking(
	value: any,
	source: string,
): TaskThinkingPreferences | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value))
		invalidModelConfig(source, "models.tasksThinking must be an object");
	const thinking: TaskThinkingPreferences = {};
	for (const [category, level] of Object.entries(value)) {
		// SAFETY: category membership is checked before indexing the typed map.
		if (!TASK_CATEGORIES.includes(category as TaskCategory))
			invalidModelConfig(
				source,
				`models.tasksThinking.${category} is unsupported; supported categories: ${TASK_CATEGORIES.join(", ")}`,
			);
		if (!isString(level) || !isThinkingLevel(level))
			invalidModelConfig(
				source,
				`models.tasksThinking.${category} must be one of: ${THINKING_LEVELS.join(", ")}`,
			);
		// SAFETY: the fixed category check above rejects unknown keys.
		thinking[category as TaskCategory] = level;
	}
	return thinking;
}

function parseTasksMeta(
	value: any,
	source: string,
): TaskPreferencesMeta | undefined {
	if (value == null) return undefined;
	if (!isPlainObject(value))
		invalidModelConfig(source, "models.tasksMeta must be an object");
	const unsupported = Object.keys(value).filter(
		(key) => key !== "generatedAt" && key !== "method",
	);
	if (unsupported.length > 0) {
		invalidModelConfig(
			source,
			`models.tasksMeta has unsupported key(s): ${unsupported.join(", ")}`,
		);
	}
	if (
		!isString(value.generatedAt) ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
			value.generatedAt,
		) ||
		Number.isNaN(Date.parse(value.generatedAt))
	) {
		invalidModelConfig(
			source,
			"models.tasksMeta.generatedAt must be an ISO-8601 string",
		);
	}
	if (value.method !== "research" && value.method !== "registry-only") {
		invalidModelConfig(
			source,
			'models.tasksMeta.method must be "research" or "registry-only"',
		);
	}
	return { generatedAt: value.generatedAt, method: value.method };
}

export function parseModelConfig(
	rawConfig: any,
	source = "config.json",
): ModelConfig {
	if (!isPlainObject(rawConfig))
		invalidModelConfig(source, "root must be an object");
	const models = rawConfig.models;
	if (models == null) return { agents: {} };
	if (!isPlainObject(models))
		invalidModelConfig(source, "models must be an object");
	const allowedKeys = new Set([
		"default",
		"agents",
		"tasks",
		"tasksThinking",
		"tasksMeta",
	]);
	const unsupportedKeys = Object.keys(models).filter(
		(key) => !allowedKeys.has(key),
	);
	if (unsupportedKeys.length > 0)
		invalidModelConfig(
			source,
			`models has unsupported key(s): ${unsupportedKeys.join(", ")}`,
		);

	let defaultModel: string | undefined;
	if (models.default != null) {
		if (!isString(models.default) || models.default.trim() === "")
			invalidModelConfig(source, "models.default must be a non-empty string");
		const trimmedDefault = models.default.trim();
		defaultModel = trimmedDefault;
		rejectTaskReference(trimmedDefault, "models.default", source);
	}
	const agents: Record<string, string> = {};
	if (models.agents != null) {
		if (!isPlainObject(models.agents))
			invalidModelConfig(source, "models.agents must be an object");
		for (const [agent, model] of Object.entries(models.agents)) {
			if (!isString(model) || model.trim() === "")
				invalidModelConfig(
					source,
					`models.agents.${agent} must be a non-empty string`,
				);
			const trimmed = model.trim();
			rejectTaskReference(trimmed, `models.agents.${agent}`, source);
			Object.defineProperty(agents, agent, {
				value: trimmed,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	const tasks = parseTasks(models.tasks, source);
	const tasksThinking = parseTasksThinking(models.tasksThinking, source);
	const tasksMeta = parseTasksMeta(models.tasksMeta, source);
	const config: ModelConfig = { agents };
	if (defaultModel) config.default = defaultModel;
	if (tasks) config.tasks = tasks;
	if (tasksThinking) config.tasksThinking = tasksThinking;
	if (tasksMeta) config.tasksMeta = tasksMeta;
	return config;
}

export function resolveModelDefault(
	agentName: string | undefined,
	agentModel: string | undefined,
	config: ModelConfig,
): string | undefined {
	if (agentModel) return agentModel;
	if (agentName && Object.hasOwn(config.agents, agentName))
		return config.agents[agentName];
	return config.default;
}

export function loadModelConfig(configDir: string): ModelConfig {
	return readModelConfigSnapshot(configDir).config;
}

export interface ModelConfigSnapshot {
	config: ModelConfig;
	/** Revision of the exact bytes `config` was parsed from. */
	revision: string;
}

/** Parse the saved model settings and revision them from one read of the file. */
export function readModelConfigSnapshot(
	configDir: string,
): ModelConfigSnapshot {
	const configPath = join(configDir, "config.json");
	const bytes = readBytesIfExists(configPath);
	if (bytes == null)
		return { config: { agents: {} }, revision: MISSING_CONFIG_REVISION };
	try {
		return {
			config: parseModelConfig(JSON.parse(bytes.toString("utf8")), configPath),
			revision: computeConfigRevision(bytes),
		};
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new Error(
				`Invalid JSON in subagent model config ${configPath}: ${error.message}`,
			);
		throw error;
	}
}

function invalidBasis(message: string): never {
	throw new Error(`Invalid ranking basis: ${message}`);
}

function isUsableUrl(value: string): boolean {
	const url = URL.parse(value);
	return (
		url !== null &&
		(url.protocol === "https:" || url.protocol === "http:") &&
		url.hostname !== ""
	);
}

/**
 * Validate a writer call's optional ranking basis against its tasksMeta.method.
 * Code checks shape and consistency only; it cannot prove a source was read.
 */
export function parseRankingBasis(
	value: any,
	method: TaskPreferencesMeta["method"],
): RankingBasis {
	if (!isPlainObject(value)) invalidBasis("basis must be an object");
	if (value.kind !== method)
		invalidBasis(
			`basis.kind ${JSON.stringify(value.kind)} must equal tasksMeta.method ${JSON.stringify(method)}`,
		);
	if (value.kind === "registry-only") {
		if (Object.keys(value).length !== 1)
			invalidBasis("a registry-only basis has no other fields");
		return { kind: "registry-only" };
	}
	if (
		Object.keys(value).some(
			(key) => key !== "kind" && key !== "sources" && key !== "uncertainty",
		)
	)
		invalidBasis("a research basis has only kind, sources and uncertainty");
	if (!Array.isArray(value.sources) || value.sources.length === 0)
		invalidBasis(
			"research needs at least one source that informed the ranking",
		);
	// SAFETY: the check above rejected an empty list, and map keeps its length.
	const sources = value.sources.map((source: any, index: number) => {
		if (
			!isPlainObject(source) ||
			Object.keys(source).some((key) => key !== "url" && key !== "influence")
		)
			invalidBasis(`sources[${index}] has only url and influence`);
		if (!isString(source.url) || !isUsableUrl(source.url))
			invalidBasis(`sources[${index}].url must be an http(s) URL with a host`);
		if (!isString(source.influence) || source.influence.trim() === "")
			invalidBasis(
				`sources[${index}].influence must say how the source informed the ranking`,
			);
		return { url: source.url, influence: source.influence };
	}) as [ResearchSource, ...ResearchSource[]];
	if (!isString(value.uncertainty) || value.uncertainty.trim() === "")
		invalidBasis("research must disclose its remaining uncertainty");
	return { kind: "research", sources, uncertainty: value.uncertainty };
}

export interface SavedTaskModelConfig {
	configPath: string;
	tasks: TaskPreferences;
	tasksThinking?: TaskThinkingPreferences;
	tasksMeta: TaskPreferencesMeta | undefined;
	missingCategories: TaskCategory[];
	/** Revision of the exact bytes this call published. */
	configRevision: string;
}

/** Revision of an absent config file. */
export const MISSING_CONFIG_REVISION = "missing";
const CONFIG_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<lowercase hex>` over the exact file bytes, never normalized JSON. */
export function computeConfigRevision(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isConfigRevision(value: any): value is string {
	return (
		value === MISSING_CONFIG_REVISION ||
		(isString(value) && CONFIG_REVISION_PATTERN.test(value))
	);
}

/** Read the exact-byte revision of a config file, or `missing` when absent. */
export function readConfigRevision(configPath: string): string {
	const bytes = readBytesIfExists(configPath);
	return bytes == null ? MISSING_CONFIG_REVISION : computeConfigRevision(bytes);
}

export type TaskModelConfigWriteErrorCode =
	| "invalid-revision"
	| "stale-revision"
	| "busy";

export class TaskModelConfigWriteError extends Error {
	readonly code: TaskModelConfigWriteErrorCode;
	constructor(code: TaskModelConfigWriteErrorCode, message: string) {
		super(message);
		this.name = "TaskModelConfigWriteError";
		this.code = code;
	}
}

export interface WriteTaskModelConfigOptions {
	/** Replaces category thinking when supplied; omitted preserves it for retained categories. */
	tasksThinking?: TaskThinkingPreferences;
	/**
	 * Exact-byte revision the caller proposed against. Omitted keeps the
	 * unconditional write; `missing` requires the file to be absent.
	 */
	expectedConfigRevision?: string;
	fileOperations?: Pick<
		typeof import("node:fs"),
		"renameSync" | "writeFileSync"
	>;
}

/** Normalize and validate a proposal without creating files or acquiring a lock. */
export function validateTaskModelProposal(
	configPath: string,
	tasks: TaskPreferences,
	tasksMeta: TaskPreferencesMeta,
	isAuthenticatedCandidate: (candidate: string) => boolean,
	options: WriteTaskModelConfigOptions = {},
): ModelConfig {
	if (
		options.expectedConfigRevision !== undefined &&
		!isConfigRevision(options.expectedConfigRevision)
	) {
		throw new TaskModelConfigWriteError(
			"invalid-revision",
			`Invalid expectedConfigRevision: use "sha256:" followed by 64 lowercase hex digits of the exact config bytes, or "${MISSING_CONFIG_REVISION}" when the config file is absent. Omit it only for an unconditional write.`,
		);
	}
	const candidate = parseModelConfig(
		{ models: { tasks, tasksThinking: options.tasksThinking, tasksMeta } },
		configPath,
	);
	for (const candidates of Object.values(candidate.tasks ?? {})) {
		for (const ref of candidates) {
			if (!isAuthenticatedCandidate(ref))
				throw new Error(
					`Task model candidate ${JSON.stringify(ref)} is not an authenticated exact registry model`,
				);
		}
	}
	return candidate;
}

/** Check the proposal's revision before approval and again under the write lock. */
export function assertTaskModelConfigRevision(
	configPath: string,
	expected: string | undefined,
	actual: string,
): void {
	if (expected === undefined || actual === expected) return;
	let state = "the config file bytes changed since the proposal was read";
	if (expected === MISSING_CONFIG_REVISION)
		state = "the proposal expected no config file, but one now exists";
	else if (actual === MISSING_CONFIG_REVISION)
		state =
			"the proposal expected an existing config file, but it is now missing";
	throw new TaskModelConfigWriteError(
		"stale-revision",
		`Stale task model config revision for ${configPath}: ${state}. Configuration was not replaced. Re-read the config, prepare a fresh proposal, and obtain fresh approval before writing.`,
	);
}

/** Legacy callers preserve thinking only for task categories they retain. */
export function resolveTaskThinkingPreferences(
	tasks: TaskPreferences | undefined,
	requested: TaskThinkingPreferences | undefined,
	previous: TaskThinkingPreferences | undefined,
): TaskThinkingPreferences | undefined {
	const selected = requested ?? previous;
	if (!selected) return undefined;
	const retained: TaskThinkingPreferences = {};
	for (const category of TASK_CATEGORIES) {
		const level = selected[category];
		if (tasks?.[category] && level !== undefined) retained[category] = level;
	}
	return retained;
}

/**
 * Atomically replace models.tasks, category thinking and models.tasksMeta in the durable user config.
 *
 * Every call holds an exclusive sibling lock file while it reads one snapshot,
 * checks the optional revision precondition, and renames a private temporary file
 * into place. The lock is advisory: it serializes cooperating writers only and
 * cannot constrain editors or processes that ignore it. Contention and stale locks
 * fail closed without waiting or breaking another owner's lock.
 */
export function writeTaskModelConfig(
	configPath: string,
	examplePath: string,
	tasks: TaskPreferences,
	tasksMeta: TaskPreferencesMeta,
	isAuthenticatedCandidate: (candidate: string) => boolean,
	options: WriteTaskModelConfigOptions = {},
): SavedTaskModelConfig {
	const expected = options.expectedConfigRevision;
	const candidateConfig = validateTaskModelProposal(
		configPath,
		tasks,
		tasksMeta,
		isAuthenticatedCandidate,
		options,
	);
	const fileOperations = options.fileOperations ?? {
		renameSync,
		writeFileSync,
	};
	mkdirSync(dirname(configPath), { recursive: true });
	return withConfigWriteLock(configPath, () => {
		const currentBytes = readBytesIfExists(configPath);
		assertTaskModelConfigRevision(
			configPath,
			expected,
			currentBytes == null
				? MISSING_CONFIG_REVISION
				: computeConfigRevision(currentBytes),
		);
		const current = currentBytes?.toString("utf8");
		const source = current ?? readFileSync(examplePath, "utf8");
		let parsed: any;
		try {
			parsed = JSON.parse(source);
		} catch (error) {
			const path = current == null ? examplePath : configPath;
			throw new Error(
				`Invalid JSON in subagent config ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isPlainObject(parsed))
			throw new Error(
				`Invalid JSON in subagent config ${configPath}: root must be an object`,
			);
		const models = isPlainObject(parsed.models) ? { ...parsed.models } : {};
		const retainedThinking = resolveTaskThinkingPreferences(
			candidateConfig.tasks,
			candidateConfig.tasksThinking,
			candidateConfig.tasksThinking === undefined
				? parseTasksThinking(models.tasksThinking, configPath)
				: undefined,
		);
		if (retainedThinking) models.tasksThinking = retainedThinking;
		else delete models.tasksThinking;
		models.tasks = candidateConfig.tasks;
		models.tasksMeta = candidateConfig.tasksMeta;
		const output = JSON.stringify({ ...parsed, models }, null, 2) + "\n";
		const temporary = join(
			dirname(configPath),
			`.${Date.now()}-${process.pid}-${randomUUID()}-config.tmp`,
		);
		let published = false;
		try {
			fileOperations.writeFileSync(temporary, output, { flag: "wx" });
			fileOperations.renameSync(temporary, configPath);
			published = true;
		} finally {
			if (!published) rmSync(temporary, { force: true });
		}
		const saved: SavedTaskModelConfig = {
			configPath,
			tasks: candidateConfig.tasks ?? {},
			tasksMeta: candidateConfig.tasksMeta,
			missingCategories: TASK_CATEGORIES.filter(
				(category) => !candidateConfig.tasks?.[category],
			),
			configRevision: computeConfigRevision(Buffer.from(output, "utf8")),
		};
		if (retainedThinking) saved.tasksThinking = retainedThinking;
		return saved;
	});
}

/** Sibling advisory lock path shared by every cooperating config writer. */
export function getConfigWriteLockPath(configPath: string): string {
	return `${configPath}.lock`;
}

function withConfigWriteLock<T>(configPath: string, write: () => T): T {
	const lockPath = getConfigWriteLockPath(configPath);
	const token = randomUUID();
	let descriptor: number;
	try {
		descriptor = openSync(lockPath, "wx");
	} catch (error) {
		// SAFETY: openSync errors expose the Node errno code.
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new TaskModelConfigWriteError("busy", describeHeldLock(lockPath));
		throw error;
	}
	try {
		try {
			writeSync(
				descriptor,
				JSON.stringify({
					pid: process.pid,
					hostname: hostname(),
					token,
					createdAt: new Date().toISOString(),
				}),
			);
		} finally {
			closeSync(descriptor);
		}
	} catch (error) {
		rmSync(lockPath, { force: true });
		throw error;
	}
	try {
		return write();
	} finally {
		releaseConfigWriteLock(lockPath, token);
	}
}

function releaseConfigWriteLock(lockPath: string, token: string): void {
	let owner: any;
	try {
		owner = JSON.parse(readFileSync(lockPath, "utf8"));
	} catch {
		return;
	}
	// Never remove a lock this invocation does not own.
	if (isPlainObject(owner) && owner.token === token) unlinkSync(lockPath);
}

function describeHeldLock(lockPath: string): string {
	let owner = "an unidentified owner";
	let stale = "";
	try {
		const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
		if (isPlainObject(parsed) && Number.isInteger(parsed.pid)) {
			owner = `pid ${parsed.pid}${isString(parsed.hostname) ? ` on ${parsed.hostname}` : ""}${isString(parsed.createdAt) ? ` since ${parsed.createdAt}` : ""}`;
			if (parsed.hostname === hostname() && !isProcessAlive(parsed.pid))
				stale =
					" That process is no longer running, so the lock appears stale.";
		}
	} catch {
		// Unreadable lock contents still mean another writer may be active.
	}
	return `Task model config writer busy: lock ${lockPath} is held by ${owner}. Configuration was not replaced.${stale} Retry after the other writer finishes; remove the lock manually only after confirming no writer is active. Locks are never broken automatically.`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// SAFETY: process.kill errors expose the Node errno code.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readBytesIfExists(path: string): Buffer | undefined {
	try {
		return readFileSync(path);
	} catch (error) {
		// SAFETY: readFileSync errors expose the Node errno code.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
