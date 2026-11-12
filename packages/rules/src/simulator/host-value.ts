import { FirestoreSet } from './firestore-set.js';
import { MapDiff } from './mapdiff.js';
import { isRulesMap } from './rules-type.js';

/**
 * A rules value as a JSON-safe host value. An int held as a bigint
 * (`rules-int.ts`) becomes a JavaScript number when it is at most 2^53 in
 * magnitude, and its decimal digits otherwise, inside lists, maps, sets and
 * map diffs too. Every other value is returned as it is, and a collection
 * with no bigint in it is returned unchanged rather than copied.
 *
 * Expression traces hold evaluated values, and traces reach
 * `JSON.stringify` and the worker bridge, which cannot hold a bigint. The
 * trace recorder converts each value once, sharing `seen` across one rule's
 * trace so a document read many times is walked once.
 */
export function toHostValue(value: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown {
  if (typeof value === 'bigint') return hostInt(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  seen.set(value, value);
  const converted = convertCollection(value, seen);
  seen.set(value, converted);
  return converted;
}

function hostInt(value: bigint): number | string {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}

function convertCollection(value: object, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) return convertList(value, seen);
  if (value instanceof FirestoreSet) {
    const items = value.toArray();
    const converted = convertList(items, seen);
    return converted === items ? value : new FirestoreSet(converted);
  }
  if (value instanceof MapDiff) return value.withMaps((map) => convertMap(map, seen));
  if (isRulesMap(value)) return convertMap(value, seen);
  return value;
}

function convertList(items: unknown[], seen: WeakMap<object, unknown>): unknown[] {
  const converted = items.map((item) => toHostValue(item, seen));
  return converted.every((item, index) => item === items[index]) ? items : converted;
}

function convertMap(map: Record<string, unknown>, seen: WeakMap<object, unknown>): Record<string, unknown> {
  let changed = false;
  const entries = Object.keys(map).map((key) => {
    const converted = toHostValue(map[key], seen);
    if (converted !== map[key]) changed = true;
    return [key, converted] as const;
  });
  return changed ? Object.fromEntries(entries) : map;
}
