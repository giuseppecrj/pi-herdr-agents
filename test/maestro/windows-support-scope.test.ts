import "../clean-host-env.ts";
import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../../pi-extension/subagents/index.ts";
import {
	readGlobalSlot,
	RUNTIME_KEY,
	type SubagentRuntime,
} from "../../pi-extension/subagents/state.ts";
import {
	HERDR_CORE_UNSUPPORTED_ON_WINDOWS,
	MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
	assertManagedWorktreesSupported,
	managedWorktreeRefusal,
} from "../../maestro/core/platform-support.ts";
import { selectHerdrBinding } from "../../maestro/core/config/herdr-config.ts";
import type { WorktreeOperations } from "../../maestro/core/worktree.ts";
import type { PiWorktreeHandoffInput } from "../../maestro/runtime/index.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

// Windows support scope: ordinary subagents on legacy Herdr only. Managed
// worktrees and Herdr Core are refused before any effect. The platform is
// injected, so the win32 branch runs on every host.

const escaped = (text: string) =>
	new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const worktreeRefusal = escaped(MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS);
const coreRefusal = escaped(HERDR_CORE_UNSUPPORTED_ON_WINDOWS);

test("the managed-worktree predicate refuses only win32", () => {
	assert.equal(
		managedWorktreeRefusal("win32"),
		MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
	);
	assert.throws(() => assertManagedWorktreesSupported("win32"), {
		message: MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
	});
	for (const platform of ["linux", "darwin"] as const) {
		assert.equal(managedWorktreeRefusal(platform), undefined);
		assertManagedWorktreesSupported(platform);
	}
});

test("Herdr Core selection fails on win32 with the Windows message; legacy is unchanged", () => {
	const core = { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/run/core.sock" };
	const pipe = { HC_TERMINAL_ID: "t1", HC_SOCKET: "\\\\.\\pipe\\herdr-core" };
	for (const env of [core, pipe]) {
		// Explicit Core, and auto in a Core terminal: auto never falls back to
		// legacy when Core context is present, so it fails the same way.
		for (const backend of ["core", "auto"] as const)
			assert.throws(() => selectHerdrBinding(backend, env, "win32"), {
				message: HERDR_CORE_UNSUPPORTED_ON_WINDOWS,
			});
	}
	assert.throws(() => selectHerdrBinding("core", {}, "win32"), coreRefusal);
	assert.deepEqual(selectHerdrBinding("legacy", core, "win32"), {
		backend: "legacy",
	});
	assert.deepEqual(
		selectHerdrBinding(
			"auto",
			{ HC_SOCKET: "/socket", HERDR_ENV: "1" },
			"win32",
		),
		{ backend: "legacy" },
	);
	for (const platform of ["linux", "darwin"] as const) {
		assert.deepEqual(selectHerdrBinding("auto", core, platform), {
			backend: "core",
			socket: "/run/core.sock",
			parentTerminal: "t1",
		});
		// The socket check is not widened: a named pipe stays malformed.
		assert.throws(
			() => selectHerdrBinding("core", pipe, platform),
			/Restart Pi in a local Core terminal/,
		);
	}
});

/** The parameters these tests pass to the host's tools. */
interface ToolCallParams {
	name?: string;
	task?: string;
	model?: string;
	thinking?: string;
	fork?: boolean;
	worktree?: { branch: string };
	target?: string;
	preserve?: boolean;
}

/** Forward `method`, recording `label` first. */
function recorded<A extends unknown[], R>(
	calls: string[],
	label: string,
	method: (...args: A) => R,
): (...args: A) => R {
	return (...args) => {
		calls.push(label);
		return method(...args);
	};
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" });
}

async function withHost(
	platform: NodeJS.Platform,
	run: (f: Awaited<ReturnType<typeof loadHost>>) => Promise<void>,
): Promise<void> {
	const f = await loadHost(platform);
	try {
		await run(f);
	} finally {
		await f.shutdown();
	}
}

async function loadHost(platform: NodeJS.Platform) {
	const dir = mkdtempSync(join(tmpdir(), "windows-scope-"));
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "parent.jsonl");
	writeFileSync(
		sessionFile,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) +
			"\n",
	);
	const calls: string[] = [];
	const provider = new FakeSurfaceProvider();
	const supervision = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: provider
				.listSurfaces()
				.map((pane) => ({ paneId: pane.id, workspaceId: "fixture" })),
		}),
		(id) => provider.inspectSurface(id),
	);
	// Any managed-worktree step reaching these fakes is recorded, then stops.
	const reached = (name: string) => () => {
		calls.push(`worktree.${name}`);
		throw new Error(`fixture: worktree ${name} reached`);
	};
	const worktreeOperations: WorktreeOperations = {
		resolveGitCommit: async () => reached("resolveGitCommit")(),
		resolveWorktreeProvisionCwd: async () =>
			reached("resolveWorktreeProvisionCwd")(),
		writeWorktreeManifest: reached("writeWorktreeManifest"),
		captureWorktreeHandoff: async () => reached("captureWorktreeHandoff")(),
		persistWorktreeResult: reached("persistWorktreeResult"),
	};
	const operations = launchOperationsFromSurface(
		provider,
		{ mode: "tab", direction: "right", maxPerTab: 4 },
		worktreeOperations,
	);
	operations.waitForShellReady = async () => {};
	operations.runScript = (_id, _command, options) => options.scriptPath;
	// Record every Herdr and launch step that creates, types into, lists or
	// focuses a resource.
	provider.createSurface = recorded(
		calls,
		"herdr.createSurface",
		provider.createSurface.bind(provider),
	);
	provider.createWorktreeSurface = recorded(
		calls,
		"herdr.createWorktreeSurface",
		provider.createWorktreeSurface.bind(provider),
	);
	provider.removeWorktreeSurface = recorded(
		calls,
		"herdr.removeWorktreeSurface",
		provider.removeWorktreeSurface.bind(provider),
	);
	provider.listWorktreeSurfaces = recorded(
		calls,
		"herdr.listWorktreeSurfaces",
		provider.listWorktreeSurfaces.bind(provider),
	);
	provider.focusWorkspace = recorded(
		calls,
		"herdr.focusWorkspace",
		provider.focusWorkspace.bind(provider),
	);
	provider.runScript = recorded(
		calls,
		"herdr.runScript",
		provider.runScript.bind(provider),
	);
	operations.createPane = recorded(
		calls,
		"launch.createPane",
		operations.createPane,
	);
	operations.createWorktree = recorded(
		calls,
		"launch.createWorktree",
		operations.createWorktree,
	);
	operations.runScript = recorded(
		calls,
		"launch.runScript",
		operations.runScript,
	);
	const notices: { message: string; level: string }[] = [];
	const model = { provider: "test", id: "one", reasoning: true };
	const ctx = {
		cwd: dir,
		model,
		modelRegistry: {
			find: () => model,
			getAvailable: () => [model],
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => "parent",
			getSessionDir: () => sessionDir,
			getLeafId: () => "leaf",
		},
		ui: {
			notify(message: string, level: string) {
				notices.push({ message, level });
			},
			setWidget() {},
		},
		waitForIdle: async () => {},
	};
	const mock = createMockExtensionApi();
	mock.api.getThinkingLevel = () => "high";
	extension(mock.api, {
		platform,
		infrastructure: {
			surfaceProvider: provider,
			launchOperations: operations,
			worktreeOperations,
			supervision,
		},
		cleanupOperations: () => {
			calls.push("cleanup.operations");
			throw new Error("fixture: cleanup operations reached");
		},
	});
	await mock.eventHandlers.get("session_start")![0]({}, ctx);
	const runtime = readGlobalSlot<SubagentRuntime>(RUNTIME_KEY)!;
	const tool = (name: string) =>
		mock.registeredTools.find((entry) => entry.name === name)!;
	const execute = (name: string, params: ToolCallParams) =>
		tool(name).execute(
			name,
			params,
			new AbortController().signal,
			() => {},
			ctx,
		);
	const command = mock.registeredCommands.find(
		(entry) => entry.name === "worktree",
	)!;
	return {
		dir,
		calls,
		notices,
		provider,
		runtime,
		ctx,
		execute,
		spawn: (name: string, extra: ToolCallParams = {}) =>
			execute("subagent", {
				name,
				task: "work",
				model: "test/one",
				thinking: "high",
				fork: false,
				...extra,
			}),
		worktreeCommand: (args: string) => command.handler(args, ctx),
		async shutdown() {
			await mock.eventHandlers.get("session_shutdown")![0](
				{ reason: "quit" },
				ctx,
			);
			supervision.close();
			await new Promise<void>((resolve) => setImmediate(resolve));
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("win32: subagent with worktree is refused before any manifest, Herdr or Git effect", async () => {
	await withHost("win32", async (f) => {
		await assert.rejects(
			f.spawn("isolated", { worktree: { branch: "win-scope" } }),
			worktreeRefusal,
		);
		assert.deepEqual(f.calls, []);
		assert.equal(f.provider.listSurfaces().length, 0);
		assert.equal(f.runtime.runningSubagents.size, 0);
		assert.deepEqual(
			filesUnder(f.dir).filter((path) => path.includes("worktree-runs")),
			[],
		);
	});
});

test("win32: an ordinary subagent launch is not refused", async () => {
	await withHost("win32", async (f) => {
		const result = await f.spawn("ordinary");
		assert.equal(result.details.status, "started");
		assert.ok(f.calls.includes("launch.createPane"), f.calls.join(", "));
		assert.equal(f.provider.listSurfaces().length, 1);
		assert.ok(!f.calls.some((call) => call.startsWith("worktree.")));
	});
});

test("win32: worktree_list and worktree_remove refuse before cleanup operations exist", async () => {
	await withHost("win32", async (f) => {
		await assert.rejects(f.execute("worktree_list", {}), worktreeRefusal);
		await assert.rejects(
			f.execute("worktree_remove", { target: "win-scope", preserve: true }),
			worktreeRefusal,
		);
		assert.deepEqual(f.calls, []);
	});
});

test("win32: every /worktree form notifies the refusal and runs nothing", async () => {
	await withHost("win32", async (f) => {
		for (const args of [
			"list",
			"remove win-scope --preserve",
			"win-scope continue here",
			"",
		])
			await f.worktreeCommand(args);
		assert.deepEqual(
			f.notices,
			Array.from({ length: 4 }, () => ({
				message: MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
				level: "error",
			})),
		);
		assert.deepEqual(f.calls, []);
		assert.equal(f.provider.listSurfaces().length, 0);
	});
});

test("win32: the run session refuses worktree handoff and cleanup composition directly", async () => {
	await withHost("win32", async (f) => {
		const session = f.runtime.session!;
		assert.equal(
			session.managedWorktreeRefusal(),
			MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
		);
		// SAFETY: the refusal precedes every read of the handoff input.
		const input = { branch: "win-scope" } as PiWorktreeHandoffInput;
		await assert.rejects(session.handoffWorktree(input), worktreeRefusal);
		assert.throws(
			() =>
				session.createWorktreeCleanupOperations({
					manifestDir: join(f.dir, "worktree-runs"),
					liveHolders: () => [],
				}),
			worktreeRefusal,
		);
		assert.deepEqual(f.calls, []);
		assert.equal(f.provider.listSurfaces().length, 0);
	});
});

// Controls: on Linux and macOS the same calls reach the recorded fakes, so the
// empty call lists above are not vacuous.
for (const platform of ["linux", "darwin"] as const)
	test(`${platform}: the same worktree calls still reach Git and cleanup`, async () => {
		await withHost(platform, async (f) => {
			assert.equal(f.runtime.session!.managedWorktreeRefusal(), undefined);
			await assert.rejects(
				f.spawn("isolated", { worktree: { branch: "control" } }),
				/fixture: worktree resolveGitCommit reached/,
			);
			assert.ok(f.calls.includes("worktree.resolveGitCommit"));
			await assert.rejects(
				f.execute("worktree_list", {}),
				/fixture: cleanup operations reached/,
			);
			assert.ok(f.calls.includes("cleanup.operations"));
			assert.ok(
				!f.notices.some(
					(notice) =>
						notice.message === MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
				),
			);
		});
	});
