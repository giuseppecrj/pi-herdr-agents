import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function getAgentConfigDir(): string {
	return getAgentDir();
}

export function getSubagentsConfigDir(): string {
	return join(getAgentConfigDir(), "herdr-agents");
}

export function getSubagentsConfigPath(): string {
	return join(getSubagentsConfigDir(), "config.json");
}

export function getSubagentsConfigExamplePath(
	assetRoot = PACKAGE_ROOT,
): string {
	return join(assetRoot, "config.json.example");
}

export function getSubagentsPackageRoot(): string {
	return PACKAGE_ROOT;
}
