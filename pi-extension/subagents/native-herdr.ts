import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	isPlainObject,
	isRecord,
	isString,
	type JsonValue,
} from "./type-guards.ts";
import { isHerdrAvailable } from "./herdr.ts";

const execFileAsync = promisify(execFile);
export type NativeKind = "claude" | "codex";
export type NativeStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export interface NativeIdentity {
	paneId: string;
	terminalId: string;
	agent: NativeKind;
	sessionId: string;
	status: NativeStatus;
}
export type NativeInspection =
	| { kind: "present"; identity: NativeIdentity }
	| { kind: "missing" | "unsupported" | "unavailable" };

/** Require native session evidence, not a pane label, cwd, or title. */
export function parseNativePane(
	output: string,
	paneId: string,
): NativeInspection {
	try {
		const parsed = JSON.parse(output);
		if (
			parsed?.error?.code === "pane_not_found" ||
			parsed?.error?.code === "not_found"
		)
			return { kind: "missing" };
		if (parsed?.error) return { kind: "unavailable" };
		return inspectReportedPane(parsed?.result?.pane, paneId);
	} catch {
		return { kind: "unavailable" };
	}
}

function inspectReportedPane(
	pane: JsonValue | undefined,
	paneId: string,
): NativeInspection {
	if (
		!isRecord(pane) ||
		pane.pane_id !== paneId ||
		!isString(pane.terminal_id) ||
		!pane.terminal_id
	)
		return { kind: "unavailable" };
	if (pane.agent !== "claude" && pane.agent !== "codex")
		return { kind: "unsupported" };
	const session = pane.agent_session;
	if (
		!isRecord(session) ||
		session.agent !== pane.agent ||
		session.kind !== "id" ||
		session.source !== `herdr:${pane.agent}` ||
		!isString(session.value) ||
		!session.value
	)
		return { kind: "unavailable" };
	const status = pane.agent_status;
	return {
		kind: "present",
		identity: {
			paneId,
			terminalId: pane.terminal_id,
			agent: pane.agent,
			sessionId: session.value,
			status:
				status === "idle" ||
				status === "working" ||
				status === "blocked" ||
				status === "done"
					? status
					: "unknown",
		},
	};
}

/** A complete, unfiltered list is required before absence can remove a row. */
export function parseNativePaneSnapshot(
	output: string,
): Map<string, NativeInspection> | null {
	try {
		const parsed = JSON.parse(output);
		const panes = parsed?.result?.panes;
		if (
			parsed?.error ||
			parsed?.result?.type !== "pane_list" ||
			!Array.isArray(panes)
		)
			return null;
		const snapshot = new Map<string, NativeInspection>();
		for (const pane of panes) {
			if (
				!isPlainObject(pane) ||
				!isString(pane.pane_id) ||
				!pane.pane_id ||
				!isString(pane.workspace_id) ||
				!pane.workspace_id ||
				!isString(pane.terminal_id) ||
				!pane.terminal_id ||
				snapshot.has(pane.pane_id)
			)
				return null;
			snapshot.set(pane.pane_id, inspectReportedPane(pane, pane.pane_id));
		}
		return snapshot;
	} catch {
		return null;
	}
}

export async function inspectNativePanes(): Promise<Map<
	string,
	NativeInspection
> | null> {
	try {
		return parseNativePaneSnapshot(await readHerdr(["pane", "list"]));
	} catch {
		return null;
	}
}

async function readHerdr(args: string[]): Promise<string> {
	if (!isHerdrAvailable())
		throw new Error("Native tracking requires Pi inside Herdr.");
	const { stdout } = await execFileAsync("herdr", args, {
		encoding: "utf8",
		timeout: 3000,
		killSignal: "SIGKILL",
	});
	return stdout;
}

export async function inspectNativePane(
	paneId: string,
): Promise<NativeInspection> {
	try {
		return parseNativePane(await readHerdr(["pane", "get", paneId]), paneId);
	} catch (error: any) {
		// Only a structured not-found response establishes absence. Transport
		// failures and malformed output retain the row as unknown.
		if (error) {
			for (const output of [error.stderr, error.stdout]) {
				if (
					isString(output) &&
					parseNativePane(output, paneId).kind === "missing"
				)
					return { kind: "missing" };
			}
		}
		return { kind: "unavailable" };
	}
}

export async function currentNativeObserverPane(): Promise<string> {
	const parsed = JSON.parse(await readHerdr(["pane", "current", "--current"]));
	const paneId = parsed?.result?.pane?.pane_id;
	if (!isString(paneId) || !paneId)
		throw new Error("Cannot verify the parent Herdr pane.");
	return paneId;
}
