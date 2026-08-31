import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	realpathSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import subagentsExtension, {
	__test__ as subagentTest,
} from "../pi-extension/subagents/index.ts";
import {
	beginWorkflowCancellation,
	cancelTerminationResult,
	claimWorkflowTerminal,
	createWorkflowReaderCheckout,
	createWorkflowTerminalGate,
	disposeWorkflowReaderCheckout,
	executeWorkflow,
	recoverWorkflowStartup,
	prepareWorkflow,
	validateWorkflowApproval,
	type JsonValue,
	type WorkflowRole,
} from "../pi-extension/subagents/workflow.ts";

function createRepository() {
	const root = mkdtempSync(join(tmpdir(), "workflow-test-"));
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"]);
	writeFileSync(join(root, "README.md"), "# test\n");
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "source.md"), "source\n");
	execFileSync("git", ["-C", root, "add", "."]);
	execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
	return root;
}

function writeWorkflow(root: string, body: string, run = "review") {
	const dir = join(root, ".pi", "plans", run);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "workflow.js");
	writeFileSync(path, body);
	return path;
}

function workflow(baseSha: string, overrides: any = {}) {
	return `/* herdr-workflow
${JSON.stringify(
	{
		version: 1,
		name: "review source",
		sources: ["docs/source.md", "#7", "https://example.test/spec"],
		baseSha,
		maxAgents: 2,
		maxConcurrency: 2,
		roles: [
			{
				role: "reviewer",
				kind: "review",
				model: "test/model",
				thinking: "low",
			},
		],
		...overrides,
	},
	null,
	2,
)}
*/
// Workflow body.
`;
}

const roles: WorkflowRole[] = [
	{
		name: "reviewer",
		source: "project",
		path: "/roles/reviewer.md",
		body: "Review the source.",
		tools: "read, bash, grep",
	},
];

const models = {
	find(provider: string, id: string) {
		return provider === "test" && id === "model"
			? { provider, id, reasoning: true, thinkingLevelMap: { low: "low" } }
			: undefined;
	},
	available() {
		return [{ provider: "test", id: "model", reasoning: true }];
	},
	hasConfiguredAuth() {
		return true;
	},
};

function prepare(root: string, path: string, workflowRoles = roles) {
	return prepareWorkflow({
		cwd: root,
		path,
		roles: workflowRoles,
		modelRegistry: models,
		parentSession: {
			id: "session-1",
			file: join(root, "parent.jsonl"),
			prepareLeafId: "leaf-1",
		},
	});
}

function createExtensionApi() {
	const tools: any[] = [];
	const sentMessages: any[] = [];
	let receiveMessage: (value: any) => void = () => {};
	const nextMessage = new Promise<any>((resolve) => {
		receiveMessage = resolve;
	});
	return {
		tools,
		sentMessages,
		nextMessage,
		// SAFETY: this fixture implements only the ExtensionAPI members these
		// tests exercise; TypeScript cannot verify partial-mock compatibility
		// without also declaring every unused SDK method.
		api: {
			events: createEventBus(),
			on() {},
			registerTool(tool: any) {
				tools.push(tool);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			sendUserMessage() {},
			sendMessage(message: any, options: any) {
				sentMessages.push({ message, options });
				receiveMessage({ message, options });
			},
			getAllTools() {
				return [];
			},
		} as any,
	};
}

describe("workflow preparation", () => {
	let root = "";

	before(() => {
		root = createRepository();
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	it("builds a fresh isolated Pi child command with only approved read tools", () => {
		const command = subagentTest.buildWorkflowChildCommand({
			checkout: "/checkout",
			sessionFile: "/sessions/child.jsonl",
			id: "child-1",
			name: "workflow reviewer",
			model: "test/model",
			thinking: "low",
			tools: ["read", "grep"],
			rolePrompt: "Review only.",
			task: "Inspect the source.",
		});
		assert.match(command, /cd '\/checkout'/);
		assert.match(
			command,
			/--no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve/,
		);
		assert.match(
			command,
			/--model 'test\/model' --thinking 'low' --tools 'read,grep'/,
		);
		assert.match(
			command,
			/PI_DENY_TOOLS='[^']*caller_ping[^']*herdr_workflow[^']*'/,
		);
	});

	it("prepares one immutable candidate without creating an execution artifact", () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const path = writeWorkflow(
			root,
			workflow(baseSha) + "throw new Error('workflow was evaluated');\n",
		);

		const candidate = prepare(root, path);

		assert.equal(candidate.runId, "review");
		assert.equal(candidate.baseSha, baseSha);
		assert.equal(candidate.repository.root, realpathSync(root));
		assert.match(candidate.scriptHash, /^[a-f0-9]{64}$/);
		assert.deepEqual(candidate.sources, [
			"docs/source.md",
			"#7",
			"https://example.test/spec",
		]);
		assert.deepEqual(candidate.rolePolicies[0].tools, ["read", "grep"]);
		assert.equal(lstatSync(path).isFile(), true);
		assert.throws(() =>
			lstatSync(join(root, ".pi", "plans", "review", "run.jsonl")),
		);
	});

	it("creates a detached reader checkout at the approved base without parent files", () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const candidate = prepare(
			root,
			writeWorkflow(root, workflow(baseSha), "reader-checkout"),
		);
		const parentOnly = join(root, "parent-only.txt");
		writeFileSync(parentOnly, "uncommitted\n");
		const events: Array<{ type: string; [key: string]: JsonValue }> = [];
		const journal = {
			append(type: string, details: Record<string, JsonValue> = {}) {
				events.push({ type, ...details });
				return String(events.length);
			},
			path: join(root, ".pi", "plans", "reader-checkout", "run.jsonl"),
		};
		try {
			const checkout = createWorkflowReaderCheckout(candidate, journal);
			assert.equal(
				readFileSync(join(checkout, "README.md"), "utf8"),
				"# test\n",
			);
			assert.equal(existsSync(join(checkout, "parent-only.txt")), false);
			assert.deepEqual(
				disposeWorkflowReaderCheckout(candidate, checkout, journal),
				{
					path: checkout,
					status: "disposed",
				},
			);
			assert.equal(existsSync(checkout), false);
			assert.deepEqual(
				events.map((event) => event.type),
				["reader_checkout_ready", "reader_checkout_disposed"],
			);
		} finally {
			rmSync(parentOnly, { force: true });
		}
	});

	it("registers parent-only control and prepares through its public seam", async () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const path = writeWorkflow(
			root,
			workflow(baseSha) + "return { prepared: true };\n",
			"control",
		);
		const agents = join(root, ".pi", "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(
			join(agents, "reviewer.md"),
			"---\nname: reviewer\ndescription: test reviewer\ntools: read, bash\n---\nReview carefully.\n",
		);
		const previousCwd = process.cwd();
		const previousChildId = process.env.PI_SUBAGENT_ID;
		const previousHerdrEnv = process.env.HERDR_ENV;
		const previousPath = process.env.PATH;
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\n");
		chmodSync(join(bin, "herdr"), 0o755);
		process.env.HERDR_ENV = "1";
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		delete process.env.PI_SUBAGENT_ID;
		process.chdir(root);
		try {
			const parent = createExtensionApi();
			subagentsExtension(parent.api);
			const control = parent.tools.find(
				(tool) => tool.name === "herdr_workflow",
			);
			assert.ok(control);
			const result = await control.execute(
				"test",
				{ action: "prepare", path },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent.jsonl"),
						getSessionId: () => "session-1",
						getLeafId: () => "leaf-1",
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			assert.match(result.content[0].text, /Prepared workflow control/);
			assert.match(
				result.content[0].text,
				/Review-node policy fingerprints: reviewer=[a-f0-9]{64}/,
			);
			assert.match(result.content[0].text, /APPROVE [a-f0-9]{8}/);
			assert.throws(() =>
				lstatSync(join(root, ".pi", "plans", "control", "run.jsonl")),
			);

			const approval = `APPROVE ${result.details.scriptHash.slice(0, 8)}`;
			const started = await control.execute(
				"start",
				{ action: "start", runId: "control" },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent.jsonl"),
						getSessionId: () => "session-1",
						getLeafId: () => "approval-1",
						getBranch: () => [
							{ id: "leaf-1" },
							{
								id: "approval-1",
								type: "message",
								message: {
									role: "user",
									content: [{ type: "text", text: approval }],
								},
							},
						],
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			assert.match(started.content[0].text, /started in the background/);
			const delivered = await parent.nextMessage;
			assert.equal(delivered.message.customType, "herdr_workflow_result");
			assert.match(delivered.message.content, /"prepared":true/);
			assert.equal(delivered.message.details.state, "completed");
			const events = readFileSync(
				join(root, ".pi", "plans", "control", "run.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.deepEqual(
				events.map((event) => event.type),
				[
					"approved",
					"started",
					"reader_checkout_ready",
					"reader_checkout_disposed",
					"completed",
					"delivery",
				],
			);
			assert.equal(events[0].approvingUserEntryId, "approval-1");
			assert.equal(events[4].envelope.result.prepared, true);
			assert.equal(events[4].envelope.checkout.status, "disposed");
			assert.equal(
				existsSync(join(root, ".pi", "plans", "control", "reader-checkout")),
				false,
			);
			assert.equal("envelope" in events[5], false);

			process.env.PI_SUBAGENT_ID = "workflow-child";
			const child = createExtensionApi();
			subagentsExtension(child.api);
			assert.equal(
				child.tools.some((tool) => tool.name === "herdr_workflow"),
				false,
			);
		} finally {
			process.chdir(previousCwd);
			if (previousChildId == null) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = previousChildId;
			if (previousHerdrEnv == null) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previousHerdrEnv;
			if (previousPath == null) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("accepts only an exact post-prepare user approval in the preparing session", () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const candidate = prepare(
			root,
			writeWorkflow(root, workflow(baseSha), "approval"),
		);
		const expected = `APPROVE ${candidate.scriptHash.slice(0, 8)}`;
		const parent = {
			sessionId: "session-1",
			sessionFile: join(root, "parent.jsonl"),
			branch: [
				{ id: "leaf-1" },
				{
					id: "approval-1",
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: expected }],
					},
				},
			],
		};
		assert.deepEqual(validateWorkflowApproval(candidate, parent), {
			entryId: "approval-1",
		});
		assert.throws(() =>
			validateWorkflowApproval(candidate, { ...parent, sessionId: "other" }),
		);
		assert.throws(() =>
			validateWorkflowApproval(candidate, {
				...parent,
				branch: [
					...parent.branch,
					{
						id: "later",
						type: "message",
						message: {
							role: "user",
							content: [{ type: "text", text: `${expected} ` }],
						},
					},
				],
			}),
		);
		assert.throws(() =>
			validateWorkflowApproval(candidate, {
				...parent,
				branch: parent.branch.slice(1),
			}),
		);
	});

	it("allows distinct review nodes to share one role", () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const legacyCandidate = prepare(
			root,
			writeWorkflow(root, workflow(baseSha), "legacy-reviewer-role"),
		);
		const legacy = subagentTest.resolveWorkflowReviewNode(
			legacyCandidate.rolePolicies,
			undefined,
			"reviewer",
		);
		assert.ok("policy" in legacy);
		assert.equal(legacy.policy.id, "reviewer");

		const candidate = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha, {
					roles: [
						{
							id: "standards",
							role: "reviewer",
							kind: "review",
							model: "test/model",
							thinking: "low",
						},
						{
							id: "spec",
							role: "reviewer",
							kind: "review",
							model: "test/model",
							thinking: "low",
						},
					],
				}),
				"shared-reviewer-role",
			),
		);

		assert.deepEqual(
			candidate.rolePolicies.map(({ id, role }) => ({ id, role })),
			[
				{ id: "standards", role: "reviewer" },
				{ id: "spec", role: "reviewer" },
			],
		);
		assert.deepEqual(
			subagentTest.resolveWorkflowReviewNode(
				candidate.rolePolicies,
				undefined,
				"reviewer",
			),
			{
				error: 'Workflow role "reviewer" is ambiguous; use a review node ID.',
			},
		);
	});

	it("fails closed at the artifact, metadata, source, and role-policy boundaries", () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const cases: Array<{ name: string; setup: (run: string) => string }> = [
			{
				name: "path outside plans",
				setup: () => join(root, "workflow.js"),
			},
			{
				name: "reused journal",
				setup: (run) => {
					const path = writeWorkflow(root, workflow(baseSha), run);
					writeFileSync(join(root, ".pi", "plans", run, "run.jsonl"), "{}\n");
					return path;
				},
			},
			{
				name: "unknown metadata field",
				setup: (run) =>
					writeWorkflow(root, workflow(baseSha, { unexpected: true }), run),
			},
			{
				name: "source path escape",
				setup: (run) =>
					writeWorkflow(
						root,
						workflow(baseSha, { sources: ["../outside"] }),
						run,
					),
			},
			{
				name: "unknown role",
				setup: (run) =>
					writeWorkflow(
						root,
						workflow(baseSha, {
							roles: [
								{
									role: "missing",
									kind: "review",
									model: "test/model",
									thinking: "low",
								},
							],
						}),
						run,
					),
			},
			{
				name: "write role",
				setup: (run) =>
					writeWorkflow(
						root,
						workflow(baseSha, {
							roles: [
								{
									role: "reviewer",
									kind: "write",
									model: "test/model",
									thinking: "low",
								},
							],
						}),
						run,
					),
			},
			{
				name: "unauthenticated model",
				setup: (run) =>
					writeWorkflow(
						root,
						workflow(baseSha, {
							roles: [
								{
									role: "reviewer",
									kind: "review",
									model: "other/model",
									thinking: "low",
								},
							],
						}),
						run,
					),
			},
			{
				name: "syntax error",
				setup: (run) => writeWorkflow(root, workflow(baseSha) + "if (", run),
			},
		];

		for (const [index, testCase] of cases.entries()) {
			const run = `invalid-${index}`;
			const path = testCase.setup(run);
			assert.throws(() => prepare(root, path), testCase.name);
		}
	});

	it("rejects every remaining strict metadata, source, and capability boundary", () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const cases: Array<{ name: string; overrides: any }> = [
			{ name: "short base SHA", overrides: { baseSha: baseSha.slice(0, -1) } },
			{ name: "empty sources", overrides: { sources: [] } },
			{ name: "too many agents", overrides: { maxAgents: 9 } },
			{ name: "concurrency above agents", overrides: { maxConcurrency: 3 } },
			{
				name: "missing thinking",
				overrides: {
					roles: [{ role: "reviewer", kind: "review", model: "test/model" }],
				},
			},
			{
				name: "duplicate review node",
				overrides: {
					roles: [
						{
							role: "reviewer",
							kind: "review",
							model: "test/model",
							thinking: "low",
						},
						{
							role: "reviewer",
							kind: "review",
							model: "test/model",
							thinking: "low",
						},
					],
				},
			},
			{
				name: "unsupported role field",
				overrides: {
					roles: [
						{
							role: "reviewer",
							kind: "review",
							model: "test/model",
							thinking: "low",
							extra: true,
						},
					],
				},
			},
			{ name: "absolute source", overrides: { sources: ["/tmp"] } },
		];
		for (const [index, testCase] of cases.entries()) {
			assert.throws(
				() =>
					prepare(
						root,
						writeWorkflow(
							root,
							workflow(baseSha, testCase.overrides),
							`strict-${index}`,
						),
					),
				testCase.name,
			);
		}

		const outside = `${root}-outside-source.md`;
		try {
			writeFileSync(outside, "outside\n");
			const sourceLink = join(root, "docs", "source-link.md");
			symlinkSync(outside, sourceLink);
			assert.throws(
				() =>
					prepare(
						root,
						writeWorkflow(
							root,
							workflow(baseSha, { sources: ["docs/source-link.md"] }),
							"source-link",
						),
					),
				"source symlink escape",
			);
		} finally {
			rmSync(outside, { force: true });
		}

		assert.throws(
			() =>
				prepare(root, writeWorkflow(root, workflow(baseSha), "no-read-tools"), [
					{ ...roles[0], tools: "bash" },
				]),
			"empty read-only tools",
		);
	});

	it("executes JSON results in a worker and terminates bad asynchronous scripts", async () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const complete = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) + "log('running');\nreturn { answer: 42 };\n",
				"worker-complete",
			),
		);
		const logs: string[] = [];
		assert.deepEqual(
			await executeWorkflow(complete, {
				deadlineMs: 1_000,
				onLog: (message) => logs.push(message),
			}),
			{ state: "completed", result: { answer: 42 } },
		);
		assert.deepEqual(logs, ["running"]);
		const childResult = {
			ok: true,
			value: "reviewed",
			sessionFile: "/sessions/child.jsonl",
		};
		const agent = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) +
					"return await agent('Review the source.', { kind: 'review', node: 'reviewer' });\n",
				"worker-agent",
			),
		);
		let request: { prompt: string; options: unknown } | undefined;
		assert.deepEqual(
			await executeWorkflow(agent, {
				deadlineMs: 1_000,
				onAgent: async (prompt, options) => {
					request = { prompt, options };
					return childResult;
				},
			}),
			{ state: "completed", result: childResult },
		);
		assert.deepEqual(request, {
			prompt: "Review the source.",
			options: { kind: "review", node: "reviewer" },
		});
		const legacyAgent = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) +
					"return await agent('Review the source.', { kind: 'review', role: 'reviewer' });\n",
				"worker-legacy-agent",
			),
		);
		let legacyRequest: { prompt: string; options: unknown } | undefined;
		assert.deepEqual(
			await executeWorkflow(legacyAgent, {
				deadlineMs: 1_000,
				onAgent: async (prompt, options) => {
					legacyRequest = { prompt, options };
					return childResult;
				},
			}),
			{ state: "completed", result: childResult },
		);
		assert.deepEqual(legacyRequest, {
			prompt: "Review the source.",
			options: { kind: "review", role: "reviewer" },
		});
		const invalidAgent = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) +
					"return await agent('Review the source.', { role: 'reviewer' });\n",
				"worker-invalid-agent",
			),
		);
		assert.equal(
			(await executeWorkflow(invalidAgent, { deadlineMs: 1_000 })).state,
			"failed",
		);
		assert.deepEqual(
			await executeWorkflow(agent, {
				deadlineMs: 1_000,
				onAgent: () => {
					throw new Error("launch unavailable");
				},
			}),
			{
				state: "completed",
				result: {
					ok: false,
					code: "workflow_agent_error",
					message: "launch unavailable",
					retryable: false,
				},
			},
		);
		const noConsole = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) + "return typeof console;\n",
				"worker-console",
			),
		);
		assert.deepEqual(await executeWorkflow(noConsole, { deadlineMs: 1_000 }), {
			state: "completed",
			result: "undefined",
		});

		const lossy = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) + "return { nested: undefined };\n",
				"worker-lossy",
			),
		);
		assert.equal(
			(await executeWorkflow(lossy, { deadlineMs: 1_000 })).state,
			"failed",
		);
		const sparse = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) + "return new Array(1);\n",
				"worker-sparse",
			),
		);
		assert.equal(
			(await executeWorkflow(sparse, { deadlineMs: 1_000 })).state,
			"failed",
		);
		const nonFinite = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) + "return { value: Infinity };\n",
				"worker-nonfinite",
			),
		);
		assert.equal(
			(await executeWorkflow(nonFinite, { deadlineMs: 1_000 })).state,
			"failed",
		);
		const oversized = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) + "return 'x'.repeat(65536);\n",
				"worker-oversized",
			),
		);
		assert.equal(
			(await executeWorkflow(oversized, { deadlineMs: 1_000 })).state,
			"failed",
		);
		const tooManyLogs = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) +
					"for (let i = 0; i < 101; i++) log('x');\nreturn true;\n",
				"worker-logs",
			),
		);
		assert.equal(
			(await executeWorkflow(tooManyLogs, { deadlineMs: 1_000 })).state,
			"failed",
		);

		const loop = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha) + "await Promise.resolve();\nfor (;;) {}\n",
				"worker-loop",
			),
		);
		assert.deepEqual(await executeWorkflow(loop, { deadlineMs: 50 }), {
			state: "failed",
			error: {
				code: "workflow_deadline",
				message: "Workflow deadline exceeded",
			},
		});
	});

	it("preserves failed review evidence for synthesis and an incomplete task result", async () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const synthesisRole = { ...roles[0], name: "synthesizer" };
		const candidate = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha, {
					maxAgents: 3,
					roles: [
						{
							role: "reviewer",
							kind: "review",
							model: "test/model",
							thinking: "low",
						},
						{
							role: "synthesizer",
							kind: "review",
							model: "test/model",
							thinking: "low",
						},
					],
				}) +
					`
const reviews = await Promise.all([
  agent("first", { kind: "review", role: "reviewer" }),
  agent("second", { kind: "review", role: "reviewer" }),
]);
const synthesis = await agent("SYNTHESIS " + JSON.stringify(reviews), { kind: "review", role: "synthesizer" });
return { status: reviews.every((review) => review.ok) ? "complete" : "incomplete", reviews, synthesis };
`,
				"worker-incomplete",
			),
			[roles[0], synthesisRole],
		);
		const result = await executeWorkflow(candidate, {
			deadlineMs: 1_000,
			onAgent: (prompt, options): any => {
				if (options.role === "synthesizer") {
					assert.match(prompt, /"code":"child_error"/);
					return { ok: true, value: "incomplete evidence" };
				}
				return prompt === "first"
					? { ok: true, value: "reviewed" }
					: {
							ok: false,
							code: "child_error",
							message: "pane lost",
							retryable: false,
						};
			},
		});
		assert.deepEqual(result, {
			state: "completed",
			result: {
				status: "incomplete",
				reviews: [
					{ ok: true, value: "reviewed" },
					{
						ok: false,
						code: "child_error",
						message: "pane lost",
						retryable: false,
					},
				],
				synthesis: { ok: true, value: "incomplete evidence" },
			},
		});
	});

	it("queues raw Promise fan-out FIFO within the approved concurrency and agent caps", async () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const candidate = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha, { maxAgents: 2, maxConcurrency: 1 }) +
					`
const results = await Promise.all([
  agent("first", { kind: "review", role: "reviewer" }),
  agent("second", { kind: "review", role: "reviewer" }),
  agent("third", { kind: "review", role: "reviewer" }),
]);
return results;
`,
				"worker-fifo",
			),
		);
		const calls: string[] = [];
		let active = 0;
		let peak = 0;
		const result = await executeWorkflow(candidate, {
			deadlineMs: 1_000,
			onAgent: async (prompt) => {
				calls.push(prompt);
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return { ok: true, value: prompt };
			},
		});
		assert.deepEqual(calls, ["first", "second"]);
		assert.equal(peak, 1);
		assert.deepEqual(result, {
			state: "completed",
			result: [
				{ ok: true, value: "first" },
				{ ok: true, value: "second" },
				{
					ok: false,
					code: "agent_limit",
					message: "Workflow agent limit exceeded.",
					retryable: false,
				},
			],
		});
	});

	it("rejects a workflow artifact reached through a symlink", () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const target = writeWorkflow(root, workflow(baseSha), "target");
		const linkDir = join(root, ".pi", "plans", "linked");
		symlinkSync(join(root, ".pi", "plans", "target"), linkDir);

		assert.throws(() => prepare(root, join(linkDir, "workflow.js")));
		assert.equal(lstatSync(target).isFile(), true);
	});

	it("marks only direct running journals interrupted after a full restart", () => {
		const plans = join(root, ".pi", "plans");
		const interruptedDir = join(plans, "restart-running");
		const nestedDir = join(plans, "nested", "restart-running");
		const settledDir = join(plans, "restart-settled");
		mkdirSync(interruptedDir, { recursive: true });
		mkdirSync(nestedDir, { recursive: true });
		mkdirSync(settledDir, { recursive: true });
		writeFileSync(
			join(interruptedDir, "run.jsonl"),
			'{"id":"start","type":"started"}\n{"id":"torn","type":"started"',
		);
		writeFileSync(
			join(nestedDir, "run.jsonl"),
			'{"id":"nested","type":"started"}\n',
		);
		writeFileSync(
			join(settledDir, "run.jsonl"),
			'{"id":"terminal","type":"completed","envelope":{"state":"completed"}}\n' +
				'{"id":"delivery","type":"delivery","terminalEventId":"terminal","state":"completed"}\n',
		);

		const records = recoverWorkflowStartup(root);
		const interruptedPath = join(interruptedDir, "run.jsonl");
		const interrupted = readFileSync(interruptedPath, "utf8");
		assert.equal(
			records.find((record) => record.runId === "restart-running")?.interrupted,
			true,
		);
		assert.match(
			interrupted,
			/"id":"torn","type":"started"\n\{"id":"[^"]+","type":"interrupted"/,
		);
		assert.equal(interrupted.endsWith("\n"), true);
		assert.equal(
			readFileSync(join(nestedDir, "run.jsonl"), "utf8").trim().split("\n")
				.length,
			1,
		);
		assert.equal(
			readFileSync(join(settledDir, "run.jsonl"), "utf8").trim().split("\n")
				.length,
			2,
		);
		const secondRecords = recoverWorkflowStartup(root);
		assert.equal(
			secondRecords.find((record) => record.runId === "restart-running")
				?.interrupted,
			false,
		);
		assert.equal(readFileSync(interruptedPath, "utf8"), interrupted);
	});

	it("uses a compare-and-set terminal gate so only one path wins", () => {
		const gate = createWorkflowTerminalGate();
		assert.equal(
			claimWorkflowTerminal(gate, { state: "completed", result: { ok: true } }),
			true,
		);
		assert.equal(claimWorkflowTerminal(gate, { state: "cancelled" }), false);
		assert.equal(gate.outcome?.state, "completed");

		const cancelGate = createWorkflowTerminalGate();
		assert.deepEqual(beginWorkflowCancellation(cancelGate), { claimed: true });
		assert.equal(
			claimWorkflowTerminal(cancelGate, { state: "completed", result: 1 }),
			false,
		);
		assert.equal(
			claimWorkflowTerminal(cancelGate, {
				state: "cancelled",
				error: { code: "cancelled", message: "Workflow cancelled." },
			}),
			true,
		);
		assert.deepEqual(beginWorkflowCancellation(cancelGate), {
			claimed: false,
			outcome: {
				state: "cancelled",
				error: { code: "cancelled", message: "Workflow cancelled." },
			},
		});
		const midCancel = createWorkflowTerminalGate();
		assert.deepEqual(beginWorkflowCancellation(midCancel), { claimed: true });
		assert.deepEqual(beginWorkflowCancellation(midCancel), { claimed: false });
		assert.deepEqual(cancelTerminationResult([4242], "/tmp/reader-checkout"), {
			retainCheckout: true,
			outcome: {
				state: "failed",
				error: {
					code: "cancel_termination_failed",
					message:
						"Workflow cancellation could not confirm process exit for: 4242",
				},
			},
			checkout: {
				path: "/tmp/reader-checkout",
				status: "retained",
				reason: "cancel_termination_failed",
			},
		});
		assert.equal(
			cancelTerminationResult([], "/tmp/reader-checkout", {
				identityUnconfirmed: true,
			}).retainCheckout,
			true,
		);
		assert.equal(
			cancelTerminationResult([], "/tmp/reader-checkout", {
				identityUnconfirmed: true,
			}).outcome.state,
			"failed",
		);
		assert.equal(cancelTerminationResult([]).retainCheckout, false);
		assert.equal(cancelTerminationResult([]).outcome.state, "cancelled");
	});

	it("cancels queued agents and terminates the Worker under abort", async () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const candidate = prepare(
			root,
			writeWorkflow(
				root,
				workflow(baseSha, { maxAgents: 3, maxConcurrency: 1 }) +
					`
const results = await Promise.all([
  agent("first", { kind: "review", role: "reviewer" }),
  agent("second", { kind: "review", role: "reviewer" }),
  agent("third", { kind: "review", role: "reviewer" }),
]);
return results;
`,
				"worker-cancel",
			),
		);
		const controller = new AbortController();
		const started: string[] = [];
		let resolveFirstSeen!: () => void;
		const firstSeen = new Promise<void>((resolve) => {
			resolveFirstSeen = resolve;
		});
		const resultPromise = executeWorkflow(candidate, {
			deadlineMs: 5_000,
			signal: controller.signal,
			onAgent: async (prompt) => {
				started.push(prompt);
				if (prompt === "first") resolveFirstSeen();
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { ok: true, value: prompt };
			},
		});
		await firstSeen;
		controller.abort();
		const result = await resultPromise;
		assert.equal(result.state, "cancelled");
		assert.deepEqual(started, ["first"]);
	});

	it("cancels an active public control workflow idempotently", async () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const path = writeWorkflow(
			root,
			workflow(baseSha, { maxAgents: 2, maxConcurrency: 1 }) +
				`
await agent("slow", { kind: "review", role: "reviewer" });
return { shouldNot: "complete" };
`,
			"cancel-control",
		);
		const agents = join(root, ".pi", "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(
			join(agents, "reviewer.md"),
			"---\nname: reviewer\ndescription: test reviewer\ntools: read, bash\n---\nReview carefully.\n",
		);
		const previousCwd = process.cwd();
		const previousChildId = process.env.PI_SUBAGENT_ID;
		const previousHerdrEnv = process.env.HERDR_ENV;
		const previousPath = process.env.PATH;
		const bin = join(root, "bin-cancel");
		mkdirSync(bin);
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\n");
		chmodSync(join(bin, "herdr"), 0o755);
		process.env.HERDR_ENV = "1";
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		delete process.env.PI_SUBAGENT_ID;
		process.chdir(root);
		try {
			const parent = createExtensionApi();
			subagentsExtension(parent.api);
			const control = parent.tools.find(
				(tool) => tool.name === "herdr_workflow",
			);
			assert.ok(control);
			const prepared = await control.execute(
				"prep",
				{ action: "prepare", path },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent-cancel.jsonl"),
						getSessionId: () => "session-cancel",
						getLeafId: () => "leaf-cancel",
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			const approval = `APPROVE ${prepared.details.scriptHash.slice(0, 8)}`;
			await control.execute(
				"start",
				{ action: "start", runId: "cancel-control" },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent-cancel.jsonl"),
						getSessionId: () => "session-cancel",
						getLeafId: () => "approval-cancel",
						getBranch: () => [
							{ id: "leaf-cancel" },
							{
								id: "approval-cancel",
								type: "message",
								message: {
									role: "user",
									content: [{ type: "text", text: approval }],
								},
							},
						],
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			const cancelled = await control.execute(
				"cancel",
				{ action: "cancel", runId: "cancel-control" },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent-cancel.jsonl"),
						getSessionId: () => "session-cancel",
						getLeafId: () => "approval-cancel",
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			assert.match(cancelled.content[0].text, /cancelled/);
			const again = await control.execute(
				"cancel-again",
				{ action: "cancel", runId: "cancel-control" },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent-cancel.jsonl"),
						getSessionId: () => "session-cancel",
						getLeafId: () => "approval-cancel",
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			assert.match(
				again.content[0].text,
				/already ended as cancelled|cancelled/,
			);
			const delivered = await parent.nextMessage;
			assert.equal(delivered.message.customType, "herdr_workflow_result");
			assert.equal(delivered.message.details.state, "cancelled");
			const events = readFileSync(
				join(root, ".pi", "plans", "cancel-control", "run.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const terminals = events.filter((event) =>
				["completed", "failed", "cancelled", "interrupted"].includes(
					event.type,
				),
			);
			assert.equal(terminals.length, 1);
			assert.equal(terminals[0].type, "cancelled");
			assert.equal(
				events.filter((event) => event.type === "delivery").length,
				1,
			);
			assert.equal("envelope" in events.at(-1), false);
		} finally {
			process.chdir(previousCwd);
			if (previousChildId == null) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = previousChildId;
			if (previousHerdrEnv == null) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previousHerdrEnv;
			if (previousPath == null) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("retains checkout and fails when cancel cannot confirm process exit", async () => {
		const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const path = writeWorkflow(
			root,
			workflow(baseSha, { maxAgents: 2, maxConcurrency: 1 }) +
				`
await agent("slow", { kind: "review", role: "reviewer" });
return { shouldNot: "complete" };
`,
			"cancel-survivor",
		);
		const agents = join(root, ".pi", "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(
			join(agents, "reviewer.md"),
			"---\nname: reviewer\ndescription: test reviewer\ntools: read, bash\n---\nReview carefully.\n",
		);
		const previousCwd = process.cwd();
		const previousChildId = process.env.PI_SUBAGENT_ID;
		const previousHerdrEnv = process.env.HERDR_ENV;
		const previousPath = process.env.PATH;
		const bin = join(root, "bin-cancel-survivor");
		mkdirSync(bin);
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\n");
		chmodSync(join(bin, "herdr"), 0o755);
		process.env.HERDR_ENV = "1";
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		delete process.env.PI_SUBAGENT_ID;
		process.chdir(root);
		subagentTest.setWorkflowCancelHooks({
			getProcessInfo: () => ({
				paneId: "survivor-pane",
				shellPid: 4242,
				pids: [4242],
				foregroundProcesses: [],
			}),
			closeSurface: () => {},
			waitAbsence: async () => true,
			waitExit: async () => [4242],
		});
		try {
			const parent = createExtensionApi();
			subagentsExtension(parent.api);
			const control = parent.tools.find(
				(tool) => tool.name === "herdr_workflow",
			);
			assert.ok(control);
			const prepared = await control.execute(
				"prep",
				{ action: "prepare", path },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent-survivor.jsonl"),
						getSessionId: () => "session-survivor",
						getLeafId: () => "leaf-survivor",
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			const approval = `APPROVE ${prepared.details.scriptHash.slice(0, 8)}`;
			await control.execute(
				"start",
				{ action: "start", runId: "cancel-survivor" },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent-survivor.jsonl"),
						getSessionId: () => "session-survivor",
						getLeafId: () => "approval-survivor",
						getBranch: () => [
							{ id: "leaf-survivor" },
							{
								id: "approval-survivor",
								type: "message",
								message: {
									role: "user",
									content: [{ type: "text", text: approval }],
								},
							},
						],
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);

			// Plant a synthetic active child so cancel exercises process wait.
			const deadline = Date.now() + 5_000;
			let owner = subagentTest.getActiveWorkflow();
			while ((!owner || !owner.checkout) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				owner = subagentTest.getActiveWorkflow();
			}
			if (!owner?.checkout) {
				throw new Error("reader checkout must exist before cancel");
			}
			const checkoutPath = owner.checkout;
			owner.children.set("synthetic-survivor", {
				controller: new AbortController(),
				surface: "survivor-pane",
			});

			const failed = await control.execute(
				"cancel",
				{ action: "cancel", runId: "cancel-survivor" },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent-survivor.jsonl"),
						getSessionId: () => "session-survivor",
						getLeafId: () => "approval-survivor",
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			assert.match(
				failed.content[0].text,
				/cancel_termination_failed|ended as failed/,
			);
			assert.equal(failed.details.status, "failed");
			assert.equal(
				failed.details.outcome?.error?.code,
				"cancel_termination_failed",
			);

			const again = await control.execute(
				"cancel-again",
				{ action: "cancel", runId: "cancel-survivor" },
				new AbortController().signal,
				() => {},
				{
					cwd: root,
					sessionManager: {
						getSessionFile: () => join(root, "parent-survivor.jsonl"),
						getSessionId: () => "session-survivor",
						getLeafId: () => "approval-survivor",
					},
					modelRegistry: {
						find: models.find,
						getAvailable: models.available,
						hasConfiguredAuth: models.hasConfiguredAuth,
					},
				},
			);
			assert.match(
				again.content[0].text,
				/already ended as failed|ended as failed/,
			);
			assert.equal(again.details.status, "failed");
			assert.equal(
				again.details.outcome?.error?.code,
				"cancel_termination_failed",
			);

			const delivered = await parent.nextMessage;
			assert.equal(delivered.message.customType, "herdr_workflow_result");
			assert.equal(delivered.message.details.state, "failed");
			assert.equal(
				delivered.message.details.error?.code,
				"cancel_termination_failed",
			);
			assert.equal(existsSync(checkoutPath), true);

			const events = readFileSync(
				join(root, ".pi", "plans", "cancel-survivor", "run.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const terminals = events.filter((event) =>
				["completed", "failed", "cancelled", "interrupted"].includes(
					event.type,
				),
			);
			assert.equal(terminals.length, 1);
			assert.equal(terminals[0].type, "failed");
			assert.equal(
				terminals[0].envelope.error.code,
				"cancel_termination_failed",
			);
			assert.equal(
				events.filter((event) => event.type === "delivery").length,
				1,
			);
			assert.ok(
				events.some(
					(event) =>
						event.type === "reader_checkout_retained" &&
						event.reason === "cancel_termination_failed",
				),
			);
			assert.ok(
				events.some(
					(event) =>
						event.type === "cancel_process_info" &&
						Array.isArray(event.pids) &&
						event.pids.includes(4242),
				),
			);
			assert.equal(
				events.some((event) => event.type === "reader_checkout_disposed"),
				false,
			);
		} finally {
			subagentTest.setWorkflowCancelHooks(undefined);
			process.chdir(previousCwd);
			if (previousChildId == null) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = previousChildId;
			if (previousHerdrEnv == null) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previousHerdrEnv;
			if (previousPath == null) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	for (const scenario of [
		{
			name: "getProcessInfo throws",
			runId: "cancel-info-throw",
			hooks: {
				getProcessInfo: () => {
					throw new Error("boom");
				},
				closeSurface: () => {},
				waitAbsence: async () => true,
				waitExit: async () => [],
			},
			journalType: "cancel_process_info_failed",
			assertJournal: (events: Array<Record<string, JsonValue>>) => {
				assert.ok(
					events.some(
						(event) =>
							event.type === "cancel_process_info_failed" &&
							String(event.error).includes("boom"),
					),
				);
			},
		},
		{
			name: "getProcessInfo returns empty pids",
			runId: "cancel-info-empty",
			hooks: {
				getProcessInfo: () => ({
					paneId: "empty-pane",
					shellPid: 1,
					pids: [],
					foregroundProcesses: [],
				}),
				closeSurface: () => {},
				waitAbsence: async () => true,
				waitExit: async () => [],
			},
			journalType: "cancel_process_info",
			assertJournal: (events: Array<Record<string, JsonValue>>) => {
				assert.ok(
					events.some(
						(event) =>
							event.type === "cancel_process_info" &&
							Array.isArray(event.pids) &&
							event.pids.length === 0,
					),
				);
			},
		},
	] as const) {
		it(`retains checkout and fails cancel when ${scenario.name}`, async () => {
			const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim();
			const path = writeWorkflow(
				root,
				workflow(baseSha, { maxAgents: 2, maxConcurrency: 1 }) +
					`
await agent("slow", { kind: "review", role: "reviewer" });
return { shouldNot: "complete" };
`,
				scenario.runId,
			);
			const agents = join(root, ".pi", "agents");
			mkdirSync(agents, { recursive: true });
			writeFileSync(
				join(agents, "reviewer.md"),
				"---\nname: reviewer\ndescription: test reviewer\ntools: read, bash\n---\nReview carefully.\n",
			);
			const previousCwd = process.cwd();
			const previousChildId = process.env.PI_SUBAGENT_ID;
			const previousHerdrEnv = process.env.HERDR_ENV;
			const previousPath = process.env.PATH;
			const bin = join(root, `bin-${scenario.runId}`);
			mkdirSync(bin);
			writeFileSync(join(bin, "herdr"), "#!/bin/sh\n");
			chmodSync(join(bin, "herdr"), 0o755);
			process.env.HERDR_ENV = "1";
			process.env.PATH = `${bin}:${previousPath ?? ""}`;
			delete process.env.PI_SUBAGENT_ID;
			process.chdir(root);
			subagentTest.setWorkflowCancelHooks(scenario.hooks);
			try {
				const parent = createExtensionApi();
				subagentsExtension(parent.api);
				const control = parent.tools.find(
					(tool) => tool.name === "herdr_workflow",
				);
				assert.ok(control);
				const prepared = await control.execute(
					"prep",
					{ action: "prepare", path },
					new AbortController().signal,
					() => {},
					{
						cwd: root,
						sessionManager: {
							getSessionFile: () =>
								join(root, `parent-${scenario.runId}.jsonl`),
							getSessionId: () => `session-${scenario.runId}`,
							getLeafId: () => `leaf-${scenario.runId}`,
						},
						modelRegistry: {
							find: models.find,
							getAvailable: models.available,
							hasConfiguredAuth: models.hasConfiguredAuth,
						},
					},
				);
				const approval = `APPROVE ${prepared.details.scriptHash.slice(0, 8)}`;
				await control.execute(
					"start",
					{ action: "start", runId: scenario.runId },
					new AbortController().signal,
					() => {},
					{
						cwd: root,
						sessionManager: {
							getSessionFile: () =>
								join(root, `parent-${scenario.runId}.jsonl`),
							getSessionId: () => `session-${scenario.runId}`,
							getLeafId: () => `approval-${scenario.runId}`,
							getBranch: () => [
								{ id: `leaf-${scenario.runId}` },
								{
									id: `approval-${scenario.runId}`,
									type: "message",
									message: {
										role: "user",
										content: [{ type: "text", text: approval }],
									},
								},
							],
						},
						modelRegistry: {
							find: models.find,
							getAvailable: models.available,
							hasConfiguredAuth: models.hasConfiguredAuth,
						},
					},
				);

				const deadline = Date.now() + 5_000;
				let owner = subagentTest.getActiveWorkflow();
				while ((!owner || !owner.checkout) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					owner = subagentTest.getActiveWorkflow();
				}
				if (!owner?.checkout) {
					throw new Error("reader checkout must exist before cancel");
				}
				const checkoutPath = owner.checkout;
				owner.children.set(`synthetic-${scenario.runId}`, {
					controller: new AbortController(),
					surface: `${scenario.runId}-pane`,
				});

				const failed = await control.execute(
					"cancel",
					{ action: "cancel", runId: scenario.runId },
					new AbortController().signal,
					() => {},
					{
						cwd: root,
						sessionManager: {
							getSessionFile: () =>
								join(root, `parent-${scenario.runId}.jsonl`),
							getSessionId: () => `session-${scenario.runId}`,
							getLeafId: () => `approval-${scenario.runId}`,
						},
						modelRegistry: {
							find: models.find,
							getAvailable: models.available,
							hasConfiguredAuth: models.hasConfiguredAuth,
						},
					},
				);
				assert.match(
					failed.content[0].text,
					/cancel_termination_failed|ended as failed/,
				);
				assert.equal(failed.details.status, "failed");
				assert.equal(
					failed.details.outcome?.error?.code,
					"cancel_termination_failed",
				);

				const again = await control.execute(
					"cancel-again",
					{ action: "cancel", runId: scenario.runId },
					new AbortController().signal,
					() => {},
					{
						cwd: root,
						sessionManager: {
							getSessionFile: () =>
								join(root, `parent-${scenario.runId}.jsonl`),
							getSessionId: () => `session-${scenario.runId}`,
							getLeafId: () => `approval-${scenario.runId}`,
						},
						modelRegistry: {
							find: models.find,
							getAvailable: models.available,
							hasConfiguredAuth: models.hasConfiguredAuth,
						},
					},
				);
				assert.match(
					again.content[0].text,
					/already ended as failed|ended as failed/,
				);
				assert.equal(again.details.status, "failed");
				assert.equal(
					again.details.outcome?.error?.code,
					"cancel_termination_failed",
				);

				const delivered = await parent.nextMessage;
				assert.equal(delivered.message.customType, "herdr_workflow_result");
				assert.equal(delivered.message.details.state, "failed");
				assert.equal(
					delivered.message.details.error?.code,
					"cancel_termination_failed",
				);
				assert.equal(existsSync(checkoutPath), true);

				const events = readFileSync(
					join(root, ".pi", "plans", scenario.runId, "run.jsonl"),
					"utf8",
				)
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const terminals = events.filter((event) =>
					["completed", "failed", "cancelled", "interrupted"].includes(
						event.type,
					),
				);
				assert.equal(terminals.length, 1);
				assert.equal(terminals[0].type, "failed");
				assert.equal(
					terminals[0].envelope.error.code,
					"cancel_termination_failed",
				);
				assert.equal(
					events.filter((event) => event.type === "delivery").length,
					1,
				);
				assert.ok(
					events.some(
						(event) =>
							event.type === "reader_checkout_retained" &&
							event.reason === "cancel_termination_failed",
					),
				);
				scenario.assertJournal(events);
				assert.equal(
					events.some((event) => event.type === "reader_checkout_disposed"),
					false,
				);
			} finally {
				subagentTest.setWorkflowCancelHooks(undefined);
				process.chdir(previousCwd);
				if (previousChildId == null) delete process.env.PI_SUBAGENT_ID;
				else process.env.PI_SUBAGENT_ID = previousChildId;
				if (previousHerdrEnv == null) delete process.env.HERDR_ENV;
				else process.env.HERDR_ENV = previousHerdrEnv;
				if (previousPath == null) delete process.env.PATH;
				else process.env.PATH = previousPath;
			}
		});
	}
});
