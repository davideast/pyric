/**
 * The JSON measures observed session data shares: its size in UTF-8 bytes,
 * what counts as a plain record, and the keys no record may carry.
 */

/** Keys that would reach an object's prototype, refused in every path and record. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The UTF-8 byte length of a value's JSON, the unit every session cap counts in. */
export function byteLengthOf(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 0;
  return Buffer.byteLength(serialized, 'utf8');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
