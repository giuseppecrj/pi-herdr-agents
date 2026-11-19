import { fileURLToPath } from "node:url";
import { createPiExtension } from "@nubl/maestro/pi";
import { bindLegacyPaneActions, hostSurfaceBinding } from "./host-surface.ts";
import { borderLine, createWidgetController } from "./widgets.ts";
import { registerMessageRenderers } from "./renderers.ts";
import { toolRenderers } from "./tool-renderers.ts";

export {
	hasWorkingSubagents,
	shouldDeliverSubagentCompletion,
	selectCompletionApi,
	shouldPreserveSubagentsOnShutdown,
	cleanupSubagentsForShutdown,
	shouldAdvanceToFallback,
} from "@nubl/maestro/pi/subagents/index";

// Keep pane actions on the same backend the run owner selects.
let paneActions: ReturnType<typeof bindLegacyPaneActions>;
let registerPaneFocusCommand: ReturnType<
	typeof createWidgetController
>["registerPaneFocusCommand"];

// Invoke per load, not in the engine cache. Presentation never replaces a run owner.
const extension = createPiExtension({
	hostSurface: {
		...hostSurfaceBinding,
		resolve(...args) {
			const binding = hostSurfaceBinding.resolve(...args);
			paneActions = bindLegacyPaneActions(binding);
			return binding;
		},
	},
	presentation: {
		borderLine,
		createWidgets(deps) {
			const widgets = createWidgetController({
				...deps,
				getPaneActions: () => paneActions,
			});
			registerPaneFocusCommand = widgets.registerPaneFocusCommand;
			return widgets;
		},
		registerMessageRenderers,
		toolRenderers,
	},
	childEntryPath: fileURLToPath(
		new URL(
			"../../maestro/adapters/pi/child/subagent-done.ts",
			import.meta.url,
		),
	),
	configAssetRoot: fileURLToPath(new URL("../../", import.meta.url)),
});

export const __test__ = extension.__test__;
export default function subagentsExtension(
	...args: Parameters<typeof extension>
) {
	paneActions = undefined;
	extension(...args);
	registerPaneFocusCommand(args[0]);
}
