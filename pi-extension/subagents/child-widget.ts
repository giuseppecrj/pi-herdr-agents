import { Box, Text } from "@earendil-works/pi-tui";
import type { ChildPresentationHook } from "@nubl/maestro/pi/child";

export const renderChildWidget: ChildPresentationHook = (
	ctx,
	{ subagentAgent, subagentName, toolNames, denied },
) => {
	ctx.ui.setWidget(
		"subagent-tools",
		(_tui: any, theme: any) => {
			const box = new Box(1, 0, (text: string) =>
				theme.bg("toolSuccessBg", text),
			);

			const label = subagentAgent || subagentName;
			const agentTag = label
				? theme.bold(theme.fg("accent", `[${label}]`))
				: "";

			const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
			const deniedInfo =
				denied.length > 0
					? theme.fg("dim", " · ") +
						theme.fg("error", `${denied.length} denied`)
					: "";

			const content = new Text(`${agentTag}${countInfo}${deniedInfo}`, 0, 0);
			box.addChild(content);

			return box;
		},
		{ placement: "aboveEditor" },
	);
};
