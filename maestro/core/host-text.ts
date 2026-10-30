import { shellQuote } from "./shell.ts";

/**
 * Host text for parent-facing sinks. Three policies, never mixed:
 * - display values in a host line are encoded and bounded (`encodeHostValue`);
 * - executable command arguments are serialized losslessly or omitted
 *   (`jsonArgument`, `shellArgument`), never encoded or abbreviated;
 * - child text in a terminal view is split on every line separator and its
 *   controls are shown as escapes before any prefix (`displayLines`).
 */

/** A literal report delimiter in any case, opening or closing. */
export const REPORT_DELIMITER = /<(\/?subagent_report)/gi;

/** Default bound for one variable value inside a host line. */
export const HOST_VALUE_CHARS = 200;
/** Bound for a path or a short diagnostic. */
export const HOST_PATH_CHARS = 1_000;
/** Bound for an error relayed from a child or a tool. */
export const HOST_ERROR_CHARS = 4_000;

// Every C0/C1 control, Unicode line and paragraph separators, and every bidi
// control: anything that could start a new line or reorder what a reader sees.
const UNSAFE_HOST_CHAR = /[\p{Cc}\u2028\u2029\p{Bidi_Control}]/gu;
const UNSAFE_HOST_CHAR_TEST = /[\p{Cc}\u2028\u2029\p{Bidi_Control}]/u;
// JSON.stringify already escapes C0 controls, quotes and backslashes.
const UNSAFE_JSON_CHAR = /[\u007f-\u009f\u2028\u2029\p{Bidi_Control}<]/gu;
const DISPLAY_LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
const DISPLAY_CONTROL = /[\p{Cc}\p{Bidi_Control}]/gu;
const SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

function escapeChar(char: string): string {
	return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** Keep at most `count` leading code units without splitting a surrogate pair. */
function sliceHead(value: string, count: number): string {
	const code = value.charCodeAt(count - 1);
	return value.slice(0, code >= 0xd800 && code <= 0xdbff ? count - 1 : count);
}

/** Keep at most `count` trailing code units without splitting a surrogate pair. */
function sliceTail(value: string, count: number): string {
	if (count <= 0) return "";
	const start = value.length - count;
	const code = value.charCodeAt(start);
	return value.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start);
}

/** Bound one value by replacing its middle with `marker`. */
export function abbreviateMiddle(
	value: string,
	maxChars: number,
	marker: string,
): string {
	if (value.length <= maxChars) return value;
	const retainedChars = Math.max(0, maxChars - marker.length);
	return (
		sliceHead(value, Math.ceil(retainedChars / 2)) +
		marker +
		sliceTail(value, Math.floor(retainedChars / 2))
	);
}

/**
 * The encoding policy for any child-, transcript- or environment-influenced
 * value shown in a host line: JSON string escaping (so `\n`, `"` and `\` stay
 * visible as escapes), every other control, separator or bidi control as
 * `\uXXXX`, report delimiters neutralized, and a bounded length. The result is
 * always one line. Callers keep the original value in structured details.
 */
export function encodeHostValue(
	value: string,
	maxChars: number = HOST_VALUE_CHARS,
): string {
	const escaped = JSON.stringify(value)
		.slice(1, -1)
		.replace(UNSAFE_HOST_CHAR, escapeChar)
		.replace(REPORT_DELIMITER, "&lt;$1");
	return abbreviateMiddle(escaped, maxChars, " [... abbreviated ...] ");
}

/** Host-authored text forced onto one line: controls become visible escapes. */
export function oneLine(text: string): string {
	return text.replace(UNSAFE_HOST_CHAR, escapeChar);
}

/**
 * A lossless JSON string literal for an executable argument: `JSON.parse`
 * returns `value` exactly. It is always one line and never contains a report
 * delimiter, because separators, bidi controls and `<` are `\uXXXX` escapes.
 */
export function jsonArgument(value: string): string {
	return JSON.stringify(value).replace(UNSAFE_JSON_CHAR, escapeChar);
}

/**
 * A shell word that a POSIX shell reads back as exactly `value`, or undefined
 * when no one-line form is safe to show (a line break or other control).
 */
export function shellArgument(value: string): string | undefined {
	if (SHELL_WORD.test(value)) return value;
	if (!value || UNSAFE_HOST_CHAR_TEST.test(value)) return undefined;
	return shellQuote(value);
}

/**
 * Child text for a terminal view: one entry per displayed line, split on CR,
 * LF, CRLF, NEL, VT, FF and U+2028/U+2029, with every remaining control
 * (ESC, CSI, bidi controls) shown as `\uXXXX`. Tabs stay; the renderer
 * expands them.
 */
export function displayLines(text: string): string[] {
	return text
		.split(DISPLAY_LINE_BREAK)
		.map((line) =>
			line.replace(DISPLAY_CONTROL, (char) =>
				char === "\t" ? char : escapeChar(char),
			),
		);
}
