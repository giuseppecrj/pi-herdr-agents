import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
	type AgentSession,
	createAgentSession,
	createToolSearchExtension,
	DefaultResourceLoader,
	type ExtensionFactory,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";
import {
	isNativeToolSearch,
	type ToolSearchCandidate,
	trackDeferredTools,
} from "../../pi-extension/subagents/deferred-tools.ts";

// The extension reads its durable config when the module loads; point it at
// an empty agent home first.
const root = mkdtempSync(join(tmpdir(), "deferred-tools-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent-home");
const { default: subagentsExtension } = await import(
	"../../pi-extension/subagents/index.ts"
);
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(
	/\/$/,
	"",
);

const ROUTINE: readonly string[] = [
	"subagent",
	"subagent_resume",
	"subagent_interrupt",
	"subagent_cancel",
	"subagent_send",
	"subagent_stop",
	"subagents_list",
	"worktree_list",
	"worktree_remove",
];
const WRITER = "subagents_write_task_models";
const COORDINATOR_RULE = "Act as the coordinator.";
const NAMING_RULE = "choose a short task slug";
const LOAD_SUBAGENT = "launch subagent model thinking";

type SearchMode = "native" | "inline" | "impostor" | "none";

interface Request {
	tools: string[];
	prompt: string;
	/** Tool declarations and prompt as one string, for absence checks. */
	payload: string;
	/** Text of the latest tool result, when the request follows one. */
	toolResult?: string;
}

type Step = (request: Request) => AssistantMessage;

const search =
	(query: string, limit = 1): Step =>
	() =>
		fauxAssistantMessage(fauxToolCall("tool_search", { query, limit }), {
			stopReason: "toolUse",
		});
const reply: Step = () => fauxAssistantMessage("ok");

const impostorSearch: ExtensionFactory = (pi) =>
	pi.registerTool({
		name: "tool_search",
		label: "impostor",
		description: "Another extension's tool_search",
		exposure: "model-only",
		defaultActive: false,
		parameters: Type.Object({ query: Type.String() }),
		async execute() {
			return { content: [{ type: "text", text: "impostor" }], details: {} };
		},
	});

function searchExtensions(mode: SearchMode): InlineExtension[] {
	// The CLI loads Pi's tool search as the built-in `builtin:tool-search`.
	const native: InlineExtension = {
		name: "tool-search",
		factory: createToolSearchExtension(),
		builtin: true,
		replaceable: true,
	};
	if (mode === "native") return [native];
	if (mode === "inline") return [createToolSearchExtension()];
	// A non-replaceable extension tool of the same name replaces the built-in.
	if (mode === "impostor") return [native, impostorSearch];
	return [];
}

async function withEnv<T>(
	vars: Record<string, string | undefined>,
	run: () => Promise<T>,
): Promise<T> {
	const previous = Object.fromEntries(
		Object.keys(vars).map((key) => [key, process.env[key]]),
	);
	for (const [key, value] of Object.entries(vars))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(previous))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
}

let sessionCount = 0;

/**
 * Run the extension in a real SDK session with a scripted faux model and
 * record what each provider request declared.
 */
async function openSession(options: {
	search: SearchMode;
	tools?: string[];
	excludeTools?: string[];
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	/** A child session's PI_SUBAGENT_ID and PI_DENY_TOOLS. */
	child?: { denyTools?: string };
	sessionManager?: (cwd: string) => SessionManager;
	/** Runs before session_start, for example to stand in for a restored loadout. */
	beforeStart?: (session: AgentSession) => void;
}) {
	const dir = join(root, `session-${++sessionCount}`);
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	mkdirSync(cwd, { recursive: true });
	const env = {
		PI_SUBAGENT_ID: options.child ? "deferred-test-child" : undefined,
		PI_DENY_TOOLS: options.child?.denyTools,
		PI_SUBAGENT_MODEL_SCOPE: undefined,
	};
	const requests: Request[] = [];
	const steps: Step[] = [];
	const extensionErrors: string[] = [];
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "test-key");
	// Refresh the availability snapshot the session registry reads.
	await modelRuntime.getAvailable();
	const respond = (context: { messages: any[] }) => {
		const tools = getCurrentTools(context.messages);
		const prompt = getCurrentSystemPrompt(context.messages);
		// Pi appends the tool delta as a system message after the tool result.
		const last = context.messages.findLast(
			(message) => message.role !== "system",
		);
		const request: Request = {
			tools: tools.map((tool) => tool.name),
			prompt,
			payload: `${prompt}\n${JSON.stringify(tools)}`,
			toolResult:
				last?.role === "toolResult"
					? last.content.map((part: any) => part.text ?? "").join("")
					: undefined,
		};
		requests.push(request);
		const step = steps.shift();
		assert.ok(step, "the model was asked for an unscripted response");
		return step(request);
	};
	const session = await withEnv(env, async () => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(options.settings),
			extensionFactories: [
				...searchExtensions(options.search),
				(pi) => subagentsExtension(pi),
			],
			// The user's own skills and context files would mention subagents.
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
		});
		await loader.reload();
		const created = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoader: loader,
			sessionManager:
				options.sessionManager?.(cwd) ?? SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(options.settings),
			tools: options.tools,
			excludeTools: options.excludeTools,
		});
		options.beforeStart?.(created.session);
		// Binding emits session_start; bindings also make reload emit it again.
		await created.session.bindExtensions({
			onError: (error) => extensionErrors.push(error.error),
		});
		return created.session;
	});
	return {
		session,
		requests,
		registered: () => session.getAllTools().map((tool) => tool.name),
		async prompt(text: string, ...script: Step[]) {
			steps.push(...script);
			faux.setResponses(Array.from({ length: script.length }, () => respond));
			await withEnv(env, () => session.prompt(text));
			assert.equal(steps.length, 0, "every scripted response was requested");
		},
		/** Accept one more scripted request, for prompts the extension submits. */
		expect(...script: Step[]) {
			steps.push(...script);
			faux.setResponses(Array.from({ length: script.length }, () => respond));
		},
		reload: () => withEnv(env, () => session.reload()),
		dispose() {
			session.dispose();
			assert.deepEqual(extensionErrors, []);
		},
	};
}

const hostTools = (names: readonly string[]) =>
	names.filter((name) => ROUTINE.includes(name) || name === WRITER);

describe("routine host tools are deferred to Pi's native tool_search", () => {
	it("keeps host schemas, guidelines, and the catalog out until a search loads only its matches", async () => {
		const run = await openSession({ search: "native" });
		try {
			assert.deepEqual(
				hostTools(run.session.getActiveToolNames()),
				[],
				"no host tool is active after startup",
			);
			assert.ok(run.session.getActiveToolNames().includes("tool_search"));
			await run.prompt(
				"Delegate this.",
				search(LOAD_SUBAGENT),
				search("persistent specialist follow-up task"),
				search("write task model preferences models.tasks tasksMeta", 8),
				reply,
			);
			const [first, second, third, fourth] = run.requests;

			assert.ok(first.tools.includes("tool_search"));
			assert.deepEqual(hostTools(first.tools), []);
			assert.doesNotMatch(
				// Pi's docs block names its install path, which can contain these
				// words (for example a checkout under ~/.herdr/worktrees).
				first.payload.replaceAll(PACKAGE_ROOT, "<package-root>"),
				/subagent|worktree|coordinator|model catalog|faux\/m/i,
				"the first request carries no host schema, guideline, or catalog",
			);

			assert.deepEqual(hostTools(second.tools), ["subagent"]);
			assert.match(second.toolResult ?? "", /Loaded 1 tool/);
			assert.ok(second.prompt.includes(COORDINATOR_RULE));
			assert.ok(second.prompt.includes(NAMING_RULE));
			assert.match(
				second.prompt,
				/faux\/m/,
				"the current session's model catalog arrives with subagent",
			);
			assert.doesNotMatch(second.prompt, /model catalog becomes available/);
			assert.deepEqual(
				hostTools(third.tools),
				["subagent", "subagent_send"],
				"optional controls are discoverable one search at a time",
			);
			assert.ok(
				!fourth.tools.includes(WRITER),
				"the init-only writer is never found by search",
			);
			assert.doesNotMatch(fourth.toolResult ?? "", new RegExp(WRITER));
		} finally {
			run.dispose();
		}
	});

	it("leaves the one-shot task-model writer to /subagents-init", async () => {
		const run = await openSession({ search: "native" });
		try {
			const writer = run.session
				.getAllTools()
				.find((tool) => tool.name === WRITER);
			assert.equal(writer?.exposure, "direct", "not searchable");
			assert.ok(!run.session.getActiveToolNames().includes(WRITER));
			run.expect(reply);
			await run.session.prompt("/subagents-init");
			await run.session.waitForIdle();
			const [init] = run.requests;
			assert.ok(init.tools.includes(WRITER), "init activates the writer");
			assert.deepEqual(
				hostTools(init.tools),
				[WRITER],
				"init loads no routine tool",
			);
		} finally {
			run.dispose();
		}
	});

	it("keeps loaded tools and search active across reload and resume", async () => {
		const sessionDir = join(root, "resume-sessions");
		let file: string | undefined;
		const run = await openSession({
			search: "native",
			sessionManager: (cwd) => {
				const manager = SessionManager.create(cwd, sessionDir);
				file = manager.getSessionFile();
				return manager;
			},
		});
		try {
			await run.prompt("Delegate this.", search(LOAD_SUBAGENT), reply);
			await run.reload();
			await run.prompt("After reload.", reply);
			const afterReload = run.requests.at(-1)!;
			assert.ok(afterReload.tools.includes("tool_search"));
			assert.deepEqual(hostTools(afterReload.tools), ["subagent"]);
		} finally {
			run.dispose();
		}
		assert.ok(file);
		const resumed = await openSession({
			search: "native",
			sessionManager: () => SessionManager.open(file!, sessionDir),
			// Pi restores the transcript's loadout on resume; this SDK's
			// createAgentSession always passes initial tools, so restore it the
			// same way before session_start runs.
			beforeStart(session) {
				const restored = getCurrentTools(
					session.sessionManager.buildSessionContext().messages,
				).map((tool) => tool.name);
				assert.ok(restored.includes("subagent"));
				session.setActiveToolsByName(
					restored.filter((name) => name !== "tool_search"),
				);
			},
		});
		try {
			await resumed.prompt("After resume.", search("worktree", 1), reply);
			const [request, next] = resumed.requests;
			assert.ok(
				request.tools.includes("tool_search"),
				"session_start reactivates search without dropping restored tools",
			);
			assert.deepEqual(hostTools(request.tools), ["subagent"]);
			assert.ok(request.prompt.includes(COORDINATOR_RULE));
			assert.equal(hostTools(next.tools).length, 2, "search still loads");
		} finally {
			resumed.dispose();
		}
	});
});

describe("Pi tool policy decides which host tools exist", () => {
	it("an allowlist without host tools registers none and activates no search", async () => {
		const run = await openSession({ search: "native", tools: ["read"] });
		try {
			assert.deepEqual(hostTools(run.registered()), []);
			await run.prompt("Hello.", reply);
			assert.deepEqual(run.requests[0].tools, ["read"]);
		} finally {
			run.dispose();
		}
	});

	it("an allowlist declares the host tools it names, with or without search", async () => {
		for (const tools of [
			["read", "subagent"],
			["read", "tool_search", "subagent"],
		]) {
			const run = await openSession({ search: "native", tools });
			try {
				assert.deepEqual(hostTools(run.registered()), ["subagent"]);
				await run.prompt(
					"Hello.",
					...(tools.includes("tool_search")
						? [search("subagent worktree cancel resume list", 8)]
						: []),
					reply,
				);
				for (const request of run.requests)
					assert.deepEqual(request.tools, tools);
			} finally {
				run.dispose();
			}
		}
	});

	it("excluded host tools stay unreachable through search", async () => {
		const run = await openSession({
			search: "native",
			excludeTools: ["subagent_cancel", "worktree_remove"],
		});
		try {
			await run.prompt("Hello.", search("cancel remove worktree", 8), reply);
			const loaded = hostTools(run.requests[1].tools);
			assert.ok(loaded.includes("worktree_list"));
			assert.ok(!loaded.includes("subagent_cancel"));
			assert.ok(!loaded.includes("worktree_remove"));
		} finally {
			run.dispose();
		}
	});

	it("a child's PI_DENY_TOOLS leaves denied tools unregistered and unsearchable", async () => {
		const run = await openSession({
			search: "native",
			child: { denyTools: "subagent,subagent_resume" },
		});
		try {
			assert.deepEqual(hostTools(run.registered()), [
				"subagent_send",
				"subagent_stop",
				"subagent_interrupt",
				"subagent_cancel",
				"subagents_list",
			]);
			await run.prompt("Hello.", search("subagent launch resume", 8), reply);
			const loaded = hostTools(run.requests[1].tools);
			assert.ok(!loaded.includes("subagent"));
			assert.ok(!loaded.includes("subagent_resume"));
		} finally {
			run.dispose();
		}
	});
});

describe("without Pi's own tool_search the permitted routine tools stay eager", () => {
	for (const [mode, why] of [
		["none", "no search extension is loaded"],
		["inline", "the search tool lacks built-in provenance"],
		["impostor", "another extension replaced the built-in search"],
	] as const)
		it(`activates them when ${why}`, async () => {
			const run = await openSession({ search: mode });
			try {
				await run.prompt("Hello.", reply);
				const [request] = run.requests;
				assert.deepEqual(
					[...hostTools(request.tools)].sort(),
					[...ROUTINE].sort(),
				);
				assert.ok(!request.tools.includes(WRITER));
				assert.ok(
					!request.tools.includes("tool_search"),
					"a search tool that is not Pi's own stays inactive",
				);
				assert.ok(request.prompt.includes(COORDINATOR_RULE));
			} finally {
				run.dispose();
			}
		});

	it("activates the permitted ones when the search tool is excluded", async () => {
		const run = await openSession({
			search: "native",
			excludeTools: ["tool_search", "worktree_remove"],
		});
		try {
			await run.prompt("Hello.", reply);
			const tools = hostTools(run.requests[0].tools);
			assert.deepEqual(
				[...tools].sort(),
				ROUTINE.filter((name) => name !== "worktree_remove").sort(),
			);
		} finally {
			run.dispose();
		}
	});

	it("activates them when defaultTools turns the search off", async () => {
		const run = await openSession({
			search: "native",
			settings: { defaultTools: ["-tool_search"] },
		});
		try {
			await run.prompt("Hello.", reply);
			await run.reload();
			await run.prompt("After reload.", reply);
			for (const request of run.requests) {
				assert.ok(
					!request.tools.includes("tool_search"),
					"the setting keeps search off",
				);
				assert.deepEqual(
					[...hostTools(request.tools)].sort(),
					[...ROUTINE].sort(),
				);
			}
		} finally {
			run.dispose();
		}
	});

	it("a child's deny list wins over its allowlist", async () => {
		const run = await openSession({
			search: "native",
			tools: ["read", "subagent", "subagent_cancel", "caller_ping"],
			child: { denyTools: "subagent_cancel" },
		});
		try {
			await run.prompt("Hello.", reply);
			assert.deepEqual(run.requests[0].tools, ["read", "subagent"]);
		} finally {
			run.dispose();
		}
	});
});

describe("deferred tool registration (mock API)", () => {
	const deferredTool = (name: string): ToolDefinition => ({
		name,
		label: name,
		description: name,
		exposure: "deferred",
		parameters: Type.Object({}),
		async execute() {
			return { content: [], details: {} };
		},
	});
	const nativeSearch = {
		name: "tool_search",
		exposure: "model-only",
		defaultActive: false,
		parameters: {},
		sourceInfo: {
			path: "builtin:tool-search",
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		},
	} satisfies ToolSearchCandidate & {
		defaultActive: boolean;
		parameters: object;
	};

	it("registers the routine tools deferred and the writer direct and inactive", () =>
		withEnv(
			{ PI_SUBAGENT_ID: undefined, PI_DENY_TOOLS: undefined },
			async () => {
				const { api, registeredTools } = createMockExtensionApi();
				subagentsExtension(api);
				const exposures = Object.fromEntries(
					registeredTools.map((tool) => [tool.name, tool.exposure]),
				);
				for (const name of ROUTINE) assert.equal(exposures[name], "deferred");
				assert.equal(exposures[WRITER], undefined);
				assert.equal(
					registeredTools.find((tool) => tool.name === WRITER).defaultActive,
					false,
				);
				assert.deepEqual(hostTools(api.getActiveTools()), []);
			},
		));

	it("activates the native search, else only its own permitted tools", () => {
		const withSearch = createMockExtensionApi();
		const tracked = trackDeferredTools(withSearch.api);
		withSearch.registeredTools.push(nativeSearch);
		tracked.api.registerTool(deferredTool("subagent"));
		assert.equal(tracked.ensureReachable(), "search");
		assert.deepEqual(withSearch.api.getActiveTools(), ["tool_search"]);

		const without = createMockExtensionApi();
		const fallback = trackDeferredTools(without.api);
		for (const name of ["subagent", "subagents_list"])
			fallback.api.registerTool(deferredTool(name));
		// A later extension's tool of the same name replaces this load's, and
		// another extension adds its own deferred tool: neither is activated.
		const listIndex = without.registeredTools.findIndex(
			(tool) => tool.name === "subagents_list",
		);
		without.registeredTools[listIndex] = {
			name: "subagents_list",
			exposure: "deferred",
			parameters: {},
		};
		without.registeredTools.push({
			name: "other_tool",
			exposure: "deferred",
			parameters: {},
		});
		assert.equal(fallback.ensureReachable(), "eager");
		assert.deepEqual(without.api.getActiveTools(), ["subagent"]);

		const none = createMockExtensionApi();
		assert.equal(trackDeferredTools(none.api).ensureReachable(), "none");
	});

	it("recognizes Pi's tool_search only by its built-in provenance", () => {
		assert.equal(isNativeToolSearch(nativeSearch), true);
		for (const variant of [
			{ ...nativeSearch, name: "search" },
			{ ...nativeSearch, exposure: "deferred" },
			{
				...nativeSearch,
				sourceInfo: { ...nativeSearch.sourceInfo, path: "<inline:1>" },
			},
			{
				...nativeSearch,
				sourceInfo: { ...nativeSearch.sourceInfo, source: "inline" },
			},
			{ ...nativeSearch, sourceInfo: undefined },
		] satisfies ToolSearchCandidate[])
			assert.equal(isNativeToolSearch(variant), false);
	});
});
