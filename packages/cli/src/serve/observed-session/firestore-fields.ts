/**
 * Field-level edits of an observed Firestore document as the host folds them:
 * a `set` with `merge` deep-merges maps, an `update` sets dotted field paths,
 * and `deleteFields` removes them. Serialized special values (timestamps,
 * geopoints, bytes, vectors, references) are leaves, never maps to merge into.
 */
import { hasCollidingFirestoreMarkerShape } from 'pyric/sandbox/internal';
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
function isSerializedFirestoreLeafObject(value: Record<string, unknown>): boolean {
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
    value.type === 'pyric/number/1.0' &&
    (value.value === 'NaN' ||
      value.value === 'Infinity' ||
      value.value === '-Infinity' ||
      value.value === '-0')
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
    ((keys.length === 3 || (keys.length === 4 && typeof value.databaseId === 'string')) &&
      value.type === 'document' &&
      typeof value.path === 'string' &&
      typeof value.id === 'string') ||
    ((keys.length === 2 || (keys.length === 3 && typeof value.databaseId === 'string')) &&
      value.__type === 'reference' &&
      typeof value.path === 'string')
  ) {
    return true;
  }
  return false;
}

function wrapPlainMapIfColliding(map: Record<string, unknown>, isRoot: boolean): Record<string, unknown> {
  if (isRoot) {
    if (isEscapedPlainMap(map)) {
      return { type: 'pyric/map/1.0', fields: map };
    }
    return map;
  }
  if (hasCollidingFirestoreMarkerShape(map) || isSerializedFirestoreLeafObject(map) || isEscapedPlainMap(map)) {
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

type FieldLookup = { readonly found: true; readonly value: unknown } | { readonly found: false };

function readDottedSegments(
  cursor: Record<string, unknown>,
  parts: readonly string[],
  index: number,
): FieldLookup {
  let unwrapped = cursor;
  if (isEscapedPlainMap(cursor)) unwrapped = cursor.fields;
  const seg = parts[index];
  if (seg === undefined || FORBIDDEN_KEYS.has(seg)) return { found: false };
  if (!Object.prototype.hasOwnProperty.call(unwrapped, seg)) return { found: false };
  const current = unwrapped[seg];
  if (index === parts.length - 1) return { found: true, value: current };
  if (!isPlainObject(current) || isSerializedFirestoreLeafObject(current)) return { found: false };
  return readDottedSegments(current, parts, index + 1);
}

function valuesStructurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (!valuesStructurallyEqual(left[i], right[i])) return false;
    }
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!valuesStructurallyEqual(left[key], right[key])) return false;
  }
  return true;
}

/**
 * True when any field named in `fields` differs between `storedDoc` and
 * `projectedData` (including presence vs absence when a field was added or
 * deleted on the server).
 */
export function projectionContradictsStoredDoc(
  storedDoc: Record<string, unknown>,
  fields: readonly string[],
  projectedData: Record<string, unknown>,
): boolean {
  for (const fieldPath of fields) {
    const parts = fieldPath.split('.');
    if (parts.length === 0) return true;
    const storedLookup = readDottedSegments(storedDoc, parts, 0);
    const projectedLookup = readDottedSegments(projectedData, parts, 0);
    if (storedLookup.found !== projectedLookup.found) return true;
    if (storedLookup.found && projectedLookup.found) {
      if (!valuesStructurallyEqual(storedLookup.value, projectedLookup.value)) return true;
    }
  }
  return false;
}

