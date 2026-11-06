import {
	buildTaskModelBrief,
	buildTaskModelInitPrompt,
	collectApprovalOffers,
	DIRECT_WRITER_DESTINATION,
	type NonEmpty,
	type OfferCallback,
	openApprovalOffer,
	selectApprovalRoute,
	type TaskModelBrief,
	type TaskModelFacts,
	type TaskModelInitDestination,
	type TaskModelRegistryProjector,
	type TaskModelRegistrySnapshot,
} from "../core/config/task-model-init.ts";
import type { ModelConfigSnapshot } from "../core/config/model-config.ts";
import { projectTaskModelRegistry } from "../adapters/pi/task-model-init.ts";

/** What one init request did. Only `started` submitted a prompt. */
export type TaskModelInitOutcome =
	| { kind: "started"; destination: string }
	| { kind: "not-started"; reason: string };

export interface TaskModelInitInput {
	preferences: string;
	/** Saved settings and the revision of the same bytes; throws when invalid. */
	readConfig(): ModelConfigSnapshot;
	/** The host supplies its actual active registry to this projector exactly once. */
	projectActiveRegistry(
		project: TaskModelRegistryProjector,
	): TaskModelRegistrySnapshot;
	/** Emits the approval request for this brief and returns when listeners did. */
	emitApprovalRequest(brief: TaskModelBrief, offer: OfferCallback): void;
	/**
	 * Called with the chosen destination tool before the active-tool check, so
	 * the host can activate a writer it keeps inactive outside init.
	 */
	activateTool?(name: string): void;
	isToolActive(name: string): boolean;
	/** Hands the prompt to Pi; a throw means Pi did not take it. */
	submit(prompt: string): void;
}

/** Listeners share the brief; freezing it keeps the prompt equal to what they saw. */
function deepFreeze<T>(value: T): T {
	if (value == null || Object(value) !== value) return value;
	// SAFETY: Object(value) === value holds only for objects and functions.
	for (const item of Object.values(value as object)) deepFreeze(item);
	return Object.freeze(value);
}

function isNonEmpty<T>(values: T[]): values is NonEmpty<T> {
	return values.length > 0;
}

/**
 * Capture one brief, pick where its proposal goes, and submit the prompt. It
 * runs synchronously, so nothing can change between selection and submission.
 * An opened offer that is not submitted is cancelled before this returns.
 */
export function startTaskModelInit(
	input: TaskModelInitInput,
): TaskModelInitOutcome {
	const notStarted = (reason: string): TaskModelInitOutcome => ({
		kind: "not-started",
		reason,
	});
	let snapshot: ModelConfigSnapshot;
	try {
		snapshot = input.readConfig();
	} catch (error) {
		return notStarted(error instanceof Error ? error.message : String(error));
	}
	const { models } = input.projectActiveRegistry(projectTaskModelRegistry);
	if (!isNonEmpty<TaskModelFacts>(models))
		return notStarted(
			"the active registry has no authenticated models, so there is nothing to rank. Configure a provider, then run /subagents-init again",
		);
	const brief = deepFreeze(
		buildTaskModelBrief({
			models,
			current: snapshot.config,
			configRevision: snapshot.revision,
			preferences: input.preferences,
		}),
	);
	const route = selectApprovalRoute(
		collectApprovalOffers((offer) => input.emitApprovalRequest(brief, offer)),
	);
	let destination: TaskModelInitDestination;
	let cancel: () => string | undefined = () => undefined;
	switch (route.kind) {
		case "direct":
			destination = DIRECT_WRITER_DESTINATION;
			break;
		case "refused":
			return notStarted(route.reason);
		case "offer": {
			const opened = openApprovalOffer(route.offer);
			if (opened.kind === "blocked") return notStarted(opened.reason);
			destination = opened.destination;
			cancel = opened.cancel;
			break;
		}
		default: {
			const _exhaustive: never = route;
			return _exhaustive;
		}
	}
	const cancelled = (reason: string): TaskModelInitOutcome => {
		const problem = cancel();
		return notStarted(problem ? `${reason}; ${problem}` : reason);
	};
	input.activateTool?.(destination.toolName);
	if (!input.isToolActive(destination.toolName))
		return cancelled(`${destination.toolName} is not an active tool`);
	try {
		input.submit(buildTaskModelInitPrompt(brief, destination));
	} catch (error) {
		return cancelled(
			`Pi did not accept the init prompt (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	return { kind: "started", destination: destination.toolName };
}
