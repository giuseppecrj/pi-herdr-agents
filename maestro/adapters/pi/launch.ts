import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getSubagentActivityFile } from "./activity-file.ts";
import {
	createLifecycle,
	type SubagentLifecycle,
} from "../../core/lifecycle.ts";
import {
	assertModelInScope,
	type ResolvedRuntimePlan,
} from "../../core/routing.ts";
import {
	DECLARED_SKILLS_ENV,
	formatDeclaredSkillsEnv,
	parseDeclaredSkills,
} from "../../core/declared-skills.ts";
import { shellQuote } from "../../core/shell.ts";
import { ACCEPT_FILE_ENV, type AcceptSpec } from "../../core/accept.ts";
import {
	AcquisitionUncertainError,
	isAcquisitionUncertainError,
	WorktreeProvisioningError,
} from "../../core/surface-provider.ts";
import type {
	FailedWorktreeManifest,
	WorktreeLaunch,
	WorktreeOperations,
} from "../../core/worktree.ts";
import {
	getSubagentProcessIdentityFile,
	type PiProcessIdentity,
} from "./process-identity.ts";
import {
	appendPersistentDeliveryLedger,
	createWorktreeSessionFork,
	seedSubagentSessionFile,
	writeSubagentSessionPolicy,
	type SubagentSessionPolicyV2,
} from "./session.ts";
import {
	buildSubagentToolAllowlist,
	childDepthAssignment,
	modelScopeArgs,
	modelScopeAssignment,
	safeName,
	shellComment,
	SUBAGENTS_DIR,
	timestampForFile,
} from "./launch-command.ts";
import {
	PI_LAUNCH_SESSION_ENV,
	type PiLaunchOperations,
	type WorktreeSurfaceForLaunch,
} from "./launch-operations.ts";
import { launchResumedPiSubagent } from "./launch-resume.ts";

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface FreshPiLaunchRequest {
	kind: "fresh";
	acquisitionSignal?: AbortSignal;
	id?: string;
	name: string;
	task: string;
	agent?: string;
	cwd?: string;
	worktree?: { branch: string; base?: string } | null;
	/** Written to a spec file the child reads; a handoff carries none. */
	accept?: AcceptSpec;
	fork?: boolean;
	handoff?: { leafId: string };
	surface?: string;
	parent: {
		cwd: string;
		invocationCwd?: string;
		sessionFile: string;
		sessionId: string;
		sessionDir: string;
		agentDir?: string;
	};
	runtimePlan: ResolvedRuntimePlan;
	/** The parent session's model scope (exact provider/model-id refs). The
	 * child receives it as its exact allowlist ({@link MODEL_SCOPE_ENV}) and as
	 * Pi's `--models` hint; absent leaves it unscoped. */
	modelScope?: readonly string[];
	behavior: {
		tools?: string;
		skills?: string;
		deniedTools: readonly string[];
		/** Lets the child launch another instance of its own role. */
		selfSpawn?: boolean;
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
	acquisitionSignal?: AbortSignal;
	id?: string;
	name: string;
	sessionFile: string;
	message?: string;
	parent: {
		sessionId: string;
		sessionDir: string;
	};
	/** The parent session's model scope. When set, the stored model must be in
	 * it and is pinned with `--model`; the child receives it as its exact
	 * allowlist ({@link MODEL_SCOPE_ENV}) and as Pi's `--models` hint. */
	modelScope?: readonly string[];
	behavior?: {
		autoExit?: boolean;
		interactive?: boolean;
	};
}

export type PiLaunchRequest = FreshPiLaunchRequest | ResumePiLaunchRequest;

export interface PiRunningChild {
	/** Dispatch/rollback failed; this real owner remains controlled until exit. */
	launchFailure?: string;
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	/** Only an ordinary pane created by this transaction may be closed. */
	ownsSurface: boolean;
	startTime: number;
	sessionFile: string;
	launchScriptFile: string;
	activityFile: string;
	interactive: boolean;
	runtimePlan: ResolvedRuntimePlan | undefined;
	worktree?: WorktreeLaunch;
	/** Where the child runs: the worktree root or the ordinary cwd. */
	cwd?: string;
	/** The validated accept check the parent re-runs in `cwd`. */
	accept?: AcceptSpec;
	lifecycle: SubagentLifecycle;
	persistent?: boolean;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
	policyTools?: string[] | null;
	policyDeniedTools?: string[];
	tasksCompleted?: number;
	taskId?: string;
	/** Task IDs this parent dispatched; the child-writable ledger never decides. */
	issuedTaskIds?: string[];
	inboxSequence?: number;
	observedTaskEvents?: number;
	stopState?: "requested" | "pending" | "failed";
	stopFailure?: string;
	crashNotified?: boolean;
	/** Managed worktree children: where the child records its own process identity. */
	processIdentityFile?: string;
	/** Verified at launch readiness; a worktree cancel's only signal and exit evidence. */
	processIdentity?: PiProcessIdentity;
	/** Settles when launch-readiness capture verifies or gives up; never rejects. */
	processIdentityCapture?: Promise<PiProcessIdentity | undefined>;
	processIdentityError?: string;
}

/** Ownership transfer, not a retryable rejection. The initialized child is real. */
export class AcquiredPiLaunchError extends Error {
	readonly child: PiRunningChild;
	constructor(child: PiRunningChild, cause: unknown) {
		super(
			`Launch outcome uncertain; ${child.worktree ? `worktree retained at ${child.worktree.path} (workspace ${child.worktree.workspaceId}); ` : `pane ${child.surface}; `}owner retained, no fallback: ${errorMessage(cause)}`,
			{ cause },
		);
		this.name = "AcquiredPiLaunchError";
		this.child = child;
		child.launchFailure = this.message;
	}
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
	policy: SubagentSessionPolicyV2;
	initialTaskId?: string;
	processIdentityFile?: string;
}

interface PreparedArtifacts extends PreparedSession {
	taskArg: string;
	systemPromptFile?: string;
	acceptFile?: string;
}

/**
 * Launch one validated Pi-backed request. Lifecycle watching and parent
 * delivery begin only after this transaction returns the running child.
 */
export async function launchPiSubagent(
	request: PiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	if (request.kind === "resume")
		return launchResumedPiSubagent(request, operations);
	// Last checks before any resource exists: the plan must be in the live
	// scope, and the scope must be representable as the child's --models.
	assertModelInScope(request.runtimePlan.model, { scope: request.modelScope });
	modelScopeArgs(request.modelScope);
	// Declared skill names must follow Pi's rules; a handoff carries none.
	if (!request.handoff) parseDeclaredSkills(request.behavior.skills);
	return launchFreshPiSubagent(request, operations);
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
	let running: PiRunningChild | undefined;

	try {
		request.acquisitionSignal?.throwIfAborted();
		surface = await prepareLaunchSurface(resolved, operations);
		request.acquisitionSignal?.throwIfAborted();
		const session = prepareChildSession(resolved, surface, operations);
		const handoffArtifacts = request.handoff
			? prepareTaskArtifacts(resolved, session, operations)
			: undefined;
		await confirmShellReady(session, operations);
		const artifacts =
			handoffArtifacts ?? prepareTaskArtifacts(resolved, session, operations);
		request.acquisitionSignal?.throwIfAborted();
		const command = buildPiCommand(resolved, artifacts);
		if (artifacts.worktree && !request.handoff) {
			requireWorktreeOperations(operations).persistWorktreeResult(
				artifacts.worktree,
				"running",
			);
		}
		request.acquisitionSignal?.throwIfAborted();
		// Complete fallible initialization while this transaction still owns the
		// surface, before any child can run or mutate its session artifacts.
		running = createRunningChild(resolved, artifacts);
		running.launchScriptFile = await startPiProcess(
			resolved,
			artifacts,
			command,
			running.launchScriptFile,
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
		startProcessIdentityCapture(running, operations);
		return running;
	} catch (error) {
		if (!surface) throw error;
		if (running) startProcessIdentityCapture(running, operations);
		if (!surface.worktree) {
			if (!request.surface) {
				try {
					await operations.closePane(surface.surface);
				} catch (rollback) {
					if (running)
						throw new AcquiredPiLaunchError(
							running,
							new Error(
								`${errorMessage(error)}; rollback unconfirmed: ${errorMessage(rollback)}`,
								{ cause: error },
							),
						);
					throw new AcquisitionUncertainError(
						`${errorMessage(error)}; rollback unconfirmed: ${errorMessage(rollback)}; pane retained: ${surface.surface}; no fallback`,
						{
							kind: "surface-create",
							placement: "tab",
							observedSurfaceId: surface.surface,
						},
						{ cause: error },
					);
				}
			}
			if (running) throw new AcquiredPiLaunchError(running, error);
			throw error;
		}
		if (running) {
			try {
				const worktreeOps = requireWorktreeOperations(operations);
				// Interactive handoffs have no runtime finalizer. Watched children capture there once.
				const handoff = request.handoff
					? await worktreeOps.captureWorktreeHandoff(surface.worktree)
					: undefined;
				worktreeOps.persistWorktreeResult(surface.worktree, "failed", handoff);
				worktreeOps.writeWorktreeManifest(surface.worktree.manifestFile, {
					acquisitionUncertain: true,
					error: errorMessage(error),
				});
			} catch {
				/* transfer ownership even if evidence persistence fails */
			}
			throw new AcquiredPiLaunchError(running, error);
		}
		const worktreeOps = requireWorktreeOperations(operations);
		let handoff;
		try {
			handoff = await worktreeOps.captureWorktreeHandoff(surface.worktree);
		} catch {
			/* preserve launch failure */
		}
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
				(await operations.createPane(request.name, resolved.sourceCwd, {
					signal: request.acquisitionSignal,
				})),
			targetCwd: resolved.sourceCwd,
			effectiveAgentDir: resolved.localAgentDir ?? resolved.agentDir,
			localAgentDir: resolved.localAgentDir,
		};
	}
	if (request.surface)
		throw new Error("A worktree subagent cannot use a pre-created pane");

	const worktreeOps = requireWorktreeOperations(operations);
	const baseRef = request.worktree.base ?? "HEAD";
	const baseSha = await worktreeOps.resolveGitCommit(
		resolved.sourceCwd,
		baseRef,
	);
	const provisionCwd = await worktreeOps.resolveWorktreeProvisionCwd(
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
			{ signal: request.acquisitionSignal },
		);
	} catch (error) {
		const failedManifest: FailedWorktreeManifest = {
			state: "failed",
			...ownership,
		};
		if (error instanceof WorktreeProvisioningError) {
			Object.assign(failedManifest, error.recoveredWorktree);
		}
		if (
			isAcquisitionUncertainError(error) &&
			error.uncertainty.kind === "worktree-create"
		) {
			Object.assign(failedManifest, error.uncertainty.recovered, {
				acquisitionUncertain: true,
			});
		}
		failedManifest.error = errorMessage(error);
		try {
			worktreeOps.writeWorktreeManifest(manifestFile, failedManifest);
		} catch {
			/* original acquisition failure remains authoritative */
		}
		if (isAcquisitionUncertainError(error))
			throw new AcquisitionUncertainError(
				`${error.message}; ownership manifest retained at ${manifestFile}`,
				error.uncertainty,
				{ cause: error },
			);
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
	try {
		worktreeOps.writeWorktreeManifest(manifestFile, {
			state: "provisioned",
			...ownership,
			...worktree,
		});
	} catch (error) {
		// Preserve the known retained root even when a manifest update fails.
		(worktree.diagnostics ??= []).push(
			`Manifest update failed: ${errorMessage(error)}`,
		);
	}
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
	const policy = writeSubagentSessionPolicy(sessionFile, {
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
		policy,
		initialTaskId: policy.persistent
			? (resolved.request.behavior.taskId ?? randomUUID())
			: undefined,
		// A handoff Pi loads no child protocol extension, so it records nothing.
		processIdentityFile:
			(surface.worktree || resolved.request.surface) &&
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
	// A file, never the raw command in the launch environment or script.
	let acceptFile: string | undefined;
	if (request.accept && !request.handoff) {
		acceptFile = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-accept-${resolved.id}.json`,
		);
		mkdirSync(dirname(acceptFile), { recursive: true });
		writeFileSync(
			acceptFile,
			JSON.stringify({ version: 1, ...request.accept }),
			"utf8",
		);
	}
	return { ...session, taskArg, systemPromptFile, acceptFile };
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
		...modelScopeArgs(request.modelScope),
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
	if (!request.handoff) parts.push(shellQuote(artifacts.taskArg));

	const env = [
		`${PI_LAUNCH_SESSION_ENV}=${shellQuote(artifacts.sessionFile)}`,
		childDepthAssignment(resolved.request.handoff ? "handoff" : "child"),
		modelScopeAssignment(request.modelScope),
		// Explicit on every path, including a handoff, so an opt-in left in the
		// pane's shell never reaches a session whose role did not declare it.
		`PI_SUBAGENT_SELF_SPAWN=${!request.handoff && request.agent && request.behavior.selfSpawn ? "1" : "0"}`,
	];
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
		if (artifacts.acceptFile)
			env.push(`${ACCEPT_FILE_ENV}=${shellQuote(artifacts.acceptFile)}`);
		// Names only, always set: the child's own Pi decides which skills exist.
		env.push(
			`${DECLARED_SKILLS_ENV}=${shellQuote(formatDeclaredSkillsEnv(parseDeclaredSkills(request.behavior.skills)))}`,
		);
		if (request.behavior.persistent) {
			env.push("PI_SUBAGENT_PERSISTENT=1");
			env.push(
				`PI_SUBAGENT_GENERATION_ID=${shellQuote(artifacts.policy.generationId)}`,
			);
			env.push(`PI_SUBAGENT_TASK_ID=${shellQuote(artifacts.initialTaskId!)}`);
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
	launchScriptFile: string,
	operations: PiLaunchOperations,
): Promise<string> {
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
): PiRunningChild {
	const child: PiRunningChild = {
		id: resolved.id,
		name: resolved.request.name,
		task: resolved.request.task,
		agent: resolved.request.agent,
		surface: artifacts.surface,
		ownsSurface: !artifacts.worktree && !resolved.request.surface,
		startTime: resolved.startTime,
		sessionFile: artifacts.sessionFile,
		launchScriptFile: join(
			resolved.artifactDir,
			"subagent-scripts",
			`${safeName(resolved.request.name) || "subagent"}-${resolved.id}.sh`,
		),
		activityFile: artifacts.activityFile,
		interactive: resolved.request.behavior.interactive,
		runtimePlan: resolved.request.runtimePlan,
		worktree: artifacts.worktree,
		cwd: artifacts.targetCwd,
		// A handoff loads no child protocol, so it never carries a check.
		accept: resolved.request.handoff ? undefined : resolved.request.accept,
		lifecycle: createLifecycle(resolved.startTime),
		processIdentityFile: artifacts.processIdentityFile,
	};
	const { policy, initialTaskId } = artifacts;
	if (policy.persistent) {
		Object.assign(child, {
			persistent: true,
			logicalId: policy.logicalId,
			generationId: policy.generationId,
			policyHash: policy.policyHash,
			policyTools: policy.tools,
			policyDeniedTools: policy.deniedTools,
			tasksCompleted: 0,
			taskId: initialTaskId,
			issuedTaskIds: [initialTaskId!],
			inboxSequence: 0,
			observedTaskEvents: 0,
		});
		appendPersistentDeliveryLedger(child.sessionFile, {
			task: initialTaskId!,
			outcome: "dispatched",
			generation: policy.generationId,
			logicalId: policy.logicalId,
			policyHash: policy.policyHash,
		});
	}
	return child;
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

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
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
