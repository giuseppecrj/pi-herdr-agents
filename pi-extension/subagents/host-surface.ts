import { join } from "node:path";
import {
	loadHerdrConfig,
	selectHerdrBinding,
	type HerdrBinding,
} from "@nubl/maestro/core/config/herdr-config";
import type { PaneConfig } from "@nubl/maestro/core/config/pane-config";
import type { SurfaceProvider } from "@nubl/maestro/core/surface-provider";
import type { ScriptShellResolver } from "@nubl/maestro/core/script-launch";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import { HerdrCoreSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-core-surface-provider.ts";
import { createPiScriptShellResolver } from "@nubl/maestro/adapters/pi/script-shell";
import type { PiLaunchSnapshot } from "@nubl/maestro/runtime/pi-run-session-types";
import type { HostSurfaceBinding } from "@nubl/maestro/runtime/host-surface-binding";
import {
	herdrMarkerWriter,
	herdrMarkerSessionReader,
} from "./marker-transport.ts";

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

/**
 * The Herdr provider one launch types its script through. On Windows it
 * resolves bash from the launching session's own settings and trust decision;
 * a snapshot without them is untrusted.
 */
export function createLaunchSurfaceProvider(
	snapshot: PiLaunchSnapshot,
): HerdrSurfaceProvider {
	return new HerdrSurfaceProvider({
		paneConfig: snapshot.paneConfig,
		resolveScriptShell: createPiScriptShellResolver(
			snapshot.scriptShell ?? {
				cwd: snapshot.parent.cwd,
				projectTrusted: false,
			},
		),
	});
}

/**
 * The terminal host's runtime composition: Herdr/Core selection, the owning
 * provider, the per-launch legacy pane provider, and this pane's socket marker
 * transport. The run session never discovers any of these itself.
 */
export const hostSurfaceBinding: HostSurfaceBinding = {
	resolve: resolveHerdrBinding,
	createProvider: createHerdrProvider,
	createLaunchProvider: createLaunchSurfaceProvider,
	markers() {
		const path = process.env.HERDR_SOCKET_PATH;
		return path
			? {
					write: herdrMarkerWriter(path),
					readSession: herdrMarkerSessionReader(path),
				}
			: undefined;
	},
};
