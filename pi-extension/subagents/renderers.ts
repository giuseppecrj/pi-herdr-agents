import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	isFiniteNumber,
	isString,
} from "../../maestro/core/config/type-guards.ts";
import {
	encodeHostValue,
	formatElapsed,
	splitChildReport,
} from "./presentation.ts";

/**
 * The human view of a delivered result: host lines unprefixed, the child's
 * report fenced by a labelled rule with every child line prefixed, so child
 * text cannot pass for host evidence.
 */
function resultViewLines(
	rawContent: string,
	name: string,
	elapsed: string,
	exitCode: number,
): string[] {
	const shownName = encodeHostValue(name);
	const stripSession = (text: string) =>
		text.replace(/\n\nSession: .+\nResume: .+$/, "");
	const { before, report, after } = splitChildReport(rawContent);
	const head = stripSession(before)
		.replace(`Sub-agent "${shownName}" completed (${elapsed}).\n\n`, "")
		.replace(
			`Sub-agent "${shownName}" was cancelled by the parent after ${elapsed}. `,
			"",
		)
		.replace(`Sub-agent "${shownName}" failed (exit code ${exitCode}).\n\n`, "")
		.replace(
			new RegExp(
				`^Sub-agent "${shownName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error\\)\\.\\n\\n`,
			),
			"",
		);
	const lines: string[] = [];
	if (head.trim()) lines.push(...head.trimEnd().split("\n"));
	if (report) {
		lines.push(`┌ Child report from ${report.from} (${report.kind})`);
		for (const line of report.body.split("\n")) lines.push(`│ ${line}`);
		lines.push("└ end of child report");
	}
	const evidence = stripSession(after).replace(/^\n+/, "");
	if (evidence.trim()) lines.push(...evidence.trimEnd().split("\n"));
	return lines;
}

export function registerMessageRenderers(pi: ExtensionAPI): void {
	// ── subagent_result message renderer ──
	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_result"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const exitCode = details.exitCode ?? 0;
				const errorMessage = isString(details.errorMessage)
					? details.errorMessage
					: "";
				const failed = exitCode !== 0 || !!errorMessage;
				const elapsed =
					details.elapsed == null ? "?" : formatElapsed(details.elapsed);
				const bgFn = failed
					? (text: string) => theme.bg("toolErrorBg", text)
					: (text: string) => theme.bg("toolSuccessBg", text);
				const cancelled = details.error === "cancelled";
				const icon = cancelled
					? theme.fg("warning", "■")
					: failed
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const status = cancelled
					? "cancelled"
					: errorMessage
						? "failed (provider/agent error)"
						: failed
							? `failed (exit ${exitCode})`
							: "completed";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";

				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
				const rawContent = isString(details.resultContent)
					? details.resultContent
					: isString(message.content)
						? message.content
						: "";

				// Host lines, then the fenced child report, then host evidence; the
				// session reference is rendered from details below.
				const summaryLines = resultViewLines(
					rawContent,
					name,
					elapsed,
					exitCode,
				);

				// Build content for the box
				const contentLines = [header];

				if (options.expanded) {
					// Full view: complete summary + session info
					for (const line of summaryLines) {
						contentLines.push(line.slice(0, width - 6));
					}
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(
							theme.fg("dim", `Session: ${details.sessionFile}`),
						);
						contentLines.push(
							theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`),
						);
					}
				} else {
					// Collapsed: preview + expand hint
					for (const line of summaryLines.slice(0, 5)) {
						contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
					}
					if (summaryLines.length > 5) {
						contentLines.push(
							theme.fg("muted", `… ${summaryLines.length - 5} more lines`),
						);
					}
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				// Render via Box for background + padding, with blank line above for separation
				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_status message renderer ──
	pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_status"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		const lines = Array.isArray(details?.lines) ? details.lines : [];
		const overflow = isFiniteNumber(details?.overflow) ? details.overflow : 0;
		if (lines.length === 0 && overflow === 0) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const lineWidth = Math.max(0, width - 6);
				const contentLines = [
					`${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
					...lines.map((line: string) =>
						theme.fg("dim", truncateToWidth(line, lineWidth)),
					),
				];

				if (overflow > 0) {
					contentLines.push(theme.fg("muted", `+${overflow} more running.`));
				}
				if (!options.expanded) {
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				const box = new Box(1, 1, (text: string) =>
					theme.bg("customMessageBg", text),
				);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_ping message renderer ──
	pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_ping"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";
				const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

				const icon = theme.fg("accent", "?");
				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

				const contentLines = [header];

				if (options.expanded) {
					contentLines.push("");
					contentLines.push(details.message ?? "");
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(
							theme.fg("dim", `Session: ${details.sessionFile}`),
						);
					}
				} else {
					const preview = (details.message ?? "")
						.split("\n")[0]
						.slice(0, width - 10);
					contentLines.push(theme.fg("dim", preview));
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});
}
