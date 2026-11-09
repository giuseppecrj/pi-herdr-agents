import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	NativeExecution,
	NativeExecutionInspection,
	SurfaceProvider,
} from "../../core/surface-provider.ts";
import {
	AcquisitionUncertainError,
	isAcquisitionUncertainError,
} from "../../core/surface-provider.ts";
import type { SurfaceHandle, PaneInspection } from "../../core/types.ts";
import {
	CoreRpcError,
	HerdrCoreClient,
	parseTerminal,
	parseTerminalList,
	parseReadResult,
	parseKeysResult,
	parseRemoveResult,
	type CoreTerminal,
} from "./herdr-core-protocol.ts";

function unsupported(): never {
	throw new Error(
		"Herdr Core does not support Desktop panes, Agents tabs, or managed worktrees in this milestone",
	);
}

/** Local Core terminal ownership. Never adopts a terminal by name or ancestry. */
export class HerdrCoreSurfaceProvider implements SurfaceProvider {
	readonly name = "herdr-core";
	readonly nativeExecution: NativeExecution;
	private readonly client: HerdrCoreClient;
	private readonly owned = new Map<string, CoreTerminal>();
	private readonly pending = new Map<
		string,
		{ cwd: string; scriptPath: string }
	>();
	private readonly binding: { socket: string; parentTerminal: string };
	constructor(
		binding: { socket: string; parentTerminal: string },
		options: { timeoutMs?: number } = {},
	) {
		this.binding = { ...binding };
		this.client = new HerdrCoreClient(binding.socket, options.timeoutMs);
		this.nativeExecution = {
			start: (input) => this.start(input),
			inspect: (id) => this.inspectExecution(id),
			terminate: (id) => this.terminate(id),
		};
	}
	isAvailable(): boolean {
		return true;
	}
	setupHint(): string {
		return "Run Pi in a local Herdr Core terminal. Core children start in the background; Desktop Agents tabs and managed worktrees are not yet supported.";
	}
	private async start(
		input: Parameters<NativeExecution["start"]>[0],
	): Promise<string> {
		input.signal?.throwIfAborted();
		const parent = await this.client.call(
			"terminal.get",
			{
				terminal: this.binding.parentTerminal,
			},
			parseTerminal,
		);
		if (
			parent.address !== this.binding.parentTerminal ||
			parent.state !== "live"
		)
			throw new Error("Herdr Core parent terminal is not live");
		mkdirSync(dirname(input.scriptPath), { recursive: true });
		// Core overlays env on its own environment. Clear inherited child/legacy
		// protocol variables in bash too, before explicit per-launch assignments.
		writeFileSync(
			input.scriptPath,
			[
				"#!/bin/bash",
				input.scriptPreamble,
				'for piha_key in ${!PI_SUBAGENT_@} ${!HERDR_@}; do unset "$piha_key"; done',
				"unset PI_DENY_TOOLS PI_HERDR_AGENTS_SESSION",
				input.command,
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (
				value !== undefined &&
				!key.startsWith("PI_SUBAGENT_") &&
				!key.startsWith("HERDR_") &&
				!key.startsWith("HC_") &&
				key !== "PI_DENY_TOOLS" &&
				key !== "PI_HERDR_AGENTS_SESSION"
			)
				env[key] = value;
		}
		env.PATH = process.env.PATH ?? "/usr/bin:/bin";
		input.signal?.throwIfAborted();
		let terminal: CoreTerminal;
		try {
			terminal = await this.client.call(
				"terminal.run",
				{
					argv: ["/bin/bash", input.scriptPath],
					cwd: input.cwd,
					env,
					parent: this.binding.parentTerminal,
					no_notify: true,
					outlive_parent: true,
					keep: false,
					rm: false,
					wait: false,
				},
				parseTerminal,
				true,
				input.signal,
			);
			// Parsed records can still fail launch verification. Keep those on the
			// same pending-ownership path as incomplete replies, not ownerless.
			if (
				terminal.parent !== this.binding.parentTerminal ||
				terminal.cwd !== input.cwd ||
				terminal.keep ||
				terminal.rm ||
				JSON.stringify(terminal.argv) !==
					JSON.stringify(["/bin/bash", input.scriptPath]) ||
				terminal.address === parent.address ||
				this.owned.has(terminal.address) ||
				this.pending.has(terminal.address)
			)
				throw new AcquisitionUncertainError(
					"Herdr Core returned an unverified execution; no retry or fallback",
					{ kind: "execution-start", observedSurfaceId: terminal.address },
				);
		} catch (error) {
			if (
				isAcquisitionUncertainError(error) &&
				error.uncertainty.kind === "execution-start"
			) {
				const id = error.uncertainty.observedSurfaceId;
				// An uncertain reply binds only a fresh exact ID, never a guessed
				// name. Future control must first verify the unique script and parent.
				if (
					id &&
					id !== parent.address &&
					!this.owned.has(id) &&
					!this.pending.has(id)
				) {
					this.pending.set(id, {
						cwd: input.cwd,
						scriptPath: input.scriptPath,
					});
					throw new AcquisitionUncertainError(
						error.message,
						{
							kind: "execution-start",
							observedSurfaceId: id,
							acquiredSurfaceId: id,
						},
						{ cause: error },
					);
				}
			}
			throw error;
		}
		// The verified native record is the acquisition result, not a shell.
		this.owned.set(terminal.address, terminal);
		return terminal.address;
	}
	private async getOwned(id: string): Promise<CoreTerminal | undefined> {
		const expected = this.owned.get(id);
		const pending = this.pending.get(id);
		if (!expected && !pending)
			throw new Error("Herdr Core terminal is not owned by this host");
		let terminal: CoreTerminal;
		try {
			terminal = await this.client.call(
				"terminal.get",
				{ terminal: id },
				parseTerminal,
			);
		} catch (error) {
			if (error instanceof CoreRpcError && error.kind === "not_found")
				return undefined;
			throw error;
		}
		if (
			terminal.address !== id ||
			terminal.parent !== this.binding.parentTerminal ||
			terminal.keep ||
			terminal.rm ||
			(expected &&
				(terminal.created_ms !== expected.created_ms ||
					terminal.cwd !== expected.cwd ||
					JSON.stringify(terminal.argv) !== JSON.stringify(expected.argv))) ||
			(pending &&
				(terminal.cwd !== pending.cwd ||
					JSON.stringify(terminal.argv) !==
						JSON.stringify(["/bin/bash", pending.scriptPath])))
		)
			throw new Error(
				"Herdr Core terminal ownership changed; refusing control",
			);
		if (pending) {
			this.owned.set(id, terminal);
			this.pending.delete(id);
		}
		return terminal;
	}
	private async inspectExecution(
		id: string,
	): Promise<NativeExecutionInspection> {
		try {
			const terminal = await this.getOwned(id);
			if (!terminal) return { kind: "missing" };
			return terminal.state === "live"
				? { kind: "live" }
				: { kind: "finished", exitCode: terminal.exit_code ?? undefined };
		} catch {
			return {
				kind: "unavailable",
				error: "Herdr Core execution inspection unavailable",
			};
		}
	}
	private async terminate(id: string): Promise<void> {
		const before = await this.getOwned(id);
		if (!before || before.state === "finished") return;
		try {
			await this.client.call("terminal.kill", { terminal: id }, parseTerminal);
		} catch {
			/* A reply or acknowledgement is not independent exit evidence. */
		}
		const after = await this.getOwned(id);
		if (after?.state === "live")
			throw new Error("Herdr Core terminal termination unconfirmed");
	}
	async closeSurface(id: string): Promise<void> {
		const terminal = await this.getOwned(id);
		if (terminal?.state === "live")
			throw new Error("Cannot remove a live Herdr Core execution");
		if (terminal) {
			const result = await this.client.call(
				"terminal.rm",
				{ terminal: id },
				parseRemoveResult,
			);
			if (result !== id) throw new Error("Malformed Herdr Core remove reply");
		}
		this.owned.delete(id);
		this.pending.delete(id);
	}
	async sendKeys(id: string, keys: string): Promise<void> {
		if (keys !== "Escape") unsupported();
		const terminal = await this.getOwned(id);
		if (!terminal || terminal.state !== "live")
			throw new Error("Herdr Core owned terminal is not live");
		await this.client.call(
			"terminal.keys",
			{
				terminal: id,
				keys: ["esc"],
			},
			parseKeysResult,
		);
	}
	async readScreen(id: string, lines = 40): Promise<string> {
		await this.getOwned(id);
		return this.client.call(
			"terminal.read",
			{
				terminal: id,
				lines,
			},
			parseReadResult,
		);
	}
	async inspectSurface(id: string): Promise<PaneInspection> {
		const execution = await this.inspectExecution(id);
		if (execution.kind === "missing" || execution.kind === "unavailable")
			return execution;
		return { kind: "present", agentStatus: "unknown", observedAt: Date.now() };
	}
	async listSurfaces() {
		const terminals = await this.client.call(
			"terminal.list",
			{ all: true },
			parseTerminalList,
		);
		return terminals
			.filter((terminal) => this.owned.has(terminal.address))
			.map((terminal) => ({ id: terminal.address, cwd: terminal.cwd }));
	}
	attachSurface(id: string): SurfaceHandle {
		return {
			id,
			runCommand: unsupported,
			readScreen: (lines) => this.readScreen(id, lines),
			sendKeys: (keys) => this.sendKeys(id, keys),
			close: () => this.closeSurface(id),
		};
	}
	async waitForSurfaceAbsence(id: string): Promise<void> {
		const execution = await this.inspectExecution(id);
		if (execution.kind !== "missing" && execution.kind !== "finished")
			throw new Error("Herdr Core exit unconfirmed");
	}
	createSurface = unsupported;
	runCommand = unsupported;
	createWorktreeSurface = unsupported;
	removeWorktreeSurface = unsupported;
	reportOpenedPrimaryWorkspace = unsupported;
	runScript = unsupported;
	getProcessInfo = unsupported;
	waitForShellReady = async (): Promise<never> => unsupported();
	listWorktreeSurfaces = async (): Promise<never> => unsupported();
	focusWorkspace = unsupported;
	setTitle = unsupported;
}
