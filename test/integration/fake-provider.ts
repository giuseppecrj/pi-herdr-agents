import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
	isPlainObject,
	isString,
} from "../../pi-extension/subagents/type-guards.ts";

interface ChatMessage {
	role?: string;
	content?: unknown;
}

interface ChatRequest {
	model?: string;
	messages?: ChatMessage[];
	tools?: Array<{ function?: { name?: string } }>;
}

interface ToolCallArguments {
	name?: string;
	task?: string;
	agent?: string;
	model?: string;
	cwd?: string;
	systemPrompt?: string;
	fork?: boolean;
	worktree?: { branch: string };
	sessionPath?: string;
	message?: string;
	autoExit?: boolean;
	action?: string;
	id?: string;
	persistent?: boolean;
	runId?: string;
	path?: string;
	command?: string;
}

interface ToolCall {
	name: string;
	arguments: ToolCallArguments;
}

interface ResponsePlan {
	text?: string;
	emptyCompletion?: boolean;
	toolCalls?: ToolCall[];
}

export const TEST_MODEL = "pi-integration/test";

export interface ProviderRequest {
	model?: string;
	status: number;
	tools?: string[];
	lastUser?: string;
}

const providerRequests: ProviderRequest[] = [];
const resumeRestrictionStates = new Map<string, "launched" | "resumed">();
const persistentSpecialistStates = new Map<
	string,
	{
		busySent: boolean;
		listSent: boolean;
		taskTwoSent: boolean;
		stopSent: boolean;
		finalListSent: boolean;
	}
>();

export function getProviderRequests(): readonly ProviderRequest[] {
	return providerRequests;
}

export function resetProviderRequests(): void {
	providerRequests.length = 0;
	resumeRestrictionStates.clear();
	persistentSpecialistStates.clear();
}

async function readJson(request: IncomingMessage): Promise<ChatRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function messageText(content: any): string {
	if (isString(content)) return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => isPlainObject(part))
		.filter((part) => part.type === "text" && isString(part.text))
		.map((part) => part.text)
		.join("\n");
}

function requestText(request: ChatRequest): string {
	return (request.messages ?? [])
		.map((message) => messageText(message.content))
		.join("\n");
}

function lastUserText(request: ChatRequest): string {
	const message = [...(request.messages ?? [])]
		.reverse()
		.find((entry) => entry.role === "user");
	return messageText(message?.content);
}

function toolNames(request: ChatRequest): Set<string> {
	return new Set(
		(request.tools ?? []).map((tool) => tool.function?.name).filter(isString),
	);
}

function quotedValue(source: string, key: string): string | undefined {
	const match = source.match(
		new RegExp(`\\b${key}:\\s*"((?:\\\\.|[^"\\\\])*)"`),
	);
	if (!match) return undefined;
	try {
		return JSON.parse(`"${match[1]}"`);
	} catch {
		return match[1];
	}
}

function subagentCalls(source: string): ToolCall[] {
	const names = [...source.matchAll(/\bname:\s*"((?:\\.|[^"\\])*)"/g)];
	return names.flatMap((match, index) => {
		const section = source.slice(match.index, names[index + 1]?.index);
		const name = quotedValue(section, "name");
		const task = quotedValue(section, "task");
		if (!name || !task) return [];

		const agent = quotedValue(section, "agent");
		const model = quotedValue(section, "model");
		const cwd = quotedValue(section, "cwd");
		const systemPrompt = quotedValue(section, "systemPrompt");
		const branch = section.match(
			/\bworktree:\s*\{\s*branch:\s*"((?:\\.|[^"\\])*)"/,
		)?.[1];
		const args: ToolCallArguments = { name, task };
		if (agent) args.agent = agent;
		if (model) args.model = model;
		if (cwd) args.cwd = cwd;
		if (systemPrompt) args.systemPrompt = systemPrompt;
		if (section.includes("fork: true")) args.fork = true;
		if (section.includes("persistent: true")) args.persistent = true;
		if (branch) args.worktree = { branch };
		return [{ name: "subagent", arguments: args }];
	});
}

function subagentSendCall(name: string, message: string): ToolCall {
	return {
		name: "subagent_send",
		arguments: { name, message },
	};
}

function subagentStopCall(name: string): ToolCall {
	return { name: "subagent_stop", arguments: { name } };
}

async function persistentSpecialistResponse(
	request: ChatRequest,
): Promise<ResponsePlan | null> {
	const names = toolNames(request);
	const source = requestText(request);
	const user = lastUserText(request);
	const match = source.match(
		/INTEGRATION_PERSISTENT_SPECIALIST:([A-Za-z0-9_-]+)/,
	);
	const childMatch = source.match(/PERSISTENT_TASK_[12]_([A-Za-z0-9_-]+)/);
	if (!match && !childMatch) return null;
	const id = match?.[1] ?? childMatch?.[1];
	if (!id) return null;
	const specialistName = `Persistent-${id}`;
	const taskOne = `PERSISTENT_TASK_1_${id}`;
	const taskTwo = `PERSISTENT_TASK_2_${id}`;

	// The child is deliberately multi-turn: task 1 performs a visible delay,
	// then both task completions are ordinary assistant turns with no
	// subagent_done call. The inbox poller supplies task 2 later.
	if (!names.has("subagent") && names.has("bash")) {
		if (user.includes(taskOne) && request.messages?.at(-1)?.role !== "tool") {
			const marker = user.match(/PERSISTENT_START_FILE:\s*(\S+)/)?.[1];
			if (marker) {
				return {
					toolCalls: [
						{
							name: "bash",
							arguments: {
								command: `echo 'PERSISTENT_START_${id}' > '${marker}'; sleep 5; echo 'PERSISTENT_DONE_${id}' >> '${marker}'`,
							},
						},
					],
				};
			}
		}
		if (user.includes(taskOne) && request.messages?.at(-1)?.role === "tool") {
			return { text: `PERSISTENT_TASK_1_RESULT_${id}` };
		}
		if (user.includes(taskTwo)) {
			return { text: `PERSISTENT_TASK_2_RESULT_${id}` };
		}
	}

	if (!names.has("subagent")) return null;
	const state = persistentSpecialistStates.get(id) ?? {
		busySent: false,
		listSent: false,
		taskTwoSent: false,
		stopSent: false,
		finalListSent: false,
	};
	persistentSpecialistStates.set(id, state);
	const launched = source.includes(
		`Sub-agent "${specialistName}" launched and is now running in the background`,
	);
	if (!launched) {
		return {
			toolCalls: [
				{
					name: "subagent",
					arguments: {
						name: specialistName,
						agent: "test-echo",
						persistent: true,
						task: `${taskOne} PERSISTENT_START_FILE: ${source.match(/PERSISTENT_START_FILE:\s*(\S+)/)?.[1] ?? ""}`,
					},
				},
			],
		};
	}
	if (!state.busySent) {
		state.busySent = true;
		return {
			toolCalls: [
				subagentSendCall(
					specialistName,
					`REJECTED_TASK_${id} must never execute`,
				),
			],
		};
	}
	if (!state.listSent && /1 tasks completed/.test(source)) {
		state.listSent = true;
		return { toolCalls: [{ name: "subagents_list", arguments: {} }] };
	}
	if (
		state.listSent &&
		!state.taskTwoSent &&
		/1 tasks completed/.test(source)
	) {
		state.taskTwoSent = true;
		// Allow the extension's one-second lifecycle poll to observe idle before
		// the parent attempts the follow-up dispatch.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		return {
			toolCalls: [
				subagentSendCall(
					specialistName,
					`${taskTwo} execute the follow-up task`,
				),
			],
		};
	}
	if (!state.stopSent && /2 tasks completed/.test(source)) {
		state.stopSent = true;
		return { toolCalls: [subagentStopCall(specialistName)] };
	}
	if (
		state.stopSent &&
		!state.finalListSent &&
		source.includes("Persistent specialist stopped.")
	) {
		state.finalListSent = true;
		return { toolCalls: [{ name: "subagents_list", arguments: {} }] };
	}
	if (state.finalListSent)
		return { text: `PERSISTENT_LIFECYCLE_COMPLETE_${id}` };
	return { text: `WAITING_FOR_PERSISTENT_SPECIALIST_${id}` };
}

function subagentResumeCall(source: string): ToolCall | null {
	const sessionPath = quotedValue(source, "sessionPath");
	if (!sessionPath) return null;
	const name = quotedValue(source, "name");
	const message = quotedValue(source, "message");
	const args: ToolCallArguments = { sessionPath };
	if (name) args.name = name;
	if (message) args.message = message;
	if (/\bautoExit:\s*false\b/.test(source)) args.autoExit = false;
	return { name: "subagent_resume", arguments: args };
}

function bashCommand(source: string): string | undefined {
	const commandStart = source.search(/\becho\s+['"]/);
	if (commandStart === -1) return undefined;
	const command = source
		.slice(commandStart)
		.split(/\n(?:After|Do not|Just|Use the|Then |You must|First,|Call )/)[0]
		.trim();
	// Lifecycle tests with observable START_/STATUS_ markers need the real delay;
	// other delays only slow the suite.
	return (
		(command.includes("STATUS_") || command.includes("START_")
			? command
			: command.replace(/\bsleep\s+\d+;?\s*/g, "")) || undefined
	);
}

function markerText(source: string): string | undefined {
	return source.match(/(?:Return|return) exactly ([A-Za-z0-9_]+)/)?.[1];
}

async function waitForIntegrationGate(source: string): Promise<void> {
	const path = source.match(/INTEGRATION_WAIT_FOR_FILE:\s*(\S+)/)?.[1];
	if (!path) return;
	const deadline = Date.now() + 30_000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!existsSync(path))
		throw new Error(`Integration gate was not opened: ${path}`);
}

function btwText(source: string): string | undefined {
	// Prefer the latest BTW question over inherited "Reply with only SECRET_" context.
	if (/BTW question:\s*Say FIRST/i.test(source)) return "FIRST";
	if (/BTW question:\s*Read the previous assistant answer/i.test(source)) {
		const secret = source.match(/SECRET_([a-z0-9_]+)/i)?.[1];
		return secret ? `BTW_CONFIRMED_SECRET_${secret}` : "BTW_CONFIRMED";
	}
	const requestedSecret = source.match(
		/Reply with only (SECRET_[a-z0-9_]+)/i,
	)?.[1];
	if (requestedSecret) return requestedSecret;
	return undefined;
}

function resumeRestrictionResponse(request: ChatRequest): ResponsePlan | null {
	const names = toolNames(request);
	const source = requestText(request);
	const user = lastUserText(request);
	const id = source.match(
		/INTEGRATION_RESUME_RESTRICTIONS:([A-Za-z0-9_-]+)/,
	)?.[1];
	if (!id) return null;

	if (!names.has("subagent") && !names.has("subagent_resume")) {
		if (user.includes(`RESUME_RESTRICTED_${id}`)) {
			return names.has("read") &&
				!names.has("subagent") &&
				!names.has("subagent_resume")
				? { text: `RESTRICTED_RESUME_${id}` }
				: { text: `RESTRICTED_TOOL_LEAK_${id}` };
		}
		return { text: `RESTRICTED_FIRST_${id}` };
	}

	const state = resumeRestrictionStates.get(id);
	if (state === "resumed") {
		return { text: `RESUME_RESTRICTIONS_COMPLETE_${id}` };
	}
	if (state === "launched") {
		const sessionPath = source.match(/Session:\s*(\S+\.jsonl)/)?.[1];
		if (source.includes(`RESTRICTED_FIRST_${id}`) && sessionPath) {
			resumeRestrictionStates.set(id, "resumed");
			return {
				toolCalls: [
					{
						name: "subagent_resume",
						arguments: {
							sessionPath,
							name: `Restricted-${id}`,
							message: `RESUME_RESTRICTED_${id}`,
						},
					},
				],
			};
		}
		return { text: `WAITING_FOR_RESTRICTED_RESULT_${id}` };
	}
	resumeRestrictionStates.set(id, "launched");
	return {
		toolCalls: [
			{
				name: "subagent",
				arguments: {
					name: `Restricted-${id}`,
					agent: "test-restricted",
					task: `INTEGRATION_RESUME_RESTRICTIONS:${id} Return exactly RESTRICTED_FIRST_${id}`,
				},
			},
		],
	};
}

function multiWaveCoordinatorResponse(
	request: ChatRequest,
): ResponsePlan | null {
	const names = toolNames(request);
	const source = requestText(request);
	const user = lastUserText(request);
	const id = source.match(
		/INTEGRATION_MULTI_WAVE_COORDINATOR:([A-Za-z0-9_-]+)/,
	)?.[1];
	if (!names.has("subagent") || !names.has("caller_ping") || !id) {
		return null;
	}
	const discoveryName = `${id}-review-1`;
	const synthesisName = `${id}-review-2`;
	const discoveryResult = `DISCOVERY_RESULT_${id}`;
	const synthesisResult = `SYNTHESIS_RESULT_${id}`;
	const discoveryLaunched = source.includes(
		`Sub-agent "${discoveryName}" launched`,
	);
	const synthesisLaunched = source.includes(
		`Sub-agent "${synthesisName}" launched`,
	);

	if (user.includes(synthesisResult)) {
		if (source.includes("Shutting down subagent session.")) {
			return { text: `FINAL_MULTI_WAVE_${id}` };
		}
		return {
			text: `FINAL_MULTI_WAVE_${id}`,
			toolCalls: [{ name: "subagent_done", arguments: {} }],
		};
	}
	if (user.includes(discoveryResult) && !synthesisLaunched) {
		return {
			toolCalls: [
				{
					name: "subagent",
					arguments: {
						name: synthesisName,
						agent: "test-echo",
						model: TEST_MODEL,
						task: `Alias S1. Return exactly ${synthesisResult}`,
					},
				},
			],
		};
	}
	if (synthesisLaunched) return { text: `WAITING_FOR_SYNTHESIS_${id}` };
	if (discoveryLaunched) return { text: `WAITING_FOR_DISCOVERY_${id}` };
	return {
		toolCalls: [
			{
				name: "subagent",
				arguments: {
					name: discoveryName,
					agent: "test-echo",
					model: TEST_MODEL,
					task: `Alias R1. Return exactly ${discoveryResult}`,
				},
			},
		],
	};
}

async function planResponse(request: ChatRequest): Promise<ResponsePlan> {
	const names = toolNames(request);
	const source = requestText(request);
	const user = lastUserText(request);
	const lastRole = request.messages?.at(-1)?.role;

	const resumeRestriction = resumeRestrictionResponse(request);
	if (resumeRestriction) return resumeRestriction;

	const persistentSpecialist = await persistentSpecialistResponse(request);
	if (persistentSpecialist) return persistentSpecialist;

	const multiWave = multiWaveCoordinatorResponse(request);
	if (multiWave) return multiWave;

	const resumed = !/Call the subagent_resume tool/i.test(user)
		? user.match(/RESUME_FOLLOWUP_INPUT:\s*([a-z0-9]+)/i)?.[1]
		: undefined;
	if (resumed) return { text: `RESUME_RESULT_${resumed}` };
	const btw = btwText(source);
	if (btw) return { text: btw };

	// caller_ping is always allowlisted for public children; only use it when the
	// prompt actually asks for a help ping (test-ping), not for ordinary tasks.
	if (
		names.has("caller_ping") &&
		/caller_ping|ONLY call caller_ping|call the caller_ping tool/i.test(user)
	) {
		return {
			toolCalls: [
				{ name: "caller_ping", arguments: { message: "PING: integration" } },
			],
		};
	}

	await waitForIntegrationGate(source);

	if (lastRole === "tool") return { text: "completed" };

	if (
		names.has("subagent_resume") &&
		!/Session "[^"]+" resumed\./.test(source)
	) {
		const resumeCall = subagentResumeCall(user);
		if (resumeCall) return { toolCalls: [resumeCall] };
	}

	// A fork retains the parent's launch instruction and can also expose subagent.
	// Route its current explicit shell task before scanning inherited launch text.
	if (names.has("bash") && /^Run this bash command:/i.test(user.trim())) {
		const command = bashCommand(user);
		if (command)
			return { toolCalls: [{ name: "bash", arguments: { command } }] };
	}

	if (names.has("subagent")) {
		if (
			/Sub-agent "[^"]+" launched and is now running in the background/.test(
				source,
			)
		) {
			const continuation = source.match(
				/\b(?:say|respond with)\s+([A-Z][A-Za-z0-9_]*)/,
			)?.[1];
			return { text: continuation ?? "completed" };
		}
		const calls = subagentCalls(source);
		if (calls.length > 0) {
			return {
				toolCalls: [
					...(names.has("subagents_list") && /subagents_list/i.test(source)
						? [{ name: "subagents_list", arguments: {} }]
						: []),
					...calls,
				],
			};
		}
		return { text: "completed" };
	}

	if (names.has("bash")) {
		const command = bashCommand(source);
		if (command)
			return { toolCalls: [{ name: "bash", arguments: { command } }] };
	}

	const marker = markerText(source);
	return marker === "EMPTY_COMPLETION"
		? { emptyCompletion: true }
		: { text: marker ?? "completed" };
}

type ChatDelta = Partial<{
	role: string;
	content: string;
	tool_calls: ReadonlyArray<{
		index: number;
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
}>;

function writeEvent(
	response: ServerResponse,
	request: ChatRequest,
	delta: ChatDelta,
	finishReason: string | null,
): void {
	response.write(
		`data: ${JSON.stringify({
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: request.model ?? TEST_MODEL,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`,
	);
}

function writeResponse(
	response: ServerResponse,
	request: ChatRequest,
	plan: ResponsePlan,
): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});

	if (plan.toolCalls && plan.toolCalls.length > 0) {
		const delta: ChatDelta = {
			role: "assistant",
			tool_calls: plan.toolCalls.map((toolCall, index) => ({
				index,
				id: `call_${Date.now()}_${index}`,
				type: "function",
				function: {
					name: toolCall.name,
					arguments: JSON.stringify(toolCall.arguments),
				},
			})),
		};
		if (plan.text) delta.content = plan.text;
		writeEvent(response, request, delta, null);
		writeEvent(response, request, {}, "tool_calls");
	} else {
		writeEvent(
			response,
			request,
			plan.emptyCompletion
				? { role: "assistant" }
				: { role: "assistant", content: plan.text ?? "completed" },
			null,
		);
		writeEvent(response, request, {}, "stop");
	}

	response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	try {
		const chatRequest = await readJson(request);
		if (chatRequest.model === "account-rejected") {
			providerRequests.push({ model: chatRequest.model, status: 400 });
			response.writeHead(400, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					error: {
						message:
							"The 'account-rejected' model is not supported when using this account.",
					},
				}),
			);
			return;
		}
		if (
			chatRequest.model === "fallback-primary" ||
			chatRequest.model === "fallback-fail"
		) {
			providerRequests.push({ model: chatRequest.model, status: 503 });
			response.writeHead(503, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					error: { message: "deterministic fallback provider failure" },
				}),
			);
			return;
		}
		providerRequests.push({
			model: chatRequest.model,
			status: 200,
			tools: [...toolNames(chatRequest)].sort(),
			lastUser: lastUserText(chatRequest),
		});
		writeResponse(response, chatRequest, await planResponse(chatRequest));
	} catch (error) {
		providerRequests.push({ status: 500 });
		response.writeHead(500, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			}),
		);
	}
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
server.unref();

const address = server.address();
if (!address || isString(address))
	throw new Error("Expected fake provider to bind to a TCP port");

export const TEST_PROVIDER_URL = `http://127.0.0.1:${address.port}/v1`;
