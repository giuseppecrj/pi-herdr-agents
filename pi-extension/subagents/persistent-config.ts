import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "./type-guards.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PERSISTENT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const PERSISTENT_CONFIG_EXAMPLE_PATH = join(
	PACKAGE_ROOT,
	"config.json.example",
);

export const DEFAULT_MAX_PERSISTENT_AGENTS = 3;

export interface PersistentConfig {
	maxAgents: number;
}

function invalidPersistentConfig(source: string, message: string): never {
	throw new Error(
		`Invalid persistent specialist config in ${source}: ${message}`,
	);
}

export function parsePersistentConfig(
	rawConfig: any,
	source = "config.json",
): PersistentConfig {
	if (!isPlainObject(rawConfig)) {
		invalidPersistentConfig(source, "root must be an object");
	}
	if (!Object.hasOwn(rawConfig, "persistent")) {
		return { maxAgents: DEFAULT_MAX_PERSISTENT_AGENTS };
	}
	if (!isPlainObject(rawConfig.persistent)) {
		invalidPersistentConfig(source, "persistent must be an object");
	}
	const unsupported = Object.keys(rawConfig.persistent).filter(
		(key) => key !== "maxAgents",
	);
	if (unsupported.length > 0) {
		invalidPersistentConfig(
			source,
			`persistent has unsupported key(s): ${unsupported.join(", ")}`,
		);
	}
	if (!Object.hasOwn(rawConfig.persistent, "maxAgents")) {
		return { maxAgents: DEFAULT_MAX_PERSISTENT_AGENTS };
	}
	const { maxAgents } = rawConfig.persistent;
	if (!Number.isInteger(maxAgents) || maxAgents < 1) {
		invalidPersistentConfig(
			source,
			"persistent.maxAgents must be a positive integer",
		);
	}
	return { maxAgents };
}

interface ConfigSource {
	sourcePath: string;
	rawConfig: string;
}

function readPersistentConfigFile(
	configPath: string,
	examplePath: string,
): ConfigSource {
	try {
		return {
			sourcePath: configPath,
			rawConfig: readFileSync(configPath, "utf8"),
		};
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		return {
			sourcePath: examplePath,
			rawConfig: readFileSync(examplePath, "utf8"),
		};
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`Missing persistent specialist config. Expected ${configPath} or ${examplePath}.`,
			);
		}
		throw error;
	}
}

export function loadPersistentConfig(
	configPath = DEFAULT_PERSISTENT_CONFIG_PATH,
	examplePath = PERSISTENT_CONFIG_EXAMPLE_PATH,
): PersistentConfig {
	const { sourcePath, rawConfig } = readPersistentConfigFile(
		configPath,
		examplePath,
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawConfig);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
	}
	return parsePersistentConfig(parsed, sourcePath);
}
