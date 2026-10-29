import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
	PiRunSession,
	CancelReport,
} from "../../maestro/runtime/index.ts";
import { markInterruptRequested } from "../../maestro/core/lifecycle.ts";
import type { RunningSubagent, SubagentRuntime } from "./state.ts";
import { ensureLifecycle, type Observation } from "./observation.ts";

interface SubagentInterruptDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: "interrupt_requested";
}

export const SUBAGENT_CANCEL_DESCRIPTION =
	"Cancel a running ordinary (non-persistent) Pi-backed subagent, including an interrupted one: " +
	"records terminal intent first, terminates its owned process, and delivers exactly one cancelled result. " +
	"No model fallback, retry, or recovery starts after a cancel. " +
	"An ordinary pane is closed; a managed-worktree child stops only its Pi process and keeps the workspace, checkout, commits, and manifest. " +
	"Returns confirmed, requested (launch still in flight), unconfirmed (the run stays live; call again to retry), or already-terminal. " +
	"Persistent specialists are rejected; use subagent_stop. Do not poll: the cancelled result arrives automatically.";

export interface SubagentCancelDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: CancelReport["status"];
	requestedAt?: number;
	repeated?: boolean;
}

function cancelStatusText(
	name: string,
	report: CancelReport,
	worktree: boolean,
): string {
	const noRetry = "No model fallback, retry, or recovery will start.";
	switch (report.status) {
		case "confirmed":
			return worktree
				? `Cancelled subagent "${name}": its Pi process exit is confirmed; the worktree workspace, checkout, commits, and manifest are retained. ${noRetry} One cancelled result will be delivered automatically.`
				: `Cancelled subagent "${name}": its pane was closed and Herdr confirmed it is gone. ${noRetry} One cancelled result will be delivered automatically.`;
		case "requested":
			return `Cancel recorded for subagent "${name}"; its in-flight launch is terminated as soon as it is acquired. ${noRetry} One cancelled result will be delivered after termination is confirmed.`;
		case "unconfirmed":
			return `Cancel recorded for subagent "${name}", but termination is unconfirmed: ${report.error ?? "unknown error"}. The run stays live and owned. ${noRetry} Call subagent_cancel again to retry termination.`;
		case "already-terminal":
			return `Subagent "${name}" already reached a terminal result; nothing was cancelled.`;
	}
}

interface ControlDeps {
	runtime: SubagentRuntime;
	updateWidget: () => void;
	observeRunningSubagent: Observation["observeRunningSubagent"];
}

/** Interrupt and cancel controls bound to one extension instance. */
export function createControls({
	runtime,
	updateWidget,
	observeRunningSubagent,
}: ControlDeps) {
	const runningSubagents = runtime.runningSubagents;

	function resolveInterruptTarget(params: {
		id?: string;
		name?: string;
	}): { running: RunningSubagent } | { error: string } {
		const requestedId = params.id?.trim();
		if (requestedId) {
			const running = runningSubagents.get(requestedId);
			return running
				? { running }
				: { error: `No running subagent with id "${requestedId}".` };
		}

		const requestedName = params.name?.trim();
		if (!requestedName) {
			return { error: "Provide a running subagent id or exact display name." };
		}

		const matches = Array.from(runningSubagents.values()).filter(
			(running) => running.name === requestedName,
		);
		if (matches.length === 1) return { running: matches[0] };
		if (matches.length === 0) {
			return { error: `No running subagent named "${requestedName}".` };
		}

		const candidates = matches
			.map((running) => `${running.name} [${running.id}]`)
			.join(", ");
		return {
			error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
		};
	}

	async function requestSubagentInterrupt(
		running: RunningSubagent,
		interruptPaneKey: (surface: string) => void | Promise<void> = () =>
			runtime.session!.interrupt(
				runtime.session!.getControlTaskId(running.id)!,
			),
	): Promise<{ ok: true } | { error: string }> {
		try {
			await interruptPaneKey(running.surface);
			return { ok: true };
		} catch (error: any) {
			return {
				error:
					`Failed to send Escape to subagent "${running.name}" via herdr: ` +
					`${error?.message ?? String(error)}`,
			};
		}
	}

	async function handleSubagentInterrupt(
		params: { id?: string; name?: string },
		interruptPaneKey?: (surface: string) => void | Promise<void>,
	): Promise<AgentToolResult<SubagentInterruptDetails>> {
		const resolved = resolveInterruptTarget(params);
		if ("error" in resolved) {
			return {
				content: [{ type: "text" as const, text: resolved.error }],
				details: { error: resolved.error },
			};
		}

		const running = resolved.running;
		const now = Date.now();
		observeRunningSubagent(running, now);

		const interruption = await requestSubagentInterrupt(
			running,
			interruptPaneKey,
		);
		if ("error" in interruption) {
			return {
				content: [{ type: "text" as const, text: interruption.error }],
				details: {
					error: interruption.error,
					id: running.id,
					name: running.name,
				},
			};
		}

		running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
		updateWidget();

		return {
			content: [
				{
					type: "text" as const,
					text: `Interrupt requested for subagent "${running.name}".`,
				},
			],
			details: {
				id: running.id,
				name: running.name,
				status: "interrupt_requested",
			},
		};
	}

	async function handleSubagentCancel(
		params: { id?: string; name?: string },
		session: Pick<
			PiRunSession,
			"cancel" | "getControlTaskId"
		> = runtime.session!,
	): Promise<AgentToolResult<SubagentCancelDetails>> {
		const fail = (error: string, extra: SubagentCancelDetails = {}) => ({
			content: [{ type: "text" as const, text: error }],
			details: { error, ...extra },
		});
		const resolved = resolveInterruptTarget(params);
		if ("error" in resolved) {
			// No live row: a retired run keeps only its consumed control ID, and a run
			// still in its initial launch has no row yet. Report the kernel's answer.
			const id = params.id?.trim();
			const report = id
				? await session.cancel(id).catch(() => undefined)
				: undefined;
			if (!id || !report) return fail(resolved.error);
			updateWidget();
			return {
				content: [
					{ type: "text" as const, text: cancelStatusText(id, report, false) },
				],
				details: { id, status: report.status },
			};
		}
		const running = resolved.running;
		const target = { id: running.id, name: running.name };
		if (running.persistent)
			return fail(
				`Subagent "${running.name}" is a persistent specialist; subagent_cancel does not stop it. Use subagent_stop({ id: "${running.id}" }) for the graceful v1 stop.`,
				target,
			);
		const control = session.getControlTaskId(running.id);
		if (!control)
			return fail(
				`Subagent "${running.name}" has no live owner in this session; nothing was cancelled.`,
				target,
			);
		let report: CancelReport;
		try {
			report = await session.cancel(control);
		} catch (error) {
			return fail(
				error instanceof Error ? error.message : String(error),
				target,
			);
		} finally {
			updateWidget();
		}
		const details: SubagentCancelDetails = { ...target, status: report.status };
		if (report.requestedAt !== undefined)
			details.requestedAt = report.requestedAt;
		if (report.error) details.error = report.error;
		if (report.repeated) details.repeated = true;
		return {
			content: [
				{
					type: "text" as const,
					text: cancelStatusText(running.name, report, !!running.worktree),
				},
			],
			details,
		};
	}

	return {
		resolveInterruptTarget,
		requestSubagentInterrupt,
		handleSubagentInterrupt,
		handleSubagentCancel,
	};
}
