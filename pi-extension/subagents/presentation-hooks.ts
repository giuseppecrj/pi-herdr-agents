import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SupervisionConfig } from "../../maestro/core/config/supervision-config.ts";
import type { StatusConfig } from "../../maestro/core/status.ts";
import type { RunningSubagent, SubagentRuntime } from "./state.ts";
import type { Observation } from "./observation.ts";

export type PiToolRenderers = Partial<
	Record<
		| "subagent"
		| "subagent_resume"
		| "subagent_interrupt"
		| "subagent_cancel"
		| "subagents_list",
		Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">
	>
>;

export interface PiPresentationHooks {
	createWidgets(deps: {
		runtime: SubagentRuntime;
		statusConfig: StatusConfig;
		supervisionConfig: SupervisionConfig;
		observeRunningSubagent: Observation["observeRunningSubagent"];
		evaluateNoProgressAdvisory: Observation["evaluateNoProgressAdvisory"];
	}): {
		renderSubagentWidgetLines(
			agents: RunningSubagent[],
			width: number,
		): string[];
		updateWidget(): void;
		startStatusRefresh(pi: ExtensionAPI): void;
		startWidgetRefresh(): void;
		stopRefresh(): void;
	};
	borderLine(
		left: string,
		right: string,
		width: number,
		accent?: string,
	): string;
	registerMessageRenderers(pi: ExtensionAPI): void;
	toolRenderers?: PiToolRenderers;
}
