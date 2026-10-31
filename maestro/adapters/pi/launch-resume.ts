import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSubagentActivityFile } from "./activity-file.ts";
import { createLifecycle } from "../../core/lifecycle.ts";
import { assertModelInScope, modelScopeOf } from "../../core/routing.ts";
import { isNonEmptyString } from "../../core/config/type-guards.ts";
import {
	DECLARED_SKILLS_ENV,
	formatDeclaredSkillsEnv,
} from "../../core/declared-skills.ts";
import { shellQuote } from "../../core/shell.ts";
import {
	findStoredSessionModel,
	getNewEntries,
	readSubagentSessionPolicy,
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
import type { PiLaunchOperations } from "./launch-operations.ts";
import type { PiRunningChild, ResumePiLaunchRequest } from "./launch.ts";

export async function launchResumedPiSubagent(
	callerRequest: ResumePiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	// Pi resolves `--session` against the pane's cwd, not the caller's. Resolve
	// it here once, so every read, the command, and the running child's
	// session file name the same absolute path that Pi then reports to Herdr.
	const request = {
		...callerRequest,
		sessionFile: resolve(callerRequest.sessionFile),
	};
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
	// A scoped parent pins the stored model after checking it, so Pi cannot
	// restore an out-of-scope model on resume.
	const scopeArgs = modelScopeArgs(request.modelScope);
	let pinnedModel: string | undefined;
	if (modelScopeOf({ scope: request.modelScope })) {
		const stored = findStoredSessionModel(
			getNewEntries(request.sessionFile, 0),
		);
		if (!stored)
			throw new Error(
				`Cannot resume ${request.sessionFile} in a scoped session: it records no model to check against the scope (--models / enabledModels).`,
			);
		pinnedModel = `${stored.provider}/${stored.modelId}`;
		assertModelInScope(
			pinnedModel,
			{ scope: request.modelScope },
			"the resumed session's stored model",
			"resume keeps a session's model, so launch a new subagent with an in-scope model instead",
		);
	}
	const surface = await operations.createPane(request.name, cwd);
	try {
		await operations.waitForShellReady(surface);
		const activityFile = getSubagentActivityFile(artifactDir, id);
		mkdirSync(dirname(activityFile), { recursive: true });

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
			childDepthAssignment(),
			modelScopeAssignment(request.modelScope),
			// The saved session policy records no self-spawn opt-in.
			"PI_SUBAGENT_SELF_SPAWN=0",
			// A resumed session already holds its skills; never inject them again.
			`${DECLARED_SKILLS_ENV}=${shellQuote(formatDeclaredSkillsEnv([]))}`,
			`PI_SUBAGENT_NAME=${shellQuote(request.name)}`,
			`PI_SUBAGENT_SESSION=${shellQuote(request.sessionFile)}`,
			`PI_SUBAGENT_ID=${shellQuote(id)}`,
			`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`,
			`PI_SUBAGENT_AUTO_EXIT=${autoExit ? "1" : "0"}`,
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
			...(pinnedModel ? ["--model", shellQuote(pinnedModel)] : []),
			...scopeArgs,
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
		return {
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
			cwd,
			lifecycle: createLifecycle(startTime),
		};
	} catch (error) {
		try {
			await operations.closePane(surface);
		} catch {
			// The launch error remains authoritative when cleanup also fails.
		}
		throw error;
	}
}
