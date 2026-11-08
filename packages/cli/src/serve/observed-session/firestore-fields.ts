/**
 * Field-level edits of an observed Firestore document as the host folds them:
 * a `set` with `merge` deep-merges maps, an `update` sets dotted field paths,
 * and `deleteFields` removes them. Serialized special values (timestamps,
 * geopoints, bytes, vectors, references) are leaves, never maps to merge into.
 */
import { FORBIDDEN_KEYS, isPlainObject } from './json-values.js';

/**
 * True when `value` is one of the 5 serialized Firestore scalar/reference
 * shapes recognized by `@pyric/ui` and `rehydrateFirestoreDocData`, so map
 * merges treat it as an atomic leaf rather than a nested map.
 */
export function isSerializedFirestoreLeafObject(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (
    keys.length === 2 &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number'
  ) {
    return true;
  }
  if (
    keys.length === 2 &&
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
    keys.length === 3 &&
    value.type === 'document' &&
    typeof value.path === 'string' &&
    typeof value.id === 'string'
  ) {
    return true;
  }
  return false;
}

export function deepMergeFirestoreMap(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = next[key];
    if (
      isPlainObject(value) &&
      !isSerializedFirestoreLeafObject(value) &&
      isPlainObject(existing) &&
      !isSerializedFirestoreLeafObject(existing)
    ) {
      next[key] = deepMergeFirestoreMap(existing, value);
    } else {
      next[key] = structuredClone(value);
    }
  }
  return next;
}

export function setDottedField(target: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    if (FORBIDDEN_KEYS.has(seg)) return;
    const current = cursor[seg];
    if (!isPlainObject(current) || isSerializedFirestoreLeafObject(current)) {
      const fresh: Record<string, unknown> = {};
      cursor[seg] = fresh;
      cursor = fresh;
    } else {
      const copy: Record<string, unknown> = { ...current };
      cursor[seg] = copy;
      cursor = copy;
    }
  }
  const leaf = parts[parts.length - 1]!;
  if (FORBIDDEN_KEYS.has(leaf)) return;
  cursor[leaf] = structuredClone(value);
}

export function deleteDottedField(target: Record<string, unknown>, fieldPath: string): void {
  const parts = fieldPath.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    if (FORBIDDEN_KEYS.has(seg)) return;
    const current = cursor[seg];
    if (!isPlainObject(current) || isSerializedFirestoreLeafObject(current)) return;
    const copy: Record<string, unknown> = { ...current };
    cursor[seg] = copy;
    cursor = copy;
  }
  const leaf = parts[parts.length - 1]!;
  if (FORBIDDEN_KEYS.has(leaf)) return;
  delete cursor[leaf];
}

