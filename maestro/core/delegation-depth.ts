/**
 * Host-enforced delegation depth. A top-level parent session has depth 0 and
 * every launch exports `PI_SUBAGENT_DEPTH=<parent depth + 1>` to its child.
 * The raw environment string is parsed once, here, into a typed value.
 */

export const DELEGATION_DEPTH_ENV = "PI_SUBAGENT_DEPTH";

/** Parent 0, children 1, grandchildren 2, great-grandchildren 3. */
export const DEFAULT_MAX_DELEGATION_DEPTH = 3;

export type DelegationDepth =
	| { kind: "known"; depth: number }
	| { kind: "unknown"; raw: string };

/**
 * An absent variable means a top-level session (depth 0). A present value must
 * be a canonical non-negative decimal integer; anything else is unknown and is
 * never treated as 0, so a corrupted value cannot reset the count.
 */
export function parseDelegationDepth(raw: string | undefined): DelegationDepth {
	if (raw === undefined) return { kind: "known", depth: 0 };
	if (/^(0|[1-9]\d*)$/.test(raw)) {
		const depth = Number(raw);
		if (Number.isSafeInteger(depth)) return { kind: "known", depth };
	}
	return { kind: "unknown", raw };
}

export type DelegationDecision =
	| { allowed: true; childDepth: number }
	| { allowed: false; reason: "unknown-depth" | "max-depth"; message: string };

/** Decide whether a session at `parent` depth may launch one more child. */
export function decideDelegation(
	parent: DelegationDepth,
	maxDepth: number,
): DelegationDecision {
	if (parent.kind === "unknown") {
		return {
			allowed: false,
			reason: "unknown-depth",
			message:
				`Delegation refused: ${DELEGATION_DEPTH_ENV}=${JSON.stringify(parent.raw)} is not a non-negative integer, ` +
				"so this session's delegation depth is unknown and is treated as already at the limit. " +
				`Unset ${DELEGATION_DEPTH_ENV} in the environment that started this session, or do the work directly.`,
		};
	}
	const childDepth = parent.depth + 1;
	if (childDepth > maxDepth) {
		return {
			allowed: false,
			reason: "max-depth",
			message:
				`Delegation refused: this session is at delegation depth ${parent.depth} and the maximum is ${maxDepth} ` +
				`(spawning.maxDepth in config.json), so it cannot launch another child. ` +
				"Complete the work directly, or ask the user to raise spawning.maxDepth.",
		};
	}
	return { allowed: true, childDepth };
}

/**
 * The depth to export to a child launched from a session with this
 * environment. Throws on an unknown parent depth rather than guessing.
 */
export function childDelegationDepth(
	rawParentDepth: string | undefined,
): number {
	const parent = parseDelegationDepth(rawParentDepth);
	if (parent.kind === "unknown") {
		throw new Error(
			`Cannot launch a child: ${DELEGATION_DEPTH_ENV}=${JSON.stringify(parent.raw)} is not a non-negative integer.`,
		);
	}
	return parent.depth + 1;
}
