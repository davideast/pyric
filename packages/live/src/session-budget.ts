/**
 * The byte budget a session-data copy spends, in the unit the live host
 * measures: UTF-8 bytes of the value's JSON. A host refuses an item over
 * 512 KiB and a delta over 1 MiB; the client caps each at half that, so the
 * paths and op envelopes around the copied values always fit.
 *
 * Each charge is an upper bound on the bytes its token adds to the JSON: a
 * string or key is charged its quoted, escaped UTF-8 length plus one
 * separator (`,` or `:`), a number its printed length plus one (at least 8),
 * `null` and booleans 8, and a container its two brackets plus a separator.
 */

/** The most one observed document or RTDB value may spend. */
export const MAX_SESSION_ITEM_BYTES = 256 * 1024;
/** The most all values of one delta may spend together. */
export const MAX_SESSION_DELTA_BYTES = 512 * 1024;

/** What is left to spend; it goes negative once a copy runs past it. */
export interface SessionBudget {
  left: number;
}

const ENCODER = new TextEncoder();
const SCALAR_CHARGE = 8;
const SEPARATOR_CHARGE = 1;
const CONTAINER_CHARGE = 3;

/** UTF-8 bytes of a value's JSON, quotes and escapes included. */
export function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 0;
  return ENCODER.encode(serialized).byteLength;
}

/** Charges a string value or an object key; true while the budget holds. */
export function chargeString(budget: SessionBudget, text: string): boolean {
  budget.left -= jsonByteLength(text) + SEPARATOR_CHARGE;
  return budget.left >= 0;
}

/** Charges `null`, a boolean or a finite number; true while the budget holds. */
export function chargeScalar(budget: SessionBudget, value: null | boolean | number): boolean {
  let charge = SCALAR_CHARGE;
  if (typeof value === 'number') charge = Math.max(SCALAR_CHARGE, String(value).length + SEPARATOR_CHARGE);
  budget.left -= charge;
  return budget.left >= 0;
}

/** Charges one array's or object's brackets; true while the budget holds. */
export function chargeContainer(budget: SessionBudget): boolean {
  budget.left -= CONTAINER_CHARGE;
  return budget.left >= 0;
}

/** Charges a complete JSON value (a serialized SDK type); true while the budget holds. */
export function chargeJson(budget: SessionBudget, value: unknown): boolean {
  budget.left -= jsonByteLength(value) + SEPARATOR_CHARGE;
  return budget.left >= 0;
}
