import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject, isString } from "./type-guards.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PANE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const PANE_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export type PaneMode = "grouped" | "tab" | "split";
export type PaneDirection = "right" | "down";

export interface PaneConfig {
	mode: PaneMode;
	direction: PaneDirection;
	maxPerTab: number;
}

type PaneCreator = (name: string, cwd?: string) => string;
type SplitPaneCreator = (
	name: string,
	direction: PaneDirection,
	cwd?: string,
) => string;
type GroupedPaneCreator = (
	name: string,
	cwd: string,
	maxPerTab: number,
	direction: PaneDirection,
) => string;

function invalidPaneConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent pane config in ${source}: ${message}`);
}

export function parsePaneConfig(
	rawConfig: any,
	source = "config.json",
): PaneConfig {
	if (!isPlainObject(rawConfig)) {
		invalidPaneConfig(source, "root must be an object");
	}
	if (!Object.hasOwn(rawConfig, "panes")) {
		return { mode: "grouped", direction: "right", maxPerTab: 4 };
	}
	if (!isPlainObject(rawConfig.panes)) {
		invalidPaneConfig(source, "panes must be an object");
	}

	const unsupportedKeys = Object.keys(rawConfig.panes).filter(
		(key) => key !== "mode" && key !== "direction" && key !== "maxPerTab",
	);
	if (unsupportedKeys.length > 0) {
		invalidPaneConfig(
			source,
			`panes has unsupported key(s): ${unsupportedKeys.join(", ")}`,
		);
	}

	let mode: PaneMode = "grouped";
	if (Object.hasOwn(rawConfig.panes, "mode")) {
		if (
			!isString(rawConfig.panes.mode) ||
			(rawConfig.panes.mode !== "grouped" &&
				rawConfig.panes.mode !== "tab" &&
				rawConfig.panes.mode !== "split")
		) {
			invalidPaneConfig(
				source,
				'panes.mode must be "grouped", "tab", or "split"',
			);
		}
		mode = rawConfig.panes.mode;
	}

	let direction: PaneDirection = "right";
	if (Object.hasOwn(rawConfig.panes, "direction")) {
		if (
			!isString(rawConfig.panes.direction) ||
			(rawConfig.panes.direction !== "right" &&
				rawConfig.panes.direction !== "down")
		) {
			invalidPaneConfig(source, 'panes.direction must be "right" or "down"');
		}
		direction = rawConfig.panes.direction;
	}

	const maxPerTab = Object.hasOwn(rawConfig.panes, "maxPerTab")
		? rawConfig.panes.maxPerTab
		: 4;
	if (!Number.isSafeInteger(maxPerTab) || maxPerTab < 1) {
		invalidPaneConfig(
			source,
			"panes.maxPerTab must be a positive safe integer",
		);
	}
	return { mode, direction, maxPerTab };
}

interface PaneConfigSource {
	sourcePath: string;
	rawConfig: string;
}

function readPaneConfigFile(
	configPath: string,
	examplePath: string,
): PaneConfigSource {
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
				`Missing subagent pane config. Expected ${configPath} or ${examplePath}.`,
			);
		}
		throw error;
	}
}

export function loadPaneConfig(
	configPath = DEFAULT_PANE_CONFIG_PATH,
	examplePath = PANE_CONFIG_EXAMPLE_PATH,
): PaneConfig {
	const { sourcePath, rawConfig } = readPaneConfigFile(configPath, examplePath);
	let parsed;
	try {
		parsed = JSON.parse(rawConfig);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
	}
	return parsePaneConfig(parsed, sourcePath);
}

export function createSubagentPaneFactory(
	config: PaneConfig,
	createTab: PaneCreator,
	createSplit: SplitPaneCreator,
	createGrouped?: GroupedPaneCreator,
): PaneCreator {
	if (config.mode === "grouped") {
		return (name, cwd = process.cwd()) => {
			if (!createGrouped)
				throw new Error("Grouped pane creation is unavailable");
			return createGrouped(name, cwd, config.maxPerTab, config.direction);
		};
	}
	return config.mode === "split"
		? (name, cwd) => createSplit(name, config.direction, cwd)
		: createTab;
}
