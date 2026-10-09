// Pi Herdr Agents Sidebar: the Focus and All actions for Herdr's Agents view.
// Herdr may install only this directory, so the file uses Node built-ins only.
import { realpathSync } from "node:fs";
import net from "node:net";
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

/** Runs one action and returns its exit code; output goes through `out`. */
export async function runAction(action, options) {
	const { env, out } = options;
	const request = options.request ?? requestHerdr;
	if (action !== "focus" && action !== "all") {
		out.error(`Unknown action ${describe(action)}; expected focus or all.`);
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
	if (action === "focus") {
		const reply = await request(socketPath, "agent.view.set", FOCUS_PARAMS);
		if (!reply.ok) {
			out.error(`Focus failed: ${reply.error.code}: ${reply.error.message}`);
			return 1;
		}
		if (
			!isAgentView(reply.result) ||
			reply.result.active !== true ||
			reply.result.source !== VIEW_SOURCE
		) {
			out.error(`Focus failed: unexpected reply ${describe(reply.result)}`);
			return 1;
		}
		out.log(FOCUS_MESSAGE);
		return 0;
	}
	// Guarded clear: Herdr leaves a view owned by another source in place and
	// reports it, so All never claims that a foreign filter is gone.
	const reply = await request(socketPath, "agent.view.clear", ALL_PARAMS);
	if (!reply.ok) {
		out.error(`All failed: ${reply.error.code}: ${reply.error.message}`);
		return 1;
	}
	if (!isAgentView(reply.result)) {
		out.error(`All failed: unexpected reply ${describe(reply.result)}`);
		return 1;
	}
	if (!reply.result.active) {
		out.log(ALL_MESSAGE);
		return 0;
	}
	if (reply.result.source === VIEW_SOURCE) {
		out.error("All failed: Herdr still reports this plugin's view as active.");
		return 1;
	}
	const label = reply.result.label
		? `, label ${describe(reply.result.label)}`
		: "";
	out.error(
		`Another agent view is still active (source ${describe(reply.result.source)}${label}). ` +
			"All clears only this plugin's Focus, so that view was left in place and may still hide agents. " +
			"Clear it from the tool that set it.",
	);
	return 3;
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
