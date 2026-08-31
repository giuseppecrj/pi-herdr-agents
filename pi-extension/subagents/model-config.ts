import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject, isString } from "./type-guards.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MODEL_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");

export interface ModelConfig {
	default?: string;
	agents: Record<string, string>;
}

function invalidModelConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent model config in ${source}: ${message}`);
}

export function parseModelConfig(
	rawConfig: any,
	source = "config.json",
): ModelConfig {
	if (!isPlainObject(rawConfig)) {
		invalidModelConfig(source, "root must be an object");
	}

	const models = rawConfig.models;
	if (models == null) return { agents: {} };
	if (!isPlainObject(models)) {
		invalidModelConfig(source, "models must be an object");
	}

	const value = models;
	const allowedKeys = new Set(["default", "agents"]);
	const unsupportedKeys = Object.keys(value).filter(
		(key) => !allowedKeys.has(key),
	);
	if (unsupportedKeys.length > 0) {
		invalidModelConfig(
			source,
			`models has unsupported key(s): ${unsupportedKeys.join(", ")}`,
		);
	}

	let defaultModel: string | undefined;
	if (value.default != null) {
		if (!isString(value.default) || value.default.trim() === "") {
			invalidModelConfig(source, "models.default must be a non-empty string");
		}
		defaultModel = value.default.trim();
	}

	const agents: Record<string, string> = {};
	if (value.agents != null) {
		if (!isPlainObject(value.agents)) {
			invalidModelConfig(source, "models.agents must be an object");
		}
		for (const [agent, model] of Object.entries(value.agents)) {
			if (!isString(model) || model.trim() === "") {
				invalidModelConfig(
					source,
					`models.agents.${agent} must be a non-empty string`,
				);
			}
			Object.defineProperty(agents, agent, {
				value: model.trim(),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}

	return { default: defaultModel, agents };
}

export function resolveModelDefault(
	agentName: string | undefined,
	agentModel: string | undefined,
	config: ModelConfig,
): string | undefined {
	if (agentModel) return agentModel;
	if (agentName && Object.hasOwn(config.agents, agentName)) {
		return config.agents[agentName];
	}
	return config.default;
}

export function loadModelConfig(
	configPath = DEFAULT_MODEL_CONFIG_PATH,
): ModelConfig {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		// SAFETY: readFileSync only throws Node's fs errors here, which are
		// always Error instances carrying an ErrnoException `code`.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code === "ENOENT") return { agents: {} };
		throw error;
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Invalid JSON in subagent model config ${configPath}: ${detail}`,
		);
	}
	return parseModelConfig(parsed, configPath);
}
