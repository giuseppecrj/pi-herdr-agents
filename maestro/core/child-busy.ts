/**
 * Event-bus channel a child asks before it asks itself whether its task is
 * done. A listener that knows the child is still waiting on work of its own,
 * such as running subagents, sets `busy` synchronously.
 */
export const CHILD_BUSY_CHANNEL = "pi-herdr-agents:child-busy";

export interface ChildBusyProbe {
	busy: boolean;
}

export interface ChildBusyEvents {
	emit(channel: string, probe: ChildBusyProbe): void;
}

export function isChildBusy(events: ChildBusyEvents | undefined): boolean {
	if (!events) return false;
	const probe: ChildBusyProbe = { busy: false };
	events.emit(CHILD_BUSY_CHANNEL, probe);
	return probe.busy;
}
