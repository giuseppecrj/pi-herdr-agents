import type {
	CreateSurfaceOptions,
	CreateWorktreeSurfaceOptions,
	ReportOpenedPrimaryWorkspaceInput,
	SurfaceInfo,
	SurfaceProcessInfo,
	SurfaceProvider,
	WorktreeSurface,
	WorktreeSurfaceInfo,
} from "../../core/surface-provider.ts";
import type { OpenedPrimaryWorkspaceReport } from "../../core/opened-primary-workspace.ts";
import type { PaneInspection, SurfaceHandle } from "../../core/types.ts";
import type { PaneConfig } from "../../core/config/pane-config.ts";
import type { ScriptShellResolver } from "../../core/script-launch.ts";
import {
	closeHerdrSurface,
	createHerdrGroupedSurface,
	createHerdrSurface,
	createHerdrSurfaceSplit,
	createHerdrWorktree,
	focusHerdrWorkspace,
	reportOpenedPrimaryWorkspace as reportHerdrOpenedPrimaryWorkspace,
	listHerdrWorktrees,
	readHerdrScreenAsync,
	removeHerdrWorktree,
	renameHerdrTab,
	renameHerdrWorkspace,
	sendHerdrCommand,
	sendHerdrKeys,
} from "./herdr.ts";
import {
	getHerdrPaneProcessInfoAsync,
	inspectHerdrPane,
	listHerdrPanes,
	waitForHerdrPaneAbsence,
	waitForHerdrShellReady,
} from "./herdr-pane.ts";
import { isHerdrAvailable } from "./herdr-cli.ts";
import { runScriptInPane, terminalSetupHint } from "./terminal.ts";

export class HerdrSurfaceProvider implements SurfaceProvider {
	readonly name = "herdr";
	readonly #paneConfig: PaneConfig;

	readonly #resolveScriptShell: ScriptShellResolver | undefined;
	readonly #platform: NodeJS.Platform | undefined;

	constructor(options: {
		paneConfig: PaneConfig;
		/** Absolute bash path for launch scripts on Windows. */
		resolveScriptShell?: ScriptShellResolver;
		/** Defaults to the host platform; injected by tests. */
		platform?: NodeJS.Platform;
	}) {
		this.#paneConfig = options.paneConfig;
		this.#resolveScriptShell = options.resolveScriptShell;
		this.#platform = options.platform;
	}

	isAvailable(): boolean {
		return isHerdrAvailable();
	}

	createSurface(opts: CreateSurfaceOptions): Promise<string> {
		const placement = opts.placement ?? { kind: "grouped" };
		if (placement.kind === "grouped") {
			return createHerdrGroupedSurface(
				opts.name,
				opts.cwd,
				this.#paneConfig.maxPerTab,
				this.#paneConfig.direction,
				opts,
			);
		}
		if (placement.kind === "split") {
			return createHerdrSurfaceSplit(
				opts.name,
				placement.direction,
				opts.cwd,
				opts,
			);
		}
		return createHerdrSurface(opts.name, opts.cwd, opts);
	}

	runCommand(surfaceId: string, command: string): Promise<void> {
		return sendHerdrCommand(surfaceId, command);
	}

	runScript(
		surfaceId: string,
		command: string,
		options: { scriptPath: string; scriptPreamble: string },
	): Promise<string> {
		return runScriptInPane(surfaceId, command, {
			...options,
			resolveShell: this.#resolveScriptShell,
			platform: this.#platform,
		});
	}

	readScreen(surfaceId: string, lines?: number): Promise<string> {
		return readHerdrScreenAsync(surfaceId, lines);
	}

	closeSurface(surfaceId: string): Promise<void> {
		return closeHerdrSurface(surfaceId);
	}

	async listSurfaces(opts?: { timeoutMs?: number }): Promise<SurfaceInfo[]> {
		const panes = await listHerdrPanes(opts?.timeoutMs);
		if (panes === null) throw new Error("Unable to list Herdr panes");
		return panes.map((pane) => {
			const surface: SurfaceInfo = { id: pane.paneId };
			if (pane.name) surface.name = pane.name;
			if (pane.cwd) surface.cwd = pane.cwd;
			if (pane.tabId) surface.group = pane.tabId;
			surface.workspaceId = pane.workspaceId;
			return surface;
		});
	}

	attachSurface(id: string): SurfaceHandle {
		return {
			id,
			runCommand: (command) => this.runCommand(id, command),
			readScreen: (lines) => this.readScreen(id, lines),
			sendKeys: (keys) => this.sendKeys(id, keys),
			close: () => this.closeSurface(id),
		};
	}

	async createWorktreeSurface(
		opts: CreateWorktreeSurfaceOptions,
	): Promise<WorktreeSurface> {
		const worktree = await createHerdrWorktree(
			opts.name,
			opts.cwd,
			opts.branch,
			opts.base,
			undefined,
			opts,
		);
		const surface: WorktreeSurface = {
			path: worktree.path,
			branch: worktree.branch,
			workspaceId: worktree.workspaceId,
			surfaceId: worktree.paneId,
		};
		if (worktree.diagnostics) surface.diagnostics = worktree.diagnostics;
		return surface;
	}

	reportOpenedPrimaryWorkspace(
		input: ReportOpenedPrimaryWorkspaceInput,
	): Promise<OpenedPrimaryWorkspaceReport | undefined> {
		return reportHerdrOpenedPrimaryWorkspace(input.sourceRepo, input.claims);
	}

	removeWorktreeSurface(
		workspaceId: string,
		opts?: { timeoutMs?: number },
	): Promise<void> {
		return removeHerdrWorktree(workspaceId, opts?.timeoutMs);
	}

	setupHint(): string {
		return terminalSetupHint();
	}

	async inspectSurface(surfaceId: string): Promise<PaneInspection> {
		const result = await inspectHerdrPane(surfaceId);
		if (result.kind === "present") return { ...result, observedAt: Date.now() };
		return result;
	}

	sendKeys(surfaceId: string, keys: string): Promise<void> {
		return sendHerdrKeys(surfaceId, keys);
	}

	async getProcessInfo(
		surfaceId: string,
		opts?: { timeoutMs?: number },
	): Promise<SurfaceProcessInfo> {
		const info = await getHerdrPaneProcessInfoAsync(surfaceId, opts?.timeoutMs);
		return {
			shellPid: info.shellPid,
			foregroundProcessGroupId: info.foregroundProcessGroupId,
			pids: [...info.pids],
			foregroundProcesses: info.foregroundProcesses.map((process) => ({
				...process,
				argv: process.argv ? [...process.argv] : undefined,
			})),
		};
	}

	async waitForShellReady(
		surfaceId: string,
		opts?: { timeoutMs?: number },
	): Promise<void> {
		await waitForHerdrShellReady(surfaceId, opts);
	}

	async waitForSurfaceAbsence(
		surfaceId: string,
		opts?: { timeoutMs?: number },
	): Promise<void> {
		const absent = await waitForHerdrPaneAbsence(surfaceId, opts);
		if (!absent) {
			throw new Error(
				`Herdr pane absence unconfirmed after ${opts?.timeoutMs ?? 5_000}ms: ${surfaceId}`,
			);
		}
	}

	async listWorktreeSurfaces(opts?: {
		cwd?: string;
		timeoutMs?: number;
	}): Promise<WorktreeSurfaceInfo[]> {
		return (await listHerdrWorktrees(opts?.cwd, opts?.timeoutMs)).map(
			(worktree) => ({
				...worktree,
			}),
		);
	}

	focusWorkspace(workspaceId: string): Promise<void> {
		return focusHerdrWorkspace(workspaceId);
	}

	setTitle(target: "tab" | "workspace", title: string): Promise<void> {
		return target === "tab"
			? renameHerdrTab(title)
			: renameHerdrWorkspace(title);
	}
}
