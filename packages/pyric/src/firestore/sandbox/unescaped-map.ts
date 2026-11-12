import {
  registerActivityValue,
  registeredActivityValue,
} from './activity-value-registry.js';
import { registeredReferenceQueryValuePath } from './query-value-registry.js';

export const UNESCAPED_MAP_TAG = Symbol.for('pyric.unescapedMap');

const SENTINEL_REGISTRY_KEY = Symbol.for('pyric.firestore.field-value-sentinels');
const globalSentinelStore = globalThis as { [SENTINEL_REGISTRY_KEY]?: WeakSet<object> };
const registeredSentinels: WeakSet<object> =
  globalSentinelStore[SENTINEL_REGISTRY_KEY] ??
  (globalSentinelStore[SENTINEL_REGISTRY_KEY] = new WeakSet());

export function markFieldValueSentinel<T extends object>(sentinel: T): T {
  registeredSentinels.add(sentinel);
  return sentinel;
}

export function isRegisteredFieldValueSentinel(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && registeredSentinels.has(value);
}

export function isUnescapedUserMap(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[UNESCAPED_MAP_TAG] === true
  );
}

export function stampUnescapedUserMap<T extends Record<string, unknown>>(target: T): T {
  Object.defineProperty(target, UNESCAPED_MAP_TAG, { value: true });
  return target;
}

export function copyUnescapedUserMapTag<T extends Record<string, unknown>>(
  source: unknown,
  target: T,
): T {
  if (isUnescapedUserMap(source)) {
    stampUnescapedUserMap(target);
  }
  return target;
}

export function hasCollidingFirestoreMarkerShape(map: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(map, '__type') ||
    Object.hasOwn(map, 'type') ||
    Object.hasOwn(map, '__type__') ||
    (Object.hasOwn(map, 'id') && Object.hasOwn(map, 'path'))
  );
}

/**
 * Mark user-supplied plain map literals whose keys collide with internal
 * Firestore sentinel or wrapper markers (`__type`, `type`, `__type__`, or
 * serialized `id`+`path`), while leaving genuine `FieldValue.*` sentinels,
 * `DocumentReference` handles, and scalar wrapper instances untouched.
 */
export function markUserWriteValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = markUserWriteValue(item);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  if (isRegisteredFieldValueSentinel(value)) {
    if (
      (value.__type === 'arrayUnion' || value.__type === 'arrayRemove') &&
      Array.isArray(value.values)
    ) {
      let changed = false;
      const nextValues = value.values.map((item) => {
        const mapped = markUserWriteValue(item);
        if (mapped !== item) changed = true;
        return mapped;
      });
      if (!changed) return value;
      return markFieldValueSentinel({ __type: value.__type, values: nextValues });
    }
    return value;
  }
  if (registeredReferenceQueryValuePath(value) !== undefined) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const record = value as Record<string, unknown>;
  let childChanged = false;
  const entries = Object.entries(record).map(([key, item]) => {
    const mapped = markUserWriteValue(item);
    if (mapped !== item) childChanged = true;
    return [key, mapped] as const;
  });
  const alreadyStamped = isUnescapedUserMap(record);
  const needsStamp = !alreadyStamped && hasCollidingFirestoreMarkerShape(record);
  if (!childChanged && !needsStamp) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    Object.defineProperty(out, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (alreadyStamped || hasCollidingFirestoreMarkerShape(out)) {
    stampUnescapedUserMap(out);
  }
  const activity = registeredActivityValue(record);
  if (activity !== undefined) {
    registerActivityValue(out, activity);
  }
  return out;
}
