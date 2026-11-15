import { fileURLToPath } from "node:url";
import { createPiExtension } from "./extension.ts";
import { hostSurfaceBinding } from "./host-surface.ts";
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
} from "./extension.ts";

// Invoke per load, not in the engine cache. Presentation never replaces a run owner.
const extension = createPiExtension({
	hostSurface: hostSurfaceBinding,
	presentation: {
		borderLine,
		createWidgets: createWidgetController,
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
export default extension;
