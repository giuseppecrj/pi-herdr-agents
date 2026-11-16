import "../clean-host-env.ts";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cleanupTestProcess } from "../helpers/process-cleanup.ts";
import { PiHarnessAdapter } from "@nubl/maestro/adapters/pi/pi-harness-adapter";
import {
	captureSurfacePiProcessIdentity,
	launchOperationsFromSurface,
} from "@nubl/maestro/adapters/pi/launch-operations";
import { FakeSurfaceProvider } from "@nubl/maestro/testing";
import { FileWakeRegistry } from "@nubl/maestro/core/wake";
import { SupervisionCoordinator } from "@nubl/maestro/core/supervision";
import type { SpawnOptions } from "@nubl/maestro/core/harness-adapter";

const paneConfig = {
	mode: "grouped",
	direction: "right",
	maxPerTab: 4,
} as const;
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-adapter-test-"));
	const sessionDir = join(root, "parent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "parent.jsonl");
	writeFileSync(
		sessionFile,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root }) +
			"\n",
	);
	const surface = new FakeSurfaceProvider();
	// Fake only the process launch. Session policy, artifact creation and completion are real.
	const operations = launchOperationsFromSurface(surface, paneConfig);
	operations.runScript = (_surface, _command, options) => options.scriptPath;
	const wake = new FileWakeRegistry();
	const supervision = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: surface
				.listSurfaces()
				.map((s) => ({ paneId: s.id, workspaceId: "fixture" })),
		}),
		(id) => surface.inspectSurface(id),
		false,
		wake,
	);
	const modelRegistry = {
		find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
		available: () => [],
		hasConfiguredAuth: () => true,
		supportedThinkingLevels:
			(): import("@nubl/maestro/core/types").ThinkingLevel[] => [
				"off",
				"minimal",
				"low",
				"medium",
				"high",
			],
		clampThinkingLevel: (
			_model: import("@nubl/maestro/core/routing").RoutingModel,
			level: import("@nubl/maestro/core/types").ThinkingLevel,
		) => level,
	};
	const adapter = new PiHarnessAdapter({
		surface,
		paneConfig,
		operations,
		wake,
		supervision,
		modelRegistry,
		parent: {
			cwd: root,
			sessionFile,
			sessionId: "parent",
			sessionDir,
			agentDir: join(root, "agent"),
		},
		parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
	});
	const options: SpawnOptions = {
		name: "worker",
		task: "bounded task",
		cwd: root,
		sessionId: "logical-task",
		role: {
			name: "worker",
			version: "1",
			description: "test",
			systemPrompt: "Focused identity",
			allowedTools: ["read", "bash"],
			defaults: { autoExit: true, spawning: false },
		},
		runtime: { model: "fake/test", thinking: "off" },
	};
	return {
		root,
		modelRegistry,
		adapter,
		surface,
		options,
		operations,
		wake,
		supervision,
		dispose() {
			supervision.close();
			wake.close();
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

describe("PiHarnessAdapter retained worktree kill with real processes", () => {
	async function realChild(
		f: ReturnType<typeof fixture>,
		mode: string,
		t: TestContext,
	) {
		const sessionFile = join(f.root, `real-${mode}.jsonl`);
		const file = `${sessionFile}.process.json`;
		const proc = spawnIdentityChild(file, "real-run", sessionFile, mode);
		// Own cleanup before readiness or any setup assertion can fail.
		t.after(() => cleanupTestProcess(proc.pid));
		await childReady(proc);
		// Pi's `process.title` rewrite has removed the session from argv.
		assert.doesNotMatch(
			readFileSync(`/proc/${proc.pid}/cmdline`, "utf8"),
			/--session|real-run/,
		);
		const captured = await captureSurfacePiProcessIdentity(
			{
				getProcessInfo: () => ({
					shellPid: process.pid,
					pids: [process.pid],
					foregroundProcesses: [],
				}),
			},
			"pane",
			{ file, id: "real-run", sessionFile },
			{ timeoutMs: 5_000, intervalMs: 20 },
		);
		assert.equal(captured.pid, proc.pid);
		const adapter = new PiHarnessAdapter({
			surface: f.surface,
			paneConfig,
			operations: f.operations,
			supervision: f.supervision,
			modelRegistry: f.modelRegistry,
			parent: {
				cwd: f.root,
				sessionFile: join(f.root, "parent", "parent.jsonl"),
				sessionId: "parent",
				sessionDir: join(f.root, "parent"),
				agentDir: join(f.root, "agent"),
			},
			parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
			killTimeoutMs: 300,
		});
		const h = await adapter.spawn(f.options);
		const child = adapter.getRunningChild(h);
		child.worktree = {
			path: join(f.root, "worktree"),
			workspaceId: "owned-workspace",
			paneId: child.surface,
			branch: "cancel",
			baseRef: "HEAD",
			baseSha: "base",
			manifestFile: join(f.root, "manifest.json"),
		};
		child.processIdentity = captured;
		return { proc, adapter, h };
	}
	it("a title-rewritten Pi that survives SIGTERM is unconfirmed until THAT process exits", async (t) =>
		usingFixture(async (f) => {
			if (process.platform !== "linux") return;
			const r = await realChild(f, "ignore-term", t);
			try {
				await assert.rejects(r.adapter.kill(r.h), /is still alive/);
				const exited = once(r.proc, "exit");
				r.proc.kill("SIGKILL");
				await exited;
				await r.adapter.kill(r.h);
			} finally {
				r.proc.kill("SIGKILL");
			}
		}));
	it("a suspended title-rewritten Pi is unconfirmed; resumed, SIGTERM ends it and confirms", async (t) =>
		usingFixture(async (f) => {
			if (process.platform !== "linux") return;
			const r = await realChild(f, "default", t);
			try {
				process.kill(r.proc.pid!, "SIGSTOP");
				await assert.rejects(r.adapter.kill(r.h), /is still alive/);
				const exited = once(r.proc, "exit");
				process.kill(r.proc.pid!, "SIGCONT");
				await exited;
				await r.adapter.kill(r.h);
			} finally {
				r.proc.kill("SIGKILL");
			}
		}));
});

// Records its identity through the real child-extension hook, rewrites its
// title as Pi does, then idles. `ignore-term` survives SIGTERM.
const IDENTITY_CHILD = `
const [extension, file, id, sessionFile, mode] = process.argv.slice(1);
const { recordProcessIdentity } = await import(extension);
if (mode === "ignore-term") process.on("SIGTERM", () => {});
recordProcessIdentity(id, sessionFile, file);
process.title = "pi";
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;
function spawnIdentityChild(
	file: string,
	id: string,
	sessionFile: string,
	mode: string,
) {
	return spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			"--input-type=module",
			"-e",
			IDENTITY_CHILD,
			"--",
			new URL(
				"../../maestro/adapters/pi/child/subagent-done.ts",
				import.meta.url,
			).href,
			file,
			id,
			sessionFile,
			mode,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
}
async function childReady(proc: ReturnType<typeof spawn>) {
	let output = "";
	for await (const chunk of proc.stdout!) {
		output += String(chunk);
		if (output.includes("ready\n")) return;
	}
	throw new Error("identity child exited before it was ready");
}
