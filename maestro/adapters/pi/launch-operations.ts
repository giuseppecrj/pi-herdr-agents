import type { PaneConfig } from "../../core/config/pane-config.ts";
import type {
	SurfaceProvider,
	AcquisitionControl,
	WorktreeSurface,
} from "../../core/surface-provider.ts";
import type { WorktreeOperations } from "../../core/worktree.ts";
import { Deadline } from "../../core/deadline.ts";
import {
	linuxProcessProbe,
	readLinuxProcessEnvironment,
	readProcessIdentityRecord,
	verifyProcessIdentityRecord,
	type PiProcessIdentity,
	type ProcessEnvironmentReader,
	type ProcessIdentityProbe,
} from "./process-identity.ts";

/** What a captured identity must match: this run, its session, and its pane. */
export interface ProcessIdentityExpectation {
	file: string;
	id: string;
	sessionFile: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface WorktreeSurfaceForLaunch {
	path: string;
	branch: string;
	workspaceId: string;
	paneId: string;
	diagnostics?: string[];
}

export interface PiLaunchOperations {
	/** Required for managed worktree launches; ordinary panes need no Git effects. */
	worktree?: WorktreeOperations;
	createPane(
		name: string,
		cwd?: string,
		control?: AcquisitionControl,
	): MaybePromise<string>;
	createWorktree(
		name: string,
		cwd: string,
		branch: string,
		base: string,
		control?: AcquisitionControl,
	): MaybePromise<WorktreeSurfaceForLaunch>;
	waitForShellReady(surface: string): Promise<void>;
	runScript(
		surface: string,
		command: string,
		options: { scriptPath: string; scriptPreamble: string },
	): MaybePromise<string>;
	/** Rollback resolves only once this ordinary pane is confirmed absent. */
	closePane(pane: string): MaybePromise<void>;
	waitForPiReady?(
		surface: string,
		sessionFile: string,
		cwd: string,
	): Promise<void>;
	focusWorkspace?(workspaceId: string): MaybePromise<void>;
	/** Bounded readiness capture of a worktree child's verified process identity. */
	captureProcessIdentity?(
		surface: string,
		expected: ProcessIdentityExpectation,
		options?: { timeoutMs?: number },
	): Promise<PiProcessIdentity>;
}

function placementFromPaneConfig(config: PaneConfig) {
	if (config.mode === "split") {
		return { kind: "split" as const, direction: config.direction };
	}
	if (config.mode === "tab") return { kind: "tab" as const };
	return { kind: "grouped" as const };
}

function worktreeSurfaceForLaunch(
	worktree: WorktreeSurface,
): WorktreeSurfaceForLaunch {
	const surface: WorktreeSurfaceForLaunch = {
		path: worktree.path,
		branch: worktree.branch,
		workspaceId: worktree.workspaceId,
		paneId: worktree.surfaceId,
	};
	if (worktree.diagnostics?.length) surface.diagnostics = worktree.diagnostics;
	return surface;
}

/**
 * Names the launched session in the Pi process's exec-time environment. Pi
 * rewrites its command line, so `--session` is never readiness evidence.
 * Nothing inside Pi reads it.
 */
export const PI_LAUNCH_SESSION_ENV = "PI_HERDR_AGENTS_SESSION";

export function isExpectedPiProcess(
	process: {
		pid: number;
		name?: string;
		argv0?: string;
		cwd?: string;
	},
	sessionFile: string,
	cwd: string,
	readEnvironment: ProcessEnvironmentReader = readLinuxProcessEnvironment,
): boolean {
	return (
		(process.name === "pi" || process.argv0?.split("/").pop() === "pi") &&
		process.cwd === cwd &&
		readEnvironment(process.pid)?.get(PI_LAUNCH_SESSION_ENV) === sessionFile
	);
}

async function waitForSurfacePiReady(
	provider: SurfaceProvider,
	surface: string,
	sessionFile: string,
	cwd: string,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Deadline.after(timeoutMs);
	let lastError = "expected Pi process not observed";

	while (!deadline.expired()) {
		try {
			const info = await provider.getProcessInfo(surface, {
				timeoutMs: deadline.remainingMs(),
			});
			deadline.remainingMs();
			// An unreadable process (one that is exiting) proves nothing, but must
			// not hide a matching sibling.
			for (const process of info.foregroundProcesses) {
				try {
					if (isExpectedPiProcess(process, sessionFile, cwd)) return;
				} catch (error) {
					lastError = errorMessage(error);
				}
			}
		} catch (error) {
			lastError = errorMessage(error);
		}
		if (deadline.expired()) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, deadline.remainingMs())),
		);
	}
	throw new Error(
		`Timed out waiting for Pi session ${sessionFile} in Herdr pane ${surface}: ${lastError}`,
	);
}

/**
 * Wait for the child to publish its own identity, then accept it only while
 * that process is alive in this host's namespace as the Herdr pane shell or a
 * descendant of it. Command-line text is never consulted: Pi rewrites it.
 */
export async function captureSurfacePiProcessIdentity(
	provider: Pick<SurfaceProvider, "getProcessInfo">,
	surface: string,
	expected: ProcessIdentityExpectation,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		probe?: ProcessIdentityProbe;
	} = {},
): Promise<PiProcessIdentity> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const intervalMs = options.intervalMs ?? 100;
	const deadline = Date.now() + timeoutMs;
	let lastError = "the child has not recorded its process identity";
	let answered = false;
	for (;;) {
		if (Date.now() >= deadline) break;
		try {
			const record = readProcessIdentityRecord(expected.file);
			if (record) {
				// The deadline bounds Herdr too; a late answer is dropped, never accepted.
				const info = await settleBefore(
					Promise.resolve().then(() => {
						const remaining = deadline - Date.now();
						if (remaining <= 0) return undefined;
						return provider.getProcessInfo(surface, { timeoutMs: remaining });
					}),
					deadline,
					{ unref: true },
				);
				if (!info) {
					// The deadline passed; an earlier answer's refusal says more.
					if (!answered)
						lastError = `Herdr process info for pane ${surface} timed out`;
					break;
				}
				answered = true;
				if (info.shellPid === undefined)
					throw new Error(`Herdr reports no shell for pane ${surface}`);
				return verifyProcessIdentityRecord(
					record,
					{ ...expected, shellPid: info.shellPid },
					options.probe ?? linuxProcessProbe,
				);
			}
		} catch (error) {
			lastError = errorMessage(error);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		// Background capture must never hold the parent process open.
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, remaining)).unref(),
		);
	}
	throw new Error(
		`Process identity not captured within ${timeoutMs}ms: ${lastError}`,
	);
}

/**
 * The pending value if it settles before the deadline; otherwise undefined.
 * A value that arrives after the deadline is dropped, never reported, even
 * when a delayed event loop runs it before the overdue timer.
 */
export async function settleBefore<T>(
	pending: Promise<T> | undefined,
	deadline: number,
	options: { unref?: boolean } = {},
): Promise<T | undefined> {
	if (!pending) return undefined;
	let expire!: () => void;
	const expired = new Promise<undefined>((resolve) => {
		expire = () => resolve(undefined);
	});
	const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
	if (options.unref) timer.unref();
	try {
		const onTime = pending.then((value) =>
			Date.now() > deadline ? undefined : value,
		);
		return await Promise.race([onTime, expired]);
	} finally {
		clearTimeout(timer);
	}
}

export function launchOperationsFromSurface(
	provider: SurfaceProvider,
	config: PaneConfig,
	worktree?: WorktreeOperations,
): PiLaunchOperations {
	return {
		worktree,
		createPane(name, cwd, control) {
			return provider.createSurface({
				name,
				cwd: cwd ?? process.cwd(),
				placement: placementFromPaneConfig(config),
				signal: control?.signal,
			});
		},
		async createWorktree(name, cwd, branch, base, control) {
			const worktree = await Promise.resolve(
				provider.createWorktreeSurface({
					name,
					cwd,
					branch,
					base,
					signal: control?.signal,
				}),
			);
			return worktreeSurfaceForLaunch(worktree);
		},
		waitForShellReady(surface) {
			return provider.waitForShellReady(surface);
		},
		runScript(surface, command, options) {
			return provider.runScript(surface, command, options);
		},
		async closePane(pane) {
			let closeError: unknown;
			try {
				await provider.closeSurface(pane);
			} catch (error) {
				closeError = error;
			}
			try {
				await provider.waitForSurfaceAbsence(pane);
			} catch (error) {
				throw new Error(
					`${closeError ? `${errorMessage(closeError)}; ` : ""}${errorMessage(error)}`,
				);
			}
		},
		waitForPiReady(surface, sessionFile, cwd) {
			return waitForSurfacePiReady(provider, surface, sessionFile, cwd);
		},
		focusWorkspace(workspaceId) {
			return provider.focusWorkspace(workspaceId);
		},
		captureProcessIdentity(surface, expected, options) {
			return captureSurfacePiProcessIdentity(
				provider,
				surface,
				expected,
				options,
			);
		},
	};
}

function errorMessage(error: any): string {
	return error instanceof Error ? error.message : String(error);
}
