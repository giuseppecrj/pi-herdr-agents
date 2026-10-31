/**
 * The SurfaceProvider seam: the multiplexer is swappable infrastructure, not
 * a foundation. pi-herdr-agents hard-requires Herdr; here Herdr is one
 * provider among many, behind this interface.
 *
 * Methods may be sync or async; providers choose. The CLI is the only place
 * that wires a provider to an adapter (via core's SurfaceHandle).
 */
import { isPlainObject, isString } from "./config/type-guards.ts";
import type {
	OpenedPrimaryWorkspaceReport,
	PrimaryWorkspaceClaim,
} from "./opened-primary-workspace.ts";
import type { PaneInspection, SurfaceHandle } from "./types.ts";

// pi-herdr-agents extension
export type SurfacePlacement =
	| { kind: "grouped" }
	| { kind: "split"; direction: "right" | "down" }
	| { kind: "tab" };

export interface SurfaceInfo {
	id: string;
	name?: string;
	cwd?: string;
	/** Tab or window the surface belongs to. */
	// pi-herdr-agents extension
	group?: string;
	/** Provider-native workspace/container id when the provider reports one. */
	// pi-herdr-agents extension
	workspaceId?: string;
}

export interface AcquisitionControl {
	/** Admission intent only; abort does not cancel a remote mutation. */
	signal?: AbortSignal;
}

export type UncertainAcquisition =
	| {
			kind: "surface-create";
			placement: "tab" | "split";
			workspaceId?: string;
			anchorSurfaceId?: string;
			observedSurfaceId?: string;
	  }
	| {
			kind: "worktree-create";
			sourceCwd: string;
			branch: string;
			recovered?: RecoveredWorktreeProvisioning;
	  }
	| { kind: "command-dispatch"; surfaceId: string };

/** A started mutating request has no proven outcome. Never retry it. */
export class AcquisitionUncertainError extends Error {
	readonly code = "PIHA_ACQUISITION_UNCERTAIN";
	readonly uncertainty: UncertainAcquisition;
	constructor(
		message: string,
		uncertainty: UncertainAcquisition,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AcquisitionUncertainError";
		this.uncertainty = uncertainty;
	}
}

/** Structural so errors from an earlier extension load remain recognizable. */
export function isAcquisitionUncertainError(
	error: any,
): error is AcquisitionUncertainError {
	if (error?.code !== "PIHA_ACQUISITION_UNCERTAIN" || !isString(error.message))
		return false;
	const value = error.uncertainty;
	if (!isPlainObject(value)) return false;
	switch (value.kind) {
		case "surface-create":
			return (
				"placement" in value &&
				(value.placement === "tab" || value.placement === "split")
			);
		case "worktree-create":
			return isString(value.sourceCwd) && isString(value.branch);
		case "command-dispatch":
			return isString(value.surfaceId);
		default:
			return false;
	}
}

export interface CreateSurfaceOptions extends AcquisitionControl {
	name: string;
	cwd: string;
	/** Default: { kind: "grouped" }. */
	// pi-herdr-agents extension
	placement?: SurfacePlacement;
}

export interface CreateWorktreeSurfaceOptions extends AcquisitionControl {
	name: string;
	cwd: string;
	branch: string;
	/** Base git ref or SHA the worktree starts from. */
	base: string;
}

export interface WorktreeSurface {
	path: string;
	branch: string;
	/** Provider-native workspace/container id for later removal. */
	workspaceId: string;
	surfaceId: string;
	/** Non-fatal provisioning problems the parent should see, such as a failed snapshot. */
	diagnostics?: string[];
}

export interface ReportOpenedPrimaryWorkspaceInput {
	sourceRepo: string;
	claims: readonly PrimaryWorkspaceClaim[];
}

export type RecoveredWorktreeProvisioning = Pick<
	WorktreeSurfaceInfo,
	"path" | "branch" | "workspaceId"
> & { paneId?: string };

export class WorktreeProvisioningError extends Error {
	readonly recoveredWorktree: RecoveredWorktreeProvisioning;

	constructor(
		message: string,
		recoveredWorktree: RecoveredWorktreeProvisioning,
	) {
		super(message);
		this.name = "WorktreeProvisioningError";
		this.recoveredWorktree = recoveredWorktree;
	}
}

// pi-herdr-agents extension
export interface WorktreeSurfaceInfo {
	/** Empty for detached HEAD. */
	branch: string;
	path: string;
	label?: string;
	workspaceId?: string;
	isLinkedWorktree: boolean;
}

// pi-herdr-agents extension
export interface SurfaceForegroundProcess {
	pid: number;
	name?: string;
	argv0?: string;
	argv?: string[];
	cwd?: string;
}

// pi-herdr-agents extension
export interface SurfaceProcessInfo {
	shellPid?: number;
	foregroundProcessGroupId?: number;
	pids: number[];
	foregroundProcesses: SurfaceForegroundProcess[];
}

export interface SurfaceProvider {
	/** Stable provider name, e.g. "herdr". */
	readonly name: string;

	/** False when the multiplexer is not installed/usable. Never throws. */
	isAvailable(): boolean;

	/** Create a new surface (tab/pane/window). Returns the surface id. */
	createSurface(opts: CreateSurfaceOptions): string | Promise<string>;

	/** Run a shell command in the surface (sends text + Enter). */
	runCommand(surfaceId: string, command: string): void | Promise<void>;

	/** Read visible screen text, most recent `lines` lines. */
	readScreen(surfaceId: string, lines?: number): string | Promise<string>;

	/** Close and discard a surface. */
	closeSurface(surfaceId: string): void | Promise<void>;

	listSurfaces(opts?: {
		timeoutMs?: number;
	}): SurfaceInfo[] | Promise<SurfaceInfo[]>;

	/**
	 * Wrap an already-existing surface id as a SurfaceHandle (for adapters and
	 * for `maestro kill`). Works because provider CLIs address surfaces by id.
	 */
	attachSurface(id: string): SurfaceHandle;

	/** Create a worktree-backed surface: isolated checkout + hosting surface. */
	createWorktreeSurface(
		opts: CreateWorktreeSurfaceOptions,
	): WorktreeSurface | Promise<WorktreeSurface>;

	/** Remove a worktree-backed surface created by createWorktreeSurface. */
	removeWorktreeSurface(
		workspaceId: string,
		opts?: { timeoutMs?: number },
	): void | Promise<void>;

	/**
	 * Suggest closing a claimed primary workspace that still looks untouched.
	 * Never closes it. Unsupported providers return undefined.
	 */
	reportOpenedPrimaryWorkspace(
		input: ReportOpenedPrimaryWorkspaceInput,
	):
		| OpenedPrimaryWorkspaceReport
		| undefined
		| Promise<OpenedPrimaryWorkspaceReport | undefined>;

	/** Human-readable hint when isAvailable() is false; today's terminalSetupHint(). */
	// pi-herdr-agents extension
	setupHint(): string;

	/** Write a script file and run it in the surface; today's runScriptInPane (terminal.ts:115). */
	// pi-herdr-agents extension
	runScript(
		surfaceId: string,
		command: string,
		options: { scriptPath: string; scriptPreamble: string },
	): string | Promise<string>;

	// pi-herdr-agents extension
	inspectSurface(surfaceId: string): Promise<PaneInspection>;

	// pi-herdr-agents extension
	sendKeys(surfaceId: string, keys: string): void | Promise<void>;

	// pi-herdr-agents extension
	getProcessInfo(
		surfaceId: string,
		opts?: { timeoutMs?: number },
	): SurfaceProcessInfo | Promise<SurfaceProcessInfo>;

	// pi-herdr-agents extension
	waitForShellReady(
		surfaceId: string,
		opts?: { timeoutMs?: number },
	): Promise<void>;

	// pi-herdr-agents extension
	waitForSurfaceAbsence(
		surfaceId: string,
		opts?: { timeoutMs?: number },
	): Promise<void>;

	// pi-herdr-agents extension
	listWorktreeSurfaces(opts?: {
		cwd?: string;
		timeoutMs?: number;
	}): Promise<WorktreeSurfaceInfo[]>;

	// pi-herdr-agents extension
	focusWorkspace(workspaceId: string): void | Promise<void>;

	// pi-herdr-agents extension
	setTitle(target: "tab" | "workspace", title: string): void | Promise<void>;
}
