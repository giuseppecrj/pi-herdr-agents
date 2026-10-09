import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getSubagentActivityFile } from "./activity-file.ts";
import {
	createLifecycle,
	type SubagentLifecycle,
} from "../../core/lifecycle.ts";
import type { ResolvedRuntimePlan } from "../../core/routing.ts";
import type { PaneConfig } from "../../core/config/pane-config.ts";
import { isNonEmptyString } from "../../core/config/type-guards.ts";
import { shellQuote } from "../../core/shell.ts";
import type {
	SurfaceProvider,
	WorktreeSurface,
} from "../../core/surface-provider.ts";
import { WorktreeProvisioningError } from "../../core/surface-provider.ts";
import type {
	FailedWorktreeManifest,
	WorktreeLaunch,
	WorktreeOperations,
} from "../../core/worktree.ts";
import {
	getSubagentProcessIdentityFile,
	linuxProcessProbe,
	readLinuxProcessEnvironment,
	readProcessIdentityRecord,
	verifyProcessIdentityRecord,
	type PiProcessIdentity,
	type ProcessEnvironmentReader,
	type ProcessIdentityProbe,
} from "./process-identity.ts";
import {
	createWorktreeSessionFork,
	getNewEntries,
	readSubagentSessionPolicy,
	seedSubagentSessionFile,
	writeSubagentSessionPolicy,
} from "./session.ts";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface FreshPiLaunchRequest {
	kind: "fresh";
	id?: string;
	name: string;
	task: string;
	agent?: string;
	cwd?: string;
	worktree?: { branch: string; base?: string } | null;
	fork?: boolean;
	handoff?: { leafId: string };
	surface?: string;
	/** Ordinary children record their process identity too (sidebar markers). */
	recordProcessIdentity?: boolean;
	parent: {
		cwd: string;
		invocationCwd?: string;
		sessionFile: string;
		sessionId: string;
		sessionDir: string;
		agentDir?: string;
	};
	runtimePlan: ResolvedRuntimePlan;
	behavior: {
		tools?: string;
		skills?: string;
		deniedTools: readonly string[];
		autoExit: boolean;
		interactive: boolean;
		persistent?: boolean;
		logicalId?: string;
		generationId?: string;
		taskId?: string;
		identity?: string;
		systemPromptMode?: "append" | "replace";
		sessionMode: SubagentSessionMode;
		cwd?: string;
	};
}

export interface ResumePiLaunchRequest {
	kind: "resume";
	id?: string;
	name: string;
	sessionFile: string;
	message?: string;
	/** Record the resumed process's identity (sidebar markers). */
	recordProcessIdentity?: boolean;
	parent: {
		sessionId: string;
		sessionDir: string;
	};
	behavior?: {
		autoExit?: boolean;
		interactive?: boolean;
	};
}

export type PiLaunchRequest = FreshPiLaunchRequest | ResumePiLaunchRequest;

export interface PiRunningChild {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile: string;
	activityFile: string;
	interactive: boolean;
	runtimePlan: ResolvedRuntimePlan | undefined;
	worktree?: WorktreeLaunch;
	lifecycle: SubagentLifecycle;
	persistent?: boolean;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
	policyTools?: string[] | null;
	policyDeniedTools?: string[];
	tasksCompleted?: number;
	taskId?: string;
	inboxSequence?: number;
	observedTaskEvents?: number;
	stopState?: "requested" | "pending" | "failed";
	stopFailure?: string;
	crashNotified?: boolean;
	/**
	 * Where the child records its own process identity: every managed worktree
	 * child, and other children when the launch asks for it.
	 */
	processIdentityFile?: string;
	/**
	 * Verified at launch readiness. A worktree cancel's only signal and exit
	 * evidence; sidebar markers renew only while it is alive.
	 */
	processIdentity?: PiProcessIdentity;
	/** Settles when launch-readiness capture verifies or gives up; never rejects. */
	processIdentityCapture?: Promise<PiProcessIdentity | undefined>;
	processIdentityError?: string;
}

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
	createPane(name: string, cwd?: string): MaybePromise<string>;
	createWorktree(
		name: string,
		cwd: string,
		branch: string,
		base: string,
	): MaybePromise<WorktreeSurfaceForLaunch>;
	waitForShellReady(surface: string): Promise<void>;
	runScript(
		surface: string,
		command: string,
		options: { scriptPath: string; scriptPreamble: string },
	): MaybePromise<string>;
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
	const deadline = Date.now() + timeoutMs;
	let lastError = "expected Pi process not observed";

	while (Date.now() <= deadline) {
		try {
			const info = await Promise.resolve(provider.getProcessInfo(surface));
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
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
		try {
			const record = readProcessIdentityRecord(expected.file);
			if (record) {
				// The deadline bounds Herdr too; a late answer is dropped, never accepted.
				const info = await settleBefore(
					Promise.resolve().then(() => provider.getProcessInfo(surface)),
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
		createPane(name, cwd) {
			return provider.createSurface({
				name,
				cwd: cwd ?? process.cwd(),
				placement: placementFromPaneConfig(config),
			});
		},
		async createWorktree(name, cwd, branch, base) {
			const worktree = await Promise.resolve(
				provider.createWorktreeSurface({ name, cwd, branch, base }),
			);
			return worktreeSurfaceForLaunch(worktree);
		},
		waitForShellReady(surface) {
			return provider.waitForShellReady(surface);
		},
		runScript(surface, command, options) {
			return provider.runScript(surface, command, options);
		},
		closePane(pane) {
			return provider.closeSurface(pane);
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

interface ResolvedLaunch {
	request: FreshPiLaunchRequest;
	id: string;
	startTime: number;
	agentDir: string;
	localAgentDir: string | null;
	sourceCwd: string;
	artifactDir: string;
	sessionMode: SubagentSessionMode;
	taskDelivery: "direct" | "artifact";
}

interface PreparedSurface {
	surface: string;
	targetCwd: string;
	effectiveAgentDir: string;
	localAgentDir: string | null;
	worktree?: WorktreeLaunch;
}

interface PreparedSession extends PreparedSurface {
	sessionFile: string;
	activityFile: string;
	processIdentityFile?: string;
}

interface PreparedArtifacts extends PreparedSession {
	taskArg: string;
	systemPromptFile?: string;
}

/**
 * Launch one validated Pi-backed request. Lifecycle watching and parent
 * delivery begin only after this transaction returns the running child.
 */
export async function launchPiSubagent(
	request: PiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	return request.kind === "resume"
		? launchResumedPiSubagent(request, operations)
		: launchFreshPiSubagent(request, operations);
}

export async function launchPiWorktreeHandoff(
	request: FreshPiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<{ running: PiRunningChild; focusError?: string }> {
	if (!request.worktree || !request.handoff) {
		throw new Error("A worktree handoff requires a worktree and active leaf");
	}
	const running = await launchPiSubagent(request, operations);
	if (!running.worktree) {
		throw new Error("Worktree handoff did not create a managed worktree");
	}
	try {
		await operations.focusWorkspace?.(running.worktree.workspaceId);
	} catch (error) {
		const focusError = errorMessage(error);
		requireWorktreeOperations(operations).writeWorktreeManifest(
			running.worktree.manifestFile,
			{
				state: "running",
				focusError,
			},
		);
		return {
			running,
			focusError,
		};
	}
	return { running };
}

async function launchFreshPiSubagent(
	request: FreshPiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	const resolved = resolveLaunchRequest(request);
	let surface: PreparedSurface | undefined;

	try {
		surface = await prepareLaunchSurface(resolved, operations);
		const session = prepareChildSession(resolved, surface, operations);
		const handoffArtifacts = request.handoff
			? prepareTaskArtifacts(resolved, session, operations)
			: undefined;
		await confirmShellReady(session, operations);
		const artifacts =
			handoffArtifacts ?? prepareTaskArtifacts(resolved, session, operations);
		const command = buildPiCommand(resolved, artifacts);
		const launchScriptFile = await startPiProcess(
			resolved,
			artifacts,
			command,
			operations,
		);
		if (request.handoff) {
			if (!operations.waitForPiReady) {
				throw new Error("Pi startup confirmation is unavailable");
			}
			await operations.waitForPiReady(
				artifacts.surface,
				artifacts.sessionFile,
				artifacts.targetCwd,
			);
			if (artifacts.worktree) {
				requireWorktreeOperations(operations).persistWorktreeResult(
					artifacts.worktree,
					"running",
				);
			}
		}
		const running = createRunningChild(resolved, artifacts, launchScriptFile);
		startProcessIdentityCapture(running, operations);
		return running;
	} catch (error) {
		if (!surface) throw error;
		if (!surface.worktree) {
			if (!request.surface) {
				try {
					await operations.closePane(surface.surface);
				} catch {
					// The launch error remains authoritative when cleanup also fails.
				}
			}
			throw error;
		}
		const worktreeOps = requireWorktreeOperations(operations);
		const handoff = worktreeOps.captureWorktreeHandoff(surface.worktree);
		try {
			worktreeOps.persistWorktreeResult(surface.worktree, "failed", handoff);
		} catch {
			// The launch error remains authoritative when persistence also fails.
		}
		throw new Error(
			`Failed to launch subagent; worktree retained at ${surface.worktree.path} ` +
				`(workspace ${surface.worktree.workspaceId}): ${errorMessage(error)}`,
		);
	}
}

function resolveLaunchRequest(request: FreshPiLaunchRequest): ResolvedLaunch {
	const id = request.id ?? Math.random().toString(16).slice(2, 10);
	const agentDir =
		request.parent.agentDir ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".pi", "agent");
	const rawCwd = request.cwd ?? request.behavior.cwd;
	const cwdBase =
		request.cwd == null && request.behavior.cwd != null
			? agentDir
			: (request.parent.invocationCwd ?? request.parent.cwd);
	const sourceCwd = rawCwd
		? rawCwd.startsWith("/")
			? rawCwd
			: join(cwdBase, rawCwd)
		: request.parent.cwd;
	const localAgentDir = rawCwd ? join(sourceCwd, ".pi", "agent") : null;
	let sessionMode: SubagentSessionMode = request.behavior.sessionMode;
	if (request.fork === true) sessionMode = "fork";
	else if (request.fork === false) sessionMode = "standalone";
	return {
		request,
		id,
		startTime: Date.now(),
		agentDir,
		localAgentDir:
			localAgentDir && existsSync(localAgentDir) ? localAgentDir : null,
		sourceCwd,
		artifactDir: join(
			request.parent.sessionDir,
			"artifacts",
			request.parent.sessionId,
		),
		sessionMode,
		taskDelivery: sessionMode === "fork" ? "direct" : "artifact",
	};
}

async function prepareLaunchSurface(
	resolved: ResolvedLaunch,
	operations: PiLaunchOperations,
): Promise<PreparedSurface> {
	const { request } = resolved;
	if (!request.worktree) {
		return {
			surface:
				request.surface ??
				(await operations.createPane(request.name, resolved.sourceCwd)),
			targetCwd: resolved.sourceCwd,
			effectiveAgentDir: resolved.localAgentDir ?? resolved.agentDir,
			localAgentDir: resolved.localAgentDir,
		};
	}
	if (request.surface)
		throw new Error("A worktree subagent cannot use a pre-created pane");

	const worktreeOps = requireWorktreeOperations(operations);
	const baseRef = request.worktree.base ?? "HEAD";
	const baseSha = worktreeOps.resolveGitCommit(resolved.sourceCwd, baseRef);
	const provisionCwd = worktreeOps.resolveWorktreeProvisionCwd(
		resolved.sourceCwd,
	);
	const manifestFile = join(
		resolved.artifactDir,
		"worktree-runs",
		`${resolved.id}.json`,
	);
	const ownership = {
		id: resolved.id,
		name: request.name,
		sourceCwd: resolved.sourceCwd,
		branch: request.worktree.branch,
		baseRef,
		baseSha,
		createdAt: resolved.startTime,
	};
	worktreeOps.writeWorktreeManifest(manifestFile, {
		state: "provisioning",
		...ownership,
	});

	let created: WorktreeSurfaceForLaunch;
	try {
		created = await operations.createWorktree(
			request.name,
			provisionCwd,
			request.worktree.branch,
			baseSha,
		);
	} catch (error) {
		const failedManifest: FailedWorktreeManifest = {
			state: "failed",
			...ownership,
		};
		if (error instanceof WorktreeProvisioningError) {
			Object.assign(failedManifest, error.recoveredWorktree);
		}
		failedManifest.error = errorMessage(error);
		worktreeOps.writeWorktreeManifest(manifestFile, failedManifest);
		throw error;
	}

	const worktree: WorktreeLaunch = {
		path: created.path,
		workspaceId: created.workspaceId,
		paneId: created.paneId,
		branch: created.branch,
		baseRef,
		baseSha,
		manifestFile,
	};
	if (created.diagnostics?.length) worktree.diagnostics = created.diagnostics;
	worktreeOps.writeWorktreeManifest(manifestFile, {
		state: "provisioned",
		...ownership,
		...worktree,
	});
	const isolatedAgentDir = join(created.path, ".pi", "agent");
	const hasIsolatedAgentDir = existsSync(isolatedAgentDir);
	return {
		surface: created.paneId,
		targetCwd: created.path,
		effectiveAgentDir: hasIsolatedAgentDir
			? isolatedAgentDir
			: resolved.agentDir,
		localAgentDir: hasIsolatedAgentDir ? isolatedAgentDir : null,
		worktree,
	};
}

function prepareChildSession(
	resolved: ResolvedLaunch,
	surface: PreparedSurface,
	operations: PiLaunchOperations,
): PreparedSession {
	const sessionDir = getDefaultSessionDirFor(
		surface.targetCwd,
		surface.effectiveAgentDir,
	);
	const timestamp = timestampForFile();
	const uuid = [
		resolved.id,
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	const sessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
	if (surface.worktree) {
		surface.worktree.sessionFile = sessionFile;
		requireWorktreeOperations(operations).writeWorktreeManifest(
			surface.worktree.manifestFile,
			{ sessionFile },
		);
	}
	writeSubagentSessionPolicy(sessionFile, {
		owner: surface.worktree ? "managed-worktree" : "public",
		tools: resolved.request.behavior.tools,
		deniedTools: resolved.request.behavior.deniedTools,
		persistent: resolved.request.behavior.persistent,
		logicalId: resolved.request.behavior.logicalId ?? resolved.id,
		generationId: resolved.request.behavior.generationId,
		worktree: surface.worktree
			? {
					path: surface.worktree.path,
					workspaceId: surface.worktree.workspaceId,
					branch: surface.worktree.branch,
					baseSha: surface.worktree.baseSha,
				}
			: undefined,
	});
	const activityFile = getSubagentActivityFile(
		resolved.artifactDir,
		resolved.id,
	);
	return {
		...surface,
		sessionFile,
		activityFile,
		// A handoff Pi loads no child protocol extension, so it records nothing.
		processIdentityFile:
			(surface.worktree || resolved.request.recordProcessIdentity) &&
			!resolved.request.handoff
				? getSubagentProcessIdentityFile(sessionFile)
				: undefined,
	};
}

async function confirmShellReady(
	session: PreparedSession,
	operations: PiLaunchOperations,
): Promise<void> {
	await operations.waitForShellReady(session.surface);
}

function buildWorktreeHandoffMessage(
	request: FreshPiLaunchRequest,
	worktree: WorktreeLaunch,
	sessionFile: string,
): string {
	const task = request.task.slice(0, 2000);
	return [
		"Worktree handoff context:",
		`Branch: ${worktree.branch}`,
		`Base commit: ${worktree.baseSha}`,
		`Worktree: ${worktree.path}`,
		`Source session: ${request.parent.sessionFile}`,
		`Fork session: ${sessionFile}`,
		"",
		"Requested task:",
		task || "Continue the current work in this worktree.",
	].join("\n");
}

function prepareTaskArtifacts(
	resolved: ResolvedLaunch,
	session: PreparedSession,
	operations: PiLaunchOperations,
): PreparedArtifacts {
	const { request } = resolved;
	if (request.handoff) {
		if (!session.worktree) {
			throw new Error("A worktree handoff requires a managed worktree");
		}
		const handoffMessage = buildWorktreeHandoffMessage(
			request,
			session.worktree,
			session.sessionFile,
		);
		createWorktreeSessionFork({
			parentSessionFile: request.parent.sessionFile,
			leafId: request.handoff.leafId,
			childSessionFile: session.sessionFile,
			childCwd: session.targetCwd,
			handoffMessage,
		});
		session.worktree.sourceSessionFile = request.parent.sessionFile;
		session.worktree.handoffMessage = handoffMessage;
		requireWorktreeOperations(operations).writeWorktreeManifest(
			session.worktree.manifestFile,
			{
				sourceSessionFile: request.parent.sessionFile,
				handoffMessage,
			},
		);
	} else if (resolved.sessionMode !== "standalone") {
		seedSubagentSessionFile({
			mode: resolved.sessionMode,
			parentSessionFile: request.parent.sessionFile,
			childSessionFile: session.sessionFile,
			childCwd: session.targetCwd,
		});
	}
	mkdirSync(dirname(session.activityFile), { recursive: true });

	const identityInSystemPrompt =
		request.behavior.systemPromptMode && request.behavior.identity;
	const roleBlock =
		request.behavior.identity && !identityInSystemPrompt
			? `\n\n${request.behavior.identity}`
			: "";
	const modeHint = request.behavior.autoExit
		? "Complete your task autonomously."
		: "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
	const summaryInstruction = request.behavior.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
	const fullTask = request.handoff
		? request.task
		: resolved.sessionMode === "fork"
			? request.task
			: `${roleBlock}\n\n${modeHint}\n\n${request.task}\n\n${summaryInstruction}`;
	let taskArg = fullTask;
	if (resolved.taskDelivery === "artifact" && !request.handoff) {
		const artifactPath = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-${timestampForFile(false)}.md`,
		);
		mkdirSync(dirname(artifactPath), { recursive: true });
		writeFileSync(artifactPath, fullTask, "utf8");
		taskArg = `@${artifactPath}`;
	}

	let systemPromptFile: string | undefined;
	if (identityInSystemPrompt) {
		systemPromptFile = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-sysprompt-${timestampForFile(false)}.md`,
		);
		mkdirSync(dirname(systemPromptFile), { recursive: true });
		writeFileSync(systemPromptFile, identityInSystemPrompt, "utf8");
	}
	return { ...session, taskArg, systemPromptFile };
}

function buildPiCommand(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
): string {
	const { request } = resolved;
	const parts = [
		"pi",
		"--session",
		shellQuote(artifacts.sessionFile),
		...(request.handoff
			? []
			: ["-e", shellQuote(join(SUBAGENTS_DIR, "child", "subagent-done.ts"))]),
		"--model",
		shellQuote(request.runtimePlan.model),
		"--thinking",
		shellQuote(request.runtimePlan.thinking),
	];
	if (artifacts.systemPromptFile) {
		parts.push(
			request.behavior.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			shellQuote(artifacts.systemPromptFile),
		);
	}
	const toolAllowlist = buildSubagentToolAllowlist(
		request.behavior.tools,
		request.behavior.autoExit,
	);
	if (toolAllowlist) parts.push("--tools", shellQuote(toolAllowlist));
	if (!request.handoff) {
		for (const prompt of buildPromptArgs(
			request.behavior.skills,
			resolved.taskDelivery,
			artifacts.taskArg,
		)) {
			parts.push(shellQuote(prompt));
		}
	}

	const env = [`${PI_LAUNCH_SESSION_ENV}=${shellQuote(artifacts.sessionFile)}`];
	if (artifacts.localAgentDir) {
		env.push(`PI_CODING_AGENT_DIR=${shellQuote(artifacts.localAgentDir)}`);
	} else if (process.env.PI_CODING_AGENT_DIR) {
		env.push(
			`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`,
		);
	}
	if (!request.handoff) {
		if (request.behavior.deniedTools.length > 0) {
			env.push(
				`PI_DENY_TOOLS=${shellQuote(request.behavior.deniedTools.join(","))}`,
			);
		}
		env.push(`PI_SUBAGENT_NAME=${shellQuote(request.name)}`);
		if (request.agent)
			env.push(`PI_SUBAGENT_AGENT=${shellQuote(request.agent)}`);
		env.push(`PI_SUBAGENT_AUTO_EXIT=${request.behavior.autoExit ? "1" : "0"}`);
		if (request.behavior.persistent) {
			env.push("PI_SUBAGENT_PERSISTENT=1");
			env.push(
				`PI_SUBAGENT_GENERATION_ID=${shellQuote(request.behavior.generationId ?? "")}`,
			);
			env.push(
				`PI_SUBAGENT_TASK_ID=${shellQuote(request.behavior.taskId ?? "")}`,
			);
		}
		env.push(`PI_SUBAGENT_SESSION=${shellQuote(artifacts.sessionFile)}`);
		env.push(`PI_SUBAGENT_ID=${shellQuote(resolved.id)}`);
		env.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(artifacts.activityFile)}`);
		env.push(`PI_SUBAGENT_SURFACE=${shellQuote(artifacts.surface)}`);
		if (artifacts.processIdentityFile)
			env.push(
				`PI_SUBAGENT_PROCESS_FILE=${shellQuote(artifacts.processIdentityFile)}`,
			);
	}

	const piCommand =
		`cd ${shellQuote(artifacts.targetCwd)} && ` +
		`${env.join(" ")} ${parts.join(" ")}`;
	return request.handoff
		? piCommand
		: `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
}

async function startPiProcess(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
	command: string,
	operations: PiLaunchOperations,
): Promise<string> {
	const launchScriptFile = join(
		resolved.artifactDir,
		"subagent-scripts",
		`${safeName(resolved.request.name) || "subagent"}-${resolved.id}.sh`,
	);
	if (artifacts.worktree && !resolved.request.handoff) {
		requireWorktreeOperations(operations).persistWorktreeResult(
			artifacts.worktree,
			"running",
		);
	}
	return await operations.runScript(artifacts.surface, command, {
		scriptPath: launchScriptFile,
		scriptPreamble: [
			shellComment(`Subagent launch script for ${resolved.request.name}`),
			shellComment(`Generated: ${new Date().toISOString()}`),
			shellComment(`Session: ${artifacts.sessionFile}`),
			shellComment(`Surface: ${artifacts.surface}`),
		].join("\n"),
	});
}

function createRunningChild(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
	launchScriptFile: string,
): PiRunningChild {
	return {
		id: resolved.id,
		name: resolved.request.name,
		task: resolved.request.task,
		agent: resolved.request.agent,
		surface: artifacts.surface,
		startTime: resolved.startTime,
		sessionFile: artifacts.sessionFile,
		launchScriptFile,
		activityFile: artifacts.activityFile,
		interactive: resolved.request.behavior.interactive,
		runtimePlan: resolved.request.runtimePlan,
		worktree: artifacts.worktree,
		lifecycle: createLifecycle(resolved.startTime),
		processIdentityFile: artifacts.processIdentityFile,
	};
}

// Capture runs beside the launch so readiness never delays the acknowledgement;
// a cancel awaits it, and without a verified identity nothing is signalled. A
// cancel after an expired capture starts a fresh one bounded by its own budget.
export function startProcessIdentityCapture(
	child: PiRunningChild,
	operations: PiLaunchOperations,
	options?: { timeoutMs?: number },
): void {
	const file = child.processIdentityFile;
	if (!file) return;
	const capture = operations.captureProcessIdentity;
	if (!capture) {
		child.processIdentityError = "process identity capture is unavailable";
		return;
	}
	child.processIdentityError = undefined;
	child.processIdentityCapture = Promise.resolve()
		.then(() =>
			capture(
				child.surface,
				{ file, id: child.id, sessionFile: child.sessionFile },
				options,
			),
		)
		.then(
			(identity) => (child.processIdentity = identity),
			(error) => {
				child.processIdentityError = errorMessage(error);
				return undefined;
			},
		);
}

async function launchResumedPiSubagent(
	request: ResumePiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	const id = request.id ?? Math.random().toString(16).slice(2, 10);
	const policy = readSubagentSessionPolicy(request.sessionFile);
	if (policy.owner !== "public") {
		throw new Error(
			`Cannot resume ${policy.owner} session through subagent_resume. ` +
				"Use its retained managed-worktree workspace instead.",
		);
	}
	if (policy.persistent) {
		throw new Error(
			`Cannot resume persistent specialist ${request.sessionFile}. Spawn a new specialist instead; persistent sessions retain their evidence but do not revive in v1.`,
		);
	}
	const autoExit = request.behavior?.autoExit ?? true;
	const interactive = request.behavior?.interactive ?? !autoExit;
	const startTime = Date.now();
	const artifactDir = join(
		request.parent.sessionDir,
		"artifacts",
		request.parent.sessionId,
	);
	const header = getNewEntries(request.sessionFile, 0).find(
		(entry) => entry.type === "session",
	);
	const cwd = isNonEmptyString(header?.cwd) ? header.cwd : process.cwd();
	const surface = await operations.createPane(request.name, cwd);
	try {
		await operations.waitForShellReady(surface);
		const activityFile = getSubagentActivityFile(artifactDir, id);
		mkdirSync(dirname(activityFile), { recursive: true });
		// The session file is reused, and its sidecar keeps the first identity
		// ever published for it, so each resumed run records under its own ID.
		const processIdentityFile = request.recordProcessIdentity
			? join(artifactDir, "process-identity", `${id}.json`)
			: undefined;

		let messageFile: string | undefined;
		if (request.message) {
			messageFile = join(
				artifactDir,
				"subagent-resume",
				`${safeName(request.name) || "resume"}-${timestampForFile(false)}.md`,
			);
			mkdirSync(dirname(messageFile), { recursive: true });
			writeFileSync(messageFile, request.message, "utf8");
		}

		const env = [
			...(process.env.PI_CODING_AGENT_DIR
				? [`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`]
				: []),
			...(policy.deniedTools.length > 0
				? [`PI_DENY_TOOLS=${shellQuote(policy.deniedTools.join(","))}`]
				: []),
			`PI_SUBAGENT_NAME=${shellQuote(request.name)}`,
			`PI_SUBAGENT_SESSION=${shellQuote(request.sessionFile)}`,
			`PI_SUBAGENT_ID=${shellQuote(id)}`,
			`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`,
			`PI_SUBAGENT_AUTO_EXIT=${autoExit ? "1" : "0"}`,
			...(processIdentityFile
				? [`PI_SUBAGENT_PROCESS_FILE=${shellQuote(processIdentityFile)}`]
				: []),
		];
		const toolAllowlist = buildSubagentToolAllowlist(
			policy.tools?.join(","),
			autoExit,
		);
		const command = [
			...env,
			"pi",
			"--session",
			shellQuote(request.sessionFile),
			...(toolAllowlist ? ["--tools", shellQuote(toolAllowlist)] : []),
			"-e",
			shellQuote(join(SUBAGENTS_DIR, "child", "subagent-done.ts")),
			...(messageFile ? [shellQuote(`@${messageFile}`)] : []),
		].join(" ");
		const launchScriptFile = await operations.runScript(
			surface,
			`${command}; echo '__SUBAGENT_DONE_'$?'__'`,
			{
				scriptPath: join(
					artifactDir,
					"subagent-scripts",
					`${safeName(request.name) || "resume"}-resume-${Date.now()}.sh`,
				),
				scriptPreamble: [
					shellComment(`Subagent resume script for ${request.name}`),
					shellComment(`Generated: ${new Date().toISOString()}`),
					shellComment(`Session: ${request.sessionFile}`),
					shellComment(`Surface: ${surface}`),
					...(messageFile
						? [shellComment(`Resume message file: ${messageFile}`)]
						: []),
				].join("\n"),
			},
		);
		const running: PiRunningChild = {
			id,
			name: request.name,
			task: request.message ?? "resumed session",
			surface,
			startTime,
			sessionFile: request.sessionFile,
			launchScriptFile,
			activityFile,
			interactive,
			runtimePlan: undefined,
			lifecycle: createLifecycle(startTime),
			processIdentityFile,
		};
		startProcessIdentityCapture(running, operations);
		return running;
	} catch (error) {
		try {
			await operations.closePane(surface);
		} catch {
			// The launch error remains authoritative when cleanup also fails.
		}
		throw error;
	}
}

export function buildSubagentToolAllowlist(
	tools?: string,
	autoExit = false,
): string | null {
	const requested = (tools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (requested.length === 0) return null;
	const allow = new Set(requested);
	allow.delete("subagent_done");
	allow.add("caller_ping");
	if (!autoExit) allow.add("subagent_done");
	return [...allow].join(",");
}

function buildPromptArgs(
	skills: string | undefined,
	taskDelivery: "direct" | "artifact",
	taskArg: string,
): string[] {
	const skillPrompts = (skills ?? "")
		.split(",")
		.map((skill) => skill.trim())
		.filter(Boolean)
		.map((skill) => `/skill:${skill}`);
	return [
		...(taskDelivery === "artifact" && skillPrompts.length > 0 ? [""] : []),
		...skillPrompts,
		taskArg,
	];
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

function timestampForFile(includeMilliseconds = true): string {
	return (
		new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, includeMilliseconds ? 23 : 19) +
		(includeMilliseconds ? "Z" : "")
	);
}

function shellComment(value: string): string {
	return `# ${value.replace(/[\r\n\u2028\u2029]/g, " ")}`;
}

function safeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function requireWorktreeOperations(
	operations: PiLaunchOperations,
): WorktreeOperations {
	if (!operations.worktree)
		throw new Error("Worktree operations are unavailable");
	return operations.worktree;
}

function errorMessage(error: any): string {
	return error instanceof Error ? error.message : String(error);
}
