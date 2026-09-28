import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { normalizeStatusName } from "./status.ts";
import {
	currentNativeObserverPane,
	inspectNativePane,
	inspectNativePanes,
	type NativeIdentity,
	type NativeInspection,
} from "./native-herdr.ts";

export interface TrackedNativeAgent extends NativeIdentity {
	name: string;
	trackedAt: number;
}
export interface NativeTrackingOperations {
	currentPane(): Promise<string>;
	inspect(paneId: string): Promise<NativeInspection>;
	snapshot(): Promise<Map<string, NativeInspection> | null>;
}

export function nativeWidgetStatus(row: TrackedNativeAgent): string {
	if (row.status === "working") return "active";
	if (row.status === "idle" || row.status === "done") return "waiting";
	return row.status;
}

function sameIdentity(a: NativeIdentity, b: NativeIdentity): boolean {
	return (
		a.paneId === b.paneId &&
		a.terminalId === b.terminalId &&
		a.agent === b.agent &&
		a.sessionId === b.sessionId
	);
}

/** Observation only: this registry never enters the Pi child lifecycle. */
export class NativeTracker {
	private timer?: ReturnType<typeof setInterval>;
	private refreshing = false;
	private epoch = 0;
	private requests = new Map<string, symbol>();
	readonly rows: Map<string, TrackedNativeAgent>;
	private readonly ownedPane: (paneId: string) => boolean;
	private readonly changed: () => void;
	private readonly operations: NativeTrackingOperations;
	constructor(
		rows: Map<string, TrackedNativeAgent>,
		ownedPane: (paneId: string) => boolean,
		changed: () => void,
		operations: NativeTrackingOperations = {
			currentPane: currentNativeObserverPane,
			inspect: inspectNativePane,
			snapshot: inspectNativePanes,
		},
	) {
		this.rows = rows;
		this.ownedPane = ownedPane;
		this.changed = changed;
		this.operations = operations;
	}

	async track(paneId: string, name?: string): Promise<TrackedNativeAgent> {
		// IDs are opaque; reject options/whitespace rather than interpreting names.
		if (!paneId || paneId.startsWith("-") || /\s/.test(paneId))
			throw new Error("Supply an exact Herdr pane ID.");
		const request = Symbol();
		this.requests.set(paneId, request);
		const epoch = this.epoch;
		try {
			const parent = await this.operations.currentPane();
			if (paneId === parent || paneId === process.env.HERDR_PANE_ID)
				throw new Error("Cannot track the parent pane.");
			if (this.ownedPane(paneId))
				throw new Error("Cannot track a Pi child pane.");
			const inspection = await this.operations.inspect(paneId);
			if (inspection.kind !== "present")
				throw new Error(
					`Cannot verify a native Claude Code/Codex session in ${paneId} (${inspection.kind}).`,
				);
			if (this.epoch !== epoch || this.requests.get(paneId) !== request)
				throw new Error("Native tracking request cancelled.");
			if (this.ownedPane(paneId))
				throw new Error("Cannot track a Pi child pane.");
			const previous = this.rows.get(paneId);
			const unchanged = previous && sameIdentity(previous, inspection.identity);
			const row: TrackedNativeAgent = {
				...inspection.identity,
				name: normalizeStatusName(
					name?.trim() || (unchanged ? previous.name : paneId),
				),
				trackedAt: unchanged ? previous.trackedAt : Date.now(),
			};
			this.rows.set(paneId, row);
			this.start();
			this.changed();
			return row;
		} finally {
			if (this.requests.get(paneId) === request) this.requests.delete(paneId);
		}
	}

	untrack(paneId: string): boolean {
		this.requests.delete(paneId);
		const removed = this.rows.delete(paneId);
		if (!this.rows.size) this.clearTimer();
		this.changed();
		return removed;
	}

	start(): void {
		if (this.timer || !this.rows.size) return;
		this.timer = setInterval(() => {
			void this.refresh();
		}, 4800);
		this.timer.unref();
	}

	async refresh(): Promise<void> {
		if (this.refreshing || !this.rows.size) return;
		this.refreshing = true;
		const epoch = this.epoch;
		try {
			const rows = [...this.rows.values()];
			let snapshot: Map<string, NativeInspection> | null;
			try {
				snapshot = await this.operations.snapshot();
			} catch {
				snapshot = null;
			}
			for (const row of rows) {
				// A late snapshot cannot resurrect a row or overwrite a newer track.
				if (epoch !== this.epoch || this.rows.get(row.paneId) !== row) continue;
				const inspection: NativeInspection = snapshot
					? (snapshot.get(row.paneId) ?? { kind: "missing" })
					: { kind: "unavailable" };
				if (
					this.ownedPane(row.paneId) ||
					inspection.kind === "missing" ||
					inspection.kind === "unsupported" ||
					(inspection.kind === "present" &&
						!sameIdentity(row, inspection.identity))
				) {
					this.rows.delete(row.paneId);
				} else {
					row.status =
						inspection.kind === "present"
							? inspection.identity.status
							: "unknown";
				}
			}
			if (epoch === this.epoch) {
				if (!this.rows.size) this.clearTimer();
				this.changed();
			}
		} finally {
			this.refreshing = false;
		}
	}

	private clearTimer(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	stop(preserve: boolean): void {
		this.epoch++;
		this.requests.clear();
		this.clearTimer();
		// Let the next session start request a fresh snapshot immediately. Any
		// older in-flight refresh is fenced by the incremented epoch above.
		this.refreshing = false;
		if (!preserve) this.rows.clear();
	}
}

export function registerNativeTrackingTool(
	pi: ExtensionAPI,
	tracker: NativeTracker,
): void {
	pi.registerTool({
		name: "subagents_native",
		label: "Track native Herdr agent",
		description:
			"Parent-only, observation-only widget tracking of an existing native Claude Code or Codex session by exact Herdr paneId. Checks Herdr-reported identity; never launches, prompts, interrupts, stops, resumes, closes, or claims ownership. No Pi result delivery or parent wake-ups. Untrack removes only the widget row.",
		promptGuidelines: [
			"Use subagents_native only for explicitly selected existing native Herdr agents. No adoption by name, cwd, workspace, or label. Manage native agents and obtain their results outside the Pi subagent lifecycle; do not poll for completion.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("track"), Type.Literal("untrack")]),
			paneId: Type.String({ minLength: 1 }),
			name: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 80,
					description: "Widget display name only; never an identity selector.",
				}),
			),
		}),
		async execute(
			_id,
			params,
		): Promise<
			AgentToolResult<
				| Pick<
						TrackedNativeAgent,
						"paneId" | "agent" | "name" | "status" | "trackedAt"
				  >
				| { paneId: string; removed: boolean }
			>
		> {
			if (params.action === "untrack") {
				const removed = tracker.untrack(params.paneId);
				return {
					content: [
						{
							type: "text",
							text: removed
								? `Untracked ${params.paneId}; native agent untouched.`
								: `${params.paneId} was not tracked.`,
						},
					],
					details: { paneId: params.paneId, removed },
				};
			}
			const row = await tracker.track(params.paneId, params.name);
			return {
				content: [
					{
						type: "text",
						text: `Observing ${row.name} [native ${row.agent}] in ${row.paneId}. Widget only; no Pi result delivery.`,
					},
				],
				details: {
					paneId: row.paneId,
					agent: row.agent,
					name: row.name,
					status: row.status,
					trackedAt: row.trackedAt,
				},
			};
		},
	});
}
