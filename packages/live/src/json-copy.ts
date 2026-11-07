/**
 * A bounded JSON copy of a value a call wrote or read, for the host's local
 * rules: a Firestore write's fields or returned document, an RTDB write's
 * value. The host re-checks every copy against the same bound
 * (`readObservedCall` in pyric's observed-call contract); this runs in the
 * page, which cannot import that module, so it measures the same way. This
 * file imports no Firebase SDK.
 */
import type { LiveWriteValue } from './observe.js';

/** The deepest nesting a JSON copy keeps; the host refuses deeper. */
const MAX_DEPTH = 20;
/** The most a host keeps of written data or a returned document, as it measures it: a string's length plus 2, a key's plus 4, any other scalar 8. */
const MAX_FIELDS_SIZE = 64 * 1024;

interface Budget {
  left: number;
}

const NOT_JSON: unique symbol = Symbol('not-json');

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

/** Whether a value is a plain object (an object literal or a null-prototype one), not a class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A JSON copy of a value, or `NOT_JSON` when it holds anything else or runs past the budget. */
function jsonCopy(value: unknown, depth: number, budget: Budget): unknown {
  if (typeof value === 'string') {
    budget.left -= value.length + 2;
    return value;
  }
  const isScalar = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  if (isScalar) {
    budget.left -= 8;
    return value;
  }
  const isNested = isObject(value) && depth < MAX_DEPTH;
  if (!isNested) return NOT_JSON;
  if (Array.isArray(value)) return jsonItems(value, depth, budget);
  return isPlainObject(value) ? jsonEntries(value, depth, budget) : NOT_JSON;
}

function jsonItems(items: readonly unknown[], depth: number, budget: Budget): unknown {
  const copy: unknown[] = [];
  for (const item of items) {
    const copied = jsonCopy(item, depth + 1, budget);
    if (copied === NOT_JSON || budget.left < 0) return NOT_JSON;
    copy.push(copied);
  }
  return copy;
}

function jsonEntries(fields: object, depth: number, budget: Budget): unknown {
  const entries: [string, unknown][] = [];
  for (const [key, field] of Object.entries(fields)) {
    budget.left -= key.length + 4;
    const copied = jsonCopy(field, depth + 1, budget);
    if (copied === NOT_JSON || budget.left < 0) return NOT_JSON;
    entries.push([key, copied]);
  }
  return Object.fromEntries(entries);
}

/** A JSON copy of any value, or undefined when it is not plain JSON or larger than a host keeps. */
export function jsonValue(value: unknown): LiveWriteValue | undefined {
  const budget = { left: MAX_FIELDS_SIZE };
  const copy = jsonCopy(value, 0, budget);
  if (copy === NOT_JSON || budget.left < 0) return undefined;
  return copy as LiveWriteValue;
}

/** A JSON copy of a document's fields, or undefined when they are not plain JSON or larger than a host keeps. */
export function jsonFields(value: unknown): Record<string, unknown> | undefined {
  const isFields = isObject(value) && !Array.isArray(value);
  if (!isFields) return undefined;
  return jsonValue(value) as Record<string, unknown> | undefined;
}
