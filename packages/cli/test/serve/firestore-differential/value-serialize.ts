/**
 * Materializes JSON `ValueSpec` nodes into live SDK instances for a plane and
 * serializes read-back Firestore values into a lossless canonical JSON form.
 */

import type { FieldPathSpec, QueryFieldSpec, ValueSpec } from './sequence.js';

/**
 * Generated user `Timestamp` values always use `seconds <= 1_700_000_000`
 * (Nov 2023), so any resolved `Timestamp` above this threshold came from
 * `serverTimestamp()`.
 */
export const SERVER_TIMESTAMP_FLOOR_SECONDS = 1_700_000_001;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ValueBuilders {
  makeBytes(bytes: Uint8Array): unknown;
  makeGeoPoint(latitude: number, longitude: number): unknown;
  makeTimestamp(seconds: number, nanoseconds: number): unknown;
  makeDocRef(dbIndex: number, path: string): unknown;
  makeFieldPath(segments: string[]): unknown;
  makeDocumentId(): unknown;
  deleteField(): unknown;
  serverTimestamp(): unknown;
  increment(delta: number): unknown;
  arrayUnion(...elements: unknown[]): unknown;
  arrayRemove(...elements: unknown[]): unknown;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function materializeFieldPath(builders: ValueBuilders, spec: FieldPathSpec): unknown {
  if (typeof spec === 'string') {
    return spec;
  }
  return builders.makeFieldPath(spec.segments);
}

export function materializeQueryField(builders: ValueBuilders, spec: QueryFieldSpec): unknown {
  if (typeof spec === 'string') {
    return spec;
  }
  if ('documentId' in spec) {
    return builders.makeDocumentId();
  }
  return builders.makeFieldPath(spec.segments);
}

export function materializeValue(builders: ValueBuilders, spec: ValueSpec): unknown {
  if (spec === null || typeof spec === 'boolean' || typeof spec === 'number' || typeof spec === 'string') {
    return spec;
  }
  if ('$num' in spec) {
    if (spec.$num === '-0') return -0;
    if (spec.$num === 'NaN') return Number.NaN;
    if (spec.$num === 'Infinity') return Number.POSITIVE_INFINITY;
    return Number.NEGATIVE_INFINITY;
  }
  if ('$bytes' in spec) {
    return builders.makeBytes(new Uint8Array(spec.$bytes));
  }
  if ('$geo' in spec) {
    return builders.makeGeoPoint(spec.$geo[0], spec.$geo[1]);
  }
  if ('$ts' in spec) {
    return builders.makeTimestamp(spec.$ts[0], spec.$ts[1]);
  }
  if ('$ref' in spec) {
    return builders.makeDocRef(spec.$ref.db ?? 0, spec.$ref.path);
  }
  if ('$array' in spec) {
    return spec.$array.map((item) => materializeValue(builders, item));
  }
  if ('$map' in spec) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of spec.$map) {
      out[key] = materializeValue(builders, child);
    }
    return out;
  }
  if ('$delete' in spec) {
    return builders.deleteField();
  }
  if ('$serverTs' in spec) {
    return builders.serverTimestamp();
  }
  if ('$inc' in spec) {
    return builders.increment(spec.$inc);
  }
  if ('$union' in spec) {
    return builders.arrayUnion(...spec.$union.map((item) => materializeValue(builders, item)));
  }
  return builders.arrayRemove(...spec.$remove.map((item) => materializeValue(builders, item)));
}

function isTimestampLike(value: Record<string, unknown>): value is { seconds: number; nanoseconds: number; toMillis: () => number } {
  return (
    typeof value.seconds === 'number'
    && typeof value.nanoseconds === 'number'
    && typeof value.toMillis === 'function'
  );
}

function isGeoPointLike(value: Record<string, unknown>): value is { latitude: number; longitude: number; isEqual: (other: unknown) => boolean } {
  return (
    typeof value.latitude === 'number'
    && typeof value.longitude === 'number'
    && typeof value.isEqual === 'function'
    && !('seconds' in value)
  );
}

function isBytesLike(value: Record<string, unknown>): value is { toUint8Array: () => Uint8Array; toBase64: () => string } {
  return typeof value.toUint8Array === 'function' && typeof value.toBase64 === 'function';
}

function isDocumentRefLike(value: Record<string, unknown>): boolean {
  if (typeof value.path !== 'string' || typeof value.id !== 'string') {
    return false;
  }
  if (value.type === 'document' || value.__kind === 'doc-ref') {
    return true;
  }
  if (typeof value.withConverter === 'function' || typeof value.get === 'function') {
    return true;
  }
  return 'firestore' in value || 'parent' in value;
}

function isInternalReferenceLike(value: Record<string, unknown>): value is { path: string; databaseId?: string; segments: readonly string[] } {
  return (
    typeof value.path === 'string'
    && Array.isArray(value.segments)
    && value.constructor?.name === 'Reference'
  );
}

/**
 * Converts any runtime Firestore value (from client `DocumentSnapshot.data()`,
 * Admin `DocumentSnapshot.data()`, or `snapshotDocuments()`) into a canonical
 * tagged JSON value where `-0`, `NaN`, `+-Infinity`, `Bytes`, `GeoPoint`,
 * `Timestamp`, and `DocumentReference` are unambiguously distinguished from
 * plain maps.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalizeReadValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $t: 'num', v: 'NaN' };
    if (value === Number.POSITIVE_INFINITY) return { $t: 'num', v: 'Infinity' };
    if (value === Number.NEGATIVE_INFINITY) return { $t: 'num', v: '-Infinity' };
    if (Object.is(value, -0)) return { $t: 'num', v: '-0' };
    return value;
  }
  if (value instanceof Uint8Array) {
    return { $t: 'bytes', bytes: Array.from(value) };
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    const sec = Math.floor(ms / 1000);
    const nano = ((ms % 1000) + 1000) % 1000 * 1_000_000;
    return canonicalizeTimestamp(sec, nano);
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeReadValue(item));
  }
  if (!isObjectRecord(value)) {
    return { $t: 'other', text: String(value) };
  }
  if (isBytesLike(value)) {
    return { $t: 'bytes', bytes: Array.from(value.toUint8Array()) };
  }
  if (isTimestampLike(value)) {
    return canonicalizeTimestamp(value.seconds, value.nanoseconds);
  }
  if (isGeoPointLike(value)) {
    return {
      $t: 'geopoint',
      lat: canonicalizeReadValue(value.latitude),
      lng: canonicalizeReadValue(value.longitude),
    };
  }
  if (isInternalReferenceLike(value)) {
    return {
      $t: 'ref',
      path: value.path,
    };
  }
  if (isDocumentRefLike(value)) {
    return {
      $t: 'ref',
      path: String(value.path),
    };
  }
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareStrings(left, right));
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    mapped[key] = canonicalizeReadValue(child);
  }
  return { $t: 'map', entries: mapped };
}

function canonicalizeTimestamp(seconds: number, nanoseconds: number): Record<string, unknown> {
  if (seconds >= SERVER_TIMESTAMP_FLOOR_SECONDS) {
    return { $t: 'serverTimestamp' };
  }
  return { $t: 'timestamp', sec: seconds, nano: nanoseconds };
}
