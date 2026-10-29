import { createEventBus } from "@earendil-works/pi-coding-agent";

export function createMockExtensionApi(extensionEvents = createEventBus()) {
	const registeredTools: Array<any> = [];
	const registeredCommands: Array<any> = [];
	const registeredShortcuts: Array<any> = [];
	const registeredMessageRenderers: Array<any> = [];
	const eventHandlers = new Map<string, Array<Function>>();
	const sentUserMessages: string[] = [];
	const sentMessages: Array<any> = [];
	return {
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
				sentUserMessages.push(message);
			},
			sendMessage(message: any, options?: any) {
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
