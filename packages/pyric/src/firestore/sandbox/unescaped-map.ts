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

const UNESCAPED_MAP_REGISTRY_KEY = Symbol.for('pyric.firestore.unescaped-user-maps');
const globalUnescapedMapStore = globalThis as { [UNESCAPED_MAP_REGISTRY_KEY]?: WeakSet<object> };
const registeredUnescapedUserMaps: WeakSet<object> =
  globalUnescapedMapStore[UNESCAPED_MAP_REGISTRY_KEY] ??
  (globalUnescapedMapStore[UNESCAPED_MAP_REGISTRY_KEY] = new WeakSet());

export function markFieldValueSentinel<T extends object>(sentinel: T): T {
  registeredSentinels.add(sentinel);
  return sentinel;
}

export function isRegisteredFieldValueSentinel(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && registeredSentinels.has(value);
}

export function registerUnescapedUserMapClone<T extends object>(map: T): T {
  registeredUnescapedUserMaps.add(map);
  return map;
}

export function isRegisteredUnescapedUserMap(value: unknown): boolean {
  return typeof value === 'object' && value !== null && registeredUnescapedUserMaps.has(value);
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
  if (isUnescapedUserMap(source) || isRegisteredUnescapedUserMap(source)) {
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

/**
 * Collect JSON-safe paths to plain user maps carrying `UNESCAPED_MAP_TAG` (or
 * registered in `registeredUnescapedUserMaps`). Root map is represented as `[]`.
 */
export function collectUnescapedUserMapPaths(value: unknown): (string | number)[][] {
  const paths: (string | number)[][] = [];
  const walk = (node: unknown, currentPath: (string | number)[]): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], [...currentPath, i]);
      }
      return;
    }
    if (!isPlainMapRecord(node)) return;
    if (
      (isUnescapedUserMap(node) || isRegisteredUnescapedUserMap(node)) &&
      hasCollidingFirestoreMarkerShape(node)
    ) {
      paths.push([...currentPath]);
    }
    for (const [key, item] of Object.entries(node)) {
      walk(item, [...currentPath, key]);
    }
  };
  walk(value, []);
  return paths;
}

/**
 * Non-mutating clone that stamps `UNESCAPED_MAP_TAG` on plain maps at each
 * recorded path so in-memory callers never leak internal symbols onto public events.
 */
export function applyUnescapedUserMapPaths<T>(
  value: T,
  paths: readonly (readonly (string | number)[])[] | undefined,
): T {
  if (paths === undefined || paths.length === 0) return value;
  const targetKeys = new Set(paths.map((p) => JSON.stringify(p)));
  const walk = (node: unknown, currentPath: (string | number)[]): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      return node.map((item, idx) => walk(item, [...currentPath, idx]));
    }
    if (!isPlainMapRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      Object.defineProperty(out, key, {
        value: walk(item, [...currentPath, key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (
      targetKeys.has(JSON.stringify(currentPath)) ||
      isUnescapedUserMap(node) ||
      isRegisteredUnescapedUserMap(node)
    ) {
      stampUnescapedUserMap(out);
    }
    return out;
  };
  return walk(value, []) as T;
}

/**
 * Return a symbol-clean, unencoded clone of a plain value tree while registering
 * any colliding user maps in `registeredUnescapedUserMaps` for in-memory consumers.
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
  if (
    (isUnescapedUserMap(value) || isRegisteredUnescapedUserMap(value)) &&
    hasCollidingFirestoreMarkerShape(out)
  ) {
    registerUnescapedUserMapClone(out);
  }
  return out;
}

/**
 * Mark user-supplied plain map literals whose keys collide with internal
 * Firestore sentinel or wrapper markers, while leaving genuine `FieldValue.*`
 * sentinels, `DocumentReference` handles, and scalar wrapper instances untouched.
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
  const alreadyStamped = isUnescapedUserMap(record) || isRegisteredUnescapedUserMap(record);
  const needsStamp = !isUnescapedUserMap(record) && hasCollidingFirestoreMarkerShape(record);
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
