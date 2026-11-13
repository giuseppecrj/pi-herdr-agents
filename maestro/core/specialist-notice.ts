/**
 * Bounds for persistent-specialist notices (ADR-0019). The parent's checks
 * decide; the child's stricter checks only spare a compliant child a drop.
 */

/** Notices the parent delivers per specialist generation. */
export const NOTICE_CAP = 50;
/** The child tool refuses a notice sooner than this after its previous one. */
export const NOTICE_CHILD_INTERVAL_MS = 30_000;
/** The parent drops, and counts, a notice sooner than this after the last delivered one. */
export const NOTICE_PARENT_INTERVAL_MS = 15_000;
/** Bound for the encoded notice message in the parent's host line. */
export const NOTICE_MESSAGE_CHARS = 4_000;

/** Parent-owned notice accounting for one specialist generation. */
export interface NoticeBudget {
	delivered: number;
	/** Notices dropped by the rate limit and not yet reported to the parent. */
	unreported: number;
	/** Parent clock of the last delivered notice. */
	lastAt?: number;
}

/** Refuse notices for a non-persistent run before any resource exists. */
export function notifyLaunchRefusal(behavior: {
	persistent: boolean;
	notify?: boolean;
}): string | undefined {
	return behavior.notify && !behavior.persistent
		? "notify requires a persistent specialist; an ordinary child reports through its result or caller_ping."
		: undefined;
}

export type NoticeAdmission = "deliver" | "rate-limited" | "capped";

export function admitNotice(
	budget: NoticeBudget,
	now: number,
): NoticeAdmission {
	if (budget.delivered >= NOTICE_CAP) return "capped";
	if (
		budget.lastAt !== undefined &&
		now - budget.lastAt < NOTICE_PARENT_INTERVAL_MS
	)
		return "rate-limited";
	return "deliver";
}

/**
 * The child's own refusal before it records a notice, from the notices this
 * generation already recorded; `undefined` means it may send.
 */
export function childNoticeRefusal(
	previous: { sent: number; lastAt?: number },
	now: number,
): string | undefined {
	if (previous.sent >= NOTICE_CAP)
		return `This specialist has used its notice cap (${NOTICE_CAP}); the parent ignores further notices. Wait for subagent_send.`;
	if (previous.lastAt === undefined || Number.isNaN(previous.lastAt))
		return undefined;
	const wait = previous.lastAt + NOTICE_CHILD_INTERVAL_MS - now;
	if (wait > 0)
		return `Notices must be at least ${NOTICE_CHILD_INTERVAL_MS / 1_000} seconds apart; try again in ${Math.ceil(wait / 1_000)} s. Nothing was sent.`;
	return undefined;
}
