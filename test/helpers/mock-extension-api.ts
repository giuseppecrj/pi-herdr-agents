import { createEventBus } from "@earendil-works/pi-coding-agent";

export function createMockExtensionApi(extensionEvents = createEventBus()) {
	const registeredTools: Array<any> = [];
	const registeredCommands: Array<any> = [];
	const registeredShortcuts: Array<any> = [];
	const registeredMessageRenderers: Array<any> = [];
	const eventHandlers = new Map<string, Array<Function>>();
	const sentUserMessages: string[] = [];
	const sentMessages: Array<any> = [];
	// Like Pi, registering a `direct` or `model-only` tool (the default is
	// `direct`) activates it unless it sets `defaultActive: false`; other
	// exposures start inactive. setActiveTools() overrides that per tool and
	// ignores `hidden` tools. Tests may push straight into registeredTools, so
	// the active set is derived from it on each read. A pushed tool may carry
	// `sourceInfo`, as Pi's built-in tool_search does.
	const activeOverride = new Map<string, boolean>();
	const exposureOf = (tool: any) => tool.exposure ?? "direct";
	const activeOnRegistration = (tool: any) =>
		(exposureOf(tool) === "direct" || exposureOf(tool) === "model-only") &&
		tool.defaultActive !== false;
	let stale = false;
	// Mirrors Pi's assertActive(): a replaced extension API throws on every action.
	const assertActive = () => {
		if (stale)
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
	};
	return {
		/** Invalidate this API the way Pi does after session_shutdown on reload. */
		invalidate() {
			stale = true;
		},
		registeredTools,
		registeredCommands,
		registeredShortcuts,
		registeredMessageRenderers,
		eventHandlers,
		sentUserMessages,
		sentMessages,
		// SAFETY: this fixture implements only the ExtensionAPI members these
		// tests exercise; TypeScript cannot verify partial-mock compatibility
		// without also declaring every unused SDK method.
		api: {
			events: extensionEvents,
			on(event: string, handler: Function) {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
			registerTool(tool: any) {
				const index = registeredTools.findIndex(
					(entry) => entry.name === tool.name,
				);
				if (index < 0) registeredTools.push(tool);
				else registeredTools[index] = tool;
			},
			registerCommand(name: string, command: any) {
				registeredCommands.push({ name, ...command });
			},
			registerMessageRenderer(name: string, renderer: any) {
				registeredMessageRenderers.push({ name, renderer });
			},
			registerShortcut(key: string, shortcut: any) {
				registeredShortcuts.push({ key, ...shortcut });
			},
			sendUserMessage(message: string) {
				assertActive();
				sentUserMessages.push(message);
			},
			sendMessage(message: any, options?: any) {
				assertActive();
				sentMessages.push({ message, options });
			},
			getAllTools() {
				return registeredTools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					promptGuidelines: tool.promptGuidelines,
					exposure: exposureOf(tool),
					sourceInfo: tool.sourceInfo ?? {
						path: "<mock>",
						source: "mock",
						scope: "temporary",
						origin: "top-level",
					},
				}));
			},
			getActiveTools() {
				return registeredTools
					.filter(
						(tool) =>
							exposureOf(tool) !== "hidden" &&
							(activeOverride.get(tool.name) ?? activeOnRegistration(tool)),
					)
					.map((tool) => tool.name);
			},
			// Like Pi, unknown and hidden names are ignored.
			setActiveTools(names: string[]) {
				const wanted = new Set(names);
				for (const tool of registeredTools)
					activeOverride.set(tool.name, wanted.has(tool.name));
			},
		} as any,
	};
}
