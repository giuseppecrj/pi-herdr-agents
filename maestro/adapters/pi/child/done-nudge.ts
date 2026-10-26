/**
 * Asks a child that ended a run without subagent_done whether its task is
 * complete. A child without auto-exit stays open until it calls subagent_done,
 * and one that forgets leaves its caller waiting on a session that has stopped
 * working.
 */

export const DONE_NUDGE_DELAY_MS = 3_000;

export const DONE_NUDGE_MESSAGE =
	"Is your task complete? If it is, call subagent_done now; your last " +
	"message before it becomes the summary returned to your caller. If you " +
	"are waiting for something, such as the user's answer or your own " +
	"subagents, say what you are waiting for in one line and do not call " +
	"subagent_done.";

export interface DoneNudgeContext {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	ui?: { getEditorText?(): string };
}

export interface DoneNudgeOptions {
	send(message: string): void;
	isBusy(): boolean;
}

export interface DoneNudge {
	runStarting(prompt: string | undefined): void;
	settled(
		messages: readonly { role?: string; stopReason?: string }[] | undefined,
		aborted: boolean,
		ctx: DoneNudgeContext,
	): void;
	cancel(): void;
}

/** A run that ended on its own, not by an abort or a provider error. */
export function endedNormally(
	messages: readonly { role?: string; stopReason?: string }[] | undefined,
): boolean {
	if (!messages) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		return message.stopReason !== "aborted" && message.stopReason !== "error";
	}
	return false;
}

/**
 * Speaks at most once per run that something else started, so a child that
 * answers "waiting" is not asked again until new input arrives.
 */
export function createDoneNudge(options: DoneNudgeOptions): DoneNudge {
	let armed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function cancel() {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	}

	function fire(ctx: DoneNudgeContext) {
		timer = undefined;
		if (!armed) return;
		try {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			if (ctx.ui?.getEditorText?.()?.trim()) return;
		} catch {
			// A context that cannot answer is not one to interrupt.
			return;
		}
		if (options.isBusy()) return;
		armed = false;
		options.send(DONE_NUDGE_MESSAGE);
	}

	return {
		runStarting(prompt) {
			cancel();
			armed = prompt !== DONE_NUDGE_MESSAGE;
		},
		settled(messages, aborted, ctx) {
			cancel();
			if (!armed || aborted || !endedNormally(messages)) return;
			timer = setTimeout(() => fire(ctx), DONE_NUDGE_DELAY_MS);
			timer.unref?.();
		},
		cancel,
	};
}
