import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBoolean, isRecord } from "./type-guards.ts";

/** Settings for the guidelines the host injects into the parent's system prompt. */
export interface GuidelinesConfig {
	/** Ask the parent to print a roster table after the final launch. */
	launchRoster: boolean;
}

function invalid(source: string, message: string): never {
	throw new Error(
		`Invalid subagent guidelines config in ${source}: ${message}`,
	);
}

export function parseGuidelinesConfig(
	rawConfig: any,
	source = "config.json",
): GuidelinesConfig {
	if (!isRecord(rawConfig)) invalid(source, "root must be an object");
	if (!Object.hasOwn(rawConfig, "guidelines")) return { launchRoster: true };
	if (!isRecord(rawConfig.guidelines)) {
		invalid(source, "guidelines must be an object");
	}
	const unsupported = Object.keys(rawConfig.guidelines).filter(
		(key) => key !== "launchRoster",
	);
	if (unsupported.length > 0) {
		invalid(
			source,
			`guidelines has unsupported key(s): ${unsupported.join(", ")}`,
		);
	}
	const launchRoster = Object.hasOwn(rawConfig.guidelines, "launchRoster")
		? rawConfig.guidelines.launchRoster
		: true;
	if (!isBoolean(launchRoster)) {
		invalid(source, "guidelines.launchRoster must be a boolean");
	}
	return { launchRoster };
}

export function loadGuidelinesConfig(
	configDir: string,
	examplePath: string,
): GuidelinesConfig {
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
					`Missing subagent guidelines config. Expected ${configPath} or ${examplePath}.`,
				);
			}
			throw exampleError;
		}
	}
	try {
		return parseGuidelinesConfig(JSON.parse(rawConfig), sourcePath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(
				`Invalid JSON in subagent config ${sourcePath}: ${error.message}`,
			);
		}
		throw error;
	}
}
