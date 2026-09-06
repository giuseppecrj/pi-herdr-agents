// THROWAWAY integration adapter. Loaded only by a generated copy of the real extension.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { watch, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitForCompletion as baseline } from "../../completion.ts";
import { waitForCompletion as candidate } from "./completion-prototype.ts";
import { EventStream } from "./wake.mjs";
import { BatchInspector } from "./batch.mjs";
const exec = promisify(execFile);
const KEY = Symbol.for("issue29-prototype-parent-eba2bc97");
const shared = (globalThis[KEY] ??= {
	contexts: new Map(),
	cli: [],
	events: [],
	inFlight: 0,
	recording: false,
});
shared.seenReceipts ??= new Set();
const selectedMode = () => process.env.PI_ISSUE29_MODE ?? "baseline";

export function beginCli(command, args) {
	if (command !== "herdr") return () => {};
	shared.inFlight++;
	if (shared.recording)
		shared.cli.push({
			at: Date.now(),
			command: args?.slice(0, 2).join(" "),
			pane: args?.[2],
		});
	return () => {
		shared.inFlight--;
	};
}
function event(type, details = {}) {
	const value = {
		type,
		at: Date.now(),
		pid: process.pid,
		mode: selectedMode(),
		...details,
	};
	shared.events.push(value);
	const path = process.env.PI_ISSUE29_TRACE;
	if (path) appendFileSync(path, JSON.stringify(value) + "\n");
}
async function listPanes() {
	const end = beginCli("herdr", ["pane", "list"]);
	try {
		return JSON.parse(
			(await exec("herdr", ["pane", "list"], { timeout: 5000 })).stdout,
		);
	} finally {
		end();
	}
}
function context(mode) {
	const path = process.env.HERDR_SOCKET_PATH;
	const key = `${path}:${mode}`;
	let value = shared.contexts.get(key);
	if (!value) {
		const stream =
			mode === "events-batch" && path ? new EventStream(path) : undefined;
		value = {
			mode,
			batch: new BatchInspector(listPanes),
			stream,
			owners: new Map(),
		};
		shared.contexts.set(key, value);
		stream?.start();
	}
	return value;
}
export function snapshot() {
	return {
		at: Date.now(),
		pid: process.pid,
		mode: selectedMode(),
		cli: [...shared.cli],
		events: [...shared.events],
		inFlight: shared.inFlight,
		contexts: [...shared.contexts.values()].map((value) => ({
			mode: value.mode,
			owners: value.owners.size,
			connections: value.stream?.connects ?? 0,
			online: value.stream?.online ?? null,
			batchFetches: value.batch.fetches,
			batchFallbacks: value.batch.fallbacks,
			batchHealthy: value.batch.healthy,
		})),
	};
}

export async function waitForCompletion(signal, options) {
	const mode = selectedMode();
	if (
		!["files-batch", "events-batch"].includes(mode) ||
		process.platform !== "linux" ||
		!options.prototypePane ||
		!options.sessionFile
	) {
		event("watch-baseline", { run: options.prototypeRun });
		return baseline(signal, options);
	}
	const value = context(mode);
	const key = `${options.prototypeRun}:${options.prototypePane}`;
	if (value.owners.has(key))
		throw new Error("Duplicate prototype watcher owner");
	let pending = false,
		waiting,
		fileHealthy = true,
		closed = false,
		fsWatcher,
		unsubscribe;
	const wake = () => {
		if (closed) return;
		value.batch.invalidate();
		pending = true;
		if (waiting) {
			const fn = waiting;
			waiting = undefined;
			pending = false;
			fn();
		}
	};
	try {
		fsWatcher = watch(dirname(options.sessionFile), (_type, name) => {
			if (String(name) === basename(options.sessionFile) + ".exit") wake();
		});
		fsWatcher.on("error", () => {
			fileHealthy = false;
			wake();
		});
	} catch {
		fileHealthy = false;
	}
	value.batch.invalidate();
	unsubscribe = value.stream?.listen(options.prototypePane, wake);
	const dispose = () => {
		closed = true;
		fsWatcher?.close();
		unsubscribe?.();
		value.owners.delete(key);
	};
	value.owners.set(key, { dispose, wake });
	event("watch-candidate", {
		run: options.prototypeRun,
		pane: options.prototypePane,
	});
	const wait = (_ms, abortSignal) => {
		if (abortSignal.aborted || closed)
			return Promise.reject(
				new Error("Aborted while waiting for subagent to finish"),
			);
		if (pending) {
			pending = false;
			return Promise.resolve();
		}
		const healthy =
			fileHealthy &&
			value.batch.healthy &&
			(!value.stream || value.stream.online);
		const milliseconds = healthy ? value.batch.untilNextSweep() : 1000;
		return new Promise((resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				abortSignal.removeEventListener("abort", abort);
				waiting = undefined;
				resolve();
			};
			const abort = () => {
				clearTimeout(timer);
				waiting = undefined;
				reject(new Error("Aborted while waiting for subagent to finish"));
			};
			const timer = setTimeout(finish, milliseconds);
			waiting = finish;
			abortSignal.addEventListener("abort", abort, { once: true });
		});
	};
	try {
		return await candidate(signal, {
			...options,
			wait,
			inspectPane: () =>
				value.batch.inspect(options.prototypePane, options.inspectPane),
		});
	} finally {
		dispose();
		event("watch-released", { run: options.prototypeRun });
	}
}

export function instrumentApi(api) {
	return new Proxy(api, {
		get(target, name) {
			if (name === "sendMessage")
				return (message, options) => {
					if (
						message.customType === "subagent_result" ||
						message.customType === "herdr_workflow_result"
					)
						event("send-attempt", {
							customType: message.customType,
							name: message.details?.name,
							exitCode: message.details?.exitCode,
						});
					return target.sendMessage(message, options);
				};
			const item = target[name];
			// Preserve receiver binding for callable properties of this trusted SDK API.
			// oxlint-disable-next-line anti-slop/no-runtime-typeof
			return typeof item === "function" ? item.bind(target) : item;
		},
	});
}
export function installControl(pi) {
	pi.on("session_start", (eventValue, ctx) =>
		event("session-start", {
			reason: eventValue.reason,
			session: ctx.sessionManager.getSessionFile(),
			state: snapshot().contexts,
		}),
	);
	pi.on("before_provider_request", (eventValue, ctx) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type !== "custom_message" ||
				entry.customType !== "subagent_result" ||
				shared.seenReceipts.has(entry.id)
			)
				continue;
			try {
				const timing = JSON.parse(
					readFileSync(entry.details.sessionFile + ".timing.json", "utf8"),
				);
				shared.seenReceipts.add(entry.id);
				event("receipt-observed", {
					name: entry.details.name,
					receiptAt: Date.parse(entry.timestamp),
					evidenceAt: timing.evidenceAt,
					latencyMs: Date.parse(entry.timestamp) - timing.evidenceAt,
				});
			} catch {}
		}
		const text = JSON.stringify(eventValue.payload) ?? "";
		event("provider-request", {
			received: [...new Set(text.match(/PROTOTYPE_RESULT_[a-z0-9-]+/g) ?? [])],
		});
	});
	// Registered after the real shutdown handler: it marks delivery suppressed first.
	pi.on("session_shutdown", (eventValue) => {
		event("session-shutdown", {
			reason: eventValue.reason,
			state: snapshot().contexts,
		});
		if (eventValue.reason === "quit") {
			for (const value of shared.contexts.values()) {
				for (const owner of [...value.owners.values()]) owner.dispose();
				value.stream?.close();
			}
			shared.contexts.clear();
		}
	});
	pi.registerCommand("prototype-transport", {
		description: "Prototype-only channel fault injection",
		handler: (args) => {
			if (
				!["drop", "reconnect", "bad-list", "restore-list"].includes(args.trim())
			)
				throw new Error("Invalid prototype transport action");
			for (const value of shared.contexts.values()) {
				if (args.trim() === "drop") value.stream?.disconnect();
				if (args.trim() === "reconnect") value.stream?.start();
				if (args.trim() === "bad-list")
					value.batch.list = async () => ({ result: { type: "invalid" } });
				if (args.trim() === "restore-list") {
					value.batch.list = listPanes;
					value.batch.lastFailure = -Infinity;
				}
				value.batch.invalidate();
				for (const owner of value.owners.values()) owner.wake();
			}
			event("transport-control", { action: args.trim() });
		},
	});
	pi.registerCommand("prototype-sample", {
		description: "Prototype-only telemetry checkpoint",
		handler: async (args) => {
			const [phase, id] = args.trim().split(/\s+/);
			if (!["begin", "end", "peek"].includes(phase) || !/^[a-z0-9-]+$/.test(id))
				throw new Error("Invalid prototype sample request");
			const deadline = Date.now() + 5000;
			while (shared.inFlight && Date.now() < deadline) await delay(10);
			if (shared.inFlight) throw new Error("No quiet telemetry boundary");
			if (phase === "begin") {
				shared.cli = [];
				shared.events = [];
				shared.recording = true;
			}
			const data = snapshot();
			if (phase === "end") shared.recording = false;
			writeFileSync(
				`${process.env.PI_ISSUE29_TRACE}.${id}.json`,
				JSON.stringify({ phase, ...data }),
			);
		},
	});
}
