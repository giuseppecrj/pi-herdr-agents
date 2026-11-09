import { createConnection } from "node:net";
import { Deadline } from "../../core/deadline.ts";
import { AcquisitionUncertainError } from "../../core/surface-provider.ts";

const REQUIRED_METHODS = [
	"terminal.run",
	"terminal.get",
	"terminal.list",
	"terminal.keys",
	"terminal.kill",
	"terminal.rm",
	"terminal.read",
];
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const ERROR_KINDS = new Set([
	"not_found",
	"invalid_params",
	"spawn_failed",
	"name_taken",
	"unavailable",
	"invalid_template",
	"machine_unknown",
	"config",
	"live",
	"finished",
	"unsupported_generation",
]);

export class CoreRpcError extends Error {
	readonly kind: string;
	constructor(kind: string) {
		super(`Herdr Core RPC failed (${kind})`);
		this.kind = kind;
	}
}

// This is the untrusted JSON-RPC boundary; no unchecked value escapes validation.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function terminalAddress(value: unknown): value is string {
	return typeof value === "string" && /^t[0-9a-z]+$/.test(value);
}

function hasRequiredMethods(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		REQUIRED_METHODS.every((method) => value.includes(method))
	);
}

export interface CoreTerminal {
	address: string;
	argv: string[];
	cwd: string;
	created_ms: number;
	state: "live" | "finished";
	parent?: string | null;
	exit_code?: number | null;
	keep: boolean;
	rm: boolean;
}
export function parseTerminal(value: unknown): CoreTerminal {
	if (
		!record(value) ||
		!terminalAddress(value.address) ||
		!Array.isArray(value.argv) ||
		!value.argv.every((arg) => typeof arg === "string") ||
		typeof value.cwd !== "string" ||
		typeof value.created_ms !== "number" ||
		!Number.isSafeInteger(value.created_ms) ||
		(value.state !== "live" && value.state !== "finished") ||
		(value.parent !== undefined &&
			value.parent !== null &&
			!terminalAddress(value.parent)) ||
		(value.exit_code !== undefined &&
			value.exit_code !== null &&
			(typeof value.exit_code !== "number" ||
				!Number.isSafeInteger(value.exit_code))) ||
		typeof value.keep !== "boolean" ||
		typeof value.rm !== "boolean"
	)
		throw new Error("Malformed Herdr Core terminal reply");
	return {
		address: value.address,
		argv: value.argv,
		cwd: value.cwd,
		created_ms: value.created_ms,
		state: value.state,
		parent: value.parent,
		exit_code: value.exit_code,
		keep: value.keep,
		rm: value.rm,
	};
}

export function parseTerminalList(value: unknown): CoreTerminal[] {
	if (!record(value) || !Array.isArray(value.terminals))
		throw new Error("Malformed Herdr Core list reply");
	return value.terminals.map(parseTerminal);
}
export function parseReadResult(value: unknown): string {
	if (
		!record(value) ||
		typeof value.text !== "string" ||
		typeof value.complete !== "boolean" ||
		typeof value.how !== "string"
	)
		throw new Error("Malformed Herdr Core read reply");
	return value.text;
}
export function parseKeysResult(value: unknown): number {
	if (
		!record(value) ||
		typeof value.turn !== "number" ||
		!Number.isSafeInteger(value.turn) ||
		value.turn < 0
	)
		throw new Error("Malformed Herdr Core keys reply");
	return value.turn;
}
export function parseRemoveResult(value: unknown): string {
	if (!record(value) || !terminalAddress(value.removed))
		throw new Error("Malformed Herdr Core remove reply");
	return value.removed;
}

/** One bounded connection per operation: each hello revalidates immutable identity. */
export class HerdrCoreClient {
	private coreId?: string;
	readonly socketPath: string;
	private readonly timeoutMs: number;
	constructor(socketPath: string, timeoutMs = 5000) {
		this.socketPath = socketPath;
		this.timeoutMs = timeoutMs;
	}
	async call<T>(
		method: string,
		params: Record<string, unknown>,
		parse: (value: unknown) => T,
		mutation = false,
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		const deadline = Deadline.after(this.timeoutMs);
		return new Promise((resolve, reject) => {
			const socket = createConnection(this.socketPath);
			let submitted = false;
			let finished = false;
			let bytes = 0;
			let buffer = "";
			let stage: "hello" | "request" = "hello";
			let observedSurfaceId: string | undefined;
			const timer = setTimeout(
				() => finish(new Error("Herdr Core request deadline expired")),
				deadline.remainingMs(),
			);
			const finish = (error?: Error, result?: T) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				socket.destroy();
				if (error)
					reject(
						submitted && mutation
							? new AcquisitionUncertainError(
									"Herdr Core execution outcome uncertain; no retry or fallback",
									{ kind: "execution-start", observedSurfaceId },
									{ cause: error },
								)
							: error,
					);
				else if (result !== undefined) resolve(result);
				else reject(new Error("Missing Herdr Core parsed reply"));
			};
			socket.on("connect", () =>
				socket.write(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "hello",
						params: { generation: 1 },
					}) + "\n",
				),
			);
			socket.on("error", () =>
				finish(new Error("Herdr Core socket unavailable")),
			);
			socket.on("end", () =>
				finish(new Error("Herdr Core disconnected before reply")),
			);
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				if (finished) return;
				bytes += Buffer.byteLength(chunk);
				if (bytes > MAX_REPLY_BYTES)
					return finish(new Error("Herdr Core reply exceeds limit"));
				buffer += chunk;
				for (;;) {
					const end = buffer.indexOf("\n");
					if (end < 0) return;
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					try {
						deadline.remainingMs();
						const reply: unknown = JSON.parse(line);
						if (
							!record(reply) ||
							reply.jsonrpc !== "2.0" ||
							reply.id !== (stage === "hello" ? 1 : 2)
						)
							throw new Error("Malformed Herdr Core RPC envelope");
						if (
							stage === "request" &&
							mutation &&
							record(reply.result) &&
							terminalAddress(reply.result.address)
						)
							observedSurfaceId = reply.result.address;
						if (reply.error !== undefined) {
							// A structured error is not proof of no execution: Core can
							// return spawn_failed after SPAWN or fail while saving state.
							if (
								!record(reply.error) ||
								!Number.isSafeInteger(reply.error.code) ||
								typeof reply.error.message !== "string" ||
								Object.hasOwn(reply, "result") ||
								!record(reply.error.data) ||
								typeof reply.error.data.kind !== "string" ||
								!ERROR_KINDS.has(reply.error.data.kind)
							)
								throw new Error("Malformed Herdr Core RPC error");
							throw new CoreRpcError(reply.error.data.kind);
						}
						if (!Object.hasOwn(reply, "result"))
							throw new Error("Missing Herdr Core RPC result");
						if (stage === "hello") {
							const hello = reply.result;
							if (
								!record(hello) ||
								hello.generation !== 1 ||
								hello.framed !== false ||
								!record(hello.core) ||
								typeof hello.core.id !== "string" ||
								!hello.core.id ||
								!hasRequiredMethods(hello.methods)
							)
								throw new Error(
									"Incompatible Herdr Core hello (generation 1 and required methods expected)",
								);
							if (this.coreId && hello.core.id !== this.coreId)
								throw new Error("Herdr Core identity changed; restart Pi");
							this.coreId = hello.core.id;
							// Cancellation vetoes submission, never discards an in-flight owner.
							signal?.throwIfAborted();
							stage = "request";
							submitted = true;
							socket.write(
								JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) +
									"\n",
							);
						} else {
							// Validate mutation replies here, while submission uncertainty is still known.
							if (mutation) parseTerminal(reply.result);
							finish(undefined, parse(reply.result));
							return;
						}
					} catch (error) {
						finish(
							error instanceof SyntaxError
								? new Error("Malformed Herdr Core JSON reply")
								: error instanceof Error
									? error
									: new Error("Invalid Herdr Core reply"),
						);
						return;
					}
				}
			});
		});
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
