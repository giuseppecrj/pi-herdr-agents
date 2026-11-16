import "./clean-host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	launchOperationsFromSurface,
	type PiLaunchOperations,
} from "@nubl/maestro/adapters/pi/launch-operations";
import {
	AcquiredPiLaunchError,
	launchPiSubagent,
	type FreshPiLaunchRequest,
	type ResumePiLaunchRequest,
} from "@nubl/maestro/adapters/pi/launch";
import { HerdrClientError } from "../maestro/surfaces/herdr/herdr-cli.ts";
import { runScriptInPane } from "../maestro/surfaces/herdr/terminal.ts";
import { FakeSurfaceProvider } from "@nubl/maestro/testing";
import { AcquisitionUncertainError } from "@nubl/maestro/core/surface-provider";
import { writeSubagentSessionPolicy } from "@nubl/maestro/adapters/pi/session";

function fixture() {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "subagent-launch-test-[probe](regex)-")),
	);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "parent-sessions");
	const parentSessionFile = join(sessionDir, "parent.jsonl");
	mkdirSync(project, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		parentSessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: project })}\n`,
	);

	const request: FreshPiLaunchRequest = {
		kind: "fresh",
		id: "child-1",
		name: "Worker",
		task: "Implement the bounded change.",
		agent: "worker",
		parent: {
			cwd: project,
			sessionFile: parentSessionFile,
			sessionId: "parent",
			sessionDir,
			agentDir,
		},
		runtimePlan: {
			provider: "fake",
			modelId: "worker",
			model: "fake/worker",
			thinking: "high",
			modelSource: "request",
			thinkingSource: "request",
		},
		behavior: {
			tools: "read,bash",
			skills: "tdd",
			deniedTools: ["subagent", "subagent_resume"],
			autoExit: true,
			interactive: false,
			identity: "You are a focused worker.",
			systemPromptMode: "append",
			sessionMode: "standalone",
		},
	};
	return { root, project, agentDir, sessionDir, request };
}

function withFixture(
	run: (value: ReturnType<typeof fixture>) => Promise<void> | void,
) {
	const value = fixture();
	return Promise.resolve(run(value)).finally(() => {
		rmSync(value.root, { recursive: true, force: true });
	});
}

function writePublicResumePolicy(sessionFile: string): void {
	writeSubagentSessionPolicy(sessionFile, {
		owner: "public",
		tools: "read,bash",
		deniedTools: ["subagent", "subagent_resume"],
	});
}

async function rejection<T>(launch: Promise<T>): Promise<Error> {
	try {
		await launch;
	} catch (error) {
		assert.ok(error instanceof Error);
		return error;
	}
	return assert.fail("launch must reject");
}

describe("Pi launch", () => {
	describe("dispatch certainty", () => {
		type Target = "owned pane" | "caller surface" | "resumed pane";
		const targets: Target[] = ["owned pane", "caller surface", "resumed pane"];
		const failures = [
			{
				label: "a plain runScript rejection",
				definite: true,
				error: () => new Error("script write failed"),
			},
			{
				label: "a not-spawned Herdr client",
				definite: true,
				error: () =>
					new HerdrClientError("not-spawned", "herdr was not spawned", "", ""),
			},
			{
				label: "an uncertain command dispatch",
				definite: false,
				error: (surface: string) =>
					new AcquisitionUncertainError("dispatch receipt lost", {
						kind: "command-dispatch",
						surfaceId: surface,
					}),
			},
		];

		function requestFor(
			target: Target,
			{ request, root, sessionDir }: ReturnType<typeof fixture>,
		): FreshPiLaunchRequest | ResumePiLaunchRequest {
			if (target === "caller surface")
				return { ...request, surface: "caller-pane" };
			if (target === "owned pane") return request;
			const sessionFile = join(root, "resumed.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", id: "resumed", cwd: root }) + "\n",
			);
			writePublicResumePolicy(sessionFile);
			return {
				kind: "resume",
				id: "resume-certainty",
				name: "Resume worker",
				sessionFile,
				parent: { sessionId: "parent", sessionDir },
			};
		}

		async function withoutHerdr<T>(run: () => Promise<T>): Promise<T> {
			const saved = process.env.HERDR_ENV;
			delete process.env.HERDR_ENV;
			try {
				return await run();
			} finally {
				if (saved === undefined) delete process.env.HERDR_ENV;
				else process.env.HERDR_ENV = saved;
			}
		}

		for (const target of targets)
			for (const failure of failures)
				it(`${failure.definite ? "fails plainly" : "transfers the initialized owner"} for ${failure.label} on a ${target}`, async () => {
					await withFixture(async (value) => {
						const closed: string[] = [];
						let thrown: Error | undefined;
						const operations: PiLaunchOperations = {
							createPane: () => "owned-pane",
							createWorktree: () => {
								throw new Error("unexpected worktree creation");
							},
							waitForShellReady: async () => {},
							runScript: (surface) => {
								thrown = failure.error(surface);
								throw thrown;
							},
							closePane(surface) {
								closed.push(surface);
							},
						};
						const error = await rejection(
							launchPiSubagent(requestFor(target, value), operations),
						);
						assert.ok(thrown, "dispatch was attempted");
						const surface =
							target === "caller surface" ? "caller-pane" : "owned-pane";
						if (failure.definite) {
							assert.equal(
								error,
								thrown,
								"nothing was dispatched, so no owner is transferred",
							);
						} else {
							assert.ok(error instanceof AcquiredPiLaunchError);
							assert.equal(error.cause, thrown);
							assert.equal(error.child.surface, surface);
							assert.match(error.child.launchFailure!, /dispatch receipt lost/);
						}
						assert.deepEqual(
							closed,
							target === "caller surface" ? [] : [surface],
							"only a transaction-owned pane is closed, once",
						);
					});
				});

		for (const target of ["owned pane", "resumed pane"] as const)
			it(`a real script-write failure on a ${target} dispatches nothing and closes the pane`, async () => {
				await withFixture(async (value) => {
					// A regular file where the script directory belongs: portable, even as root.
					const scripts = join(
						value.sessionDir,
						"artifacts",
						"parent",
						"subagent-scripts",
					);
					mkdirSync(dirname(scripts), { recursive: true });
					writeFileSync(scripts, "obstruction\n");
					const provider = new FakeSurfaceProvider();
					const operations = launchOperationsFromSurface(provider, {
						mode: "grouped",
						direction: "right",
						maxPerTab: 4,
					});
					operations.waitForShellReady = async () => {};
					const scriptPaths: string[] = [];
					operations.runScript = (surface, command, options) => {
						scriptPaths.push(options.scriptPath);
						return runScriptInPane(surface, command, options);
					};
					const error = await withoutHerdr(() =>
						rejection(launchPiSubagent(requestFor(target, value), operations)),
					);
					assert.equal(scriptPaths.length, 1);
					assert.equal(dirname(scriptPaths[0]), scripts);
					assert.ok("code" in error);
					assert.match(String(error.code), /^(EEXIST|ENOTDIR)$/);
					assert.doesNotMatch(error.message, /herdr is not available/);
					assert.equal(error instanceof AcquiredPiLaunchError, false);
					assert.equal(existsSync(scriptPaths[0]), false);
					assert.deepEqual(provider.listSurfaces(), []);
				});
			});
	});
});
