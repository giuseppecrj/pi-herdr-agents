// Pi Herdr Agents Sidebar: the Focus and All actions for Herdr's Agents view.
// Herdr may install only this directory, so the file uses Node built-ins only.
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PLUGIN_ID = "pi-herdr-agents.sidebar";
export const VIEW_SOURCE = `plugin:${PLUGIN_ID}`;
// Written by the pi-herdr-agents extension on a delegated child's pane. "live"
// means recently classified as delegated, not proven alive at render time.
export const MARKER_TOKEN = "piha_delegated_v1";
export const MARKER_VALUE = "live";
export const REQUEST_TIMEOUT_MS = 3_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REPORTED_CHARS = 200;

// Hide a row only when its marker is exactly "live" and its status is idle,
// working, or done. Blocked, unknown, missing, and other marker values stay.
export const FOCUS_FILTER = {
	op: "not",
	filter: {
		op: "all",
		filters: [
			{ op: "eq", field: { token: MARKER_TOKEN }, value: MARKER_VALUE },
			{ op: "in", field: "status", values: ["idle", "working", "done"] },
		],
	},
};

export const FOCUS_PARAMS = {
	source: VIEW_SOURCE,
	label: "focus",
	filter: FOCUS_FILTER,
};
export const ALL_PARAMS = { source: VIEW_SOURCE };

// Mirrors maestro/core/config/type-guards.ts, which this file cannot import.
function isString(value) {
	return Object.prototype.toString.call(value) === "[object String]";
}

function isRecord(value) {
	return (
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

function describe(value) {
	const text = isString(value) ? value : JSON.stringify(value);
	return String(text ?? "")
		.replace(/\p{Cc}+/gu, " ")
		.slice(0, MAX_REPORTED_CHARS);
}

function failure(code, message) {
	return { ok: false, error: { code, message: describe(message) } };
}

/**
 * One request on one connection, as Herdr closes ordinary connections after a
 * reply. Settles exactly once: the first newline-terminated reply, a timeout,
 * a reply larger than maxBytes, or a connection that ends first.
 */
export function requestHerdr(socketPath, method, params, options = {}) {
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
	const id = options.id ?? `${PLUGIN_ID}:${process.pid}:${Date.now()}`;
	return new Promise((resolve) => {
		let settled = false;
		let received = Buffer.alloc(0);
		const socket = net.connect(socketPath);
		const finish = (outcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(outcome);
		};
		const timer = setTimeout(
			() =>
				finish(failure("timeout", `${method} got no reply in ${timeoutMs}ms`)),
			timeoutMs,
		);
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		socket.on("error", (error) => finish(failure("socket", error.message)));
		socket.on("close", () =>
			finish(failure("closed", `${method}: connection closed before a reply`)),
		);
		socket.on("data", (chunk) => {
			received = Buffer.concat([received, chunk]);
			const end = received.indexOf(10);
			if (end < 0) {
				if (received.length > maxBytes)
					finish(
						failure("too_large", `${method} reply exceeds ${maxBytes} bytes`),
					);
				return;
			}
			if (end > maxBytes) {
				finish(
					failure("too_large", `${method} reply exceeds ${maxBytes} bytes`),
				);
				return;
			}
			finish(
				parseReply(received.subarray(0, end).toString("utf8"), id, method),
			);
		});
	});
}

export function parseReply(line, id, method) {
	let reply;
	try {
		reply = JSON.parse(line);
	} catch {
		return failure("malformed", `${method}: reply is not JSON`);
	}
	if (!isRecord(reply))
		return failure("malformed", `${method}: reply is not an object`);
	if (reply.id !== id)
		return failure(
			"wrong_id",
			`${method}: reply id ${describe(reply.id)} is not ${id}`,
		);
	if (isRecord(reply.error))
		return failure(
			describe(reply.error.code ?? "herdr_error"),
			reply.error.message ?? "Herdr reported an error",
		);
	if (!isRecord(reply.result))
		return failure("malformed", `${method}: reply has no result`);
	return { ok: true, result: reply.result };
}

function isAgentView(result) {
	return (
		result.type === "agent_view" &&
		(result.active === true || result.active === false)
	);
}

export const FOCUS_MESSAGE =
	"Focus is on. The Agents view hides delegated Pi children that pi-herdr-agents " +
	"marked in the last 15 seconds, unless they are blocked or their status is unknown. " +
	"Focus replaced whatever agent view was active, including one set by another tool. " +
	"Run All to show every agent again.";
export const ALL_MESSAGE = "All agents are shown. No agent view is active.";

export const RESTORE_FOCUS_MESSAGE =
	"Focus restored. Delegated Pi children are hidden from the Agents view. Run All to show every agent.";
export const RESTORE_ALL_MESSAGE =
	"Focus not restored: you chose All. Run Focus to hide delegated children again.";

export const VIEW_FILE = "view.json";

/** The saved choice; a missing, unreadable, or malformed file means focus. */
export function readChoice(env) {
	const dir = env.HERDR_PLUGIN_STATE_DIR;
	if (!dir) return "focus";
	try {
		const saved = JSON.parse(readFileSync(join(dir, VIEW_FILE), "utf8"));
		return isRecord(saved) && saved.view === "all" ? "all" : "focus";
	} catch {
		return "focus";
	}
}

/** Returns an error message, or undefined when saved or when there is no state dir. */
export function saveChoice(env, choice) {
	const dir = env.HERDR_PLUGIN_STATE_DIR;
	if (!dir) return undefined;
	const temp = join(dir, `${VIEW_FILE}.${process.pid}.tmp`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(temp, `${JSON.stringify({ view: choice })}\n`);
		renameSync(temp, join(dir, VIEW_FILE));
		return undefined;
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// The directory is unusable; the save error below is the one to report.
		}
		return describe(error instanceof Error ? error.message : error);
	}
}

async function applyFocus(ctx, name, success) {
	const reply = await ctx.request(
		ctx.socketPath,
		"agent.view.set",
		FOCUS_PARAMS,
	);
	if (!reply.ok) {
		ctx.out.error(
			`${name} failed: ${reply.error.code}: ${reply.error.message}`,
		);
		return 1;
	}
	if (
		!isAgentView(reply.result) ||
		reply.result.active !== true ||
		reply.result.source !== VIEW_SOURCE
	) {
		ctx.out.error(`${name} failed: unexpected reply ${describe(reply.result)}`);
		return 1;
	}
	if (success) ctx.out.log(success + ctx.note);
	return 0;
}

async function clearView(ctx, name = "All", success = ALL_MESSAGE) {
	const { out } = ctx;
	// Guarded clear: Herdr leaves a view owned by another source in place and
	// reports it, so All never claims that a foreign filter is gone.
	const reply = await ctx.request(
		ctx.socketPath,
		"agent.view.clear",
		ALL_PARAMS,
	);
	if (!reply.ok) {
		out.error(`${name} failed: ${reply.error.code}: ${reply.error.message}`);
		return 1;
	}
	if (!isAgentView(reply.result)) {
		out.error(`${name} failed: unexpected reply ${describe(reply.result)}`);
		return 1;
	}
	if (!reply.result.active) {
		out.log(success + ctx.note);
		return 0;
	}
	if (reply.result.source === VIEW_SOURCE) {
		out.error(
			`${name} failed: Herdr still reports this plugin's view as active.`,
		);
		return 1;
	}
	const label = reply.result.label
		? `, label ${describe(reply.result.label)}`
		: "";
	out.error(
		`Another agent view is still active (source ${describe(reply.result.source)}${label}). ` +
			"All clears only this plugin's Focus, so that view was left in place and may still hide agents. " +
			"Clear it from the tool that set it." +
			ctx.note,
	);
	return 3;
}

async function restoreView(ctx) {
	if (readChoice(ctx.env) === "all") {
		ctx.out.log(RESTORE_ALL_MESSAGE);
		return 0;
	}
	const code = await applyFocus(ctx, "Focus restore");
	if (code !== 0) return code;
	if (readChoice(ctx.env) !== "all") {
		ctx.out.log(RESTORE_FOCUS_MESSAGE + ctx.note);
		return 0;
	}
	// All ran while this Focus was in flight. All saves before it clears, so
	// rereading here undoes a Focus that landed after All's clear.
	return clearView(ctx, "Focus restore cleanup", RESTORE_ALL_MESSAGE);
}

// `save` is the choice an action records; restore only reads it.
const ACTIONS = {
	focus: {
		save: "focus",
		run: (ctx) => applyFocus(ctx, "Focus", FOCUS_MESSAGE),
	},
	all: { save: "all", run: clearView },
	restore: { save: undefined, run: restoreView },
};

/** Runs one action and returns its exit code; output goes through `out`. */
export async function runAction(action, options) {
	const { env, out } = options;
	const request = options.request ?? requestHerdr;
	const entry = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
	if (!entry) {
		out.error(
			`Unknown action ${describe(action)}; expected focus, all, or restore.`,
		);
		return 2;
	}
	const socketPath = env.HERDR_SOCKET_PATH;
	if (!socketPath) {
		out.error(
			"HERDR_SOCKET_PATH is not set. Run this action from Herdr: herdr plugin action invoke pi-herdr-agents.sidebar.focus",
		);
		return 1;
	}
	if (env.HERDR_PLUGIN_ID && env.HERDR_PLUGIN_ID !== PLUGIN_ID) {
		out.error(
			`This script belongs to ${PLUGIN_ID}, but Herdr runs it as ${describe(env.HERDR_PLUGIN_ID)}; refusing to change a view it does not own.`,
		);
		return 1;
	}
	const saveError = entry.save ? saveChoice(env, entry.save) : undefined;
	const note = saveError ? ` Your choice was not saved: ${saveError}` : "";
	return entry.run({ env, out, request, socketPath, note });
}

function isMain() {
	if (!process.argv[1]) return false;
	try {
		return (
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
		);
	} catch {
		return false;
	}
}

if (isMain()) {
	const action = process.argv[2] ?? process.env.HERDR_PLUGIN_ACTION_ID;
	process.exitCode = await runAction(action, {
		env: process.env,
		out: console,
	});
}
