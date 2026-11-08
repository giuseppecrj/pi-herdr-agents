import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * Routine host tools register with this exposure. Pi keeps their schemas and
 * prompt guidelines out of requests until its built-in `tool_search` loads them.
 */
export const ROUTINE_TOOL_EXPOSURE = "deferred" as const;

const TOOL_SEARCH_NAME = "tool_search";
/** The path Pi gives tools registered by its built-in tool-search extension. */
const TOOL_SEARCH_SOURCE_PATH = "builtin:tool-search";

/** The tool metadata {@link isNativeToolSearch} reads. */
export type ToolSearchCandidate = Pick<ToolInfo, "name" | "exposure"> & {
	sourceInfo?: Partial<ToolInfo["sourceInfo"]>;
};

/**
 * Whether a tool is Pi's built-in `tool_search`. Judged by the public
 * provenance Pi reports, so another extension's tool of the same name never
 * counts, and no schema object is compared across package copies.
 */
export function isNativeToolSearch(tool: ToolSearchCandidate): boolean {
	return (
		tool.name === TOOL_SEARCH_NAME &&
		tool.sourceInfo?.source === "builtin" &&
		tool.sourceInfo.path === TOOL_SEARCH_SOURCE_PATH &&
		(tool.exposure === "model-only" || tool.exposure === "direct")
	);
}

/** How {@link DeferredTools.ensureReachable} made the routine tools reachable. */
export type DeferredReach =
	/** Pi's `tool_search` is active and loads the routine tools on demand. */
	| "search"
	/** No usable native search: the permitted routine tools are active now. */
	| "eager"
	/** Pi kept none of this load's routine tools (allowlist, exclusion, or deny list). */
	| "none";

export interface DeferredTools {
	/** Registration API that records which deferred tools this load owns. */
	api: ExtensionAPI;
	/**
	 * Make this load's routine tools reachable once every extension has
	 * registered: activate Pi's `tool_search`, or, when it is missing, filtered
	 * out, or not Pi's own, activate the routine tools Pi kept. Other active and
	 * restored tools stay active; tools Pi filtered out stay unreachable.
	 */
	ensureReachable(): DeferredReach;
}

/**
 * Track the deferred tools registered through the returned API. Ownership is
 * the registered parameter schema object, which only this load holds, so a
 * same-named tool from another extension is never activated.
 */
export function trackDeferredTools(pi: ExtensionAPI): DeferredTools {
	const owned = new Map<string, unknown>();
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		if (tool.exposure === ROUTINE_TOOL_EXPOSURE)
			owned.set(tool.name, tool.parameters);
		pi.registerTool(tool);
	};
	// SAFETY: the prototype is the real API, so every other member resolves to
	// it unchanged; only registerTool is replaced.
	const api: ExtensionAPI = Object.assign(Object.create(pi), { registerTool });
	return {
		api,
		ensureReachable() {
			const tools = pi.getAllTools();
			const routine = tools
				.filter((tool) => owned.get(tool.name) === tool.parameters)
				.map((tool) => tool.name);
			if (routine.length === 0) return "none";
			const search = tools.find(isNativeToolSearch);
			if (search) {
				const active = pi.getActiveTools();
				if (!active.includes(search.name))
					pi.setActiveTools([...active, search.name]);
				if (pi.getActiveTools().includes(search.name)) return "search";
			}
			const active = pi.getActiveTools();
			const missing = routine.filter((name) => !active.includes(name));
			if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
			return "eager";
		},
	};
}
