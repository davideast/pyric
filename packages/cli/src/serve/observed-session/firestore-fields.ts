/**
 * Field-level edits of an observed Firestore document as the host folds them:
 * a `set` with `merge` deep-merges maps, an `update` sets dotted field paths,
 * and `deleteFields` removes them. Serialized special values (timestamps,
 * geopoints, bytes, vectors, references) are leaves, never maps to merge into.
 */
import { FORBIDDEN_KEYS, isPlainObject } from './json-values.js';

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function clonePlainEntries(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    defineOwn(out, k, structuredClone(v));
  }
  return out;
}

export function isEscapedPlainMap(
  value: Record<string, unknown>,
): value is { type: 'pyric/map/1.0'; fields: Record<string, unknown> } {
  return (
    Object.keys(value).length === 2 &&
    value.type === 'pyric/map/1.0' &&
    isPlainObject(value.fields)
  );
}

/**
 * True when `value` is one of the 5 serialized Firestore scalar/reference
 * shapes recognized by `@pyric/ui` and `rehydrateFirestoreDocData`, so map
 * merges treat it as an atomic leaf rather than a nested map.
 */
export function isSerializedFirestoreLeafObject(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (
    (keys.length === 2 || (keys.length === 3 && value.type === 'firestore/timestamp/1.0')) &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number'
  ) {
    return true;
  }
  if (
    (keys.length === 2 || (keys.length === 3 && value.type === 'firestore/geoPoint/1.0')) &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number'
  ) {
    return true;
  }
  if (
    keys.length === 2 &&
    value.type === 'firestore/bytes/1.0' &&
    typeof value.bytes === 'string'
  ) {
    return true;
  }
  if (
    keys.length === 2 &&
    value.__type__ === '__vector__' &&
    Array.isArray(value.value) &&
    value.value.every((n) => typeof n === 'number')
  ) {
    return true;
  }
  if (
    keys.length === 2 &&
    value.type === 'firestore/vectorValue/1.0' &&
    Array.isArray(value.vectorValues) &&
    value.vectorValues.every((n) => typeof n === 'number')
  ) {
    return true;
  }
  if (
    (keys.length === 3 &&
      value.type === 'document' &&
      typeof value.path === 'string' &&
      typeof value.id === 'string') ||
    ((keys.length === 2 || keys.length === 3) &&
      value.__type === 'reference' &&
      typeof value.path === 'string')
  ) {
    return true;
  }
  return false;
}

function wrapPlainMapIfColliding(map: Record<string, unknown>, isRoot: boolean): Record<string, unknown> {
  if (isRoot) {
    return isEscapedPlainMap(map) ? { type: 'pyric/map/1.0', fields: map } : map;
  }
  if (isSerializedFirestoreLeafObject(map) || isEscapedPlainMap(map)) {
    return { type: 'pyric/map/1.0', fields: map };
  }
  return map;
}

function mergeFirestoreMapsInternal(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  isRoot: boolean,
): Record<string, unknown> {
  const unwrappedTarget = isEscapedPlainMap(target) ? target.fields : target;
  const unwrappedSource = isEscapedPlainMap(source) ? source.fields : source;
  const next = clonePlainEntries(unwrappedTarget);
  for (const [key, value] of Object.entries(unwrappedSource)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const existing = next[key];
    const valueIsMap = isPlainObject(value) && !isSerializedFirestoreLeafObject(value);
    const existingIsMap = isPlainObject(existing) && !isSerializedFirestoreLeafObject(existing);
    if (valueIsMap && existingIsMap) {
      defineOwn(next, key, mergeFirestoreMapsInternal(existing, value, false));
    } else {
      defineOwn(next, key, structuredClone(value));
    }
  }
  return wrapPlainMapIfColliding(next, isRoot);
}

export function deepMergeFirestoreMap(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return mergeFirestoreMapsInternal(target, source, true);
}

function setDottedSegments(
  cursor: Record<string, unknown>,
  parts: readonly string[],
  index: number,
  value: unknown,
): void {
  const seg = parts[index]!;
  if (FORBIDDEN_KEYS.has(seg)) return;
  if (index === parts.length - 1) {
    defineOwn(cursor, seg, structuredClone(value));
    return;
  }
  const current = cursor[seg];
  let inner: Record<string, unknown>;
  if (!isPlainObject(current) || isSerializedFirestoreLeafObject(current)) {
    inner = {};
  } else {
    inner = clonePlainEntries(isEscapedPlainMap(current) ? current.fields : current);
  }
  setDottedSegments(inner, parts, index + 1, value);
  defineOwn(cursor, seg, wrapPlainMapIfColliding(inner, false));
}

export function setDottedField(target: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.');
  if (parts.length === 0) return;
  setDottedSegments(target, parts, 0, value);
}

function deleteDottedSegments(
  cursor: Record<string, unknown>,
  parts: readonly string[],
  index: number,
): void {
  const seg = parts[index]!;
  if (FORBIDDEN_KEYS.has(seg)) return;
  if (index === parts.length - 1) {
    delete cursor[seg];
    return;
  }
  const current = cursor[seg];
  if (!isPlainObject(current) || isSerializedFirestoreLeafObject(current)) return;
  const inner = clonePlainEntries(isEscapedPlainMap(current) ? current.fields : current);
  deleteDottedSegments(inner, parts, index + 1);
  defineOwn(cursor, seg, wrapPlainMapIfColliding(inner, false));
}

export function deleteDottedField(target: Record<string, unknown>, fieldPath: string): void {
  const parts = fieldPath.split('.');
  if (parts.length === 0) return;
  deleteDottedSegments(target, parts, 0);
}

