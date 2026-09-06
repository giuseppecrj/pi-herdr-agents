// THROWAWAY: compare notifications as wake-ups, never as outcome evidence.
import { createConnection } from "node:net";
import { watch, readFileSync } from "node:fs";
import { basename } from "node:path";
import { waitForCompletion as baseline } from "../../completion.ts";
import { waitForCompletion as experimental } from "./completion-prototype.ts";
import { now } from "./lab.mjs";
import { BatchInspector } from "./batch.mjs";

export class EventStream {
	constructor(path) {
		this.path = path;
		this.listeners = new Map();
		this.online = false;
		this.connects = 0;
		this.events = [];
		this.stopped = false;
		this.silence = false;
	}
	notify(pane) {
		for (const [id, callbacks] of this.listeners)
			if (!pane || pane === id) for (const fn of callbacks) fn();
	}
	listen(pane, fn) {
		const callbacks = this.listeners.get(pane) ?? new Set();
		callbacks.add(fn);
		this.listeners.set(pane, callbacks);
		return () => {
			callbacks.delete(fn);
			if (!callbacks.size) this.listeners.delete(pane);
		};
	}
	start() {
		if (this.socket && !this.socket.destroyed) return;
		this.stopped = false;
		const socket = createConnection(this.path);
		this.socket = socket;
		let buffer = "";
		const handshake = setTimeout(() => socket.destroy(), 1000);
		socket.once("connect", () =>
			socket.write(
				JSON.stringify({
					id: "prototype-events",
					method: "events.subscribe",
					params: {
						subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }],
					},
				}) + "\n",
			),
		);
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > 65536) return socket.destroy();
			let newline;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let value;
				try {
					value = JSON.parse(line);
				} catch {
					return socket.destroy();
				}
				if (value.result?.type === "subscription_started") {
					clearTimeout(handshake);
					this.online = true;
					this.connects++;
					this.notify();
				} else if (value.error) socket.destroy();
				else if (["pane_exited", "pane_closed"].includes(value.event)) {
					this.events.push({
						type: value.event,
						pane: value.data?.pane_id,
						at: now(),
					});
					if (!this.silence) this.notify(value.data?.pane_id);
				}
			}
		});
		socket.on("error", () => {});
		socket.once("close", () => {
			clearTimeout(handshake);
			this.online = false;
			this.notify();
			if (!this.stopped) this.retry = setTimeout(() => this.start(), 200);
		});
	}
	disconnect() {
		this.stopped = true;
		clearTimeout(this.retry);
		this.socket?.destroy();
	}
	close() {
		this.disconnect();
		this.listeners.clear();
	}
}

export function monitor(
	lab,
	child,
	variant,
	stream,
	{ reconcileMs = 5000 } = {},
) {
	lab.monitors ??= new Map();
	if (lab.monitors.has(child.id)) return lab.monitors.get(child.id);
	const batched = variant.endsWith("-batch");
	if (batched) {
		lab.batch ??= new BatchInspector(() => lab.cli(["pane", "list"]));
		lab.batch.invalidate(); // A newly registered pane must not use an older snapshot.
	}
	const controller = new AbortController();
	let watcher,
		unsubscribe,
		waiting,
		pending = false,
		fileHealthy = true,
		closed = false;
	let cycleStart = now();
	const state = {
		child,
		variant,
		periodMs: batched
			? lab.batch.periodMs
			: variant === "baseline"
				? 1000
				: reconcileMs,
		controller,
		deliveryCount: 0,
		fileSignals: 0,
		wakeups: 0,
		cycleTimes: [],
		dropFiles: false,
		result: null,
		completedAt: null,
		inspectCount: 0,
		probeDone: 0,
		readCount: 0,
	};
	const wake = () => {
		if (closed) return;
		if (batched) lab.batch.invalidate();
		state.wakeups++;
		pending = true;
		if (waiting) {
			const fn = waiting;
			waiting = undefined;
			pending = false;
			fn();
		}
	};
	const bind = () => {
		watcher?.close();
		unsubscribe?.();
		if (variant !== "baseline") {
			try {
				watcher = watch(child.dir, (_event, filename) => {
					if (String(filename) === basename(child.session) + ".exit") {
						state.fileSignals++;
						if (!state.dropFiles) wake();
					}
				});
				watcher.on("error", () => {
					fileHealthy = false;
					wake();
				});
			} catch {
				fileHealthy = false;
			}
			if (stream) unsubscribe = stream.listen(child.pane, wake);
		}
	};
	const cleanup = () => {
		closed = true;
		watcher?.close();
		unsubscribe?.();
		if (lab.monitors.get(child.id) === state) lab.monitors.delete(child.id);
	};
	state.rebind = () => {
		bind();
		stream?.start();
		wake();
	};
	state.signal = wake;
	bind();
	const options = {
		intervalMs: 1000,
		sessionFile: child.session,
		readTerminalTail: async () => {
			cycleStart = now();
			state.cycleTimes.push(cycleStart);
			state.readCount++;
			return await lab.cli([
				"pane",
				"read",
				child.pane,
				"--source",
				"recent",
				"--lines",
				"5",
			]);
		},
		inspectPane: async () => {
			state.inspectCount++;
			const getOne = async () => {
				try {
					const response = await lab.cli(["pane", "get", child.pane]);
					return {
						kind: "present",
						agentStatus: response.result.pane.agent_status ?? "unknown",
						observedAt: Date.now(),
					};
				} catch (error) {
					return {
						kind: ["pane_not_found", "not_found"].includes(error.code)
							? "missing"
							: "unavailable",
						error: String(error),
					};
				}
			};
			try {
				return batched
					? await lab.batch.inspect(child.pane, getOne)
					: await getOne();
			} finally {
				state.probeDone++;
			}
		},
		onTick: () => {
			try {
				JSON.parse(readFileSync(child.dir + "/activity.json", "utf8"));
			} catch {}
		},
	};
	if (variant !== "baseline")
		options.wait = (_milliseconds, signal) => {
			if (signal.aborted)
				return Promise.reject(
					new Error("Aborted while waiting for subagent to finish"),
				);
			if (pending) {
				pending = false;
				return Promise.resolve();
			}
			const healthy = fileHealthy && (!stream || stream.online);
			const remaining = healthy
				? batched
					? lab.batch.untilNextSweep()
					: Math.max(0, reconcileMs - (now() - cycleStart))
				: 1000; // Match the baseline's post-inspection delay when degraded.
			return new Promise((resolveWait, reject) => {
				const done = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					waiting = undefined;
					resolveWait();
				};
				const abort = () => {
					clearTimeout(timer);
					waiting = undefined;
					reject(new Error("Aborted while waiting for subagent to finish"));
				};
				const timer = setTimeout(done, remaining);
				waiting = done;
				signal.addEventListener("abort", abort, { once: true });
			});
		};
	state.promise = (variant === "baseline" ? baseline : experimental)(
		controller.signal,
		options,
	)
		.then((result) => {
			state.result = result;
			state.completedAt = Date.now();
			state.deliveryCount++;
			return result;
		})
		.catch((error) => {
			if (!controller.signal.aborted) throw error;
			return { reason: "aborted" };
		})
		.finally(cleanup);
	state.stop = async () => {
		controller.abort();
		await state.promise;
	};
	lab.monitors.set(child.id, state);
	return state;
}
