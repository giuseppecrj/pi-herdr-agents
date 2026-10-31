import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PiHarnessAdapter } from "../../maestro/adapters/pi/pi-harness-adapter.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { waitForCompletion } from "../../maestro/adapters/pi/completion.ts";
import {
	createWorktreeOperations,
	readWorktreeManifest,
} from "../../maestro/runtime/worktree-operations.ts";
import {
	getSubagentSessionPolicyFile,
	readPersistentDeliveryLedger,
	readSubagentSessionPolicy,
	writeSubagentSessionPolicy,
} from "../../maestro/adapters/pi/session.ts";
import type { SpawnOptions } from "../../maestro/core/harness-adapter.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "audit-ownership-"));
	const parent = {
		cwd: root,
		sessionFile: join(root, "parent.jsonl"),
		sessionId: "parent",
		sessionDir: root,
		agentDir: join(root, "agent"),
	};
	const paneConfig = {
		mode: "grouped",
		direction: "right",
		maxPerTab: 4,
	} as const;
	const surface = new FakeSurfaceProvider();
	const worktree = createWorktreeOperations();
	worktree.resolveGitCommit = async () => "base-sha";
	worktree.resolveWorktreeProvisionCwd = async (cwd) => cwd;
	worktree.captureWorktreeHandoff = async (launch) => ({
		...launch,
		headSha: null,
		commitsAhead: null,
		clean: null,
		conflicted: null,
		changedFiles: null,
		untrackedFiles: null,
		gitError: "fixture has no Git state",
	});
	const operations = launchOperationsFromSurface(surface, paneConfig, worktree);
	operations.runScript = (_surface, _command, options) => options.scriptPath;
	const identity = {
		pid: 20,
		startTime: "500",
		bootId: "fixture",
		pidNamespace: "fixture",
	};
	const kernel = { alive: true };
	operations.captureProcessIdentity = async () => identity;
	const supervision = new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		(id) => surface.inspectSurface(id),
		true,
	);
	const adapter = new PiHarnessAdapter({
		surface,
		paneConfig,
		operations,
		supervision,
		processProbe: {
			host: () => identity,
			stat: () =>
				kernel.alive
					? { state: "S", ppid: 10, startTime: identity.startTime }
					: undefined,
			terminate: () => {
				throw new Error("completion must not signal a process");
			},
		},
		parent,
		parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
		modelRegistry: {
			find: (provider, id) => ({ provider, id, reasoning: true }),
			available: () => [],
			hasConfiguredAuth: () => true,
			supportedThinkingLevels: () => ["off"],
			clampThinkingLevel: (_model, level) => level,
		},
	});
	const options: SpawnOptions = {
		name: "specialist",
		task: "initial task",
		cwd: root,
		sessionId: "task",
		role: {
			name: "worker",
			version: "1",
			description: "test",
			systemPrompt: "bounded worker",
			allowedTools: ["read"],
		},
		behavior: { persistent: true },
	};
	return {
		root,
		parent,
		surface,
		operations,
		adapter,
		options,
		kernel,
		dispose() {
			supervision.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function usingFixture(
	run: (f: ReturnType<typeof fixture>) => Promise<void>,
) {
	const f = fixture();
	try {
		await run(f);
	} finally {
		f.dispose();
	}
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function commandSession(command: string): string {
	const session = command.match(/--session '([^']+)'/)?.[1];
	assert.ok(session);
	return session;
}

describe("audited launch ownership", () => {
	it("uncertain dispatch on a caller-provided surface never closes that surface", async () =>
		usingFixture(async (f) => {
			const id = f.surface.createSurface({ name: "caller", cwd: f.root });
			f.operations.runScript = () => {
				throw new Error("receipt lost");
			};
			const handle = await f.adapter.spawn({
				...f.options,
				surface: f.surface.attachSurface(id),
			});
			const child = f.adapter.getRunningChild(handle);
			assert.equal(child.ownsSurface, false);
			await child.processIdentityCapture;
			await assert.rejects(f.adapter.kill(handle), /unconfirmed/);
			assert.equal(f.surface.listSurfaces().length, 1);
			f.kernel.alive = false;
			await f.adapter.kill(handle);
			assert.equal(f.surface.listSurfaces().length, 1);
		}));
	it("transfers uncertain worktree dispatch without closing its root or fabricating process exit", async () =>
		usingFixture(async (f) => {
			f.operations.runScript = () => {
				throw new Error("dispatch response lost");
			};
			const handle = await f.adapter.spawn({
				...f.options,
				behavior: { autoExit: true },
				worktreeRequest: { branch: "retained" },
			});
			const child = f.adapter.getRunningChild(handle);
			assert.ok(child.worktree);
			assert.ok(handle.launchFailure);
			await child.processIdentityCapture;
			const controller = new AbortController();
			const wait = f.adapter.awaitCompletion(handle, controller.signal);
			await nextTurn();
			assert.equal(f.adapter.exitCode(handle), undefined);
			assert.equal(f.surface.listSurfaces().length, 1);
			controller.abort();
			await assert.rejects(wait, /Aborted/);
			f.kernel.alive = false;
			const result = await f.adapter.awaitCompletion(
				handle,
				new AbortController().signal,
			);
			assert.equal(result.reason, "error");
			assert.match(result.errorMessage!, /dispatch response lost/);
			assert.equal(f.surface.listSurfaces().length, 1);
		}));
	it("initializes persistent policy and ledger before dispatch, without rereading child-writable policy", async () =>
		usingFixture(async (f) => {
			let ledgerAtDispatch = 0;
			const policies: ReturnType<typeof readSubagentSessionPolicy>[] = [];
			f.operations.runScript = (_surface, command, options) => {
				const session = commandSession(command);
				ledgerAtDispatch = readPersistentDeliveryLedger(session).length;
				policies.push(readSubagentSessionPolicy(session));
				// A post-dispatch read failure must not report a launch failure while Pi runs.
				rmSync(getSubagentSessionPolicyFile(session));
				return options.scriptPath;
			};
			const handle = await f.adapter.spawn(f.options);
			assert.equal(ledgerAtDispatch, 1);
			const policyAtDispatch = policies[0];
			assert.ok(policyAtDispatch.version === 2);
			const child = f.adapter.getRunningChild(handle);
			assert.equal(child.policyHash, policyAtDispatch.policyHash);
			assert.equal(child.generationId, policyAtDispatch.generationId);
			assert.deepEqual(child.issuedTaskIds, [child.taskId]);
			assert.equal(f.surface.listSurfaces().length, 1);
		}));

	for (const worktree of [false, true])
		it(`a failed initial ledger write dispatches no child and ${worktree ? "retains the worktree root" : "closes the owned ordinary pane"}`, async () =>
			usingFixture(async (f) => {
				let dispatched = 0;
				// The session policy exists by shell readiness. Make the ledger unwritable
				// without chmod (the suite also runs as root).
				f.operations.waitForShellReady = async () => {
					const policy = readdirSync(f.parent.agentDir, {
						recursive: true,
						encoding: "utf8",
					}).find((file) => file.endsWith(".pi-herdr-subagent-policy.json"));
					assert.ok(policy);
					const session = join(f.parent.agentDir, policy).replace(
						/\.pi-herdr-subagent-policy\.json$/,
						"",
					);
					mkdirSync(`${session}.ledger`);
				};
				f.operations.runScript = (_surface, _command, options) => {
					dispatched++;
					return options.scriptPath;
				};
				await assert.rejects(
					f.adapter.spawn({
						...f.options,
						worktreeRequest: worktree ? { branch: "owned" } : undefined,
					}),
					/EISDIR/,
				);
				assert.equal(
					dispatched,
					0,
					"no process may escape a failed initialization",
				);
				assert.equal(f.surface.listSurfaces().length, worktree ? 1 : 0);
				if (worktree) {
					const manifests = join(
						f.root,
						"artifacts",
						"parent",
						"worktree-runs",
					);
					const manifest = readWorktreeManifest(
						join(manifests, readdirSync(manifests)[0]),
					);
					assert.equal(manifest?.state, "failed");
				}
			}));

	it("resumes with the transaction's cwd even when the transcript becomes unreadable after dispatch", async () =>
		usingFixture(async (f) => {
			const session = join(f.root, "resume.jsonl");
			const cwd = join(f.root, "saved-cwd");
			writeFileSync(session, JSON.stringify({ type: "session", cwd }) + "\n");
			writeSubagentSessionPolicy(session, { owner: "public", deniedTools: [] });
			f.operations.runScript = (_surface, _command, options) => {
				rmSync(session);
				mkdirSync(session);
				return options.scriptPath;
			};
			const handle = await f.adapter.resume({
				name: "resumed",
				sessionId: session,
			});
			assert.equal(handle.cwd, cwd);
			assert.equal(f.adapter.getRunningChild(handle).cwd, cwd);
			assert.equal(f.surface.listSurfaces().length, 1);
		}));
});

describe("audited persistent exit ownership", () => {
	for (const payload of [
		{ type: "done" },
		{ type: "ping", name: "specialist", message: "help" },
		{ type: "error", errorMessage: "provider rejected" },
	])
		it(`keeps ${payload.type} semantics until the shell confirms exit, including across an aborted wait`, async () =>
			usingFixture(async (f) => {
				const sessionFile = join(f.root, "pending.jsonl");
				const exitFile = `${sessionFile}.exit`;
				writeFileSync(exitFile, JSON.stringify(payload));
				const controller = new AbortController();
				let drained = 0;
				await assert.rejects(
					waitForCompletion(controller.signal, {
						sessionFile,
						intervalMs: 1,
						requireProcessExit: true,
						readTerminalTail: async () => "Pi is still shutting down",
						inspectPane: async () => ({
							kind: "present",
							agentStatus: "done",
							observedAt: Date.now(),
						}),
						onLocalEvidence: () => {
							drained++;
						},
						onTick: () => controller.abort(),
					}),
					/Aborted/,
				);
				assert.ok(drained > 0, "task events still drain before process exit");
				assert.equal(existsSync(exitFile), true);
				const result = await waitForCompletion(new AbortController().signal, {
					sessionFile,
					intervalMs: 1,
					requireProcessExit: true,
					// Semantic errors/help outrank even a zero shell exit.
					readTerminalTail: async () => "__SUBAGENT_DONE_0__",
				});
				assert.equal(result.reason, payload.type);
				assert.equal(result.errorMessage, payload.errorMessage);
				assert.equal(result.ping?.message, payload.message);
				assert.equal(existsSync(exitFile), false);
			}));

	it("a known-live identity blocks both a stale sentinel and pane disappearance until verified exit", async () =>
		usingFixture(async (f) => {
			const sessionFile = join(f.root, "identity.jsonl");
			writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
			let exited = false;
			let probes = 0;
			const result = await waitForCompletion(new AbortController().signal, {
				sessionFile,
				intervalMs: 1,
				requireProcessExit: true,
				inspectProcess: () => (exited ? "exited" : "alive"),
				readTerminalTail: async () => "__SUBAGENT_DONE_0__",
				inspectPane: async () => {
					probes++;
					return { kind: "missing" };
				},
				onTick: () => {
					assert.equal(existsSync(`${sessionFile}.exit`), true);
					exited = true;
				},
			});
			assert.equal(probes, 1);
			assert.equal(
				exited,
				true,
				"semantic evidence alone did not finish the wait",
			);
			assert.equal(result.reason, "done");
		}));

	it("does not treat an unavailable pane and unreadable terminal as exit evidence", async () =>
		usingFixture(async (f) => {
			const sessionFile = join(f.root, "unavailable.jsonl");
			writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
			const controller = new AbortController();
			await assert.rejects(
				waitForCompletion(controller.signal, {
					sessionFile,
					intervalMs: 1,
					requireProcessExit: true,
					inspectProcess: () => "unknown",
					readTerminalTail: async () => {
						throw new Error("unavailable");
					},
					inspectPane: async () => ({ kind: "unavailable" }),
					onTick: () => controller.abort(),
				}),
				/Aborted/,
			);
			assert.equal(existsSync(`${sessionFile}.exit`), true);
		}));

	it("reports a verified process exit without semantic evidence as a crash", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			requireProcessExit: true,
			inspectProcess: () => "exited",
			paneDisappearanceGraceMs: 0,
			readTerminalTail: async () => "",
		});
		assert.equal(result.reason, "error");
		assert.match(
			result.errorMessage!,
			/process exited before completion evidence/,
		);
	});

	for (const worktree of [false, true])
		it(`keeps a persistent ${worktree ? "worktree" : "ordinary"} child owned until verified exit`, async () =>
			usingFixture(async (f) => {
				const handle = await f.adapter.spawn({
					...f.options,
					worktreeRequest: worktree ? { branch: "owned" } : undefined,
				});
				const child = f.adapter.getRunningChild(handle);
				child.stopState = "requested";
				writeFileSync(
					`${handle.sessionId}.exit`,
					JSON.stringify({ type: "done" }),
				);
				const controller = new AbortController();
				let settled = false;
				const completion = f.adapter.awaitCompletion(handle, controller.signal);
				completion.then(
					() => {
						settled = true;
					},
					() => {},
				);
				try {
					await nextTurn();
					assert.equal(
						settled,
						false,
						"a sidecar precedes shutdown and cannot release ownership",
					);
					assert.equal(f.adapter.exitCode(handle), undefined);
					assert.notEqual(await f.adapter.getState(handle), "done");
					assert.equal(
						existsSync(`${handle.sessionId}.exit`),
						true,
						"an aborted wait must not lose semantic evidence",
					);
				} finally {
					controller.abort();
					await completion.catch(() => {});
				}
				assert.equal(f.surface.listSurfaces().length, 1);
				if (worktree) {
					await child.processIdentityCapture;
					assert.ok(child.processIdentity);
					f.kernel.alive = false;
				} else {
					f.surface.readScreen = () => "__SUBAGENT_DONE_0__";
				}
				const result = await f.adapter.awaitCompletion(
					handle,
					new AbortController().signal,
				);
				assert.equal(result.reason, "done");
				assert.equal(f.adapter.exitCode(handle), 0);
				assert.equal(
					result.worktree,
					undefined,
					"Git enrichment belongs to runtime finalization, not raw exit evidence",
				);
				assert.equal(
					f.surface.listSurfaces().length,
					1,
					"completion never closes a retained root",
				);
			}));
});
