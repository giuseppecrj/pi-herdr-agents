import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	isViewportTUI,
	truncateToWidth,
	visibleWidth,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { SupervisionConfig } from "@nubl/maestro/core/config/supervision-config";
import { encodeHostValue } from "@nubl/maestro/core/host-text";
import {
	capStatusLines,
	formatElapsedDuration,
	formatStatusAggregate,
	normalizeStatusName,
	type StatusConfig,
} from "@nubl/maestro/core/status";
import {
	formatLifecycleTransitionLine,
	lifecycleTransition,
	projectLifecycle,
} from "@nubl/maestro/core/lifecycle";
import {
	WIDGET_INTERVAL_KEY,
	STATUS_INTERVAL_KEY,
	readGlobalSlot,
	writeGlobalSlot,
	type RunningSubagent,
	type SubagentRuntime,
} from "@nubl/maestro/pi/subagents/state";
import {
	type Observation,
	formatNoProgressAdvisoryLine,
} from "@nubl/maestro/pi/subagents/observation";

// ── Widget management ──

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
	const seconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const WIDGET_FRAME_WIDTH = 4; // two borders and one space on each side
const EDIT_SUFFIX_WIDTH = 2; // a space and a pencil
const NICKNAME_LIMIT = 64;
const NICKNAMES_KEY = Symbol.for("pi-herdr-agents/subagent-nicknames");
const RST = "\x1b[0m";

function hasWidgetFrame(width: number): boolean {
	return width > WIDGET_FRAME_WIDTH + 2;
}

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

type WidgetAppearance = {
	theme?: Pick<Theme, "fg" | "bg" | "bold">;
	clickable?: boolean;
	editable?: boolean;
	pressed?: RunningSubagent;
};

type LifecycleKind = ReturnType<typeof projectLifecycle>["kind"];

const STATE_MARKERS = {
	starting: { icon: "◌", color: "accent" },
	running: { icon: "●", color: "success" },
	active: { icon: "●", color: "success" },
	waiting: { icon: "○", color: "muted" },
	blocked: { icon: "!", color: "warning" },
	stalled: { icon: "?", color: "warning" },
	interrupted: { icon: "‖", color: "warning" },
	finalizing: { icon: "◐", color: "accent" },
	completed: { icon: "✓", color: "success" },
	failed: { icon: "×", color: "error" },
	cancelling: { icon: "−", color: "warning" },
	"cancel unconfirmed": { icon: "×", color: "error" },
} satisfies Record<
	LifecycleKind | "cancelling" | "cancel unconfirmed",
	{ icon: string; color: Parameters<Theme["fg"]>[0] }
>;

function isActiveKind(kind: LifecycleKind): boolean {
	return (
		kind === "active" ||
		kind === "starting" ||
		kind === "running" ||
		kind === "blocked"
	);
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
		return `${projection.label ? encodeHostValue(projection.label) : "active"}${duration}`;
	if (projection.kind === "running") return "running…";
	if (
		projection.kind === "blocked" ||
		projection.kind === "waiting" ||
		projection.kind === "interrupted" ||
		projection.kind === "stalled"
	) {
		return `${projection.kind}${duration}`;
	}
	if (projection.kind === "finalizing") return "finalizing…";
	if (projection.kind === "starting") return "starting…";
	return projection.kind;
}

type PaneAction =
	| { kind: "applied" | "pane-missing" }
	| { kind: "failed"; reason: string };

interface PaneActions {
	focus(paneId: string): Promise<PaneAction>;
	rename(paneId: string, label: string): Promise<PaneAction>;
}

interface WidgetDeps {
	runtime: SubagentRuntime;
	statusConfig: StatusConfig;
	supervisionConfig: SupervisionConfig;
	observeRunningSubagent: Observation["observeRunningSubagent"];
	evaluateNoProgressAdvisory: Observation["evaluateNoProgressAdvisory"];
	getPaneActions?: () => PaneActions | undefined;
}

/** Widget and status refresh timers for one extension instance. */
export function createWidgetController({
	runtime,
	statusConfig,
	supervisionConfig,
	observeRunningSubagent,
	evaluateNoProgressAdvisory,
	getPaneActions,
}: WidgetDeps) {
	const runningSubagents = runtime.runningSubagents;
	// Keep user labels across /reload, but release them with their live rows.
	const nicknames =
		readGlobalSlot<WeakMap<RunningSubagent, string>>(NICKNAMES_KEY) ??
		new WeakMap<RunningSubagent, string>();
	writeGlobalSlot(NICKNAMES_KEY, nicknames);
	let editingNickname = false;

	/** Interval timer for widget re-renders. */
	let widgetInterval: ReturnType<typeof setInterval> | null = null;

	/** Interval timer for status transition checks. */
	let statusInterval: ReturnType<typeof setInterval> | null = null;
	let widget: { ctx: ExtensionContext; tui?: TUI } | undefined;

	async function focusSubagent(ctx: ExtensionContext, agent: RunningSubagent) {
		const actions = getPaneActions?.();
		if (!actions || runtime.latestCtx !== ctx) return;
		if (runningSubagents.get(agent.id) !== agent) {
			ctx.ui.notify("This subagent is no longer in the list.", "warning");
			return;
		}
		const result = await actions.focus(agent.surface);
		if (runtime.latestCtx !== ctx) return;
		if (result.kind === "pane-missing") {
			ctx.ui.notify("That subagent pane is no longer open.", "warning");
		} else if (result.kind === "failed") {
			ctx.ui.notify(
				`Could not focus subagent pane: ${encodeHostValue(result.reason)}`,
				"warning",
			);
		}
	}

	async function editNickname(ctx: ExtensionContext, agent: RunningSubagent) {
		if (
			editingNickname ||
			runtime.latestCtx !== ctx ||
			runningSubagents.get(agent.id) !== agent
		)
			return;
		editingNickname = true;
		try {
			const current = nicknames.get(agent);
			const title = current
				? `Nickname for ${encodeHostValue(agent.name)} (now: ${encodeHostValue(current)})`
				: `Nickname for ${encodeHostValue(agent.name)}`;
			const input = await ctx.ui.input(`${title} — empty to reset`);
			if (input === undefined || runtime.latestCtx !== ctx) return;
			if (runningSubagents.get(agent.id) !== agent) {
				ctx.ui.notify("This subagent is no longer in the list.", "warning");
				return;
			}
			const nickname = input.trim();
			if (
				[...nickname].length > NICKNAME_LIMIT ||
				/[\p{Cc}\u2028\u2029\p{Bidi_Control}]/u.test(nickname)
			) {
				ctx.ui.notify(
					`Use a single-line nickname of at most ${NICKNAME_LIMIT} characters.`,
					"warning",
				);
				return;
			}
			if (nickname === (current ?? "")) return;
			if (nickname) nicknames.set(agent, nickname);
			else nicknames.delete(agent);
			updateWidget();
			const result = await getPaneActions?.()?.rename(
				agent.surface,
				nickname || encodeHostValue(agent.name),
			);
			if (result?.kind === "failed" && runtime.latestCtx === ctx) {
				ctx.ui.notify(
					`Nickname saved in Pi; could not update the Herdr pane title: ${encodeHostValue(result.reason)}`,
					"warning",
				);
			}
		} finally {
			editingNickname = false;
		}
	}

	function displayName(agent: RunningSubagent): string {
		const name = encodeHostValue(agent.name);
		const nickname = nicknames.get(agent);
		return nickname && nickname !== agent.name
			? `${name} · ${encodeHostValue(nickname)}`
			: name;
	}

	function renderSubagentWidget(
		agents: RunningSubagent[],
		width: number,
		{ theme, clickable, editable, pressed }: WidgetAppearance = {},
	) {
		const now = Date.now();
		const rendered = agents.map((agent) => ({
			agent,
			projection: projectLifecycle(agent.lifecycle, now),
		}));
		const activeCount = rendered.filter(({ projection }) =>
			isActiveKind(projection.kind),
		).length;
		const openCount = agents.length - activeCount;
		const info =
			activeCount > 0
				? openCount > 0
					? `${activeCount} active · ${openCount} open`
					: `${activeCount} active`
				: `${openCount} open`;
		const framed = hasWidgetFrame(width);
		const innerBudget = Math.max(0, width - (framed ? WIDGET_FRAME_WIDTH : 0));
		const available = innerBudget - (editable ? EDIT_SUFFIX_WIDTH : 0);
		const pencil = theme?.fg("accent", "✎") ?? "✎";
		const muted = (text: string) => theme?.fg("muted", text) ?? text;
		const dim = (text: string) => theme?.fg("dim", text) ?? text;
		const primary = (text: string) => theme?.fg("text", text) ?? text;
		const title = primary("Subagents");
		const heading = `${theme?.bold(title) ?? title}  ${muted(info)}`;
		const hints = [
			clickable && "click to focus",
			editable && "✎ nickname",
		].filter(Boolean);
		const hint = hints.length ? ` · ${hints.join(" · ")}` : "";
		const headerWidth = innerBudget - (framed ? 2 : 0);
		const showHint = visibleWidth(heading) + visibleWidth(hint) <= headerWidth;
		const header = truncateToWidth(
			heading + (showHint ? dim(hint) : ""),
			headerWidth,
			"…",
		);

		const fields = rendered.map(({ agent, projection }) => {
			const cancelLabel =
				agent.cancelState === "unconfirmed"
					? "cancel unconfirmed"
					: agent.cancelState
						? "cancelling"
						: undefined;
			const kind = statusConfig.enabled ? projection.kind : "starting";
			const { icon, color } = STATE_MARKERS[cancelLabel ?? kind];
			const selected = pressed === agent;
			const marker = selected
				? (theme?.fg("accent", "›") ?? "›")
				: (theme?.fg(color, icon) ?? icon);
			const name = displayName(agent);
			const label =
				cancelLabel === "cancelling"
					? "cancelling…"
					: (cancelLabel ??
						(statusConfig.enabled
							? formatLifecycleWidgetLabel(projection, now)
							: "starting…"));
			const state =
				color === "warning" || color === "error"
					? (theme?.fg(color, label) ?? label)
					: muted(label);
			const elapsed = formatElapsedMMSS(
				agent.startTime,
				projection.runtimeEndedAt ?? now,
			);
			const model = agent.runtimePlan
				? dim(
						`${encodeHostValue(agent.runtimePlan.modelId)}/${agent.runtimePlan.thinking}`,
					)
				: "";
			const role =
				agent.agent && agent.agent !== agent.name
					? dim(encodeHostValue(agent.agent))
					: "";
			return {
				cells: [`${marker} ${primary(name)}`, state, dim(elapsed), model, role],
				selected,
			};
		});
		const gap = "  ";
		const preferred = [0, 0, 0, 0, 0];
		for (const { cells } of fields) {
			for (const [i, cell] of cells.entries()) {
				preferred[i] = Math.max(preferred[i], visibleWidth(cell));
			}
		}
		// Reserve readable columns before letting a long value consume the row.
		// The elapsed time is either shown in full or omitted.
		const widths = [8, 10, preferred[2], 10, 6].map((min, i) =>
			Math.min(min, preferred[i]),
		);
		const columns = [0];
		if (available >= 7) {
			const budget = available - gap.length;
			widths[0] = Math.min(
				widths[0],
				Math.max(budget - widths[1], Math.floor(budget / 2)),
			);
			widths[1] = Math.min(widths[1], budget - widths[0]);
			columns.push(1);
			let remaining = budget - widths[0] - widths[1];
			for (let i = 2; i < widths.length; i++) {
				const cost = gap.length + widths[i];
				if (widths[i] === 0 || cost > remaining) continue;
				columns.push(i);
				remaining -= cost;
			}
			for (const i of [1, 3, 4, 0]) {
				if (!columns.includes(i)) continue;
				const extra = Math.min(remaining, preferred[i] - widths[i]);
				widths[i] += extra;
				remaining -= extra;
			}
		} else {
			widths[0] = Math.min(preferred[0], available);
		}
		const editColumns: (number | undefined)[] = [];
		const rows = fields.map(({ cells, selected }, rowIndex) => {
			const last = columns.findLastIndex((i) => cells[i] !== "");
			const row = columns
				.slice(0, last + 1)
				.map((i, position) => {
					const cell = truncateToWidth(cells[i], widths[i], "…");
					const cellWidth = visibleWidth(cell);
					let text = cell;
					if (i === 0 && editable) {
						editColumns[rowIndex] = (framed ? 2 : 0) + cellWidth + 1;
						text += ` ${pencil}`;
					}
					return position < last
						? text + " ".repeat(widths[i] - cellWidth)
						: text;
				})
				.join(gap);
			return { row, selected, width: visibleWidth(row) };
		});
		const highlight = (row: string, selected: boolean) =>
			selected ? (theme?.bg("selectedBg", row) ?? row) : row;
		if (!framed) {
			return {
				lines: [
					header,
					...rows.map(({ row, selected }) => highlight(row, selected)),
				],
				editColumns,
			};
		}

		const border = (text: string) => theme?.fg("borderMuted", text) ?? text;
		const titleWidth = visibleWidth(header);
		const side = border("│");
		return {
			lines: [
				`${border("╭─ ")}${header}${border(` ${"─".repeat(innerBudget - titleWidth - 1)}╮`)}`,
				...rows.map(({ row, selected, width: rowWidth }) => {
					const content = highlight(
						row + " ".repeat(innerBudget - rowWidth),
						selected,
					);
					return `${side} ${content} ${side}`;
				}),
				border(`╰${"─".repeat(innerBudget + 2)}╯`),
			],
			editColumns,
		};
	}

	function updateWidget() {
		const latestCtx = runtime.latestCtx;
		if (!latestCtx?.hasUI) return;

		if (runningSubagents.size === 0) {
			widget = undefined;
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

		if (widget?.ctx === latestCtx) {
			widget.tui?.requestRender();
			return;
		}
		const view: NonNullable<typeof widget> = { ctx: latestCtx };
		widget = view;
		latestCtx.ui.setWidget(
			"subagent-status",
			(tui, theme) => {
				view.tui = tui;
				let rendered: RunningSubagent[] = [];
				let hitStart = 0;
				let hitEnd = 0;
				let editColumns: (number | undefined)[] = [];
				let press:
					| { agent: RunningSubagent; action: "focus" | "edit"; held: boolean }
					| undefined;
				return {
					invalidate() {},
					render(width: number) {
						rendered = [...runningSubagents.values()];
						const viewport = isViewportTUI(tui);
						const editable = viewport && width >= 20;
						const widgetRender = renderSubagentWidget(rendered, width, {
							theme,
							clickable: viewport && Boolean(getPaneActions?.()),
							editable,
							pressed: press?.held ? press.agent : undefined,
						});
						hitStart = hasWidgetFrame(width) ? 1 : 0;
						hitEnd = visibleWidth(widgetRender.lines[0]) - hitStart;
						editColumns = widgetRender.editColumns;
						return widgetRender.lines;
					},
					handleMouse(event: TuiMouseEvent) {
						if (!isViewportTUI(tui)) return;
						const rowIndex = event.y - 1;
						const agent =
							event.x >= hitStart && event.x < hitEnd
								? rendered[rowIndex]
								: undefined;
						const action = event.x === editColumns[rowIndex] ? "edit" : "focus";
						if (
							press?.held &&
							(event.type === "drag" || event.type === "release")
						) {
							// Pi dispatches a click after release only for an unmoved pointer.
							press =
								event.type === "release" &&
								press.agent === agent &&
								press.action === action
									? { ...press, held: false }
									: undefined;
							return { handled: true, render: true };
						}
						if (
							event.button !== "left" ||
							event.shift ||
							event.alt ||
							event.ctrl
						)
							return;
						if (event.type === "press") {
							press =
								agent && (action === "edit" || getPaneActions?.())
									? { agent, action, held: true }
									: undefined;
							if (press) return { handled: true, render: true };
						} else if (event.type === "click") {
							const target = press;
							press = undefined;
							if (
								target &&
								!target.held &&
								target.agent === agent &&
								target.action === action &&
								view === widget
							) {
								if (action === "edit")
									void editNickname(latestCtx, target.agent);
								else void focusSubagent(latestCtx, target.agent);
								return { handled: true, render: false };
							}
						}
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
		widget = undefined;
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
		renderSubagentWidgetLines: (agents: RunningSubagent[], width: number) =>
			renderSubagentWidget(agents, width).lines,
		updateWidget,
		startStatusRefresh,
		startWidgetRefresh,
		stopRefresh,
	};
}
