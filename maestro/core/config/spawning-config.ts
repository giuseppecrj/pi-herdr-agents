import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_DELEGATION_DEPTH } from "../delegation-depth.ts";
import { isFiniteNumber, isRecord } from "./type-guards.ts";

export interface SpawningConfig {
	/** Deepest child a launch may create; a top-level session is depth 0. */
	maxDepth: number;
}

function invalid(source: string, message: string): never {
	throw new Error(`Invalid spawning config in ${source}: ${message}`);
}

export function parseSpawningConfig(
	rawConfig: any,
	source = "config.json",
): SpawningConfig {
	if (!isRecord(rawConfig)) invalid(source, "root must be an object");
	if (!Object.hasOwn(rawConfig, "spawning")) {
		return { maxDepth: DEFAULT_MAX_DELEGATION_DEPTH };
	}
	if (!isRecord(rawConfig.spawning)) {
		invalid(source, "spawning must be an object");
	}
	const unsupported = Object.keys(rawConfig.spawning).filter(
		(key) => key !== "maxDepth",
	);
	if (unsupported.length > 0) {
		invalid(
			source,
			`spawning has unsupported key(s): ${unsupported.join(", ")}`,
		);
	}
	if (!Object.hasOwn(rawConfig.spawning, "maxDepth")) {
		return { maxDepth: DEFAULT_MAX_DELEGATION_DEPTH };
	}
	const { maxDepth } = rawConfig.spawning;
	if (
		!isFiniteNumber(maxDepth) ||
		!Number.isSafeInteger(maxDepth) ||
		maxDepth < 1
	) {
		invalid(source, "spawning.maxDepth must be a positive integer");
	}
	return { maxDepth };
}

export function loadSpawningConfig(
	configDir: string,
	examplePath: string,
): SpawningConfig {
	const configPath = join(configDir, "config.json");
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
					`Missing spawning config. Expected ${configPath} or ${examplePath}.`,
				);
			}
			throw exampleError;
		}
	}
	try {
		return parseSpawningConfig(JSON.parse(rawConfig), sourcePath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(
				`Invalid JSON in subagent config ${sourcePath}: ${error.message}`,
			);
		}
		throw error;
	}
}
