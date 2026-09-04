import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBoolean, isPlainObject } from "./type-guards.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const ROLE_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface RoleConfig {
	bundled: boolean;
}

function invalidRoleConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent role config in ${source}: ${message}`);
}

export function parseRoleConfig(
	rawConfig: any,
	source = "config.json",
): RoleConfig {
	if (!isPlainObject(rawConfig)) {
		invalidRoleConfig(source, "root must be an object");
	}
	if (!Object.hasOwn(rawConfig, "roles")) return { bundled: true };
	if (!isPlainObject(rawConfig.roles)) {
		invalidRoleConfig(source, "roles must be an object");
	}

	const unsupportedKeys = Object.keys(rawConfig.roles).filter(
		(key) => key !== "bundled",
	);
	if (unsupportedKeys.length > 0) {
		invalidRoleConfig(
			source,
			`roles has unsupported key(s): ${unsupportedKeys.join(", ")}`,
		);
	}
	if (!Object.hasOwn(rawConfig.roles, "bundled")) return { bundled: true };
	if (!isBoolean(rawConfig.roles.bundled)) {
		invalidRoleConfig(source, "roles.bundled must be a boolean");
	}
	return { bundled: rawConfig.roles.bundled };
}

interface RoleConfigSource {
	sourcePath: string;
	rawConfig: string;
}

function readRoleConfigFile(
	configPath: string,
	examplePath: string,
): RoleConfigSource {
	try {
		return {
			sourcePath: configPath,
			rawConfig: readFileSync(configPath, "utf8"),
		};
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code !== "ENOENT") throw error;
	}

	try {
		return {
			sourcePath: examplePath,
			rawConfig: readFileSync(examplePath, "utf8"),
		};
	} catch (error) {
		// SAFETY: see the preceding readFileSync error handling.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code === "ENOENT") {
			throw new Error(
				`Missing subagent role config. Expected ${configPath} or ${examplePath}.`,
			);
		}
		throw error;
	}
}

export function loadRoleConfig(
	configPath = DEFAULT_ROLE_CONFIG_PATH,
	examplePath = ROLE_CONFIG_EXAMPLE_PATH,
): RoleConfig {
	const { sourcePath, rawConfig } = readRoleConfigFile(configPath, examplePath);
	let parsed;
	try {
		parsed = JSON.parse(rawConfig);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
	}
	return parseRoleConfig(parsed, sourcePath);
}
