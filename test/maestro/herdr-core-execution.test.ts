import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import {
	mkdtempSync,
	realpathSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HerdrCoreSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-core-surface-provider.ts";
import { type CoreTerminal } from "../../maestro/surfaces/herdr/herdr-core-protocol.ts";
import {
	parseHerdrConfig,
	loadHerdrConfig,
	selectHerdrBinding,
	assertSameHerdrBinding,
} from "../../maestro/core/config/herdr-config.ts";
import {
	AcquisitionUncertainError,
	isAcquisitionUncertainError,
} from "../../maestro/core/surface-provider.ts";
import {
	launchPiSubagent,
	AcquiredPiLaunchError,
	type FreshPiLaunchRequest,
	type PiLaunchRequest,
} from "../../maestro/adapters/pi/launch.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { waitForCompletion } from "../../maestro/adapters/pi/completion.ts";
import {
	createLifecycle,
	lifecycleTransition,
	observePaneInspection,
	projectLifecycle,
	type LifecycleProjection,
	type LifecycleTransition,
} from "../../maestro/core/lifecycle.ts";
import {
	getNewEntries,
	readPersistentDeliveryLedger,
	writeSubagentSessionPolicy,
	getSubagentSessionPolicyFile,
} from "../../maestro/adapters/pi/session.ts";
import { createDefaultRunSession } from "../../maestro/runtime/pi-run-session.ts";
import type {
	DefaultRunSessionOptions,
	PiLaunchInput,
	PiRunSession,
	PiCompletedMetadata,
} from "../../maestro/runtime/pi-run-session-types.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import { socketPath as fixtureSocketPath } from "../socket-path.ts";
import { skipCoreOnWindows } from "../helpers/windows-scope.ts";

const panes = {
	mode: "tab" as const,
	direction: "right" as const,
	maxPerTab: 4,
};
const methods = [
	"terminal.run",
	"terminal.get",
	"terminal.list",
	"terminal.keys",
	"terminal.kill",
	"terminal.rm",
	"terminal.read",
];

interface Request {
	id: number;
	method: string;
	// Malformed JSON-RPC fixture payloads deliberately bypass production validation.
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
	params: Record<string, any>;
}
async function fixture(
	run: (f: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
) {
	const f = await makeFixture();
	try {
		await run(f);
	} finally {
		for (const session of f.sessions) await session.shutdown("quit");
		for (const socket of f.sockets) socket.destroy();
		await new Promise<void>((resolve) => f.server.close(() => resolve()));
		rmSync(f.dir, { recursive: true, force: true });
	}
}
async function makeFixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "hc-unit-")));
	const socketPath = fixtureSocketPath(dir, "rpc.sock");
	const calls: Request[] = [];
	const sockets = new Set<Socket>();
	const terminals = new Map<string, CoreTerminal>();
	const sessions: PiRunSession[] = [];
	const parent: CoreTerminal = {
		address: "t1",
		argv: ["pi"],
		cwd: dir,
		created_ms: 1,
		state: "live",
		keep: false,
		rm: false,
		parent: null,
	};
	terminals.set("t1", parent);
	// SAFETY: the initial literal is one of the closed fault modes selected by tests.
	const state = {
		coreId: "core-unit",
		helloAddress: "",
		generation: 1,
		methods: [...methods],
		runMode: "valid" as
			| "valid"
			| "partial"
			| "unverified"
			| "disconnect"
			| "timeout"
			| "malformed"
			| "rejected"
			| "duplicate-partial"
			| "duplicate-full"
			| "post-spawn-error"
			| "oversized",
		replyAddress: "t2",
		runErrorKind: "spawn_failed",
		killExits: true,
		getUnavailable: false,
		callsAfterHello: 0,
	};
	let nextId = 2;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				const request: Request = JSON.parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				calls.push(request);
				server.emit("request", request);
				const reply = (result: any) =>
					socket.write(
						JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
					);
				const error = (kind: string) =>
					socket.write(
						JSON.stringify({
							jsonrpc: "2.0",
							id: request.id,
							error: { code: -32000, message: kind, data: { kind } },
						}) + "\n",
					);
				if (request.method === "hello") {
					reply({
						generation: state.generation,
						address: state.helloAddress,
						version: "0.1.16",
						core: { id: state.coreId, name: "unit" },
						framed: false,
						methods: state.methods,
						features: ["status"],
					});
					continue;
				}
				state.callsAfterHello++;
				const id = request.params.terminal;
				const terminal = terminals.get(id);
				switch (request.method) {
					case "terminal.run": {
						if (state.runMode === "rejected") {
							error("spawn_failed");
							break;
						}
						const child: CoreTerminal = {
							address: `t${(nextId++).toString(36)}`,
							argv: request.params.argv,
							cwd: request.params.cwd,
							created_ms: Date.now(),
							state: "live",
							parent: request.params.parent,
							keep: request.params.keep,
							rm: request.params.rm,
						};
						terminals.set(child.address, child);
						if (state.runMode === "duplicate-partial")
							reply({ address: state.replyAddress, state: "live" });
						else if (state.runMode === "duplicate-full")
							reply(terminals.get(state.replyAddress));
						else if (state.runMode === "post-spawn-error")
							error(state.runErrorKind);
						else if (state.runMode === "disconnect") socket.end();
						else if (state.runMode === "timeout") {
							/* bounded no-answer fixture */
						} else if (state.runMode === "partial")
							reply({ address: child.address, state: "live" });
						else if (state.runMode === "unverified")
							reply({ ...child, cwd: join(dir, "unverified") });
						else if (state.runMode === "malformed") reply({ state: "live" });
						else if (state.runMode === "oversized")
							reply({ text: "x".repeat(2 * 1024 * 1024 + 1) });
						else reply(child);
						break;
					}
					case "terminal.get":
						if (state.getUnavailable) socket.end();
						else if (terminal)
							reply({ ...terminal, status: { state: "done" } });
						else error("not_found");
						break;
					case "terminal.list":
						reply({ terminals: [...terminals.values()] });
						break;
					case "terminal.kill":
						if (!terminal) error("not_found");
						else {
							if (state.killExits) {
								terminal.state = "finished";
								terminal.exit_code = 143;
							}
							reply(terminal);
						}
						break;
					case "terminal.rm":
						if (terminal?.state === "finished") {
							terminals.delete(id);
							server.emit("removed", id);
							reply({ removed: id });
						} else error("live");
						break;
					case "terminal.keys":
						reply({ turn: 1 });
						break;
					case "terminal.read":
						reply({
							text: "__SUBAGENT_DONE_0__",
							complete: true,
							how: "screen",
						});
						break;
					default:
						error("invalid_params");
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	const provider = new HerdrCoreSurfaceProvider(
		{ socket: socketPath, parentTerminal: "t1" },
		{ timeoutMs: 100 },
	);
	const operations = launchOperationsFromSurface(provider, panes);
	const parentFile = join(dir, "parent.jsonl");
	writeFileSync(
		parentFile,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) +
			"\n",
	);
	const request = (): FreshPiLaunchRequest => ({
		kind: "fresh",
		id: "child-id",
		name: "core child",
		task: "bounded task",
		parent: {
			cwd: dir,
			sessionFile: parentFile,
			sessionId: "parent",
			sessionDir: join(dir, "sessions"),
			agentDir: join(dir, "agent"),
		},
		runtimePlan: {
			provider: "test",
			modelId: "one",
			model: "test/one",
			thinking: "high",
			modelSource: "request",
			thinkingSource: "parent",
		},
		behavior: {
			autoExit: true,
			interactive: false,
			deniedTools: [],
			sessionMode: "standalone",
		},
	});
	const removed = (id: string) => {
		if (!terminals.has(id)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const onRemoved = (observed: string) => {
				if (observed !== id) return;
				clearTimeout(timer);
				server.off("removed", onRemoved);
				resolve();
			};
			const timer = setTimeout(() => {
				server.off("removed", onRemoved);
				reject(new Error("Fixture did not observe native record removal"));
			}, 2000);
			server.on("removed", onRemoved);
		});
	};
	const nativeStart = () =>
		provider.nativeExecution.start({
			cwd: dir,
			command: "exit 7",
			scriptPath: join(dir, "native.sh"),
			scriptPreamble: "# fixture",
		});
	return {
		dir,
		socketPath,
		server,
		sockets,
		calls,
		state,
		terminals,
		sessions,
		provider,
		operations,
		request,
		nativeStart,
		removed,
	};
}

function withEnvironment<T>(values: NodeJS.ProcessEnv, run: () => T): T {
	const saved = new Map(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function sessionOptions(
	f: Awaited<ReturnType<typeof makeFixture>>,
	injected = true,
): DefaultRunSessionOptions {
	return {
		configDir: f.dir,
		configExamplePath: join(f.dir, "example.json"),
		forcePolling: false,
		outcomeLedger: false,
		roles: [],
		infrastructure: injected
			? {
					surfaceProvider: f.provider,
					launchOperations: f.operations,
					supervision: new SupervisionCoordinator(
						async () => ({
							complete: true,
							panes: (await f.provider.listSurfaces()).map((s) => ({
								paneId: s.id,
								workspaceId: "",
							})),
						}),
						(id) => f.provider.inspectSurface(id),
						false,
						new FileWakeRegistry(),
					),
				}
			: undefined,
		getLaunchSnapshot: () => ({
			parent: f.request().parent,
			parentRuntime: { provider: "test", modelId: "one", thinking: "high" },
			paneConfig: panes,
			modelRegistry: {
				find: (provider, id) => ({ provider, id, reasoning: true }),
				available: () => [],
				hasConfiguredAuth: () => true,
				supportedThinkingLevels: () => ["off", "low", "medium", "high"],
				clampThinkingLevel: (_model, level) => level,
			},
		}),
		hooks: { onSettled() {} },
		persistent: {
			send: () => ({ error: "fixture" }),
			stop: () => ({ error: "fixture" }),
			drain() {},
		},
	};
}
function launchInput(
	f: Awaited<ReturnType<typeof makeFixture>>,
	id = "task",
): PiLaunchInput {
	return {
		task: {
			id,
			name: "child",
			prompt: "bounded task",
			role: "",
			cwd: f.dir,
			behavior: { autoExit: true },
		},
		role: {
			name: "",
			version: "1",
			description: "fixture",
			systemPrompt: "",
			allowedTools: [],
		},
		plans: [f.request().runtimePlan],
		resolved: {},
		identity: {
			id: `public-${id}`,
			logicalId: `logical-${id}`,
			generationId: `generation-${id}`,
			taskId: `inbox-${id}`,
		},
	};
}
function recordExit(file: string) {
	writeFileSync(`${file}.exit`, JSON.stringify({ type: "done" }));
}

// Configuration/selection is pure and never probes either endpoint.
test("Core config is closed, strict, defaults auto, and rejects malformed files", () =>
	fixture(async (f) => {
		assert.equal(parseHerdrConfig({}), "auto");
		assert.equal(parseHerdrConfig({ herdr: {} }), "auto");
		for (const backend of ["auto", "core", "legacy"] as const)
			assert.equal(parseHerdrConfig({ herdr: { backend } }), backend);
		for (const raw of [
			null,
			[],
			{ herdr: null },
			{ herdr: [] },
			{ herdr: { backend: "CORE" } },
			{ herdr: { backend: null } },
			{ herdr: { typo: "core" } },
		])
			assert.throws(() => parseHerdrConfig(raw), /Invalid Herdr config/);
		const example = join(f.dir, "example.json");
		writeFileSync(example, JSON.stringify({ herdr: { backend: "legacy" } }));
		assert.equal(loadHerdrConfig(f.dir, example), "legacy");
		writeFileSync(join(f.dir, "config.json"), "{broken");
		assert.throws(
			() => loadHerdrConfig(f.dir, example),
			/Cannot load Herdr config/,
		);
		writeFileSync(join(f.dir, "config.json"), '{"herdr":{"backend":"core"}}');
		assert.equal(loadHerdrConfig(f.dir, example), "core");
		assert.equal(f.calls.length, 0);
	}));
test("Core auto selection requires native terminal context and prefers terminal endpoint", () => {
	// Selection where Core is supported; Windows refuses Core itself
	// (windows-support-scope.test.ts).
	const linux = "linux";
	assert.deepEqual(
		selectHerdrBinding("auto", { HC_SOCKET: "/socket", HERDR_ENV: "1" }, linux),
		{ backend: "legacy" },
	);
	assert.deepEqual(
		selectHerdrBinding("legacy", { HC_TERMINAL_ID: "t1" }, linux),
		{
			backend: "legacy",
		},
	);
	assert.deepEqual(
		selectHerdrBinding(
			"auto",
			{
				HC_TERMINAL_ID: "t1",
				HC_TERMINAL_SOCKET: "/preferred",
				HC_SOCKET: "/fallback",
			},
			linux,
		),
		{ backend: "core", socket: "/preferred", parentTerminal: "t1" },
	);
	assert.deepEqual(
		selectHerdrBinding(
			"core",
			{
				HC_TERMINAL_ID: "t1",
				HC_SOCKET: "/fallback",
			},
			linux,
		),
		{ backend: "core", socket: "/fallback", parentTerminal: "t1" },
	);
	for (const env of [
		{},
		{ HC_SOCKET: "/only" },
		{ HC_TERMINAL_ID: "remote/t1", HC_SOCKET: "/x" },
		{ HC_TERMINAL_ID: "t1", HC_SOCKET: "relative" },
		{ HC_TERMINAL_ID: "t1" },
	])
		assert.throws(
			() => selectHerdrBinding("core", env, linux),
			/native HC_TERMINAL_ID/,
		);
	assert.throws(
		() => selectHerdrBinding("auto", { HC_TERMINAL_ID: "t1" }, linux),
		/native HC_TERMINAL_ID/,
	);
	assertSameHerdrBinding({ backend: "legacy" }, { backend: "legacy" });
	assert.throws(
		() =>
			assertSameHerdrBinding(
				{ backend: "legacy" },
				{ backend: "core", socket: "/x", parentTerminal: "t1" },
			),
		/restart/,
	);
});

test("Core provider is lazy; native start verifies hello and parent, uses atomic background payload", () =>
	fixture(async (f) => {
		assert.equal(f.calls.length, 0);
		assert.equal(f.provider.isAvailable(), true);
		const child = await launchPiSubagent(f.request(), f.operations);
		assert.equal(child.surface, "t2");
		assert.equal(child.ownsSurface, true);
		assert.equal(f.calls.filter((c) => c.method === "terminal.run").length, 1);
		const params = f.calls.find((c) => c.method === "terminal.run")!.params;
		assert.deepEqual(params.argv, ["/bin/bash", child.launchScriptFile]);
		assert.equal(params.cwd, f.dir);
		for (const [key, value] of Object.entries({
			parent: "t1",
			no_notify: true,
			outlive_parent: true,
			keep: false,
			rm: false,
			wait: false,
		}))
			assert.equal(params[key], value);
		assert.equal(params.env.PATH, process.env.PATH);
		assert.ok(!("name" in params) && !("line" in params));
		assert.deepEqual(f.calls[0].params, { generation: 1 });
		const script = readFileSync(child.launchScriptFile, "utf8");
		assert.ok(!script.includes("PI_SUBAGENT_SURFACE="));
		assert.match(script, /PI_SUBAGENT_ID='child-id'/);
		assert.match(script, /--model 'test\/one'/);
		assert.match(script, /exit "\$piha_exit"/);
		assert.equal(
			(await f.provider.nativeExecution.inspect(child.surface)).kind,
			"live",
			"status=done is not process exit",
		);
		assert.deepEqual(await f.provider.listSurfaces(), [
			{ id: "t2", cwd: f.dir },
		]);
		assert.equal(await f.provider.readScreen("t2", 5), "__SUBAGENT_DONE_0__");
	}));

for (const badHello of ["generation", "methods", "identity"] as const)
	test(`Core ${badHello} rejection never submits a program or falls back`, () =>
		fixture(async (f) => {
			if (badHello === "generation") f.state.generation = 2;
			if (badHello === "methods") f.state.methods = ["terminal.run"];
			if (badHello === "identity") {
				await f.provider.listSurfaces();
				f.state.coreId = "replacement";
			}
			await assert.rejects(f.nativeStart(), /Incompatible|identity changed/);
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.run").length,
				0,
			);
		}));

test("Core missing or finished parent refuses launch", () =>
	fixture(async (f) => {
		f.terminals.get("t1")!.state = "finished";
		await assert.rejects(f.nativeStart(), /parent terminal is not live/);
		f.terminals.delete("t1");
		await assert.rejects(f.nativeStart(), /not_found/);
		assert.equal(f.calls.filter((c) => c.method === "terminal.run").length, 0);
	}));

test("Core child environment is scrubbed even when daemon inherited stale protocol values; parent is untouched", (t) =>
	fixture(async (f) => {
		if (skipCoreOnWindows(t)) return;
		const env = {
			...process.env,
			PI_SUBAGENT_STALE: "ancestor",
			PI_DENY_TOOLS: "bash",
			HERDR_ENV: "legacy",
			HERDR_SOCKET_PATH: "/stale",
			PI_HERDR_AGENTS_SESSION: "ancestor-session",
		};
		const before = { ...process.env };
		const file = join(f.dir, "environment.sh");
		await f.provider.nativeExecution.start({
			cwd: f.dir,
			command: "env",
			scriptPath: file,
			scriptPreamble: "# fixture",
		});
		const output = execFileSync("/bin/bash", [file], { env, encoding: "utf8" });
		for (const prefix of [
			"PI_SUBAGENT_",
			"PI_DENY_TOOLS=",
			"HERDR_",
			"PI_HERDR_AGENTS_SESSION=",
		])
			assert.ok(!output.split("\n").some((line) => line.startsWith(prefix)));
		assert.deepEqual({ ...process.env }, before);
		const forwarded = f.calls.find((c) => c.method === "terminal.run")!.params
			.env;
		assert.ok(
			!Object.keys(forwarded).some(
				(key) =>
					key.startsWith("PI_SUBAGENT_") ||
					key.startsWith("HERDR_") ||
					key.startsWith("HC_"),
			),
		);
		assert.equal(forwarded.PI_DENY_TOOLS, undefined);
		assert.equal(forwarded.PATH, process.env.PATH);
	}));

for (const mode of ["standalone", "fork", "persistent", "interactive"] as const)
	test(`Core ${mode} initializes local session/artifacts/ledger before native submission`, () =>
		fixture(async (f) => {
			const request = f.request();
			if (mode === "fork") request.fork = true;
			if (mode === "persistent")
				Object.assign(request.behavior, {
					persistent: true,
					autoExit: false,
					logicalId: "logical",
					generationId: "generation",
					taskId: "task-one",
				});
			if (mode === "interactive")
				Object.assign(request.behavior, { autoExit: false, interactive: true });
			const start = f.operations.nativeExecution!.start;
			f.operations.nativeExecution = {
				...f.operations.nativeExecution!,
				async start(input) {
					const childFiles = input.command.match(/--session '([^']+)'/)!;
					assert.ok(existsSync(getSubagentSessionPolicyFile(childFiles[1])));
					if (mode === "fork")
						assert.ok(
							getNewEntries(childFiles[1], 0).some(
								(entry) => entry.type === "session",
							),
						);
					if (mode === "persistent")
						assert.equal(
							readPersistentDeliveryLedger(childFiles[1])[0]?.outcome,
							"dispatched",
						);
					return start(input);
				},
			};
			const child = await launchPiSubagent(request, f.operations);
			assert.equal(child.persistent, mode === "persistent" ? true : undefined);
			assert.equal(child.interactive, mode === "interactive");
			const script = readFileSync(child.launchScriptFile, "utf8");
			if (mode === "persistent")
				assert.match(script, /PI_SUBAGENT_PERSISTENT=1/);
			if (mode === "interactive" || mode === "persistent")
				assert.match(script, /PI_SUBAGENT_AUTO_EXIT=0/);
			else assert.match(script, /PI_SUBAGENT_AUTO_EXIT=1/);
		}));

test("Core resume uses saved public cwd/policy and atomic start without shell readiness", () =>
	fixture(async (f) => {
		const file = join(f.dir, "resumed.jsonl");
		writeFileSync(file, JSON.stringify({ type: "session", cwd: f.dir }) + "\n");
		writeSubagentSessionPolicy(file, {
			owner: "public",
			deniedTools: ["bash"],
		});
		const child = await launchPiSubagent(
			{
				kind: "resume",
				name: "resume",
				sessionFile: file,
				message: "continue",
				parent: f.request().parent,
				behavior: { autoExit: false },
			},
			f.operations,
		);
		assert.equal(child.cwd, f.dir);
		assert.equal(child.sessionFile, file);
		assert.equal(child.interactive, true);
		assert.equal(child.surface, "t2");
		const script = readFileSync(child.launchScriptFile, "utf8");
		assert.match(script, /PI_DENY_TOOLS='bash'/);
		assert.match(script, /PI_SUBAGENT_AUTO_EXIT=0/);
		assert.match(script, /exit "\$piha_exit"/);
		assert.equal(f.calls.filter((c) => c.method === "terminal.run").length, 1);
	}));

test("Core local artifact or script failure and pre-abort never start a program", () =>
	fixture(async (f) => {
		const request = f.request();
		mkdirSync(join(f.dir, "agent"), { recursive: true });
		writeFileSync(join(f.dir, "agent", "sessions"), "obstruction");
		await assert.rejects(
			launchPiSubagent(request, f.operations),
			/EEXIST|ENOTDIR/,
		);
		writeFileSync(join(f.dir, "blocked"), "obstruction");
		await assert.rejects(
			f.provider.nativeExecution.start({
				cwd: f.dir,
				command: "exit 0",
				scriptPath: join(f.dir, "blocked", "script.sh"),
				scriptPreamble: "",
			}),
			/EEXIST|ENOTDIR/,
		);
		const abort = new AbortController();
		abort.abort();
		await assert.rejects(
			f.provider.nativeExecution.start({
				cwd: f.dir,
				command: "exit 0",
				scriptPath: join(f.dir, "abort.sh"),
				scriptPreamble: "",
				signal: abort.signal,
			}),
		);
		assert.equal(f.calls.filter((c) => c.method === "terminal.run").length, 0);
	}));

for (const resumed of [false, true])
	test(`Core ${resumed ? "resumed" : "fresh"} cancellation during launch hello prevents submission`, () =>
		fixture(async (f) => {
			const abort = new AbortController();
			let hellos = 0;
			f.server.on("request", (request: Request) => {
				if (request.method === "hello" && ++hellos === 2) abort.abort();
			});
			let request: PiLaunchRequest = f.request();
			if (resumed) {
				const file = join(f.dir, "resumed.jsonl");
				writeFileSync(
					file,
					JSON.stringify({ type: "session", cwd: f.dir }) + "\n",
				);
				writeSubagentSessionPolicy(file, { owner: "public", deniedTools: [] });
				request = {
					kind: "resume",
					name: "cancelled resume",
					sessionFile: file,
					parent: f.request().parent,
				};
			}
			request.acquisitionSignal = abort.signal;
			await assert.rejects(launchPiSubagent(request, f.operations), (error) => {
				assert.equal(error, abort.signal.reason);
				assert.equal(isAcquisitionUncertainError(error), false);
				return true;
			});
			assert.equal(hellos, 2);
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.run").length,
				0,
			);
			assert.deepEqual([...f.terminals.keys()], ["t1"]);
		}));

for (const mode of ["valid", "disconnect"] as const)
	test(`Core cancellation after submission preserves ${mode === "valid" ? "the acquired owner" : "execution uncertainty"}`, () =>
		fixture(async (f) => {
			const abort = new AbortController();
			f.state.runMode = mode;
			f.server.on("request", (request: Request) => {
				if (request.method === "terminal.run") abort.abort();
			});
			const request = f.request();
			request.acquisitionSignal = abort.signal;
			const launch = launchPiSubagent(request, f.operations);
			if (mode === "valid") {
				const child = await launch;
				assert.equal(child.surface, "t2");
				await f.provider.nativeExecution.terminate(child.surface);
				assert.equal(
					(await f.provider.nativeExecution.inspect(child.surface)).kind,
					"finished",
				);
			} else {
				await assert.rejects(launch, (error) => {
					assert.ok(isAcquisitionUncertainError(error));
					assert.equal(error.uncertainty.kind, "execution-start");
					return true;
				});
			}
			assert.equal(abort.signal.aborted, true);
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.run").length,
				1,
			);
			assert.equal(f.calls.filter((c) => c.method === "terminal.rm").length, 0);
		}));

for (const mode of ["disconnect", "timeout", "malformed", "oversized"] as const)
	test(`Core ${mode} after native submission is ownerless uncertainty, not retryable`, () =>
		fixture(async (f) => {
			f.state.runMode = mode;
			await assert.rejects(
				launchPiSubagent(f.request(), f.operations),
				(error: Error) => {
					assert.ok(isAcquisitionUncertainError(error));
					assert.deepEqual(error.uncertainty, {
						kind: "execution-start",
						observedSurfaceId: undefined,
					});
					assert.ok(!error.message.includes(f.socketPath));
					return true;
				},
			);
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.run").length,
				1,
			);
			assert.equal(
				f.calls.filter(
					(c) => c.method === "terminal.kill" || c.method === "terminal.rm",
				).length,
				0,
			);
		}));

test("Core hello metadata is never an observed execution identity", () =>
	fixture(async (f) => {
		f.state.helloAddress = "t9";
		f.state.runMode = "disconnect";
		await assert.rejects(f.nativeStart(), (error: Error) => {
			assert.ok(isAcquisitionUncertainError(error));
			assert.deepEqual(error.uncertainty, {
				kind: "execution-start",
				observedSurfaceId: undefined,
			});
			return true;
		});
	}));

test("Core duplicate launch cannot cancel the first task or advance its own fallback", () =>
	fixture(async (f) => {
		const session = createDefaultRunSession(sessionOptions(f));
		f.sessions.push(session);
		const first = await session.spawnPi(launchInput(f, "first"));
		f.state.runMode = "duplicate-partial";
		const second = launchInput(f, "second");
		second.plans = [
			second.plans[0],
			{ ...second.plans[0], model: "test/two", modelId: "two" },
		];
		await assert.rejects(session.spawnPi(second), (error: Error) =>
			isAcquisitionUncertainError(error),
		);
		assert.equal(session.getRecord(second.task.id), undefined);
		await assert.rejects(session.cancel(second.task.id), /was not found/);
		assert.equal(f.terminals.get(first.surfaceId!)!.state, "live");
		assert.equal(f.calls.filter((c) => c.method === "terminal.kill").length, 0);
		assert.equal(f.calls.filter((c) => c.method === "terminal.run").length, 2);
	}));

for (const mode of ["duplicate-partial", "duplicate-full"] as const)
	for (const resumed of [false, true])
		test(`Core ${resumed ? "resume" : "fresh"} ${mode} never acquires a different launch's owner`, () =>
			fixture(async (f) => {
				await f.nativeStart(); // A owns t2; B will actually start as t3.
				f.state.runMode = mode;
				const request = f.request();
				const file = join(f.dir, "resume-collision.jsonl");
				writeFileSync(
					file,
					JSON.stringify({ type: "session", cwd: f.dir }) + "\n",
				);
				writeSubagentSessionPolicy(file, { owner: "public", deniedTools: [] });
				await assert.rejects(
					launchPiSubagent(
						resumed
							? {
									kind: "resume",
									name: "collision",
									sessionFile: file,
									parent: request.parent,
								}
							: request,
						f.operations,
					),
					(error: Error) => {
						assert.ok(
							!(error instanceof AcquiredPiLaunchError),
							"observed IDs are not acquired ownership",
						);
						assert.ok(isAcquisitionUncertainError(error));
						assert.equal(error.uncertainty.kind, "execution-start");
						return true;
					},
				);
				assert.equal(f.terminals.get("t2")!.state, "live");
				assert.equal(f.terminals.get("t3")!.state, "live");
				assert.equal(
					f.calls.filter((c) => c.method === "terminal.kill").length,
					0,
				);
			}));

for (const mode of ["duplicate-partial", "duplicate-full"] as const)
	for (const owner of ["parent", "pending"] as const)
		test(`Core ${mode} reply cannot transfer the ${owner} terminal to another launch`, () =>
			fixture(async (f) => {
				if (owner === "pending") {
					f.state.runMode = "partial";
					await assert.rejects(f.nativeStart(), (error: Error) =>
						isAcquisitionUncertainError(error),
					);
				}
				f.state.replyAddress = owner === "parent" ? "t1" : "t2";
				f.state.runMode = mode;
				await assert.rejects(
					launchPiSubagent(f.request(), f.operations),
					(error: Error) => {
						assert.ok(!(error instanceof AcquiredPiLaunchError));
						assert.ok(isAcquisitionUncertainError(error));
						return true;
					},
				);
			}));

for (const kind of ["spawn_failed", "config", "unavailable"])
	test(`Core structured ${kind} after submission cannot trigger model fallback`, () =>
		fixture(async (f) => {
			f.state.runMode = "post-spawn-error";
			f.state.runErrorKind = kind;
			const session = createDefaultRunSession(sessionOptions(f));
			f.sessions.push(session);
			const input = launchInput(f);
			input.plans = [
				input.plans[0],
				{
					...input.plans[0],
					model: "test/two",
					modelId: "two",
				},
			];
			await assert.rejects(session.spawnPi(input), (error: Error) =>
				isAcquisitionUncertainError(error),
			);
			assert.equal(session.getRecord(input.task.id), undefined);
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.run").length,
				1,
			);
			assert.equal(f.terminals.get("t2")!.state, "live");
		}));

for (const mode of ["partial", "unverified"] as const)
	for (const resumed of [false, true])
		test(`Core ${resumed ? "resume" : "fresh"} ${mode} reply retains a pending owner, verifies before control`, () =>
			fixture(async (f) => {
				f.state.runMode = mode;
				let request: PiLaunchRequest = f.request();
				if (resumed) {
					const file = join(f.dir, "resume-uncertain.jsonl");
					writeFileSync(
						file,
						JSON.stringify({ type: "session", cwd: f.dir }) + "\n",
					);
					writeSubagentSessionPolicy(file, {
						owner: "public",
						deniedTools: [],
					});
					request = {
						kind: "resume",
						name: "uncertain resume",
						sessionFile: file,
						parent: request.parent,
					};
				}
				await assert.rejects(
					launchPiSubagent(request, f.operations),
					(error: Error) => {
						assert.ok(error instanceof AcquiredPiLaunchError);
						assert.equal(error.child.surface, "t2");
						assert.ok(
							existsSync(getSubagentSessionPolicyFile(error.child.sessionFile)),
						);
						return true;
					},
				);
				assert.deepEqual(await f.provider.nativeExecution.inspect("t2"), {
					kind: "live",
				});
				await f.provider.sendKeys("t2", "Escape");
				await f.provider.nativeExecution.terminate("t2");
				assert.equal(f.terminals.get("t2")!.state, "finished");
				assert.equal(
					f.calls.filter((c) => c.method === "terminal.run").length,
					1,
				);
				assert.equal(
					f.calls.filter((c) => c.method === "terminal.rm").length,
					0,
				);
			}));

for (const field of ["parent", "cwd", "argv", "keep", "rm", "server"] as const)
	test(`Core unverified reply retains ownership but refuses control when ${field} differs`, () =>
		fixture(async (f) => {
			f.state.runMode = "unverified";
			await assert.rejects(f.nativeStart(), (error: Error) => {
				assert.ok(isAcquisitionUncertainError(error));
				assert.deepEqual(error.uncertainty, {
					kind: "execution-start",
					observedSurfaceId: "t2",
					acquiredSurfaceId: "t2",
				});
				return true;
			});
			const terminal = f.terminals.get("t2")!;
			const original = { ...terminal };
			if (field === "parent") terminal.parent = "t9";
			if (field === "cwd") terminal.cwd = join(f.dir, "other");
			if (field === "argv") terminal.argv = ["/bin/bash", "foreign.sh"];
			if (field === "keep") terminal.keep = true;
			if (field === "rm") terminal.rm = true;
			if (field === "server") f.state.coreId = "replacement";
			assert.equal(
				(await f.provider.nativeExecution.inspect("t2")).kind,
				"unavailable",
			);
			await assert.rejects(
				f.provider.nativeExecution.terminate("t2"),
				/ownership changed|identity changed/,
			);
			await assert.rejects(
				f.provider.sendKeys("t2", "Escape"),
				/ownership changed|identity changed/,
			);
			await assert.rejects(
				f.provider.closeSurface("t2"),
				/ownership changed|identity changed/,
			);
			assert.equal(
				f.calls.filter((c) =>
					["terminal.kill", "terminal.keys", "terminal.rm"].includes(c.method),
				).length,
				0,
			);
			Object.assign(terminal, original);
			f.state.coreId = "core-unit";
			await f.provider.nativeExecution.terminate("t2");
			assert.equal(terminal.state, "finished");
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.run").length,
				1,
			);
		}));

test("Core exact-ID interrupt/cancel verifies ownership; native kill reply alone does not confirm or remove", () =>
	fixture(async (f) => {
		const id = await f.nativeStart();
		await f.provider.sendKeys(id, "Escape");
		assert.deepEqual(
			f.calls.find((c) => c.method === "terminal.keys")!.params,
			{ terminal: id, keys: ["esc"] },
		);
		await assert.rejects(f.provider.sendKeys(id, "ctrl+c"), /does not support/);
		await assert.rejects(f.provider.sendKeys("t1", "Escape"), /not owned/);
		await assert.rejects(
			f.provider.nativeExecution.terminate("t1"),
			/not owned/,
		);
		f.state.killExits = false;
		await assert.rejects(
			f.provider.nativeExecution.terminate(id),
			/unconfirmed/,
		);
		await assert.rejects(f.provider.closeSurface(id), /live/);
		assert.equal(f.calls.filter((c) => c.method === "terminal.rm").length, 0);
		f.terminals.get(id)!.created_ms++;
		const kills = f.calls.filter((c) => c.method === "terminal.kill").length;
		await assert.rejects(
			f.provider.nativeExecution.terminate(id),
			/ownership changed/,
		);
		assert.equal(
			f.calls.filter((c) => c.method === "terminal.kill").length,
			kills,
		);
	}));

test("Core replacement identity cannot inspect, signal, or remove existing owners", () =>
	fixture(async (f) => {
		const id = await f.nativeStart();
		f.state.coreId = "different-core";
		assert.equal(
			(await f.provider.nativeExecution.inspect(id)).kind,
			"unavailable",
		);
		await assert.rejects(
			f.provider.nativeExecution.terminate(id),
			/identity changed/,
		);
		await assert.rejects(f.provider.closeSurface(id), /identity changed/);
		assert.ok(
			!f.calls.some(
				(c) => c.method === "terminal.kill" || c.method === "terminal.rm",
			),
		);
	}));

test("Core worktree/handoff/UI requests are rejected before Git, artifact or RPC effects", () =>
	fixture(async (f) => {
		for (const additions of [
			{ worktree: { branch: "deferred" } },
			{ handoff: { leafId: "leaf" } },
			{ surface: "t1" },
		])
			await assert.rejects(
				launchPiSubagent({ ...f.request(), ...additions }, f.operations),
				/deferred/,
			);
		assert.equal(existsSync(join(f.dir, "agent")), false);
		await assert.rejects(f.provider.listWorktreeSurfaces(), /does not support/);
		assert.throws(() => f.provider.createWorktreeSurface(), /does not support/);
		assert.throws(() => f.provider.focusWorkspace(), /does not support/);
		assert.equal(f.calls.length, 0);
	}));

test("Core execution-start uncertainty remains structurally recognizable across reloads", () => {
	assert.ok(
		isAcquisitionUncertainError(
			new AcquisitionUncertainError("owned", {
				kind: "execution-start",
				observedSurfaceId: "t2",
				acquiredSurfaceId: "t2",
			}),
		),
	);
	for (const observedSurfaceId of [undefined, "t3"])
		assert.equal(
			isAcquisitionUncertainError(
				new AcquisitionUncertainError("invalid", {
					kind: "execution-start",
					observedSurfaceId,
					acquiredSurfaceId: "t2",
				}),
			),
			false,
		);
	assert.ok(
		isAcquisitionUncertainError(
			new AcquisitionUncertainError("uncertain", { kind: "execution-start" }),
		),
	);
	assert.ok(
		isAcquisitionUncertainError(
			new AcquisitionUncertainError("uncertain", {
				kind: "execution-start",
				observedSurfaceId: "t2",
			}),
		),
	);
	assert.equal(
		isAcquisitionUncertainError({
			code: "PIHA_ACQUISITION_UNCERTAIN",
			name: "Error",
			message: "x",
			uncertainty: { kind: "execution-start", observedSurfaceId: "user/name" },
		}),
		false,
	);
});

for (const persistent of [false, true])
	test(`Core ${persistent ? "persistent" : "ordinary"} sidecar/live status/sentinel cannot release lifetime before exit`, () =>
		fixture(async (f) => {
			const request = f.request();
			request.behavior.persistent = persistent;
			const child = await launchPiSubagent(request, f.operations);
			recordExit(child.sessionFile);
			let inspections = 0,
				terminalReads = 0,
				paneReads = 0;
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile: child.sessionFile,
				requireProcessExit: persistent,
				inspectExecution: async () => {
					inspections++;
					if (inspections === 3) {
						f.terminals.get(child.surface)!.state = "finished";
						f.terminals.get(child.surface)!.exit_code = 0;
					}
					return f.provider.nativeExecution.inspect(child.surface);
				},
				readTerminalTail: async () => {
					terminalReads++;
					return "__SUBAGENT_DONE_0__";
				},
				inspectPane: async () => {
					paneReads++;
					return { kind: "missing" };
				},
			});
			assert.equal(result.reason, "done");
			assert.equal(inspections, 3);
			assert.equal(terminalReads, 0);
			assert.equal(paneReads, 0);
			assert.equal(existsSync(`${child.sessionFile}.exit`), false);
		}));

test("Core finished native exit admits interactive sentinel only after exit and with matching code", async () => {
	for (const code of [0, 7]) {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			paneDisappearanceGraceMs: 0,
			inspectExecution: async () => ({ kind: "finished", exitCode: code }),
			readTerminalTail: async () => `__SUBAGENT_DONE_${code}__`,
		});
		assert.equal(result.reason, "sentinel");
		assert.equal(result.exitCode, code);
	}
	const stale = await waitForCompletion(new AbortController().signal, {
		intervalMs: 1,
		paneDisappearanceGraceMs: 0,
		inspectExecution: async () => ({ kind: "finished", exitCode: 9 }),
		readTerminalTail: async () => "__SUBAGENT_DONE_0__",
	});
	assert.equal(stale.reason, "error");
	assert.equal(stale.exitCode, 9);
});

for (const nativeKind of ["finished", "missing"] as const)
	for (const exitCode of [0, 7, undefined])
		for (const unreadable of [false, true])
			test(`Core ${nativeKind} exit ${exitCode} without completion evidence preserves native code (unreadable=${unreadable})`, async () => {
				const result = await waitForCompletion(new AbortController().signal, {
					intervalMs: 1,
					paneDisappearanceGraceMs: 0,
					inspectExecution: async () => ({ kind: nativeKind, exitCode }),
					readTerminalTail: async () => {
						if (unreadable) throw new Error("read unavailable");
						return "";
					},
				});
				assert.equal(
					result.reason,
					"error",
					"process exit alone is not task success",
				);
				assert.equal(
					result.exitCode,
					nativeKind === "finished" ? (exitCode ?? 1) : 1,
				);
				assert.equal(result.errorSource, "host");
				assert.match(
					result.errorMessage!,
					/native execution ended before completion evidence/,
				);
			});

test("Core unavailable exit evidence preserves sidecar and owner until aborted", () =>
	fixture(async (f) => {
		const file = join(f.dir, "session.jsonl");
		recordExit(file);
		const abort = new AbortController();
		let inspections = 0;
		await assert.rejects(
			waitForCompletion(abort.signal, {
				intervalMs: 1,
				sessionFile: file,
				inspectExecution: async () => {
					if (++inspections === 3) abort.abort();
					return { kind: "unavailable" };
				},
				readTerminalTail: async () => "__SUBAGENT_DONE_0__",
				inspectPane: async () => ({ kind: "missing" }),
			}),
			/Aborted/,
		);
		assert.equal(existsSync(`${file}.exit`), true);
	}));

for (const throws of [false, true])
	test(`Core ${throws ? "throwing" : "unavailable"} native inspection stalls and live inspection recovers`, async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 1000 });
		const abort = new AbortController();
		let lifecycle = createLifecycle(Date.now());
		let inspections = 0;
		let terminalReads = 0;
		const projections: LifecycleProjection["kind"][] = [];
		const transitions: LifecycleTransition[] = [];
		await assert.rejects(
			waitForCompletion(abort.signal, {
				intervalMs: 1,
				inspectExecution: async () => {
					if (++inspections === 3) return { kind: "live" };
					if (throws) throw new Error("Core disconnected");
					return { kind: "unavailable", error: "Core disconnected" };
				},
				onPaneInspection: (inspection, at) => {
					assert.equal(at, Date.now());
					lifecycle = observePaneInspection(lifecycle, inspection, at);
					const projection = projectLifecycle(lifecycle, at);
					transitions.push(
						lifecycleTransition(projections.at(-1), projection.kind),
					);
					projections.push(projection.kind);
				},
				waitForNextCheck: async () => {
					t.mock.timers.tick(60_001);
					if (inspections === 3) abort.abort();
					return "reconcile";
				},
				readTerminalTail: async () => {
					terminalReads++;
					return "__SUBAGENT_DONE_0__";
				},
			}),
			/Aborted/,
		);
		assert.equal(inspections, 3);
		assert.equal(terminalReads, 0);
		assert.deepEqual(projections, ["starting", "stalled", "running"]);
		assert.deepEqual(transitions, [null, "stalled", "recovered"]);
	});

for (const nativeKind of ["finished", "missing"] as const)
	test(`Core ${nativeKind} supports delayed sidecar grace and crash without one`, () =>
		fixture(async (f) => {
			const file = join(f.dir, "delayed.jsonl");
			const timer = setTimeout(() => recordExit(file), 15);
			try {
				const result = await waitForCompletion(new AbortController().signal, {
					intervalMs: 1,
					sessionFile: file,
					paneDisappearanceGraceMs: 200,
					inspectExecution: async () => ({ kind: nativeKind, exitCode: 9 }),
					readTerminalTail: async () => "",
				});
				assert.equal(result.reason, "done");
			} finally {
				clearTimeout(timer);
			}
			const crash = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile: file,
				paneDisappearanceGraceMs: 0,
				inspectExecution: async () => ({ kind: nativeKind, exitCode: 9 }),
				readTerminalTail: async () => "",
			});
			assert.equal(crash.reason, "error");
			assert.match(crash.errorMessage!, /native execution ended/);
		}));

test("Core session delivery precedes record removal; cancellation confirms native exit independently", () =>
	fixture(async (f) => {
		const options = sessionOptions(f);
		const delivered: PiCompletedMetadata[] = [];
		options.hooks.onSettled = (record, result) => {
			assert.ok(
				f.terminals.has(record.surface),
				"native record retained until delivery",
			);
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.rm").length,
				delivered.length,
			);
			delivered.push(result);
		};
		const session = createDefaultRunSession(options);
		f.sessions.push(session);
		for (const cancelled of [false, true]) {
			const input = launchInput(f, cancelled ? "cancel" : "complete");
			const handle = await session.spawnPi(input);
			const record = session.getRecord(input.task.id)!;
			const wait = session.supervise(handle, session.getTask(input.task.id)!);
			if (cancelled)
				assert.equal((await session.cancel(input.task.id)).status, "confirmed");
			else {
				f.terminals.get(record.surface)!.state = "finished";
				f.terminals.get(record.surface)!.exit_code = 0;
				recordExit(record.sessionFile);
			}
			await wait;
			await f.removed(record.surface);
			assert.equal(f.terminals.has(record.surface), false);
		}
		assert.equal(delivered.length, 2);
		assert.equal(f.calls.filter((c) => c.method === "terminal.kill").length, 1);
		assert.equal(f.calls.filter((c) => c.method === "terminal.rm").length, 2);
	}));

test("Core session rejects unsupported cleanup and native worktree spawn without effects", (t) =>
	fixture(async (f) => {
		if (skipCoreOnWindows(t)) return;
		const session = createDefaultRunSession(sessionOptions(f));
		f.sessions.push(session);
		assert.throws(
			() =>
				session.createWorktreeCleanupOperations({
					manifestDir: f.dir,
					liveHolders: () => [],
				}),
			/not supported/,
		);
		await assert.rejects(session.listWorktreeSurfaces(), /does not support/);
		const input = launchInput(f);
		input.task.worktree = { branch: "deferred" };
		await assert.rejects(session.spawnPi(input), /deferred/);
		assert.equal(f.calls.length, 0);
	}));

test("Core session no-ID uncertainty blocks model fallback and leaves no fabricated owner", () =>
	fixture(async (f) => {
		f.state.runMode = "disconnect";
		const session = createDefaultRunSession(sessionOptions(f));
		f.sessions.push(session);
		const input = launchInput(f);
		input.plans = [
			input.plans[0],
			{ ...input.plans[0], model: "test/two", modelId: "two" },
		];
		await assert.rejects(session.spawnPi(input), (error: Error) =>
			isAcquisitionUncertainError(error),
		);
		assert.equal(session.getRecord(input.task.id), undefined);
		assert.equal(f.calls.filter((c) => c.method === "terminal.run").length, 1);
	}));

test("Core native binding survives reload; changed endpoint/backend fails before owner mutation", (t) =>
	fixture(async (f) => {
		if (skipCoreOnWindows(t)) return;
		mkdirSync(join(f.dir, "herdr-agents"));
		const config = join(f.dir, "herdr-agents", "config.json");
		writeFileSync(
			config,
			JSON.stringify({ herdr: { backend: "core" }, panes }),
		);
		const options = sessionOptions(f, false);
		const nativeEnv = {
			HC_TERMINAL_ID: "t1",
			HC_TERMINAL_SOCKET: f.socketPath,
		};
		const session = withEnvironment(nativeEnv, () =>
			createDefaultRunSession(options),
		);
		f.sessions.push(session);
		assert.equal(f.calls.length, 0, "extension composition cannot connect");
		const reloaded = withEnvironment(nativeEnv, () =>
			createDefaultRunSession(options, session),
		);
		f.sessions.push(reloaded);
		let wrongHooks = 0;
		assert.throws(
			() =>
				withEnvironment(
					{ ...nativeEnv, HC_TERMINAL_SOCKET: "/wrong.sock" },
					() =>
						createDefaultRunSession(
							{
								...options,
								hooks: {
									onSettled() {
										wrongHooks++;
									},
								},
							},
							reloaded,
						),
				),
			/restart/,
		);
		writeFileSync(
			config,
			JSON.stringify({ herdr: { backend: "legacy" }, panes }),
		);
		assert.throws(
			() =>
				withEnvironment(nativeEnv, () =>
					createDefaultRunSession(options, reloaded),
				),
			/restart/,
		);
		writeFileSync(
			config,
			JSON.stringify({ herdr: { backend: "core" }, panes }),
		);
		const input = launchInput(f);
		const handle = await reloaded.spawnPi(input);
		assert.equal(
			handle.surfaceId,
			"t2",
			"per-launch operations use pinned Core provider, not ambient legacy",
		);
		assert.equal(wrongHooks, 0);
		assert.equal((await reloaded.cancel(input.task.id)).status, "confirmed");
	}));

for (const resumed of [false, true])
	test(`Core ${resumed ? "resume" : "fresh"} generated script preserves Pi nonzero exit status`, (t) =>
		fixture(async (f) => {
			if (skipCoreOnWindows(t)) return;
			const bin = join(f.dir, "bin");
			mkdirSync(bin);
			writeFileSync(join(bin, "pi"), "#!/bin/bash\nexit 7\n", { mode: 0o700 });
			let child;
			if (resumed) {
				const file = join(f.dir, "resume.jsonl");
				writeFileSync(
					file,
					JSON.stringify({ type: "session", cwd: f.dir }) + "\n",
				);
				writeSubagentSessionPolicy(file, { owner: "public", deniedTools: [] });
				child = await launchPiSubagent(
					{
						kind: "resume",
						name: "resume",
						sessionFile: file,
						parent: f.request().parent,
					},
					f.operations,
				);
			} else child = await launchPiSubagent(f.request(), f.operations);
			assert.throws(
				() =>
					execFileSync("/bin/bash", [child.launchScriptFile], {
						env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
						stdio: "pipe",
					}),
				(
					error: NodeJS.ErrnoException & { status?: number; stdout?: Buffer },
				) => {
					assert.equal(error.status, 7);
					assert.match(error.stdout!.toString(), /__SUBAGENT_DONE_7__/);
					return true;
				},
			);
		}));

for (const mode of ["partial", "unverified"] as const)
	test(`Core ${mode} observed-ID uncertain session retains control, never retries or falls back`, () =>
		fixture(async (f) => {
			f.state.runMode = mode;
			const session = createDefaultRunSession(sessionOptions(f));
			f.sessions.push(session);
			const input = launchInput(f);
			input.plans = [
				input.plans[0],
				{ ...input.plans[0], model: "test/two", modelId: "two" },
			];
			const handle = await session.spawnPi(input);
			assert.ok(handle.launchFailure);
			assert.equal(session.getStarted(input.task.id)!.status, "uncertain");
			const wait = session.supervise(handle, session.getTask(input.task.id)!);
			f.state.killExits = false;
			assert.equal((await session.cancel(input.task.id)).status, "unconfirmed");
			assert.ok(session.getRecord(input.task.id));
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.run").length,
				1,
			);
			f.state.killExits = true;
			assert.equal((await session.cancel(input.task.id)).status, "confirmed");
			await wait;
			await f.removed(handle.surfaceId!);
			assert.equal(
				f.calls.filter((c) => c.method === "terminal.run").length,
				1,
			);
		}));

test("Core suppression gates confirmed termination then cleanup without parent delivery", () =>
	fixture(async (f) => {
		const options = sessionOptions(f);
		let delivered = false;
		options.hooks.onSettled = () => {
			delivered = true;
		};
		const session = createDefaultRunSession(options);
		f.sessions.push(session);
		const input = launchInput(f);
		const handle = await session.spawnPi(input);
		session.suppress(input.task.id);
		await f.removed(handle.surfaceId!);
		assert.equal(delivered, false);
		const effects = f.calls
			.filter((c) => c.method === "terminal.kill" || c.method === "terminal.rm")
			.map((c) => c.method);
		assert.deepEqual(effects, ["terminal.kill", "terminal.rm"]);
	}));

test("Core injected native binding mismatch rejects before adopting or creating resources", () =>
	fixture(async (f) => {
		const options = sessionOptions(f);
		const session = createDefaultRunSession(options);
		f.sessions.push(session);
		const changed = sessionOptions(f);
		changed.infrastructure!.launchOperations = {
			...changed.infrastructure!.launchOperations,
			nativeExecution: undefined,
		};
		assert.throws(
			() => createDefaultRunSession(changed, session),
			/same native execution binding/,
		);
		changed.infrastructure!.supervision.close();
		assert.equal(f.calls.length, 0);
	}));

test("Injected Core infrastructure ignores ambient native endpoints and configuration", () =>
	fixture(async (f) => {
		const session = withEnvironment(
			{ HC_TERMINAL_ID: "t99", HC_TERMINAL_SOCKET: "/must-not-connect.sock" },
			() => createDefaultRunSession(sessionOptions(f)),
		);
		f.sessions.push(session);
		const input = launchInput(f);
		await session.spawnPi(input);
		assert.equal(
			f.calls.find((c) => c.method === "terminal.run")!.params.parent,
			"t1",
		);
		assert.equal((await session.cancel(input.task.id)).status, "confirmed");
	}));
