/**
 * Turns an observed document's serialized special values back into
 * `pyric/firestore` instances when it is written into a local sandbox.
 */
import { Bytes, GeoPoint, Timestamp, doc, vector, type Firestore } from 'pyric/firestore';
import { FORBIDDEN_KEYS, isPlainObject } from './json-values.js';

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function rehydrateEntries(db: Firestore, entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    defineOwn(out, k, rehydrateFirestoreValue(db, v));
  }
  return out;
}

/**
 * Rehydrate serialized Firestore special values (`Timestamp`, `GeoPoint`,
 * `Bytes`, `VectorValue`, `DocumentReference`) back into `pyric/firestore`
 * instances when writing observed documents into a `Sandbox`, while unwrapping
 * escaped plain maps (`{ type: 'pyric/map/1.0', fields }`) as plain JS objects.
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
      value.type === 'pyric/map/1.0' &&
      isPlainObject(value.fields)
    ) {
      return rehydrateEntries(db, value.fields);
    }
    if (
      (keys.length === 2 || (keys.length === 3 && value.type === 'firestore/timestamp/1.0')) &&
      typeof value.seconds === 'number' &&
      typeof value.nanoseconds === 'number'
    ) {
      try {
        return new Timestamp(Math.trunc(value.seconds), Math.trunc(value.nanoseconds));
      } catch {
        return rehydrateEntries(db, value);
      }
    }
    if (
      (keys.length === 2 || (keys.length === 3 && value.type === 'firestore/geoPoint/1.0')) &&
      typeof value.latitude === 'number' &&
      typeof value.longitude === 'number'
    ) {
      try {
        return new GeoPoint(value.latitude, value.longitude);
      } catch {
        return rehydrateEntries(db, value);
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
        return rehydrateEntries(db, value);
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
        return rehydrateEntries(db, value);
      }
    }
    if (
      keys.length === 2 &&
      value.type === 'firestore/vectorValue/1.0' &&
      Array.isArray(value.vectorValues) &&
      value.vectorValues.every((n) => typeof n === 'number')
    ) {
      try {
        return vector(value.vectorValues as number[]);
      } catch {
        return rehydrateEntries(db, value);
      }
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
      try {
        const rawPath = value.path as string;
        const normalizedPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
        return doc(db, normalizedPath);
      } catch {
        return rehydrateEntries(db, value);
      }
    }
    return rehydrateEntries(db, value);
  }
  return value;
}

export function rehydrateFirestoreDocData(
  db: Firestore,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(data);
  if (keys.length === 2 && data.type === 'pyric/map/1.0' && isPlainObject(data.fields)) {
    return rehydrateEntries(db, data.fields);
  }
  return rehydrateEntries(db, data);
}

