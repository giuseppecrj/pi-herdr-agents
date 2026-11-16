import type { HerdrBinding } from "../core/config/herdr-config.ts";
import type { PaneConfig } from "../core/config/pane-config.ts";
import type { SurfaceProvider } from "../core/surface-provider.ts";
import type { ScriptShellResolver } from "../core/script-launch.ts";
import type { PiLaunchSnapshot } from "./pi-run-session-types.ts";
import type { MarkerWriter, MarkerSessionReader } from "./delegated-marker.ts";

/**
 * Explicit terminal-host composition for the Pi run session. The terminal host
 * owns backend selection, concrete providers and the socket marker transport;
 * the run session only calls these. Injected infrastructure never consults it.
 */
export interface HostSurfaceBinding {
	/** Resolves the current binding on every load; reload compares it to the owner's. */
	resolve(
		configDir: string,
		examplePath: string,
		platform?: NodeJS.Platform,
	): HerdrBinding;
	/** Creates the owning provider once, when a new owner is composed. */
	createProvider(
		binding: HerdrBinding,
		paneConfig: PaneConfig,
		resolveScriptShell: ScriptShellResolver,
	): SurfaceProvider;
	/** Called for every legacy launch, with that session's cwd and trust. */
	createLaunchProvider(snapshot: PiLaunchSnapshot): SurfaceProvider;
	/** Sidebar marker transport for legacy panes, or none outside a socket pane. */
	markers?():
		| { write: MarkerWriter; readSession: MarkerSessionReader }
		| undefined;
}
