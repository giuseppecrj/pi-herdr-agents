import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBoolean, isRecord } from "./type-guards.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface SupervisionConfig {
	forcePolling: boolean;
}

function invalid(source: string, message: string): never {
	throw new Error(
		`Invalid subagent supervision config in ${source}: ${message}`,
	);
}

export function parseSupervisionConfig(
	rawConfig: any,
	source = "config.json",
): SupervisionConfig {
	if (!isRecord(rawConfig)) invalid(source, "root must be an object");
	if (!Object.hasOwn(rawConfig, "supervision")) return { forcePolling: false };
	if (!isRecord(rawConfig.supervision)) {
		invalid(source, "supervision must be an object");
	}
	const unsupported = Object.keys(rawConfig.supervision).filter(
		(key) => key !== "forcePolling",
	);
	if (unsupported.length > 0) {
		invalid(
			source,
			`supervision has unsupported key(s): ${unsupported.join(", ")}`,
		);
	}
	if (!Object.hasOwn(rawConfig.supervision, "forcePolling")) {
		return { forcePolling: false };
	}
	if (!isBoolean(rawConfig.supervision.forcePolling)) {
		invalid(source, "supervision.forcePolling must be a boolean");
	}
	return { forcePolling: rawConfig.supervision.forcePolling };
}

export function loadSupervisionConfig(
	configPath = DEFAULT_CONFIG_PATH,
	examplePath = EXAMPLE_CONFIG_PATH,
): SupervisionConfig {
	let sourcePath = configPath;
	let rawConfig: string;
	try {
		rawConfig = readFileSync(configPath, "utf8");
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		sourcePath = examplePath;
		try {
			rawConfig = readFileSync(examplePath, "utf8");
		} catch (exampleError) {
			// SAFETY: readFileSync only throws Node fs errors here, which carry code.
			if ((exampleError as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(
					`Missing subagent supervision config. Expected ${configPath} or ${examplePath}.`,
				);
			}
			throw exampleError;
		}
	}
	try {
		return parseSupervisionConfig(JSON.parse(rawConfig), sourcePath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(
				`Invalid JSON in subagent config ${sourcePath}: ${error.message}`,
			);
		}
		throw error;
	}
}
