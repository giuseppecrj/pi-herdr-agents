import { join } from "node:path";
import {
	loadHerdrConfig,
	selectHerdrBinding,
	type HerdrBinding,
} from "../core/config/herdr-config.ts";
import type { PaneConfig } from "../core/config/pane-config.ts";
import type { SurfaceProvider } from "../core/surface-provider.ts";
import type { ScriptShellResolver } from "../core/script-launch.ts";
import { HerdrSurfaceProvider } from "../surfaces/herdr/herdr-surface-provider.ts";
import { HerdrCoreSurfaceProvider } from "../surfaces/herdr/herdr-core-surface-provider.ts";

export function resolveHerdrBinding(
	configDir: string,
	examplePath: string,
	platform: NodeJS.Platform = process.platform,
): HerdrBinding {
	return selectHerdrBinding(
		loadHerdrConfig(join(configDir, "herdr-agents"), examplePath),
		process.env,
		platform,
	);
}
export function createHerdrProvider(
	binding: HerdrBinding,
	paneConfig: PaneConfig,
	resolveScriptShell?: ScriptShellResolver,
): SurfaceProvider {
	return binding.backend === "core"
		? new HerdrCoreSurfaceProvider(binding)
		: new HerdrSurfaceProvider({ paneConfig, resolveScriptShell });
}
