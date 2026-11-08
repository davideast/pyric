/**
 * Turns an observed document's serialized special values back into
 * `pyric/firestore` instances when it is written into a local sandbox.
 */
import { Bytes, GeoPoint, Timestamp, doc, vector, type Firestore } from 'pyric/firestore';
import { FORBIDDEN_KEYS, isPlainObject } from './json-values.js';

/**
 * Rehydrate serialized Firestore special values (`Timestamp`, `GeoPoint`,
 * `Bytes`, `VectorValue`, `DocumentReference`) back into `pyric/firestore`
 * instances when writing observed documents into a `Sandbox`.
 */
function rehydrateFirestoreValue(db: Firestore, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => rehydrateFirestoreValue(db, entry));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (
      keys.length === 2 &&
      typeof value.seconds === 'number' &&
      typeof value.nanoseconds === 'number'
    ) {
      try {
        return new Timestamp(Math.trunc(value.seconds), Math.trunc(value.nanoseconds));
      } catch {
        return { ...value };
      }
    }
    if (
      keys.length === 2 &&
      typeof value.latitude === 'number' &&
      typeof value.longitude === 'number'
    ) {
      try {
        return new GeoPoint(value.latitude, value.longitude);
      } catch {
        return { ...value };
      }
    }
    if (
      keys.length === 2 &&
      value.type === 'firestore/bytes/1.0' &&
      typeof value.bytes === 'string'
    ) {
      try {
        return Bytes.fromBase64String(value.bytes);
      } catch {
        return { ...value };
      }
    }
    if (
      keys.length === 2 &&
      value.__type__ === '__vector__' &&
      Array.isArray(value.value) &&
      value.value.every((n) => typeof n === 'number')
    ) {
      try {
        return vector(value.value as number[]);
      } catch {
        return { ...value };
      }
    }
    if (
      keys.length === 3 &&
      value.type === 'document' &&
      typeof value.path === 'string' &&
      typeof value.id === 'string'
    ) {
      try {
        const normalizedPath = value.path.startsWith('/') ? value.path.slice(1) : value.path;
        return doc(db, normalizedPath);
      } catch {
        return { ...value };
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = rehydrateFirestoreValue(db, v);
    }
    return out;
  }
  return value;
}

export function rehydrateFirestoreDocData(
  db: Firestore,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return rehydrateFirestoreValue(db, data) as Record<string, unknown>;
}

