import {
	isFiniteNumber,
	isPlainObject,
	isString,
} from "../../core/config/type-guards.ts";
import { herdrExecAsync, parseHerdrJson } from "./herdr-cli.ts";
import { Deadline } from "../../core/deadline.ts";

export type {
	PaneInspection,
	SurfaceAgentStatus as HerdrAgentStatus,
} from "../../core/types.ts";

export type PaneInspectionResult =
	| {
			kind: "present";
			agent?: string;
			agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
	  }
	| { kind: "missing"; error?: string }
	| { kind: "unavailable"; error: string };

export function parsePaneGetOutput(
	output: string,
	surface: string,
): PaneInspectionResult {
	const parsed = parseHerdrJson(output);
	const errorObj = parsed?.error;
	if (errorObj?.code === "pane_not_found" || errorObj?.code === "not_found") {
		return {
			kind: "missing",
			error: isString(errorObj.message) ? errorObj.message : "pane not found",
		};
	}
	const record = parsed?.result?.pane;
	if (!isPlainObject(record))
		return { kind: "unavailable", error: "pane get returned no pane record" };
	if (record.pane_id !== surface)
		return { kind: "unavailable", error: "pane id mismatch" };
	const agent = isString(record.agent) ? record.agent : undefined;
	const rawStatus = isString(record.agent_status)
		? record.agent_status
		: "unknown";
	const agentStatus =
		rawStatus === "idle" ||
		rawStatus === "working" ||
		rawStatus === "blocked" ||
		rawStatus === "done" ||
		rawStatus === "unknown"
			? rawStatus
			: "unknown";
	const result: PaneInspectionResult = { kind: "present", agentStatus };
	if (agent) result.agent = agent;
	return result;
}

export function parsePaneGetError(error: any): PaneInspectionResult {
	for (const raw of [error?.stderr, error?.stdout]) {
		if (!isString(raw) || !raw.trim()) continue;
		try {
			const parsed = parsePaneGetOutput(raw, "");
			if (parsed.kind === "missing") return parsed;
		} catch {
			// A CLI may emit plain diagnostics on one stream and structured JSON on
			// the other. Parse each stream independently before giving up.
		}
		// Older/alternate Herdr builds may print the stable error code as plain
		// text rather than JSON. Only match explicit identifiers, not generic
		// prose such as "pane unavailable".
		if (/\b(?:pane_not_found|not_found)\b/.test(raw)) {
			return { kind: "missing", error: raw.trim() };
		}
	}
	const message = error?.message
		? String(error.message)
		: "herdr pane get failed";
	return { kind: "unavailable", error: message };
}

/**
 * Structured pane query.
 * - present: pane is reachable; agent/agentStatus may be present when detected
 * - missing: server responded, pane is gone
 * - unavailable: server command failed; caller should keep polling
 */
export interface HerdrPaneListEntry {
	paneId: string;
	workspaceId: string;
	tabId?: string;
	name?: string;
	cwd?: string;
}

/** Parse only complete snapshots; partial lists never establish pane absence. */
export function parseHerdrPaneSnapshot(
	output: string,
): HerdrPaneListEntry[] | null {
	const parsed = parseHerdrJson(output);
	const panes = parsed?.result?.panes;
	if (parsed?.result?.type !== "pane_list" || !Array.isArray(panes))
		return null;
	const ids = new Set<string>();
	const result: HerdrPaneListEntry[] = [];
	for (const pane of panes) {
		if (
			!isString(pane?.pane_id) ||
			!pane.pane_id ||
			!isString(pane?.workspace_id) ||
			!pane.workspace_id ||
			ids.has(pane.pane_id)
		)
			return null;
		ids.add(pane.pane_id);
		const entry: HerdrPaneListEntry = {
			paneId: pane.pane_id,
			workspaceId: pane.workspace_id,
		};
		if (isString(pane.tab_id)) entry.tabId = pane.tab_id;
		if (isString(pane.cwd)) entry.cwd = pane.cwd;
		if (isString(pane.label)) entry.name = pane.label;
		else if (isString(pane.terminal_title_stripped)) {
			entry.name = pane.terminal_title_stripped;
		}
		result.push(entry);
	}
	return result;
}

export async function listHerdrPanes(
	timeout?: number,
): Promise<HerdrPaneListEntry[] | null> {
	try {
		return parseHerdrPaneSnapshot(
			await herdrExecAsync(["pane", "list"], timeout),
		);
	} catch {
		return null;
	}
}

export async function inspectHerdrPane(
	surface: string,
	timeout?: number,
): Promise<PaneInspectionResult> {
	try {
		return parsePaneGetOutput(
			await herdrExecAsync(["pane", "get", surface], timeout),
			surface,
		);
	} catch (error: any) {
		return parsePaneGetError(error);
	}
}

export interface HerdrForegroundProcess {
	pid: number;
	name?: string;
	argv0?: string;
	argv?: string[];
	cwd?: string;
}

export interface HerdrPaneProcessInfo {
	paneId: string;
	shellPid?: number;
	foregroundProcessGroupId?: number;
	pids: number[];
	foregroundProcesses: HerdrForegroundProcess[];
}

export function parsePaneProcessInfo(
	output: string,
	paneId: string,
): HerdrPaneProcessInfo {
	const parsed = parseHerdrJson(output);
	const info = parsed?.result?.process_info;
	if (!isPlainObject(info)) {
		throw new Error(
			`Unexpected herdr pane process-info output: ${output.trim() || "(empty)"}`,
		);
	}
	if (isString(info.pane_id) && info.pane_id !== paneId) {
		throw new Error(
			`herdr pane process-info pane id mismatch: ${info.pane_id} != ${paneId}`,
		);
	}
	const pids = new Set<number>();
	if (Number.isInteger(info.shell_pid) && info.shell_pid > 0) {
		pids.add(info.shell_pid);
	}
	if (
		Number.isInteger(info.foreground_process_group_id) &&
		info.foreground_process_group_id > 0
	) {
		pids.add(info.foreground_process_group_id);
	}
	const foregroundProcesses: HerdrForegroundProcess[] = [];
	for (const process of info.foreground_processes ?? []) {
		if (Number.isInteger(process?.pid) && process.pid > 0) {
			pids.add(process.pid);
			const entry: HerdrForegroundProcess = { pid: process.pid };
			if (isString(process.name)) entry.name = process.name;
			if (isString(process.argv0)) entry.argv0 = process.argv0;
			if (Array.isArray(process.argv) && process.argv.every(isString)) {
				entry.argv = process.argv;
			}
			if (isString(process.cwd)) entry.cwd = process.cwd;
			foregroundProcesses.push(entry);
		}
	}
	const result: HerdrPaneProcessInfo = {
		paneId,
		pids: [...pids],
		foregroundProcesses,
	};
	if (isFiniteNumber(info.shell_pid)) result.shellPid = info.shell_pid;
	if (isFiniteNumber(info.foreground_process_group_id)) {
		result.foregroundProcessGroupId = info.foreground_process_group_id;
	}
	return result;
}

export async function getHerdrPaneProcessInfoAsync(
	surface: string,
	timeout?: number,
): Promise<HerdrPaneProcessInfo> {
	return parsePaneProcessInfo(
		await herdrExecAsync(["pane", "process-info", "--pane", surface], timeout),
		surface,
	);
}

export function isHerdrShellReady(info: HerdrPaneProcessInfo): boolean {
	return (
		info.shellPid != null && info.foregroundProcessGroupId === info.shellPid
	);
}

export async function waitForHerdrShellReady(
	surface: string,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Deadline.after(timeoutMs);
	let lastError = "no interactive shell foreground process";

	while (!deadline.expired()) {
		if (options.signal?.aborted)
			throw new Error("Shell readiness wait cancelled.");
		try {
			const info = await getHerdrPaneProcessInfoAsync(
				surface,
				deadline.remainingMs(),
			);
			deadline.remainingMs();
			options.signal?.throwIfAborted();
			if (isHerdrShellReady(info)) return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (deadline.expired()) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, deadline.remainingMs())),
		);
	}
	throw new Error(
		`Timed out waiting for interactive shell in Herdr pane ${surface}: ${lastError}`,
	);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// SAFETY: process.kill only throws Node's fs/process errors here, which
		// are always Error instances carrying an ErrnoException `code`.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function waitForProcessesExit(
	pids: readonly number[],
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		isAlive?: (pid: number) => boolean;
	} = {},
): Promise<number[]> {
	const isAlive = options.isAlive ?? isProcessAlive;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 50;
	const remaining = new Set(
		pids.filter((pid) => Number.isInteger(pid) && pid > 0 && isAlive(pid)),
	);
	const deadline = Date.now() + timeoutMs;
	while (remaining.size > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		for (const pid of remaining) {
			if (!isAlive(pid)) remaining.delete(pid);
		}
	}
	return [...remaining];
}

export async function waitForHerdrPaneAbsence(
	surface: string,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		inspect?: (
			surface: string,
			timeout?: number,
		) => Promise<PaneInspectionResult>;
	} = {},
): Promise<boolean> {
	const inspect = options.inspect ?? inspectHerdrPane;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Deadline.after(timeoutMs);
	while (!deadline.expired()) {
		const inspection = await inspect(surface, deadline.remainingMs());
		if (deadline.expired()) return false;
		if (inspection.kind === "missing") return true;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, deadline.remainingMs())),
		);
	}
	return false;
}
