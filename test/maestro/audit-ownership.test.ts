import "../clean-host-env.ts";
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
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { PiHarnessAdapter } from "@nubl/maestro/adapters/pi/pi-harness-adapter";
import { launchOperationsFromSurface } from "@nubl/maestro/adapters/pi/launch-operations";
import {
	createWorktreeOperations,
	readWorktreeManifest,
} from "@nubl/maestro/runtime/worktree-operations";
import type { SpawnOptions } from "@nubl/maestro/core/harness-adapter";
import { SupervisionCoordinator } from "@nubl/maestro/core/supervision";
import { FakeSurfaceProvider } from "@nubl/maestro/testing";
import { runScriptInPane } from "../../maestro/surfaces/herdr/terminal.ts";

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
	const kernel = { alive: true, identityCaptures: 0 };
	operations.captureProcessIdentity = async () => {
		kernel.identityCaptures++;
		return identity;
	};
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

describe("audited launch ownership", () => {
	it("a real script-write failure in a worktree dispatches nothing and fails plainly with its root retained", async () =>
		usingFixture(async (f) => {
			// A regular file where the script directory belongs: portable, even as root.
			const scripts = join(f.root, "artifacts", "parent", "subagent-scripts");
			mkdirSync(dirname(scripts), { recursive: true });
			writeFileSync(scripts, "obstruction\n");
			const scriptPaths: string[] = [];
			f.operations.runScript = (surface, command, options) => {
				scriptPaths.push(options.scriptPath);
				return runScriptInPane(surface, command, options);
			};
			await withoutHerdr(() =>
				assert.rejects(
					f.adapter.spawn({
						...f.options,
						behavior: { autoExit: true },
						worktreeRequest: { branch: "retained" },
					}),
					/^Error: Failed to launch subagent; worktree retained at .*(EEXIST|ENOTDIR)/,
				),
			);
			assert.equal(scriptPaths.length, 1);
			assert.equal(dirname(scriptPaths[0]), scripts);
			assert.equal(existsSync(scriptPaths[0]), false, "no script was written");
			assert.equal(
				f.kernel.identityCaptures,
				0,
				"no process exists to identify",
			);
			assert.equal(f.surface.listSurfaces().length, 1, "root retained");
			const manifests = join(f.root, "artifacts", "parent", "worktree-runs");
			const manifest = readWorktreeManifest(
				join(manifests, readdirSync(manifests)[0]),
			);
			assert.equal(manifest?.state, "failed");
			assert.equal(manifest?.acquisitionUncertain, undefined);
		}));
});
