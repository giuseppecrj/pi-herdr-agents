import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBoolean, isRecord } from "./type-guards.ts";

/** Whether the parent appends one outcome-ledger line per model attempt. */
export interface OutcomeLedgerConfig {
	enabled: boolean;
}

function invalid(source: string, message: string): never {
	throw new Error(`Invalid outcomeLedger config in ${source}: ${message}`);
}

/** `outcomeLedger` is on unless set to `false`; any non-boolean is rejected. */
export function parseOutcomeLedgerConfig(
	rawConfig: any,
	source = "config.json",
): OutcomeLedgerConfig {
	if (!isRecord(rawConfig)) invalid(source, "root must be an object");
	if (!Object.hasOwn(rawConfig, "outcomeLedger")) return { enabled: true };
	if (!isBoolean(rawConfig.outcomeLedger))
		invalid(source, "outcomeLedger must be true or false");
	return { enabled: rawConfig.outcomeLedger };
}

export function loadOutcomeLedgerConfig(
	configDir: string,
	examplePath: string,
): OutcomeLedgerConfig {
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
			if ((exampleError as NodeJS.ErrnoException).code === "ENOENT")
				return { enabled: true };
			throw exampleError;
		}
	}
	try {
		return parseOutcomeLedgerConfig(JSON.parse(rawConfig), sourcePath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(
				`Invalid JSON in subagent config ${sourcePath}: ${error.message}`,
			);
		}
		throw error;
	}
}
