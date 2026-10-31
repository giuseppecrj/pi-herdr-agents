import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithBufferEncoding } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
	CreateSurfaceOptions,
	CreateWorktreeSurfaceOptions,
	SurfaceProvider,
	WorktreeSurface,
} from "../../maestro/core/surface-provider.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import { registerSurfaceProviderConformance } from "../maestro/surface-provider.conformance.ts";
import {
	cleanupTestEnv,
	createTestEnv,
	getAvailableBackends,
	type TestEnv,
} from "./harness.ts";

const GROUPING_CAP = 2;
const paneConfig = {
	mode: "grouped",
	direction: "right",
	maxPerTab: GROUPING_CAP,
} as const;

class TrackedSurfaceProvider implements SurfaceProvider {
	readonly name: string;
	readonly #inner: SurfaceProvider;
	readonly #env: TestEnv;
	readonly #workspaces = new Set<string>();

	constructor(inner: SurfaceProvider, env: TestEnv) {
		this.#inner = inner;
		this.#env = env;
		this.name = inner.name;
	}

	isAvailable = () => this.#inner.isAvailable();
	setupHint = () => this.#inner.setupHint();
	readScreen = (surfaceId: string, lines?: number) =>
		this.#inner.readScreen(surfaceId, lines);
	inspectSurface = (surfaceId: string) => this.#inner.inspectSurface(surfaceId);
	sendKeys = (surfaceId: string, keys: string) =>
		this.#inner.sendKeys(surfaceId, keys);
	getProcessInfo = (surfaceId: string) => this.#inner.getProcessInfo(surfaceId);
	listSurfaces = () => this.#inner.listSurfaces();
	listWorktreeSurfaces = (opts?: { cwd?: string; timeoutMs?: number }) =>
		this.#inner.listWorktreeSurfaces(opts);
	reportOpenedPrimaryWorkspace = (
		input: Parameters<SurfaceProvider["reportOpenedPrimaryWorkspace"]>[0],
	) => this.#inner.reportOpenedPrimaryWorkspace(input);
	focusWorkspace = (workspaceId: string) =>
		this.#inner.focusWorkspace(workspaceId);
	setTitle = (target: "tab" | "workspace", title: string) =>
		this.#inner.setTitle(target, title);

	async createSurface(opts: CreateSurfaceOptions): Promise<string> {
		const surfaceId = await this.#inner.createSurface(opts);
		this.#env.surfaces.push(surfaceId);
		return surfaceId;
	}

	runCommand(surfaceId: string, command: string): void | Promise<void> {
		return this.#inner.runCommand(surfaceId, command);
	}

	runScript(
		surfaceId: string,
		command: string,
		options: { scriptPath: string; scriptPreamble: string },
	): string | Promise<string> {
		return this.#inner.runScript(surfaceId, command, options);
	}

	closeSurface(surfaceId: string): void | Promise<void> {
		return this.#inner.closeSurface(surfaceId);
	}

	attachSurface(id: string) {
		return this.#inner.attachSurface(id);
	}

	async createWorktreeSurface(
		opts: CreateWorktreeSurfaceOptions,
	): Promise<WorktreeSurface> {
		const worktree = await this.#inner.createWorktreeSurface(opts);
		this.#workspaces.add(worktree.workspaceId);
		this.#env.surfaces.push(worktree.surfaceId);
		return worktree;
	}

	async removeWorktreeSurface(workspaceId: string): Promise<void> {
		await this.#inner.removeWorktreeSurface(workspaceId);
		this.#workspaces.delete(workspaceId);
	}

	async waitForShellReady(
		surfaceId: string,
		opts?: { timeoutMs?: number },
	): Promise<void> {
		await this.#inner.waitForShellReady(surfaceId, opts);
	}

	async waitForSurfaceAbsence(
		surfaceId: string,
		opts?: { timeoutMs?: number },
	): Promise<void> {
		await this.#inner.waitForSurfaceAbsence(surfaceId, opts);
	}

	async dispose(): Promise<void> {
		for (const workspaceId of this.#workspaces) {
			try {
				await this.#inner.removeWorktreeSurface(workspaceId);
			} catch {
				// Best effort; cleanupTestEnv closes the primary fixture workspace below.
			}
		}
	}
}

if (getAvailableBackends().length === 0) {
	describe("HerdrSurfaceProvider SurfaceProvider conformance", () => {
		it("requires Herdr", () => {
			assert.fail(
				"HERDR_ENV=1 and the herdr CLI are required for integration tests",
			);
		});
	});
} else {
	registerSurfaceProviderConformance(
		{ describe, it },
		"HerdrSurfaceProvider",
		async () => {
			const env = createTestEnv("herdr");
			try {
				initializeGitRepository(env.dir);
				const provider = new TrackedSurfaceProvider(
					new HerdrSurfaceProvider({ paneConfig }),
					env,
				);
				return {
					provider,
					cwd: env.dir,
					groupingCap: GROUPING_CAP,
					async dispose() {
						await provider.dispose();
						await cleanupTestEnv(env);
					},
				};
			} catch (error) {
				await cleanupTestEnv(env);
				throw error;
			}
		},
	);
}

function initializeGitRepository(cwd: string): void {
	runGit(cwd, ["init", "-b", "main"]);
	runGit(cwd, ["config", "user.email", "surface-test@example.invalid"]);
	runGit(cwd, ["config", "user.name", "Surface Test"]);
	writeFileSync(join(cwd, "README.md"), "surface conformance fixture\n");
	runGit(cwd, ["add", "README.md"]);
	runGit(cwd, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
}

function runGit(cwd: string, args: string[]): void {
	const options: ExecFileSyncOptionsWithBufferEncoding = {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	};
	try {
		execFileSync("git", args, options);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		// SAFETY: execFileSync throws an Error augmented with captured stdout/stderr
		// buffers when stdio pipes are configured; non-buffer values are ignored.
		const childError = error as Error & { stdout?: unknown; stderr?: unknown };
		const stdout = Buffer.isBuffer(childError.stdout)
			? childError.stdout
			: undefined;
		const stderr = Buffer.isBuffer(childError.stderr)
			? childError.stderr
			: undefined;
		throw new Error(
			[
				`git ${args.join(" ")} failed in ${cwd}`,
				error.message,
				stdout?.length ? `stdout:\n${stdout.toString("utf8")}` : undefined,
				stderr?.length ? `stderr:\n${stderr.toString("utf8")}` : undefined,
			]
				.filter(Boolean)
				.join("\n"),
			{ cause: error },
		);
	}
}
