/**
 * Bounded JSON copy for Firestore `ObservedCall.writeData` and `document`
 * fields, escaping plain user maps whose keys collide with the 6 internal
 * Firestore sentinel/wrapper marker shapes (`pyric/map/1.0`).
 *
 * Imports no Firebase SDK so page and Node planes share one implementation.
 */
import { isPlainObject } from './json-copy.js';

const MAX_DEPTH = 20;
const MAX_FIELDS_SIZE = 64 * 1024;
const ESCAPED_MAP_TYPE = 'pyric/map/1.0' as const;
const ESCAPED_WRAPPER_BUDGET_BYTES = 33;

interface Budget {
  left: number;
}

const NOT_JSON: unique symbol = Symbol('not-json');

function defineOwnField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * True when a plain user map owns any of the 6 canonical Firestore marker
 * key shapes (`__type`, `type`, `__type__`, `_methodName`, `typeName`, or
 * `id` + `path`).
 */
export function hasCollidingFirestoreShape(map: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(map, '__type') ||
    Object.hasOwn(map, 'type') ||
    Object.hasOwn(map, '__type__') ||
    Object.hasOwn(map, '_methodName') ||
    Object.hasOwn(map, 'typeName') ||
    (Object.hasOwn(map, 'id') && Object.hasOwn(map, 'path'))
  );
}

function copyFirestoreJsonValue(value: unknown, depth: number, budget: Budget): unknown {
  if (typeof value === 'string') {
    budget.left -= value.length + 2;
    return value;
  }
  const isScalar =
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
  if (isScalar) {
    budget.left -= 8;
    return value;
  }
  if (depth >= MAX_DEPTH) return NOT_JSON;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const copied = copyFirestoreJsonValue(item, depth + 1, budget);
      if (copied === NOT_JSON || budget.left < 0) return NOT_JSON;
      out.push(copied);
    }
    return out;
  }
  if (!isPlainObject(value)) return NOT_JSON;
  return copyFirestoreJsonObject(value, depth, budget);
}

function copyFirestoreJsonObject(
  fields: Record<string, unknown>,
  depth: number,
  budget: Budget,
): Record<string, unknown> | typeof NOT_JSON {
  const wrapsColliding = hasCollidingFirestoreShape(fields);
  const childBaseDepth = wrapsColliding ? depth + 1 : depth;
  if (childBaseDepth >= MAX_DEPTH) return NOT_JSON;
  if (wrapsColliding) {
    budget.left -= ESCAPED_WRAPPER_BUDGET_BYTES;
    if (budget.left < 0) return NOT_JSON;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    budget.left -= key.length + 4;
    const copied = copyFirestoreJsonValue(field, childBaseDepth + 1, budget);
    if (copied === NOT_JSON || budget.left < 0) return NOT_JSON;
    defineOwnField(out, key, copied);
  }
  if (wrapsColliding) {
    return { type: ESCAPED_MAP_TYPE, fields: out };
  }
  return out;
}

/**
 * Bounded JSON copy of a Firestore document or write payload for `ObservedCall`,
 * escaping colliding user maps in `{ type: 'pyric/map/1.0', fields }`.
 */
export function firestoreJsonFields(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const budget: Budget = { left: MAX_FIELDS_SIZE };
  const copied = copyFirestoreJsonObject(value, 0, budget);
  if (copied === NOT_JSON || budget.left < 0) return undefined;
  return copied;
}
