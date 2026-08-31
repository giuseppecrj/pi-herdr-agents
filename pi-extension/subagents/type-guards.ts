/**
 * Runtime predicates for validating values read from an I/O boundary
 * (JSON files, subprocess output, CLI responses) before they are trusted
 * as a concrete domain type. Callers pass the raw, unvalidated value
 * (typed `any` at the boundary, matching `JSON.parse`'s own return type)
 * and receive a boolean verdict instead of narrowing with `typeof`.
 */

/** A JSON object whose undefined properties are omitted by JSON.stringify. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/** A JSON-serializable value, for freeform log/session/telemetry payloads. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export function isString(value: any): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

export function isNonEmptyString(value: any): value is string {
  return isString(value) && value.length > 0;
}

export function isFiniteNumber(value: any): value is number {
  return Number.isFinite(value);
}

export function isBoolean(value: any): value is boolean {
  return value === true || value === false;
}

export function isPlainObject(value: any): boolean {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}
