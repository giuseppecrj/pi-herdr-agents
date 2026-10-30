import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SupervisionConfig } from "../../maestro/core/config/supervision-config.ts";
import { encodeHostValue } from "../../maestro/core/host-text.ts";
import {
	capStatusLines,
	formatElapsedDuration,
	formatStatusAggregate,
	normalizeStatusName,
	type StatusConfig,
} from "../../maestro/core/status.ts";
import {
	formatLifecycleTransitionLine,
	lifecycleTransition,
	projectLifecycle,
} from "../../maestro/core/lifecycle.ts";
import {
	WIDGET_INTERVAL_KEY,
	STATUS_INTERVAL_KEY,
	writeGlobalSlot,
	type RunningSubagent,
	type SubagentRuntime,
} from "./state.ts";
import {
	type Observation,
	formatNoProgressAdvisoryLine,
} from "./observation.ts";

// ── Widget management ──

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
	const seconds = Math.floor((endTime - startTime) / 1000);
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
export function borderLine(
	left: string,
	right: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}│${RST}`;

	// width = total visible chars for the whole line including │ and │
	const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
	const rightVis = visibleWidth(right);

	// If the status chunk alone is too wide, prefer preserving it in compact form
	// rather than overflowing the terminal.
	if (rightVis >= contentWidth) {
		const truncRight = truncateToWidth(right, contentWidth);
		const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
		return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
	}

	const maxLeft = Math.max(0, contentWidth - rightVis);
	const truncLeft = truncateToWidth(left, maxLeft);
	const leftVis = visibleWidth(truncLeft);
	const pad = Math.max(0, contentWidth - leftVis - rightVis);
	return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(
	title: string,
	info: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╭${RST}`;

	// ╭─ Title ───...─── info ─╮
	// overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
	const inner = Math.max(0, width - 2); // inside ╭ and ╮
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`
		.slice(0, inner)
		.padEnd(inner, "─");
	return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╰${RST}`;

	const inner = Math.max(0, width - 2);
	return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
	projection: ReturnType<typeof projectLifecycle>,
	now: number,
): string {
	const duration =
		projection.stateDurationSince == null
			? ""
			: ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
	if (projection.kind === "active")
		return projection.label
			? ` active · ${encodeHostValue(projection.label)}${duration} `
			: ` active${duration} `;
	if (projection.kind === "blocked") return ` blocked${duration} `;
	if (projection.kind === "running") return " running… ";
	if (projection.kind === "waiting") return ` waiting${duration} `;
	if (projection.kind === "interrupted") return ` interrupted${duration} `;
	if (projection.kind === "stalled") return ` stalled${duration} `;
	// completed/failed exist as lifecycle projections for delivery bookkeeping,
	// but the row is removed immediately after result delivery — so the only
	// visible terminal handoff label is finalizing.
	if (
		projection.kind === "finalizing" ||
		projection.kind === "completed" ||
		projection.kind === "failed"
	) {
		return " finalizing… ";
	}
	return " starting… ";
}

interface WidgetDeps {
	runtime: SubagentRuntime;
	statusConfig: StatusConfig;
	supervisionConfig: SupervisionConfig;
	observeRunningSubagent: Observation["observeRunningSubagent"];
	evaluateNoProgressAdvisory: Observation["evaluateNoProgressAdvisory"];
}

/** Widget and status refresh timers for one extension instance. */
export function createWidgetController({
	runtime,
	statusConfig,
	supervisionConfig,
	observeRunningSubagent,
	evaluateNoProgressAdvisory,
}: WidgetDeps) {
	const runningSubagents = runtime.runningSubagents;

	/** Interval timer for widget re-renders. */
	let widgetInterval: ReturnType<typeof setInterval> | null = null;

	/** Interval timer for status transition checks. */
	let statusInterval: ReturnType<typeof setInterval> | null = null;

	function renderSubagentWidgetLines(
		agents: RunningSubagent[],
		width: number,
	): string[] {
		const now = Date.now();
		const rendered = agents.map((agent) => ({
			agent,
			projection: projectLifecycle(agent.lifecycle, now),
		}));
		const activeCount = rendered.filter(
			({ projection }) =>
				projection.kind === "active" ||
				projection.kind === "starting" ||
				projection.kind === "running" ||
				projection.kind === "blocked",
		).length;
		const openCount = agents.length - activeCount;
		const info =
			activeCount > 0
				? openCount > 0
					? `${activeCount} active · ${openCount} open`
					: `${activeCount} active`
				: `${openCount} open`;
		const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

		const lines: string[] = [borderTop("Subagents", info, width, accent)];

		for (const { agent, projection } of rendered) {
			const elapsed = formatElapsedMMSS(
				agent.startTime,
				projection.runtimeEndedAt ?? now,
			);
			const agentTag = agent.agent ? ` (${encodeHostValue(agent.agent)})` : "";
			const left = ` ${elapsed}  ${encodeHostValue(agent.name)}${agentTag} `;
			const runtimeTag = agent.runtimePlan
				? `${encodeHostValue(agent.runtimePlan.modelId)}|${agent.runtimePlan.thinking} · `
				: "";
			const label =
				agent.cancelState === "unconfirmed"
					? "cancel unconfirmed"
					: agent.cancelState
						? "cancelling…"
						: undefined;
			const right = label
				? ` ${runtimeTag}${label} `
				: statusConfig.enabled
					? ` ${runtimeTag}${formatLifecycleWidgetLabel(projection, now).trim()} `
					: ` ${runtimeTag}starting… `;

			lines.push(borderLine(left, right, width, accent));
		}

		lines.push(borderBottom(width, accent));
		return lines;
	}

	function updateWidget() {
		const latestCtx = runtime.latestCtx;
		if (!latestCtx?.hasUI) return;

		if (runningSubagents.size === 0) {
			latestCtx.ui.setWidget("subagent-status", undefined);
			if (widgetInterval) {
				clearInterval(widgetInterval);
				widgetInterval = null;
				writeGlobalSlot<ReturnType<typeof setInterval> | null>(
					WIDGET_INTERVAL_KEY,
					null,
				);
			}
			return;
		}

		latestCtx.ui.setWidget(
			"subagent-status",
			(_tui: any, _theme: any) => {
				return {
					invalidate() {},
					render(width: number) {
						return renderSubagentWidgetLines(
							Array.from(runningSubagents.values()),
							width,
						);
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	}

	function startStatusRefresh(pi: ExtensionAPI) {
		if (!statusConfig.enabled || statusInterval) return;

		statusInterval = setInterval(() => {
			if (runningSubagents.size === 0) {
				if (statusInterval) {
					clearInterval(statusInterval);
					statusInterval = null;
					writeGlobalSlot<ReturnType<typeof setInterval> | null>(
						STATUS_INTERVAL_KEY,
						null,
					);
				}
				return;
			}

			const transitionLines: string[] = [];
			const now = Date.now();
			let shouldRefreshWidget = false;

			for (const running of runningSubagents.values()) {
				// Dual-writes lifecycle + statusState for reload hydration; steers use lifecycle only.
				observeRunningSubagent(running, now);
				const projection = projectLifecycle(running.lifecycle, now);
				const transition = lifecycleTransition(
					running.lastProjectedKind,
					projection.kind,
				);
				if (running.lastProjectedKind !== projection.kind) {
					shouldRefreshWidget = true;
				}
				running.lastProjectedKind = projection.kind;

				// Interactive subagents (long-running, user-driven) intentionally don't
				// wake the parent session on stalled/recovered transitions — the user is
				// working in the subagent's pane, and a steer message here would burn an
				// orchestrator turn on a no-op "still waiting" ping. Widget still updates.
				if (transition && !running.interactive) {
					transitionLines.push(
						formatLifecycleTransitionLine(
							normalizeStatusName(running.name),
							projection,
							transition,
							now,
							running.startTime,
							formatElapsedDuration,
						),
					);
				}

				const noProgress = evaluateNoProgressAdvisory(
					running,
					projection,
					now,
					supervisionConfig.hangWarningMinutes,
				);
				if (noProgress?.notify) {
					transitionLines.push(
						formatNoProgressAdvisoryLine(running, noProgress),
					);
				}
			}

			if (shouldRefreshWidget) updateWidget();

			if (transitionLines.length > 0) {
				const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
				pi.sendMessage(
					{
						customType: "subagent_status",
						content: formatStatusAggregate(
							transitionLines,
							statusConfig.lineLimit,
						),
						display: true,
						details: { lines: capped.visibleLines, overflow: capped.overflow },
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			}
		}, 1000);

		writeGlobalSlot(STATUS_INTERVAL_KEY, statusInterval);
	}

	function startWidgetRefresh() {
		if (widgetInterval) return;
		updateWidget(); // immediate first render
		widgetInterval = setInterval(() => {
			updateWidget();
		}, 1000);
		writeGlobalSlot(WIDGET_INTERVAL_KEY, widgetInterval);
	}

	function stopRefresh() {
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				WIDGET_INTERVAL_KEY,
				null,
			);
		}
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				STATUS_INTERVAL_KEY,
				null,
			);
		}
	}

	return {
		renderSubagentWidgetLines,
		updateWidget,
		startStatusRefresh,
		startWidgetRefresh,
		stopRefresh,
	};
}
