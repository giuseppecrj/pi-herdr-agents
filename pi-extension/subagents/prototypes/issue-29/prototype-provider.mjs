// THROWAWAY deterministic scenarios shared by the test driver and its local HTTP provider.
const scenarios = new Map();
export function createScenario(id, count) {
	const children = Array.from({ length: count }, (_, index) => {
		let release;
		const promise = new Promise((resolve) => {
			release = resolve;
		});
		return { id: `${id}-${index}`, ready: false, promise, release };
	});
	const scenario = { id, count, children, launched: false, requests: [] };
	scenarios.set(id, scenario);
	return scenario;
}
export function releaseScenario(id) {
	for (const child of scenarios.get(id)?.children ?? []) child.release();
}
export async function prototypeResponse(names, source) {
	const parentId = source.match(/PROTOTYPE_PARENT_([a-z0-9-]+)/)?.[1];
	if (parentId && names.has("subagent")) {
		const scenario = scenarios.get(parentId);
		if (!scenario) return { text: "Unknown prototype scenario" };
		scenario.requests.push({
			at: Date.now(),
			received: [
				...new Set(source.match(/PROTOTYPE_RESULT_[a-z0-9-]+/g) ?? []),
			],
		});
		if (!scenario.launched) {
			scenario.launched = true;
			return {
				toolCalls: scenario.children.map((child) => ({
					name: "subagent",
					arguments: {
						name: `Prototype-${child.id}`,
						agent: "test-echo",
						model: "pi-integration/test",
						thinking: "off",
						tools: "read,caller_ping",
						task: `PROTOTYPE_HELD_CHILD_${child.id}`,
					},
				})),
			};
		}
		return { text: `PROTOTYPE_PARENT_IDLE_${parentId}` };
	}
	const childId = source.match(/PROTOTYPE_HELD_CHILD_([a-z0-9-]+)/)?.[1];
	if (childId && !names.has("subagent")) {
		const scenario = [...scenarios.values()].find((item) =>
			item.children.some((child) => child.id === childId),
		);
		const child = scenario?.children.find((item) => item.id === childId);
		if (!child) return { text: "Unknown prototype child" };
		child.ready = true;
		await child.promise;
		return { text: `PROTOTYPE_RESULT_${childId}` };
	}
	return null;
}
