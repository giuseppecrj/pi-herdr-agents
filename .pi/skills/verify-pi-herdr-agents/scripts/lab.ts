#!/usr/bin/env -S node --experimental-strip-types
/**
 * Verification lab for pi-herdr-agents: one isolated Herdr server (own HOME,
 * XDG dirs, config and socket under a temp root, via test/integration/herdr-lab.ts),
 * the in-process deterministic provider (test/integration/fake-provider.ts), and a
 * real parent Pi in a pane of that server with the extension from the working tree.
 * Never talks to the caller's Herdr: every herdr call carries the lab session and
 * socket. Run `lab.ts help` for commands.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	assertInside,
	assertLabRootShape,
	assertMarkerId,
	assertPrivateDir,
	assertRemovableLabRoot,
	assertRunDir,
	defaultEvidenceRoot,
} from "./path-guards.ts";
import {
	createLinuxProcessEnvironmentReader,
	createLinuxProcessProbe,
} from "../../../../maestro/adapters/pi/process-identity.ts";
import { requestHerdrSocket } from "../../../../maestro/surfaces/herdr/herdr-socket.ts";
import {
	createLabRoot,
	HERDR_BIN,
	herdrAtLeast,
	removeLabRoot,
	startLabServer,
	stopLabServer,
	type HerdrLabRoot,
} from "../../../../test/integration/herdr-lab.ts";

const SELF = fileURLToPath(import.meta.url);
const SKILL_REPO = resolve(dirname(SELF), "../../../..");
/** Checkout whose extension and test agents the parent Pi loads. */
const REPO = resolve(process.env.PIHA_REPO ?? SKILL_REPO);
const EXTENSION = join(REPO, "pi-extension/subagents/index.ts");
/**
 * State and evidence: an owner-private directory (default
 * `$XDG_STATE_HOME/pi-herdr-agents/verify`), checked on every use. Never /tmp:
 * another local user could pre-create a world-writable directory there.
 */
const EVIDENCE_ROOT = resolve(process.env.VERIFY_EVIDENCE_ROOT ?? defaultEvidenceRoot());
const CURRENT = join(EVIDENCE_ROOT, "current");
const PI_BIN = (() => {
	const found =
		process.env.PI_BIN ??
		execFileSync("sh", ["-c", "command -v pi || true"], {
			encoding: "utf8",
		}).trim();
	try {
		return found ? realpathSync(found) : "";
	} catch {
		return "";
	}
})();
// Same Herdr config as test/integration/sidebar.test.ts.
const CONFIG = `onboarding = false
[terminal]
default_shell = "/bin/bash"
shell_mode = "non_login"
[update]
version_check = false
manifest_check = false
`;
const probe = createLinuxProcessProbe((p) => readFileSync(p, "utf8"));
const readEnviron = createLinuxProcessEnvironmentReader((p) =>
	readFileSync(p, "utf8"),
);
const run = promisify(execFile);

interface LabState {
	runId: string;
	runDir: string;
	startedAt: string;
	repo: string;
	root: string;
	home: string;
	env: NodeJS.ProcessEnv;
	project: string;
	agentDir: string;
	parentSession: string;
	session: string;
	socket?: string;
	serverPid?: number;
	serverStartTime?: string;
	helperPid: number;
	helperStartTime: string;
	workspace?: string;
	parentPane?: string;
	ready?: boolean;
	failed?: string;
}

/** JSON.parse with the source named in the error, so a bad file or reply is diagnosable. */
function parseJson<T = any>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => process.stdout.write(`${line}\n`);

/** Create (0700) and verify the private state directory. */
function ensureEvidenceRoot(): void {
	mkdirSync(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
	assertPrivateDir(EVIDENCE_ROOT);
}

function readState(dir?: string): LabState {
	try {
		lstatSync(EVIDENCE_ROOT);
	} catch {
		throw new Error(`no lab run found (${EVIDENCE_ROOT} does not exist)`);
	}
	assertPrivateDir(EVIDENCE_ROOT);
	const runDir = dir ?? (existsSync(CURRENT) ? readFileSync(CURRENT, "utf8").trim() : "");
	if (!runDir || !existsSync(join(runDir, "state.json")))
		throw new Error(`no lab run found (looked for ${runDir || CURRENT})`);
	assertRunDir(runDir, EVIDENCE_ROOT);
	const state = parseJson<LabState>(readFileSync(join(runDir, "state.json"), "utf8"), `${runDir}/state.json`);
	// Refuse any state that does not point into our own temp lab.
	if (state.runDir !== runDir) throw new Error(`state ${runDir} names another run dir ${state.runDir}`);
	assertLabRootShape(state.root);
	if (state.home !== join(state.root, "home")) throw new Error(`state ${runDir}: home ${state.home} is not the lab home`);
	for (const [what, path] of [["project", state.project], ["agentDir", state.agentDir], ["parentSession", state.parentSession]] as const)
		assertInside(state.root, path, `state ${runDir}: ${what}`);
	if (state.socket) assertInside(state.home, state.socket, "socket");
	return state;
}

/** Marker files for a scripted prompt live in a fresh 0700 dir under the private lab root. */
function makeMarkerDir(state: LabState, kind: string, id: string): string {
	assertMarkerId(id);
	assertPrivateDir(state.root);
	const parent = join(state.root, "markers");
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	assertPrivateDir(parent);
	const dir = join(parent, `${kind}-${id}`);
	if (/[\s'"\\]/.test(dir)) throw new Error(`marker path ${dir} has characters the provider cannot carry`);
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`id ${id} was already used for ${kind} in this run; pick another`);
		throw error;
	}
	assertPrivateDir(dir);
	return dir;
}

function writeState(state: LabState): void {
	writeFileSync(join(state.runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/** herdr CLI bound to the lab session and socket; never the caller's server. */
function herdr(state: LabState, args: string[]): string {
	if (!state.socket) throw new Error("lab server not started");
	return execFileSync(HERDR_BIN, ["--session", state.session, ...args], {
		env: { ...state.env, HERDR_SOCKET_PATH: state.socket },
		encoding: "utf8",
		timeout: 10_000,
	});
}

async function herdrAsync(state: LabState, args: string[]): Promise<string> {
	const { stdout } = await run(HERDR_BIN, ["--session", state.session, ...args], {
		env: { ...state.env, HERDR_SOCKET_PATH: state.socket },
		encoding: "utf8",
		timeout: 10_000,
	});
	return stdout;
}

function alive(pid: number | undefined, startTime: string | undefined): boolean {
	if (!pid || !startTime) return false;
	const stat = probe.stat(pid);
	return !!stat && stat.startTime === startTime && stat.state !== "Z";
}

/** Node processes running integration test files (shell wait loops do not count). */
function integrationSuites(): string[] {
	const found: string[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
			if (/^node/.test(basename(argv[0] ?? "")) && argv.some((a) => a.includes("test/integration/")))
				found.push(`${entry} ${argv.join(" ").trim().slice(0, 160)}`);
		} catch {
			// The process exited or is not ours to read; it cannot be a suite we would collide with.
		}
	}
	return found;
}

/** Processes whose environment carries this lab's HOME: only the lab owns those. */
function labProcesses(home: string): number[] {
	const pids: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (readEnviron(Number(entry))?.get("HOME") === home) pids.push(Number(entry));
		} catch {
			// Unreadable environ means another user's or an exited process: never a lab process.
		}
	}
	return pids;
}

function version(bin: string): string {
	try {
		return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
	} catch (error) {
		return `unavailable (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
	}
}

async function doctor(): Promise<number> {
	let failed = 0;
	const report = (level: "ok" | "warn" | "FAIL", what: string, detail: string) => {
		if (level === "FAIL") failed++;
		say(`${level.padEnd(4)} ${what}: ${detail}`);
	};
	report(HERDR_BIN ? "ok" : "FAIL", "herdr", `${HERDR_BIN || "not found"} ${HERDR_BIN ? version(HERDR_BIN) : ""}`);
	if (HERDR_BIN) {
		try {
			report("ok", "herdr>=0.9.4", herdrAtLeast(0, 9, 4) ? "yes (new suspended-session rule, herdr #4964)" : "no (old suspended-session rule)");
		} catch (error) {
			report("FAIL", "herdr version", String(error));
		}
	}
	report(PI_BIN ? "ok" : "FAIL", "pi", `${PI_BIN || "not found (set PI_BIN)"} ${PI_BIN ? version(PI_BIN) : ""}`);
	const [maj, min] = process.versions.node.split(".").map(Number);
	report(maj > 22 || (maj === 22 && min >= 18) ? "ok" : "warn", "node", `${process.execPath} v${process.versions.node} (lint needs >=22.18)`);
	report(process.env.HERDR_ENV === "1" ? "ok" : "warn", "HERDR_ENV", `${process.env.HERDR_ENV ?? "(unset)"} (the lab does not need it; npm run test:integration does)`);
	report(existsSync(EXTENSION) ? "ok" : "FAIL", "extension", EXTENSION);
	const suites = integrationSuites();
	report(suites.length === 0 ? "ok" : "FAIL", "integration suites running", suites.length === 0 ? "none" : suites.join(" | "));
	try {
		lstatSync(EVIDENCE_ROOT);
		assertPrivateDir(EVIDENCE_ROOT);
		report("ok", "state dir", `${EVIDENCE_ROOT} (owner-private)`);
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		report(missing ? "ok" : "FAIL", "state dir", missing ? `${EVIDENCE_ROOT} (created by up)` : String(error instanceof Error ? error.message : error));
	}
	let state: LabState | undefined;
	try {
		state = readState();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		report(message.startsWith("no lab run") ? "ok" : "FAIL", "lab", message.startsWith("no lab run") ? "no current run" : message);
	}
	if (state) {
		say(`     run: ${state.runDir} (started ${state.startedAt})`);
		report(alive(state.helperPid, state.helperStartTime) ? "ok" : "warn", "lab helper", `pid ${state.helperPid} ${alive(state.helperPid, state.helperStartTime) ? "alive" : "gone"}`);
		if (alive(state.serverPid, state.serverStartTime)) {
			const owned = readEnviron(state.serverPid ?? 0)?.get("HOME") === state.home;
			report(owned ? "ok" : "FAIL", "lab server", `pid ${state.serverPid} session ${state.session} HOME ${owned ? "is ours" : "is NOT ours"}`);
			// The socket client unrefs its socket; hold the event loop open for the answer.
			const keepAlive = setInterval(() => {}, 1_000);
			const ping = state.socket
				? await requestHerdrSocket(state.socket, "ping", {}, { timeoutMs: 3_000 })
						.catch((e) => ({ kind: String(e) }))
						.finally(() => clearInterval(keepAlive))
				: { kind: "no socket" };
			clearInterval(keepAlive);
			report(ping.kind === "result" ? "ok" : "FAIL", "lab socket", `${state.socket} ${ping.kind}`);
			report(state.ready ? "ok" : "warn", "parent pi", state.ready ? `pane ${state.parentPane} ready` : (state.failed ?? "not ready"));
		} else report("warn", "lab server", `not running${existsSync(join(state.runDir, "cleanup.json")) ? " (cleaned up; evidence kept in run dir)" : ""}`);
	}
	return failed === 0 ? 0 : 1;
}

function writeModels(agentDir: string, providerUrl: string): void {
	// Mirrors writeTestProviderConfig in test/integration/harness.ts (not exported).
	const model = (id: string) => ({
		id,
		name: "Deterministic integration test model",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 4_096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const providers = {
		"pi-integration": {
			baseUrl: providerUrl,
			api: "openai-completions",
			apiKey: "test",
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
			models: ["test", "fallback-primary", "fallback-secondary", "fallback-fail", "account-rejected"].map(model),
		},
	};
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }, null, 2));
}

function setUpProject(project: string, testModel: string): void {
	const agents = join(project, ".pi/agents");
	mkdirSync(agents, { recursive: true });
	const source = join(REPO, "test/integration/agents");
	// Same rewrite as createTestEnv: pin every fixture role to the test model.
	for (const file of readdirSync(source).filter((f) => f.endsWith(".md"))) {
		const text = readFileSync(join(source, file), "utf8");
		writeFileSync(
			join(agents, file),
			/^model:\s*.*$/m.test(text) ? text.replace(/^model:\s*.*$/m, `model: ${testModel}`) : text.replace(/^---\n/, `---\nmodel: ${testModel}\n`),
		);
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "verify@example.com");
	git("config", "user.name", "Verify Lab");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(project, "README.md"), "verify-pi-herdr-agents lab project\n");
	writeFileSync(join(project, ".gitignore"), ".pi/\n");
	git("add", "README.md", ".gitignore");
	git("commit", "-qm", "lab fixture");
}

/** Copy session files and artifacts out of the lab root, so cleanup never eats them. */
function snapshotFiles(state: LabState, into: string): void {
	mkdirSync(into, { recursive: true });
	const sessions = dirname(state.parentSession);
	if (existsSync(sessions)) cpSync(sessions, join(into, "sessions"), { recursive: true });
	const agentSessions = join(state.agentDir, "sessions");
	if (existsSync(agentSessions)) cpSync(agentSessions, join(into, "agent-sessions"), { recursive: true });
}

/** The long-lived helper: provider, lab server, parent Pi; cleans up on SIGTERM. */
async function serve(runDir: string): Promise<void> {
	const keepAlive = setInterval(() => {}, 1_000);
	const { TEST_MODEL, shellQuote } = await import("../../../../test/integration/harness.ts");
	const { TEST_PROVIDER_URL, getProviderRequests } = await import("../../../../test/integration/fake-provider.ts");
	const lab: HerdrLabRoot = createLabRoot(CONFIG);
	const self = probe.stat(process.pid);
	const runId = basename(runDir);
	assertRunDir(runDir, EVIDENCE_ROOT);
	const state: LabState = {
		runId,
		runDir,
		startedAt: new Date().toISOString(),
		repo: REPO,
		root: lab.root,
		home: lab.home,
		env: lab.env,
		project: join(lab.root, "project"),
		agentDir: join(lab.root, "agent"),
		parentSession: join(lab.root, "sessions/parent.jsonl"),
		session: `verify-piha-${runId}`,
		helperPid: process.pid,
		helperStartTime: self?.startTime ?? "",
	};
	writeState(state);
	let server: Awaited<ReturnType<typeof startLabServer>> | undefined;
	let stopping = false;
	const shutdown = async (why: string) => {
		if (stopping) return;
		stopping = true;
		const result: Record<string, unknown> = { why, at: new Date().toISOString() };
		try {
			writeFileSync(join(runDir, "provider-requests.json"), JSON.stringify(getProviderRequests(), null, 2));
			snapshotFiles(state, join(runDir, "files"));
			if (server) result.server = await stopLabServer(lab, server);
			result.leftover = labProcesses(lab.home);
			assertRemovableLabRoot(lab.root, state.root);
			removeLabRoot(lab);
			result.labRootRemoved = !existsSync(lab.root);
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
		}
		writeFileSync(join(runDir, "cleanup.json"), `${JSON.stringify(result, null, 2)}\n`);
		clearInterval(keepAlive);
		process.exit(result.error ? 1 : 0);
	};
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void shutdown(signal));
	try {
		mkdirSync(join(state.agentDir, "extensions"), { recursive: true });
		mkdirSync(dirname(state.parentSession), { recursive: true });
		// Nested children auto-discover extensions: point them at this checkout too.
		writeFileSync(join(state.agentDir, "extensions/subagents.ts"), `export { default } from ${JSON.stringify(EXTENSION)};\n`);
		writeModels(state.agentDir, TEST_PROVIDER_URL);
		setUpProject(state.project, TEST_MODEL);
		// Every pane (parent and children) inherits the server env: absolute tool dirs, no shims.
		lab.env.PATH = [dirname(PI_BIN), dirname(HERDR_BIN), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
		// Pi downloads fd into a fresh agent dir; link the host's fd (same name) to stay offline.
		const fd = execFileSync("sh", ["-c", "command -v fd || true"], { encoding: "utf8" }).trim();
		if (fd) {
			mkdirSync(join(state.agentDir, "bin"), { recursive: true });
			symlinkSync(realpathSync(fd), join(state.agentDir, "bin/fd"));
		}
		lab.env.PI_CODING_AGENT_DIR = state.agentDir;
		server = await startLabServer(lab, state.session);
		Object.assign(state, { env: lab.env, socket: server.socket, serverPid: server.pid, serverStartTime: server.startTime });
		writeState(state);
		const created = await server.ok("workspace.create", { cwd: state.project, label: "verify", focus: true });
		state.workspace = (created.workspace as { workspace_id: string }).workspace_id;
		state.parentPane = (created.root_pane as { pane_id: string }).pane_id;
		writeState(state);
		const script = join(lab.root, "parent.sh");
		writeFileSync(
			script,
			[
				`cd ${shellQuote(state.project)}`,
				`PI_CODING_AGENT_DIR=${shellQuote(state.agentDir)} ${shellQuote(PI_BIN)} -ne -e ${shellQuote(EXTENSION)} --model ${shellQuote(TEST_MODEL)} --session ${shellQuote(state.parentSession)}`,
				`echo "__PARENT_EXIT_$?__"`,
			].join("\n"),
		);
		herdr(state, ["pane", "run", state.parentPane, `bash ${shellQuote(script)}`]);
		// Ready = Pi's interactive footer shows the deterministic model in the parent pane.
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const screen = herdr(state, ["pane", "read", state.parentPane, "--source", "visible"]);
			writeFileSync(join(runDir, "parent-pane-startup.txt"), screen);
			if (/__PARENT_EXIT_/.test(screen)) throw new Error(`parent Pi exited:\n${screen}`);
			// Footer: "0.0%/128k (auto) ... test • medium" (128k is the models.json contextWindow).
			if (/%\/128k\b.*\btest\b/.test(screen)) {
				state.ready = true;
				break;
			}
			await sleep(500);
		}
		if (!state.ready) throw new Error("parent Pi did not reach its prompt in 60s");
		writeState(state);
	} catch (error) {
		state.failed = error instanceof Error ? error.message : String(error);
		writeState(state);
		await shutdown("startup failure");
		return;
	}
	// Record every pane change and provider request while the lab runs.
	let lastPanes = "";
	let lastRequests = 0;
	for (;;) {
		try {
			const panes = parseJson(await herdrAsync(state, ["pane", "list"]), "herdr pane list").result.panes.map(
				(p: { pane_id: string; tab_id: string; label?: string; agent?: string }) => ({ pane: p.pane_id, tab: p.tab_id, label: p.label, agent: p.agent }),
			);
			const key = JSON.stringify(panes);
			if (key !== lastPanes) {
				lastPanes = key;
				appendFileSync(join(runDir, "pane-timeline.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), panes })}\n`);
			}
			const requests = getProviderRequests();
			if (requests.length !== lastRequests) {
				lastRequests = requests.length;
				writeFileSync(join(runDir, "provider-requests.json"), JSON.stringify(requests, null, 2));
			}
		} catch (error) {
			appendFileSync(join(runDir, "helper-errors.log"), `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}\n`);
		}
		if (stopping) return;
		await sleep(500);
	}
}

async function up(): Promise<number> {
	const suites = integrationSuites();
	if (suites.length > 0) {
		say(`refusing: an integration suite is running:\n${suites.join("\n")}`);
		return 1;
	}
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
	const runDir = join(EVIDENCE_ROOT, `${stamp}-${Math.random().toString(36).slice(2, 6)}`);
	ensureEvidenceRoot();
	mkdirSync(runDir, { mode: 0o700 });
	writeFileSync(CURRENT, `${runDir}\n`, { mode: 0o600 });
	const child = spawn(process.execPath, ["--experimental-strip-types", SELF, "serve", runDir], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		env: { ...process.env, PIHA_REPO: REPO },
	});
	child.unref();
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		await sleep(500);
		if (!existsSync(join(runDir, "state.json"))) continue;
		const state = readState(runDir);
		if (state.ready) {
			say(`LAB_READY run=${runDir} session=${state.session} workspace=${state.workspace} parent=${state.parentPane}`);
			return 0;
		}
		if (state.failed || existsSync(join(runDir, "cleanup.json"))) {
			say(`LAB_FAILED run=${runDir}: ${state.failed ?? "helper exited"}`);
			return 1;
		}
	}
	say(`LAB_FAILED run=${runDir}: not ready in 90s; run lab.ts down`);
	return 1;
}

/** Single-line prompts the deterministic provider (fake-provider.ts) understands. */
function prompt(kind: string, id: string, markers: string): { text: string; watch: string } {
	switch (kind) {
		case "launch":
			return {
				text: `Call the subagent tool with these EXACT parameters: name: "Echo-${id}" agent: "test-echo" task: "Return exactly CHILD_RESULT_${id}" Do not do anything else. After you receive the subagent result, say PARENT_CONTINUED_${id}.`,
				watch: `custom_message subagent_result from Echo-${id} containing CHILD_RESULT_${id}`,
			};
		case "ping":
			return {
				text: `Call the subagent tool with these EXACT parameters: name: "Ping-${id}" agent: "test-ping" task: "PING_TEST_${id}" Just call the subagent tool once.`,
				watch: `custom_message subagent_ping with kind="help-request" from Ping-${id}`,
			};
		case "cancel":
			return {
				text: `INTEGRATION_CANCEL:${id}:basic CANCEL_START_FILE: ${markers}/start.txt CANCEL_GATE_FILE: ${markers}/gate.txt CANCEL_ID_FILE: ${markers}/id.txt CANCEL_SLEEP: 91.${Date.now() % 1_000_000} CANCEL_MODELS: pi-integration/test,pi-integration/fallback-secondary Follow the scripted cancellation scenario.`,
				watch: `${markers}/start.txt appears (child running), then: touch ${markers}/gate.txt; expect one cancelled subagent_result`,
			};
		case "worktree":
			return {
				text: `Call the subagent tool with these EXACT parameters: name: "Worktree-${id}" agent: "test-echo" worktree: { branch: "verify/ticket-${id}" } task: "Run: echo 'WORKTREE_${id}' > 'ticket-${id}.txt' && git add 'ticket-${id}.txt' && git commit -m 'Implement ${id}'" Do not do anything else. After you receive the result, say WORKTREE_COMPLETE_${id}.`,
				watch: `subagent_result with worktree handoff for branch verify/ticket-${id}`,
			};
		case "persistent":
			return {
				text: `INTEGRATION_PERSISTENT_SPECIALIST:${id} PERSISTENT_START_FILE: ${markers}/persistent.txt Spawn the persistent specialist and follow the scripted lifecycle.`,
				watch: `two task-result deliveries from Persistent-${id}, then PERSISTENT_LIFECYCLE_COMPLETE_${id}`,
			};
		default:
			throw new Error(`unknown prompt ${kind}; use launch|ping|cancel|worktree|persistent`);
	}
}

function send(state: LabState, text: string): void {
	if (!state.ready || !state.parentPane) throw new Error("lab is not ready");
	herdr(state, ["pane", "send-text", state.parentPane, text]);
	herdr(state, ["pane", "send-keys", state.parentPane, "enter"]);
}

interface Entry {
	type?: string;
	customType?: string;
	content?: unknown;
	details?: { name?: string; sessionFile?: string; error?: string };
	message?: { role?: string; content?: unknown };
}

function entries(path: string): Entry[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l, i) => parseJson<Entry>(l, `${path}:${i + 1}`));
}

function evidence(state: LabState, label: string): string {
	const dir = join(state.runDir, `evidence-${label}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "parent-pane.txt"), herdr(state, ["pane", "read", state.parentPane ?? "", "--source", "recent", "--lines", "400"]));
	const panes = herdr(state, ["pane", "list"]);
	writeFileSync(join(dir, "panes.json"), panes);
	snapshotFiles(state, join(dir, "files"));
	const all = entries(state.parentSession);
	const delivered = all.filter((e) => e.type === "custom_message" && /^subagent_(result|ping)$/.test(e.customType ?? ""));
	writeFileSync(join(dir, "delivered.txt"), delivered.map((e) => `--- ${e.customType} (${e.details?.name})\n${String(e.content)}\n`).join("\n"));
	const childPanes = parseJson(panes, "herdr pane list").result.panes.filter((p: { pane_id: string }) => p.pane_id !== state.parentPane);
	const verdict = delivered.map((e) => {
		const content = String(e.content);
		const envelope = /<subagent_report from="([^"]*)" kind="([^"]*)">/.exec(content);
		const sessionFile = e.details?.sessionFile;
		if (sessionFile && existsSync(sessionFile)) copyFileSync(sessionFile, join(dir, `child-${basename(sessionFile)}`));
		const index = all.indexOf(e);
		return {
			customType: e.customType,
			name: e.details?.name,
			error: e.details?.error,
			envelopeFrom: envelope?.[1],
			envelopeKind: envelope?.[2],
			headOutsideEnvelope: envelope ? content.indexOf(envelope[0]) > 0 : undefined,
			childSessionFile: sessionFile,
			childSessionExists: sessionFile ? existsSync(sessionFile) : false,
			parentContinued: all.slice(index + 1).some((x) => x.type === "message" && x.message?.role === "assistant"),
		};
	});
	const summary = { label, at: new Date().toISOString(), parentSession: state.parentSession, delivered: verdict, panesOtherThanParent: childPanes.length };
	writeFileSync(join(dir, "verdict.json"), `${JSON.stringify(summary, null, 2)}\n`);
	say(JSON.stringify(summary, null, 2));
	return dir;
}

async function down(): Promise<number> {
	const state = readState();
	if (alive(state.helperPid, state.helperStartTime)) {
		const cmdline = readFileSync(`/proc/${state.helperPid}/cmdline`, "utf8");
		if (!cmdline.includes(state.runDir)) throw new Error(`pid ${state.helperPid} is not this run's helper`);
		process.kill(state.helperPid, "SIGTERM");
		for (let i = 0; i < 120 && alive(state.helperPid, state.helperStartTime); i++) await sleep(250);
	}
	if (!existsSync(join(state.runDir, "cleanup.json")) && existsSync(state.root)) {
		// The helper died without cleaning up: stop the server by identity, then the root.
		snapshotFiles(state, join(state.runDir, "files"));
		const lab: HerdrLabRoot = { root: state.root, home: state.home, env: state.env };
		const result: Record<string, unknown> = { why: "down without helper" };
		if (state.serverPid && state.serverStartTime && state.socket)
			result.server = await stopLabServer(lab, { session: state.session, pid: state.serverPid, startTime: state.serverStartTime, socket: state.socket });
		try {
			assertRemovableLabRoot(state.root, state.root);
			removeLabRoot(lab);
		} catch (error) {
			result.error = String(error);
		}
		writeFileSync(join(state.runDir, "cleanup.json"), `${JSON.stringify(result, null, 2)}\n`);
	}
	const leftover = labProcesses(state.home);
	say(`LAB_DOWN run=${state.runDir} labRootExists=${existsSync(state.root)} leftoverPids=${leftover.join(",") || "none"}`);
	say(readFileSync(join(state.runDir, "cleanup.json"), "utf8").trim());
	return leftover.length === 0 && !existsSync(state.root) ? 0 : 1;
}

const HELP = `usage: node --experimental-strip-types lab.ts <command>
  doctor                 read-only health check (exit 1 on FAIL)
  up                     start lab server + provider + parent Pi; prints LAB_READY
  prompt <kind> [id]     type a deterministic prompt into the parent (launch|ping|cancel|worktree|persistent)
  send <text>            type literal text + Enter into the parent pane (slash commands too)
  read [lines]           print the parent pane (recent output)
  panes                  pane list of the lab server (JSON)
  pane-read <pane> [n]   print any lab pane
  herdr <args...>        any herdr CLI call, bound to the lab session and socket
  state                  print the current run's state (paths, pane, project)
  evidence [label]       capture pane, sessions, delivered results and verdict.json
  down                   stop what up started, remove the lab root, keep evidence
env: PIHA_REPO=<checkout> (extension under test), HERDR_BIN, PI_BIN,
     VERIFY_EVIDENCE_ROOT (default $XDG_STATE_HOME/pi-herdr-agents/verify; must be a real dir you own, not group/world-writable)`;

const [command, ...args] = process.argv.slice(2);
let code = 0;
try {
	switch (command) {
		case "doctor":
			code = await doctor();
			break;
		case "up":
			code = await up();
			break;
		case "serve":
			await serve(args[0] ?? "");
			break;
		case "prompt": {
			const id = assertMarkerId(args[1] ?? Math.random().toString(36).slice(2, 8));
			const kind = args[0] ?? "";
			const state = readState();
			const markers = kind === "cancel" || kind === "persistent" ? makeMarkerDir(state, kind, id) : "";
			const { text, watch } = prompt(kind, id, markers);
			send(state, text);
			say(`SENT ${kind} id=${id}${markers ? `\nMARKER_DIR ${markers}` : ""}\nWATCH ${watch}`);
			break;
		}
		case "send":
			send(readState(), args.join(" "));
			say("SENT");
			break;
		case "read": {
			const state = readState();
			say(herdr(state, ["pane", "read", state.parentPane ?? "", "--source", "recent", "--lines", args[0] ?? "80"]));
			break;
		}
		case "panes":
			say(herdr(readState(), ["pane", "list"]));
			break;
		case "pane-read":
			say(herdr(readState(), ["pane", "read", args[0] ?? "", "--source", "recent", "--lines", args[1] ?? "80"]));
			break;
		case "herdr":
			say(herdr(readState(), args));
			break;
		case "state": {
			const { env: _env, ...state } = readState();
			say(JSON.stringify(state, null, 2));
			break;
		}
		case "evidence":
			say(`EVIDENCE ${evidence(readState(), args[0] ?? "manual")}`);
			break;
		case "down":
			code = await down();
			break;
		default:
			say(HELP);
			code = command && command !== "help" ? 1 : 0;
	}
} catch (error) {
	say(`error: ${error instanceof Error ? error.message : String(error)}`);
	code = 1;
}
if (command !== "serve") process.exit(code);
