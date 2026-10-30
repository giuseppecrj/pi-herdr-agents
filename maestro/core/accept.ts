/**
 * The accept check (delegation outcome contract v0.1): a caller-supplied shell
 * command the child runs before it finishes and the parent re-runs to decide
 * a verdict from a closed set. The host enforces this mechanism; which command
 * to run is the caller's or its pack's policy (ADR-0013, ADR-0017).
 *
 * This module is pure: spec validation, the verdict model, its one-line
 * description, and the outcome-ledger line. Running a command lives in
 * `adapters/pi/accept-runner.ts`.
 */
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { isFiniteNumber, isRecord, isString } from "./config/type-guards.ts";

/** The closed verdict set. A sixth value is a contract change. */
export const ACCEPT_VERDICTS = [
	"accepted",
	"rejected",
	"error",
	"skipped",
	"none",
] as const;
export type AcceptVerdict = (typeof ACCEPT_VERDICTS)[number];

export const ACCEPT_DEFAULT_MAX_RETRIES = 1;
export const ACCEPT_MAX_RETRIES = 5;
export const ACCEPT_DEFAULT_TIMEOUT_SEC = 600;
export const ACCEPT_MAX_TIMEOUT_SEC = 3600;
/** SIGTERM to the check's process group, then SIGKILL after this grace. */
export const ACCEPT_KILL_GRACE_MS = 5_000;
/** The shorter SIGKILL grace when the check's owner shuts down. */
export const ACCEPT_SHUTDOWN_GRACE_MS = 1_000;
/** Combined output kept while a check runs. */
export const ACCEPT_CAPTURE_CHARS = 64 * 1024;
/** Failing output the child receives as its retry message. */
export const ACCEPT_CHILD_OUTPUT_CHARS = 4_000;
/** Raw parent re-check output kept in structured details. */
export const ACCEPT_DETAILS_OUTPUT_CHARS = 4_000;
/** Parent re-check output shown, encoded, in the delivery. */
export const ACCEPT_PARENT_OUTPUT_CHARS = 1_500;
/** The child reads its spec from this JSON file; the command never sits in env. */
export const ACCEPT_FILE_ENV = "PI_SUBAGENT_ACCEPT_FILE";
/** Custom message type of the child's retry message. */
export const ACCEPT_RETRY_MESSAGE_TYPE = "subagent-accept-check";

/** The `accept` tool parameter as the caller sends it. */
export interface AcceptRequest {
	run: string;
	maxRetries?: number;
	timeoutSec?: number;
	paths?: string[];
}

/** A validated check with defaults applied. */
export interface AcceptSpec {
	run: string;
	maxRetries: number;
	timeoutSec: number;
	/** Repo-relative check files; changes the child made to them are reported. */
	paths: string[];
}

/** What the child's own check loop recorded in its `.exit` sidecar. */
export interface ChildAcceptReport {
	tries: number;
	childVerdict: "passed" | "failed";
	lastExitCode?: number;
	timedOut: boolean;
}

/** How one run of the check command ended. */
export type AcceptCommandResult =
	| { kind: "exit"; exitCode: number; output: string }
	| { kind: "timeout"; output: string }
	| { kind: "signal"; signal: string; output: string }
	| { kind: "cwd-missing"; output: string }
	| { kind: "spawn-error"; error: string; output: string }
	| { kind: "aborted"; output: string };

/** The verdict a delivery carries, with its structured evidence. */
export interface AcceptOutcome {
	verdict: AcceptVerdict;
	/** Why the verdict is `skipped` or `error`, as closed host text. */
	reason?: string;
	/** Child check runs, from its sidecar; absent when unknown. */
	tries?: number;
	childVerdict?: ChildAcceptReport["childVerdict"];
	/** Exit code of the parent's re-check. */
	exitCode?: number;
	timeoutSec?: number;
	/** `sha256:<hex>` of the command; never the command itself. */
	checkHash?: string;
	/** Where the parent re-check ran. */
	cwd?: string;
	/** The re-check ran in a checkout other writers may share. */
	sharedCheckout?: boolean;
	/** Check files under `paths` that the child changed; the verdict is unchanged. */
	changedCheckFiles?: string[];
	/** Raw tail of the parent re-check output, for `rejected` and `error` only. */
	output?: string;
}

function invalid(message: string): never {
	throw new Error(`Invalid accept check: ${message}`);
}

function boundedInteger(
	value: number | undefined,
	name: string,
	min: number,
	max: number,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (
		!isFiniteNumber(value) ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	)
		invalid(`${name} must be an integer from ${min} to ${max}`);
	return value;
}

function normalizeCheckPath(path: string): string {
	if (!isString(path) || !path.trim()) invalid("paths must be non-empty");
	const raw = path.trim();
	if (raw.startsWith("/") || raw.split("/").some((segment) => segment === ".."))
		invalid(`paths must be repo-relative without "..": ${path}`);
	// "." and "./" select the whole checkout.
	return posix.normalize(raw).replace(/\/+$/, "") || ".";
}

/**
 * Validate an `accept` request and apply its defaults. The tool schema
 * already checked its shape; this re-checks bounds for non-schema callers.
 */
export function normalizeAcceptSpec(request: AcceptRequest): AcceptSpec {
	if (!isRecord(request)) invalid("accept must be an object");
	const unsupported = Object.keys(request).filter(
		(key) => !["run", "maxRetries", "timeoutSec", "paths"].includes(key),
	);
	if (unsupported.length)
		invalid(`unsupported key(s): ${unsupported.join(", ")}`);
	const { run, paths } = request;
	if (!isString(run) || !run.trim()) invalid("run must be a non-empty command");
	if (paths !== undefined && !Array.isArray(paths))
		invalid("paths must be an array of repo-relative paths");
	return {
		run,
		maxRetries: boundedInteger(
			request.maxRetries,
			"maxRetries",
			0,
			ACCEPT_MAX_RETRIES,
			ACCEPT_DEFAULT_MAX_RETRIES,
		),
		timeoutSec: boundedInteger(
			request.timeoutSec,
			"timeoutSec",
			1,
			ACCEPT_MAX_TIMEOUT_SEC,
			ACCEPT_DEFAULT_TIMEOUT_SEC,
		),
		paths: [...new Set((paths ?? []).map(normalizeCheckPath))],
	};
}

/**
 * v1 supports only auto-exit, non-persistent children: an interactive child
 * closes through `subagent_done`, and a persistent specialist settles per task.
 */
export function acceptLaunchRefusal(behavior: {
	persistent: boolean;
	autoExit: boolean;
}): string | undefined {
	if (behavior.persistent)
		return "accept is not supported for persistent specialists; a check would apply per task, not per run.";
	if (!behavior.autoExit)
		return "accept requires an auto-exit child; interactive children close through subagent_done, which runs no check.";
	return undefined;
}

/** Parse the child's sidecar report; anything malformed is treated as unknown. */
export function parseChildAcceptReport(
	// Raw JSON from the child-written sidecar, typed `any` at the boundary.
	raw: any,
): ChildAcceptReport | undefined {
	if (!isRecord(raw)) return undefined;
	const { tries, childVerdict, lastExitCode, timedOut } = raw;
	if (
		!isFiniteNumber(tries) ||
		!Number.isInteger(tries) ||
		tries < 1 ||
		(childVerdict !== "passed" && childVerdict !== "failed")
	)
		return undefined;
	const report: ChildAcceptReport = {
		tries,
		childVerdict,
		timedOut: timedOut === true,
	};
	if (isFiniteNumber(lastExitCode) && Number.isInteger(lastExitCode))
		report.lastExitCode = lastExitCode;
	return report;
}

export function acceptCheckHash(run: string): string {
	return `sha256:${createHash("sha256").update(run).digest("hex")}`;
}

/** Changed files equal to, or under, a check path. */
export function changedCheckFiles(
	paths: readonly string[],
	files: readonly string[],
): string[] {
	if (!paths.length) return [];
	return [...new Set(files)].filter((file) => {
		const normalized = posix.normalize(file);
		return paths.some(
			(path) =>
				path === "." ||
				normalized === path ||
				normalized.startsWith(`${path}/`),
		);
	});
}

/** Keep the last `count` characters. */
export function outputTail(output: string, count: number): string {
	return output.length <= count ? output : output.slice(-count);
}

/**
 * The parent re-check decides the verdict; the child's report is evidence.
 * `aborted` means an operator cancel stopped the re-check (settled default).
 */
export function verdictFromCommand(
	result: AcceptCommandResult,
	spec: AcceptSpec,
	child: ChildAcceptReport | undefined,
): AcceptOutcome {
	const outcome: AcceptOutcome = {
		verdict: "error",
		checkHash: acceptCheckHash(spec.run),
		timeoutSec: spec.timeoutSec,
	};
	if (child) {
		outcome.tries = child.tries;
		outcome.childVerdict = child.childVerdict;
	}
	const tail = outputTail(result.output, ACCEPT_DETAILS_OUTPUT_CHARS);
	switch (result.kind) {
		case "exit":
			outcome.exitCode = result.exitCode;
			outcome.verdict = result.exitCode === 0 ? "accepted" : "rejected";
			break;
		case "aborted":
			outcome.verdict = "skipped";
			outcome.reason = "cancelled";
			break;
		case "timeout":
			outcome.reason = `timed out after ${spec.timeoutSec}s`;
			break;
		case "signal":
			outcome.reason = `killed by signal ${result.signal}`;
			break;
		case "cwd-missing":
			outcome.reason = "check directory is missing";
			break;
		case "spawn-error":
			outcome.reason = `could not start: ${result.error}`;
			break;
	}
	if ((outcome.verdict === "rejected" || outcome.verdict === "error") && tail)
		outcome.output = tail;
	return outcome;
}

/** A requested check whose run did not complete naturally is skipped. */
export function skippedOutcome(
	spec: AcceptSpec,
	reason: string,
): AcceptOutcome {
	return {
		verdict: "skipped",
		reason,
		checkHash: acceptCheckHash(spec.run),
		timeoutSec: spec.timeoutSec,
	};
}

function tries(count: number): string {
	return `${count} ${count === 1 ? "try" : "tries"}`;
}

/** The verdict and its detail after `Check: `, for example `accepted (2 tries)`. */
export function describeAcceptVerdict(
	outcome: AcceptOutcome | undefined,
): string {
	if (!outcome || outcome.verdict === "none") return "none";
	switch (outcome.verdict) {
		case "accepted":
			if (outcome.childVerdict === "failed" && outcome.tries !== undefined)
				return `accepted (child reported a failure after ${tries(outcome.tries)}; parent re-check passed)`;
			return outcome.tries === undefined
				? "accepted"
				: `accepted (${tries(outcome.tries)})`;
		case "rejected":
			if (outcome.childVerdict === "passed")
				return `rejected (child reported a pass; parent re-check exit ${outcome.exitCode})`;
			return outcome.tries === undefined
				? `rejected (exit ${outcome.exitCode})`
				: `rejected after ${tries(outcome.tries)} (exit ${outcome.exitCode})`;
		default:
			return outcome.reason
				? `${outcome.verdict} (${outcome.reason})`
				: outcome.verdict;
	}
}

/** One outcome-ledger line: never task text, check output, env, or the command. */
export interface OutcomeLedgerLine {
	v: 1;
	at: string;
	runId: string;
	attempt: number;
	role?: string;
	requestedModel?: string;
	category?: string;
	model?: string;
	thinking?: string;
	elapsedSec: number;
	outcome: "completed" | "failed" | "help" | "cancelled";
	checkTries?: number;
	verdict: AcceptVerdict;
	checkHash?: string;
}

export const OUTCOME_LEDGER_FILE = "outcomes.jsonl";

export function buildOutcomeLedgerLine(input: {
	at: number;
	runId: string;
	attempt: number;
	role?: string;
	requestedModel?: string;
	model?: string;
	thinking?: string;
	elapsedSec: number;
	outcome: OutcomeLedgerLine["outcome"];
	accept?: AcceptOutcome;
}): OutcomeLedgerLine {
	const line: OutcomeLedgerLine = {
		v: 1,
		at: new Date(input.at).toISOString(),
		runId: input.runId,
		attempt: input.attempt,
		elapsedSec: input.elapsedSec,
		outcome: input.outcome,
		verdict: input.accept?.verdict ?? "none",
	};
	if (input.role) line.role = input.role;
	if (input.requestedModel) {
		line.requestedModel = input.requestedModel;
		const category = /^task:(.+)$/i.exec(input.requestedModel.trim())?.[1];
		if (category) line.category = category.trim().toLowerCase();
	}
	if (input.model) line.model = input.model;
	if (input.thinking) line.thinking = input.thinking;
	if (input.accept?.tries !== undefined) line.checkTries = input.accept.tries;
	if (input.accept?.checkHash) line.checkHash = input.accept.checkHash;
	return line;
}
