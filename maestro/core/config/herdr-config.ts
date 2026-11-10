import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "./type-guards.ts";
import { HERDR_CORE_UNSUPPORTED_ON_WINDOWS } from "../platform-support.ts";

export type HerdrBackend = "auto" | "legacy" | "core";

export function parseHerdrConfig(
	raw: any,
	source = "config.json",
): HerdrBackend {
	const invalid = (detail: string): never => {
		throw new Error(`Invalid Herdr config in ${source}: ${detail}`);
	};
	if (!isPlainObject(raw)) return invalid("root must be an object");
	if (!Object.hasOwn(raw, "herdr")) return "auto";
	if (!isPlainObject(raw.herdr)) return invalid("herdr must be an object");
	if (Object.keys(raw.herdr).some((key) => key !== "backend"))
		return invalid("herdr accepts only backend");
	if (!Object.hasOwn(raw.herdr, "backend")) return "auto";
	const backend = raw.herdr.backend;
	if (backend !== "auto" && backend !== "legacy" && backend !== "core")
		return invalid('herdr.backend must be "auto", "legacy", or "core"');
	return backend;
}

export function loadHerdrConfig(
	configDir: string,
	examplePath: string,
): HerdrBackend {
	const file = join(configDir, "config.json");
	let text: string;
	let source = file;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		// SAFETY: Node filesystem failures expose an errno code.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		source = examplePath;
		text = readFileSync(source, "utf8");
	}
	try {
		return parseHerdrConfig(JSON.parse(text), source);
	} catch (error) {
		throw new Error(
			`Cannot load Herdr config ${source}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

export type HerdrBinding =
	| { backend: "legacy" }
	| { backend: "core"; socket: string; parentTerminal: string };

export function selectHerdrBinding(
	backend: HerdrBackend,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): HerdrBinding {
	if (backend === "legacy" || (backend === "auto" && !env.HC_TERMINAL_ID))
		return { backend: "legacy" };
	// Core would be selected. Like a malformed Core endpoint, auto in a Core
	// terminal fails rather than falling back to legacy.
	if (platform === "win32") throw new Error(HERDR_CORE_UNSUPPORTED_ON_WINDOWS);
	const parentTerminal = env.HC_TERMINAL_ID;
	const socket = env.HC_TERMINAL_SOCKET || env.HC_SOCKET;
	if (
		!parentTerminal ||
		!/^t[0-9a-z]+$/.test(parentTerminal) ||
		!socket ||
		!socket.startsWith("/")
	)
		throw new Error(
			"Herdr Core requires a native HC_TERMINAL_ID and absolute HC_TERMINAL_SOCKET (or HC_SOCKET). Restart Pi in a local Core terminal.",
		);
	return { backend: "core", socket, parentTerminal };
}

export function assertSameHerdrBinding(
	previous: HerdrBinding,
	next: HerdrBinding,
): void {
	if (JSON.stringify(previous) !== JSON.stringify(next))
		throw new Error(
			"Herdr backend or endpoint changed; restart Pi before applying this binding.",
		);
}
