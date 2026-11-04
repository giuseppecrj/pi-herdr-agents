import {
	isBoolean,
	isNonEmptyString,
	isRecord,
	type JsonObject,
} from "./config/type-guards.ts";
import type { WorktreeResultState } from "./worktree.ts";

/** Recognition of v1 is not proof of Git identity or cleanup eligibility. */
export interface LegacyWorktreeOwnership extends Readonly<JsonObject> {
	readonly version: 1;
	readonly kind: "worktree-run";
	readonly owner: "pi-herdr-subagents";
	readonly backend: "legacy";
}

export type CoreWorktreeResourceRole = "execution" | "retained-shell";

/** Only a confirmed acquisition may be recorded here, never a list/recovery hit. */
export interface CoreWorktreeResource {
	readonly role: CoreWorktreeResourceRole;
	readonly address: string;
	readonly createdAt: number;
}

export interface CoreWorktreeServerIdentity {
	readonly socket: string;
	readonly coreId: string;
}

export interface CoreWorktreeTerminalIdentity
	extends CoreWorktreeServerIdentity {
	readonly address: string;
	readonly createdAt: number;
	/** Native terminal ancestry, not the invoking session's current parent. */
	readonly parentTerminal: string;
}

export interface CoreWorktreeHandoff {
	readonly headSha: string | null;
	readonly commitsAhead: number | null;
	readonly clean: boolean | null;
	readonly conflicted: boolean | null;
	readonly changedFiles: readonly string[] | null;
	readonly untrackedFiles: readonly string[] | null;
	readonly gitError?: string;
}

/** Staged receipt only: no runtime currently creates or acts on Core worktrees. */
export interface CoreWorktreeOwnership extends CoreWorktreeServerIdentity {
	readonly version: 2;
	readonly kind: "worktree-run";
	readonly owner: "pi-herdr-subagents";
	readonly backend: "core";
	readonly id: string;
	readonly runToken: string;
	readonly parentTerminal: string;
	readonly sourceCwd: string;
	readonly principalCwd: string;
	readonly commonGitDir: string;
	readonly intendedPath: string;
	readonly branch: string;
	readonly baseRef: string;
	readonly baseSha: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly state: "provisioning" | "provisioned" | WorktreeResultState;
	readonly resources: readonly CoreWorktreeResource[];
	readonly acquisitionUncertain: boolean;
	/** Diagnostic evidence only; these addresses never authorize control. */
	readonly observedTerminalIds: readonly string[];
	readonly handoff?: CoreWorktreeHandoff;
}

export type WorktreeOwnership = LegacyWorktreeOwnership | CoreWorktreeOwnership;

export class WorktreeOwnershipError extends Error {
	readonly code: "invalid-receipt" | "identity-mismatch" | "invalid-update";
	constructor(code: WorktreeOwnershipError["code"], detail: string) {
		super(`Worktree ownership ${code}: ${detail}`);
		this.name = "WorktreeOwnershipError";
		this.code = code;
	}
}

const CORE_IDENTITY_FIELDS = [
	"version",
	"kind",
	"owner",
	"backend",
	"id",
	"runToken",
	"socket",
	"coreId",
	"parentTerminal",
	"sourceCwd",
	"principalCwd",
	"commonGitDir",
	"intendedPath",
	"branch",
	"baseRef",
	"baseSha",
	"createdAt",
] as const;
const LEGACY_IDENTITY_FIELDS = [
	"id",
	"sourceCwd",
	"branch",
	"baseRef",
	"baseSha",
	"createdAt",
	"path",
	"workspaceId",
	"paneId",
	"manifestFile",
	"sessionFile",
] as const;
const STATES = new Set([
	"provisioning",
	"provisioned",
	"running",
	"ready_for_review",
	"failed",
	"needs_help",
	"cancelled",
	"removed",
]);

function invalid(detail: string): never {
	throw new WorktreeOwnershipError("invalid-receipt", detail);
}
function text(value: any): value is string {
	return isNonEmptyString(value) && !value.includes("\0");
}
function timestamp(value: any): value is number {
	return Number.isSafeInteger(value) && value >= 0;
}
function address(value: any): value is string {
	return text(value) && /^t[0-9a-z]+$/.test(value);
}
function absolutePath(value: any): value is string {
	return text(value) && value.startsWith("/");
}
function strings(value: any): value is string[] {
	return Array.isArray(value) && value.every(text);
}
function parseHandoff(value: any): CoreWorktreeHandoff {
	if (
		!isRecord(value) ||
		(value.headSha !== null && !text(value.headSha)) ||
		(value.commitsAhead !== null && !timestamp(value.commitsAhead)) ||
		(value.clean !== null && !isBoolean(value.clean)) ||
		(value.conflicted !== null && !isBoolean(value.conflicted)) ||
		(value.changedFiles !== null && !strings(value.changedFiles)) ||
		(value.untrackedFiles !== null && !strings(value.untrackedFiles)) ||
		(value.gitError !== undefined && !text(value.gitError))
	)
		return invalid("malformed Core Git handoff");
	return {
		headSha: value.headSha,
		commitsAhead: value.commitsAhead,
		clean: value.clean,
		conflicted: value.conflicted,
		changedFiles: value.changedFiles === null ? null : [...value.changedFiles],
		untrackedFiles:
			value.untrackedFiles === null ? null : [...value.untrackedFiles],
		gitError: value.gitError,
	};
}

/** Parse untrusted JSON without effects; unknown backends never become legacy. */
export function parseWorktreeOwnership(value: any): WorktreeOwnership {
	if (
		!isRecord(value) ||
		value.kind !== "worktree-run" ||
		value.owner !== "pi-herdr-subagents"
	)
		return invalid("unrecognized owner or kind");
	if (
		value.version === 1 &&
		(!Object.hasOwn(value, "backend") || value.backend === "legacy")
	)
		return {
			...value,
			version: 1,
			kind: "worktree-run",
			owner: "pi-herdr-subagents",
			backend: "legacy",
		};
	if (value.version !== 2 || value.backend !== "core")
		return invalid("unsupported version/backend combination");
	if (
		!text(value.id) ||
		!text(value.runToken) ||
		!absolutePath(value.socket) ||
		!text(value.coreId) ||
		!address(value.parentTerminal) ||
		!absolutePath(value.sourceCwd) ||
		!absolutePath(value.principalCwd) ||
		!absolutePath(value.commonGitDir) ||
		!absolutePath(value.intendedPath) ||
		!text(value.branch) ||
		!text(value.baseRef) ||
		!text(value.baseSha) ||
		!timestamp(value.createdAt) ||
		!timestamp(value.updatedAt) ||
		value.updatedAt < value.createdAt ||
		!text(value.state) ||
		!STATES.has(value.state) ||
		!Array.isArray(value.resources) ||
		!isBoolean(value.acquisitionUncertain) ||
		!Array.isArray(value.observedTerminalIds) ||
		!value.observedTerminalIds.every(address)
	)
		return invalid("missing or malformed Core receipt fields");
	// Core has no workspace or pane; accepting a surrogate would blur ownership.
	if (
		["workspaceId", "paneId", "path"].some((key) => Object.hasOwn(value, key))
	)
		return invalid(
			"Core receipts cannot contain legacy workspace/pane/path fields",
		);
	const roles = new Set<CoreWorktreeResourceRole>();
	const addresses = new Set<string>([value.parentTerminal]);
	const resources: CoreWorktreeResource[] = value.resources.map((resource) => {
		if (
			!isRecord(resource) ||
			(resource.role !== "execution" && resource.role !== "retained-shell") ||
			!address(resource.address) ||
			!timestamp(resource.createdAt)
		)
			return invalid("malformed acquired resource");
		if (roles.has(resource.role) || addresses.has(resource.address))
			return invalid(
				"duplicate resource role or terminal collision (including parent)",
			);
		roles.add(resource.role);
		addresses.add(resource.address);
		return {
			role: resource.role,
			address: resource.address,
			createdAt: resource.createdAt,
		};
	});
	if (
		new Set(value.observedTerminalIds).size !== value.observedTerminalIds.length
	)
		return invalid("duplicate observed terminal");
	return {
		version: 2,
		kind: "worktree-run",
		owner: "pi-herdr-subagents",
		backend: "core",
		id: value.id,
		runToken: value.runToken,
		socket: value.socket,
		coreId: value.coreId,
		parentTerminal: value.parentTerminal,
		sourceCwd: value.sourceCwd,
		principalCwd: value.principalCwd,
		commonGitDir: value.commonGitDir,
		intendedPath: value.intendedPath,
		branch: value.branch,
		baseRef: value.baseRef,
		baseSha: value.baseSha,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		// SAFETY: state was checked against the closed STATES set above.
		state: value.state as CoreWorktreeOwnership["state"],
		resources,
		acquisitionUncertain: value.acquisitionUncertain,
		observedTerminalIds: [...value.observedTerminalIds],
		handoff:
			value.handoff === undefined ? undefined : parseHandoff(value.handoff),
	};
}

/** Compare to the recorded server ID, even in a new parent process. */
export function assertCoreWorktreeServer(
	receipt: CoreWorktreeOwnership,
	expected: CoreWorktreeServerIdentity,
): void {
	if (receipt.socket !== expected.socket || receipt.coreId !== expected.coreId)
		throw new WorktreeOwnershipError(
			"identity-mismatch",
			"Core server differs from receipt",
		);
}

/**
 * Match resource identity only, not the current program's control eligibility.
 * A future controller must also verify argv/cwd and non-restoring execution policy;
 * a kept terminal recovering as a shell retains this same terminal identity.
 */
export function assertCoreWorktreeResource(
	receipt: CoreWorktreeOwnership,
	role: CoreWorktreeResourceRole,
	expected: CoreWorktreeTerminalIdentity,
): CoreWorktreeResource {
	assertCoreWorktreeServer(receipt, expected);
	const resource = receipt.resources.find((entry) => entry.role === role);
	if (
		!resource ||
		resource.address !== expected.address ||
		resource.createdAt !== expected.createdAt ||
		receipt.parentTerminal !== expected.parentTerminal
	)
		throw new WorktreeOwnershipError(
			"identity-mismatch",
			"acquired terminal identity differs from receipt",
		);
	return resource;
}

/** Validate a complete replacement snapshot, not a patch; neither input is mutated. */
export function validateWorktreeOwnershipUpdate(
	previous: WorktreeOwnership,
	value: any,
): WorktreeOwnership {
	const next = parseWorktreeOwnership(value);
	const reject = (detail: string): never => {
		throw new WorktreeOwnershipError("invalid-update", detail);
	};
	if (previous.backend !== next.backend) return reject("backend is immutable");
	if (
		previous.acquisitionUncertain === true &&
		next.acquisitionUncertain !== true
	)
		return reject(
			"acquisition uncertainty cannot be cleared without reconciliation",
		);
	if (previous.backend === "legacy" && next.backend === "legacy") {
		for (const field of LEGACY_IDENTITY_FIELDS)
			if (previous[field] !== undefined && previous[field] !== next[field])
				return reject(`${field} is immutable once recorded`);
		return next;
	}
	if (previous.backend !== "core" || next.backend !== "core")
		return reject("version is immutable");
	for (const field of CORE_IDENTITY_FIELDS)
		if (previous[field] !== next[field]) return reject(`${field} is immutable`);
	if (next.updatedAt < previous.updatedAt)
		return reject("updatedAt cannot regress");
	if (
		next.resources.length < previous.resources.length ||
		previous.resources.some((resource, index) => {
			const updated = next.resources[index];
			return (
				!updated ||
				resource.role !== updated.role ||
				resource.address !== updated.address ||
				resource.createdAt !== updated.createdAt
			);
		})
	)
		return reject("acquired resources are append-only");
	if (
		next.observedTerminalIds.length < previous.observedTerminalIds.length ||
		previous.observedTerminalIds.some(
			(id, index) => next.observedTerminalIds[index] !== id,
		)
	)
		return reject("observed terminal evidence is append-only");
	return next;
}
