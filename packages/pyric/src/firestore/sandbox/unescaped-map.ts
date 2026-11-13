import {
  registerActivityValue,
  registeredActivityValue,
} from './activity-value-registry.js';
import { registeredReferenceQueryValuePath } from './query-value-registry.js';

const UNESCAPED_MAP_TAG = Symbol.for('pyric.unescapedMap');

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

function isPlainMapRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasCollidingFirestoreMarkerShape(map: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(map, '__type') ||
    Object.hasOwn(map, 'type') ||
    Object.hasOwn(map, '__type__') ||
    Object.hasOwn(map, '_methodName') ||
    Object.hasOwn(map, 'typeName') ||
    (Object.hasOwn(map, 'id') && Object.hasOwn(map, 'path'))
  );
}

function isCollidingWireMarkerMap(rec: Record<string, unknown>): boolean {
  if (typeof rec._methodName === 'string') return true;
  if (typeof rec.__type === 'string') return true;
  if (typeof rec.typeName === 'string') return true;
  if (rec.__type__ === '__vector__' && Array.isArray(rec.value)) return true;
  if (
    rec.type === 'pyric/map/1.0' &&
    Object.keys(rec).length === 2 &&
    isPlainMapRecord(rec.fields)
  ) {
    return true;
  }
  if (rec.type === 'pyric/number/1.0' && Object.keys(rec).length === 2) {
    return true;
  }
  if (typeof rec.type === 'string' && rec.type.startsWith('firestore/')) {
    return true;
  }
  if (typeof rec.id === 'string' && typeof rec.path === 'string') {
    return true;
  }
  return false;
}

/**
 * Strip `UNESCAPED_MAP_TAG` while wrapping marker-colliding user maps into
 * `{ type: 'pyric/map/1.0', fields }` at public event and snapshot boundaries,
 * so `JSON.stringify` / `structuredClone` round-trips stay unambiguous without
 * exposing internal symbols on returned objects.
 */
export function encodeBoundaryMapValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(encodeBoundaryMapValue);
  }
  if (!isPlainMapRecord(value)) return value;
  const fields: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(fields, key, {
      value: encodeBoundaryMapValue(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (isUnescapedUserMap(value) && (isCollidingWireMarkerMap(value) || isCollidingWireMarkerMap(fields))) {
    return { type: 'pyric/map/1.0', fields };
  }
  return fields;
}

/**
 * Return a symbol-clean clone of a plain value tree without wrapping maps
 * (used by direct document read surfaces like `admin.getDocument`).
 */
export function stripUnescapedUserMapTag(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(stripUnescapedUserMapTag);
  }
  if (!isPlainMapRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: stripUnescapedUserMapTag(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
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
