import { createEventBus } from "@earendil-works/pi-coding-agent";

export function createMockExtensionApi(extensionEvents = createEventBus()) {
	const registeredTools: Array<any> = [];
	const registeredCommands: Array<any> = [];
	const registeredShortcuts: Array<any> = [];
	const registeredMessageRenderers: Array<any> = [];
	const eventHandlers = new Map<string, Array<Function>>();
	const sentUserMessages: string[] = [];
	const sentMessages: Array<any> = [];
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
				registeredTools.push(tool);
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
				return [];
			},
			// Pi activates registered tools by default.
			getActiveTools() {
				return registeredTools.map((tool) => tool.name);
			},
		} as any,
	};
}
