/** A real interactive parent Pi in the private Core lab, using only a local provider. */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	isRecord,
	isString,
	type JsonObject,
} from "../../maestro/core/config/type-guards.ts";
import { CoreLab, findLabBinary } from "./herdr-core-lab.ts";
import {
	TEST_MODEL,
	TEST_PROVIDER_URL,
	getProviderRequests,
} from "./fake-provider.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const EXTENSION = join(REPO, "pi-extension/subagents/index.ts");

export interface CoreParent {
	terminal: string;
	session: string;
	project: string;
}

export function prepareCorePi(lab: CoreLab): string {
	const agentDir = lab.env.PI_CODING_AGENT_DIR!;
	const project = join(lab.root, "project");
	const agents = join(project, ".pi/agents");
	mkdirSync(agents, { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(agentDir, "extensions/subagents.ts"),
		`export { default } from ${JSON.stringify(EXTENSION)};\n`,
	);
	// Nested children load this checkout, not the released package or user extensions.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: [], quietStartup: true }),
	);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"pi-integration": {
					baseUrl: TEST_PROVIDER_URL,
					api: "openai-completions",
					apiKey: "test",
					compat: {
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						supportsUsageInStreaming: false,
					},
					models: [
						"test",
						"fallback-primary",
						"fallback-secondary",
						"fallback-fail",
					].map((id) => ({
						id,
						name: "Deterministic integration test model",
						reasoning: true,
						input: ["text"],
						contextWindow: 128_000,
						maxTokens: 4_096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	);
	for (const file of readdirSync(join(REPO, "test/integration/agents"))) {
		if (!file.endsWith(".md")) continue;
		const text = readFileSync(
			join(REPO, "test/integration/agents", file),
			"utf8",
		);
		writeFileSync(
			join(agents, file),
			text.replace(/^model:\s*.*$/m, `model: ${TEST_MODEL}`),
		);
	}
	const fd = findLabBinary("fd");
	if (fd) {
		mkdirSync(join(agentDir, "bin"), { recursive: true });
		symlinkSync(fd, join(agentDir, "bin/fd"));
	}
	return project;
}

export async function startCoreParent(
	lab: CoreLab,
	piBinary: string,
	project: string,
	name: string,
	prompt: string,
): Promise<CoreParent> {
	const session = join(lab.root, "sessions", `${name}.jsonl`);
	mkdirSync(join(lab.root, "sessions"), { recursive: true });
	const created = await lab.call("terminal.run", {
		argv: [
			piBinary,
			"-ne",
			"-e",
			EXTENSION,
			"--model",
			TEST_MODEL,
			"--thinking",
			"off",
			"--session",
			session,
			"--offline",
			"--no-mcp",
			"-ns",
			"-np",
			"-a",
			"--",
			prompt,
		],
		cwd: project,
		env: { PI_OFFLINE: "1" },
		keep: false,
		rm: false,
		no_notify: true,
		outlive_parent: true,
	});
	if (!isString(created.address))
		throw new Error(`No parent terminal: ${JSON.stringify(created)}`);
	return { terminal: created.address, session, project };
}

export function coreSession(path: string): JsonObject[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	// Ignore a final, incomplete append; malformed complete lines still fail.
	return text
		.slice(0, text.lastIndexOf("\n") + 1)
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value = JSON.parse(line);
			if (!isRecord(value)) throw new Error(`Invalid session entry: ${path}`);
			return value;
		});
}

export async function waitForCoreSession(
	parent: CoreParent,
	predicate: (entries: JsonObject[]) => boolean,
	timeoutMs = 60_000,
): Promise<JsonObject[]> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const entries = coreSession(parent.session);
		if (predicate(entries)) return entries;
		if (performance.now() >= deadline)
			throw new Error(
				`Timed out waiting for parent evidence: ${parent.session}`,
			);
		await delay(50);
	}
}

export function coreResults(entries: JsonObject[]): JsonObject[] {
	return entries.filter(
		(entry) =>
			entry.type === "custom_message" && entry.customType === "subagent_result",
	);
}

export function coreToolResults(
	entries: JsonObject[],
	name: string,
): JsonObject[] {
	return entries.flatMap((entry) =>
		isRecord(entry.message) &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === name
			? [entry.message]
			: [],
	);
}

export async function captureCoreEvidence(
	lab: CoreLab,
	directory: string,
): Promise<void> {
	if (
		resolve(directory) === resolve(REPO) ||
		resolve(directory).startsWith(resolve(REPO) + "/")
	)
		throw new Error("Integration evidence must stay outside the checkout");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	for (const [source, name] of [
		[join(lab.root, "sessions"), "parent-sessions"],
		[join(lab.root, "agent/sessions"), "child-sessions"],
		[join(lab.root, "agent/herdr-agents"), "host-state"],
	]) {
		if (existsSync(source))
			cpSync(source, join(directory, name), { recursive: true });
	}
	writeFileSync(
		join(directory, "provider-requests.json"),
		JSON.stringify(getProviderRequests(), null, 2),
	);
	const listing = await lab.call("terminal.list", { all: true });
	writeFileSync(
		join(directory, "terminals.json"),
		JSON.stringify(listing, null, 2),
	);
	if (!Array.isArray(listing.terminals))
		throw new Error("Core terminal inventory unavailable");
	for (const terminal of listing.terminals) {
		if (
			!isRecord(terminal) ||
			!isString(terminal.address) ||
			!/^t[0-9a-z]+$/.test(terminal.address)
		)
			throw new Error("Unexpected non-local terminal in isolated lab");
		const screen = await lab.call("terminal.read", {
			terminal: terminal.address,
			lines: 1_000,
		});
		writeFileSync(
			join(directory, `${terminal.address}.json`),
			JSON.stringify(screen, null, 2),
		);
	}
}
