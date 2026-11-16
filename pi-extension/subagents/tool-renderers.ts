import { Text } from "@earendil-works/pi-tui";
import { isPlainObject, isString } from "@nubl/maestro/core/config/type-guards";
import {
	encodeHostValue,
	HOST_ERROR_CHARS,
} from "@nubl/maestro/core/host-text";
import { getFirstText } from "@nubl/maestro/pi/subagents/presentation";
import type { SubagentCancelDetails } from "@nubl/maestro/pi/subagents/controls";
import type { PiToolRenderers } from "@nubl/maestro/pi/subagents/presentation-hooks";

interface PartialWorktreeArgs {
	branch?: unknown;
}
interface PartialSubagentArgs {
	name?: unknown;
	task?: unknown;
	agent?: unknown;
	cwd?: unknown;
	worktree?: PartialWorktreeArgs | null;
}

export const toolRenderers: PiToolRenderers = {
	subagent: {
		renderCall(args: any, theme) {
			const partialArgs: PartialSubagentArgs = isPlainObject(args) ? args : {};
			const name =
				isString(partialArgs.name) && partialArgs.name
					? partialArgs.name
					: "(unnamed)";
			const task = isString(partialArgs.task) ? partialArgs.task : "";
			const agent =
				isString(partialArgs.agent) && partialArgs.agent
					? theme.fg("dim", ` (${partialArgs.agent})`)
					: "";
			const cwdHint =
				isString(partialArgs.cwd) && partialArgs.cwd
					? theme.fg("dim", ` in ${partialArgs.cwd}`)
					: "";
			const worktree = isPlainObject(partialArgs.worktree)
				? partialArgs.worktree
				: undefined;
			const worktreeHint = isString(worktree?.branch)
				? theme.fg("dim", ` on ${worktree.branch} (worktree)`)
				: "";
			let text =
				"▸ " +
				theme.fg("toolTitle", theme.bold(name)) +
				agent +
				cwdHint +
				worktreeHint;

			// Show a one-line task preview. renderCall is called repeatedly as the
			// LLM generates tool arguments, so args.task grows token by token.
			// We keep it compact here — Ctrl+O on renderResult expands the full content.
			if (task) {
				const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
				const preview =
					firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
				if (preview) {
					text += "\n" + theme.fg("toolOutput", preview);
				}
				const totalLines = task.split("\n").length;
				if (totalLines > 1) {
					text += theme.fg("muted", ` (${totalLines} lines)`);
				}
			}

			return new Text(text, 0, 0);
		},
		renderResult(result, _opts, theme) {
			// SAFETY: renderResult only ever receives the details this tool's own
			// execute() above returned; the framework's TDetails type isn't threaded
			// through this callback precisely enough for TypeScript to see that.
			const details = result.details as any;
			const name = details?.name ?? "(unnamed)";

			// "Started" result — tool returned immediately
			if (details?.status === "started") {
				const runtime = details?.model
					? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
					: " — started";
				const worktree = details?.worktree?.branch
					? ` · ${details.worktree.branch}`
					: "";
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(name)) +
						theme.fg("dim", runtime + worktree),
					0,
					0,
				);
			}

			// Fallback (shouldn't happen)
			return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
		},
	},
	subagent_resume: {
		renderCall(args: any, theme) {
			const name = args.name ?? "Resume";
			const text =
				"▸ " +
				theme.fg("toolTitle", theme.bold(name)) +
				theme.fg("dim", " — resuming session");
			return new Text(text, 0, 0);
		},
		renderResult(result, _opts, theme) {
			// SAFETY: renderResult only ever receives the details this tool's own
			// execute() above returned; the framework's TDetails type isn't threaded
			// through this callback precisely enough for TypeScript to see that.
			const details = result.details as any;
			const name = details?.name ?? "Resume";

			if (details?.status === "started") {
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(name)) +
						theme.fg("dim", " — resumed"),
					0,
					0,
				);
			}

			// Fallback
			return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
		},
	},
	subagent_interrupt: {
		renderCall(args: any, theme) {
			const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
			return new Text(
				theme.fg("accent", "▸") +
					" " +
					theme.fg("toolTitle", theme.bold(target)) +
					theme.fg("dim", " — interrupt turn"),
				0,
				0,
			);
		},
		renderResult(result, _opts, theme) {
			// SAFETY: renderResult only ever receives the details this tool's own
			// execute() above returned; the framework's TDetails type isn't threaded
			// through this callback precisely enough for TypeScript to see that.
			const details = result.details as any;
			if (details?.status === "interrupt_requested") {
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg(
							"toolTitle",
							theme.bold(details.name ?? details.id ?? "subagent"),
						) +
						theme.fg("dim", " — interrupt requested"),
					0,
					0,
				);
			}

			return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
		},
	},
	subagent_cancel: {
		renderCall(args: any, theme) {
			const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
			return new Text(
				theme.fg("accent", "▸") +
					" " +
					theme.fg("toolTitle", theme.bold(target)) +
					theme.fg("dim", " — cancel run"),
				0,
				0,
			);
		},
		renderResult(result, _opts, theme) {
			// SAFETY: renderResult only ever receives the details this tool's own
			// execute() above returned; the framework's TDetails type isn't threaded
			// through this callback precisely enough for TypeScript to see that.
			const details = result.details as SubagentCancelDetails | undefined;
			if (details?.status)
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg(
							"toolTitle",
							theme.bold(details.name ?? details.id ?? "subagent"),
						) +
						theme.fg("dim", ` — cancel ${details.status}`),
					0,
					0,
				);
			return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
		},
	},
	subagents_list: {
		renderResult(result, _opts, theme) {
			// SAFETY: renderResult only ever receives the details this tool's own
			// execute() above returned; the framework's TDetails type isn't threaded
			// through this callback precisely enough for TypeScript to see that.
			const details = result.details as any;
			const agents = details?.agents ?? [];
			const diagnostics = details?.diagnostics ?? [];
			if (agents.length === 0 && diagnostics.length === 0) {
				return new Text(
					theme.fg("dim", "No subagent definitions found."),
					0,
					0,
				);
			}
			const lines = agents.map((a: any) => {
				const source =
					a.source === "package" && a.provider
						? `package:${a.provider}`
						: a.source;
				// Definitions may be child-writable files: encode every value.
				const badge = theme.fg("accent", ` (${encodeHostValue(source)})`);
				const desc = a.description
					? theme.fg("dim", ` — ${encodeHostValue(a.description)}`)
					: "";
				const model = a.model
					? theme.fg("dim", ` [${encodeHostValue(a.model)}]`)
					: "";
				return `  ${theme.fg("toolTitle", theme.bold(encodeHostValue(a.name)))}${badge}${model}${desc}`;
			});
			for (const diagnostic of diagnostics) {
				lines.push(
					theme.fg(
						"warning",
						`  ! ${encodeHostValue(diagnostic.message, HOST_ERROR_CHARS)}`,
					),
				);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	},
};
