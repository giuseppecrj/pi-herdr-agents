// THROWAWAY: share complete pane observations; invalid observations never imply absence.
import { now } from "./lab.mjs";
import { isString } from "../../type-guards.ts";
export class BatchInspector {
	constructor(list, periodMs = 4800) {
		this.list = list;
		this.periodMs = periodMs;
		this.epoch = now();
		this.cache = null;
		this.fetches = 0;
		this.fallbacks = 0;
		this.healthy = true;
		this.lastFailure = -Infinity;
	}
	invalidate() {
		this.cache = null;
	}
	untilNextSweep() {
		const elapsed = now() - this.epoch;
		return Math.max(
			0,
			(Math.floor(elapsed / this.periodMs) + 1) * this.periodMs - elapsed,
		);
	}
	async inspect(pane, fallback) {
		if (!this.healthy && now() - this.lastFailure < 5000) {
			this.fallbacks++;
			return fallback();
		}
		if (
			!this.cache ||
			(!this.cache.pending && now() - this.cache.finished > 100)
		) {
			const entry = { pending: true, finished: 0, promise: null };
			this.fetches++;
			entry.promise = Promise.resolve()
				.then(() => this.list())
				.then((response) => {
					if (
						response?.result?.type !== "pane_list" ||
						!Array.isArray(response.result.panes)
					)
						throw new Error("Not a complete pane-list observation");
					const panes = new Map();
					for (const item of response.result.panes) {
						if (
							!isString(item?.pane_id) ||
							!item.pane_id ||
							!isString(item.workspace_id) ||
							panes.has(item.pane_id)
						)
							throw new Error("Malformed pane-list observation");
						panes.set(item.pane_id, item);
					}
					if (this.cache === entry) this.healthy = true;
					return panes;
				})
				.finally(() => {
					entry.pending = false;
					entry.finished = now();
				});
			this.cache = entry;
		}
		const entry = this.cache;
		try {
			const item = (await entry.promise).get(pane);
			return item
				? {
						kind: "present",
						agentStatus: item.agent_status ?? "unknown",
						observedAt: Date.now(),
					}
				: { kind: "missing", error: "pane absent from complete list" };
		} catch {
			if (this.cache === entry) {
				this.healthy = false;
				this.lastFailure = now();
			}
			this.fallbacks++;
			return fallback();
		}
	}
}
