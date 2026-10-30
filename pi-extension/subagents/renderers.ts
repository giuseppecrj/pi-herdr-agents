import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	isFiniteNumber,
	isString,
} from "../../maestro/core/config/type-guards.ts";
import { displayLines, encodeHostValue } from "../../maestro/core/host-text.ts";
import {
	formatElapsed,
	resumeCommandLine,
	splitChildReport,
} from "./presentation.ts";

/**
 * The human view of a delivered message: host lines unprefixed, the child's
 * report fenced by labelled rules with every child line prefixed. Child text
 * is split on every line separator and its terminal controls are shown as
 * escapes before the prefix, so no child line can pass for host evidence.
 * With `sessionFromDetails`, session lines are dropped because the renderer
 * shows them from details.
 */
function deliveredViewLines(
	rawContent: string,
	headPrefixes: RegExp[],
	sessionFromDetails: boolean,
): string[] {
	const { before, report, after } = splitChildReport(rawContent);
	let head = before;
	for (const prefix of headPrefixes) {
		const match = prefix.exec(head);
		if (match) {
			head = head.slice(match[0].length);
			break;
		}
	}
	const hostLines = (text: string) =>
		displayLines(text.trim()).filter(
			(line) =>
				!sessionFromDetails ||
				(!line.startsWith("Session: ") && !line.startsWith("Resume: ")),
		);
	const lines: string[] = [];
	if (head.trim()) lines.push(...hostLines(head));
	if (report) {
		lines.push(
			`┌ Child report from ${displayLines(report.from).join(" ")} (${report.kind})`,
		);
		for (const line of displayLines(report.body)) lines.push(`│ ${line}`);
		lines.push("└ end of child report");
	}
	const evidence = hostLines(after);
	if (evidence.length) lines.push(...evidence);
	while (lines.at(-1) === "") lines.pop();
	return lines;
}

function resultViewLines(
	rawContent: string,
	name: string,
	elapsed: string,
	exitCode: number,
	sessionFromDetails: boolean,
): string[] {
	const lead = `^Sub-agent "${escapeRegExp(encodeHostValue(name))}" `;
	const at = escapeRegExp(elapsed);
	return deliveredViewLines(
		rawContent,
		[
			new RegExp(`${lead}completed \\(${at}\\)\\.\\n\\n`),
			new RegExp(`${lead}was cancelled by the parent after ${at}\\. `),
			new RegExp(`${lead}failed \\(exit code ${exitCode}\\)\\.\\n\\n`),
			new RegExp(
				`${lead}failed after ${at} \\(provider/agent error\\)\\.\\n\\n`,
			),
		],
		sessionFromDetails,
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A host-owned detail shown in a header: always one display line. */
function displayValue(text: string): string {
	return displayLines(text).join(" ");
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
				const rawName = String(details.name ?? "subagent");
				const name = displayValue(rawName);
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
					? theme.fg("dim", ` (${displayValue(String(details.agent))})`)
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
					rawName,
					elapsed,
					exitCode,
					!!details.sessionFile,
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
							theme.fg(
								"dim",
								`Session: ${displayValue(String(details.sessionFile))}`,
							),
						);
						// The serialized command the model sees: shell-quoted, or omitted.
						contentLines.push(
							theme.fg("dim", resumeCommandLine(String(details.sessionFile))),
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
				const rawName = String(details.name ?? "subagent");
				const name = displayValue(rawName);
				const agentTag = details.agent
					? theme.fg("dim", ` (${displayValue(String(details.agent))})`)
					: "";
				const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

				const icon = theme.fg("accent", "?");
				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

				const contentLines = [header];

				// The bounded, enveloped content, never the raw sidecar message.
				const content = isString(message.content) ? message.content : "";
				const viewLines = deliveredViewLines(
					content,
					[
						new RegExp(
							`^Sub-agent "${escapeRegExp(encodeHostValue(rawName))}" needs help \\([^)\\n]*\\):\\n\\n`,
						),
					],
					!!details.sessionFile,
				);
				if (options.expanded) {
					contentLines.push("");
					for (const line of viewLines)
						contentLines.push(line.slice(0, Math.max(0, width - 6)));
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(
							theme.fg(
								"dim",
								`Session: ${displayValue(String(details.sessionFile))}`,
							),
						);
					}
				} else {
					for (const line of viewLines.slice(0, 5))
						contentLines.push(
							theme.fg("dim", line.slice(0, Math.max(0, width - 6))),
						);
					if (viewLines.length > 5)
						contentLines.push(
							theme.fg("muted", `… ${viewLines.length - 5} more lines`),
						);
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
