import type { TestCase } from '../test/spec.js';
import { Bytes } from './wrappers/bytes.js';
import { Duration } from './wrappers/duration.js';
import { RulesFloat } from './wrappers/float.js';
import { hostNumber } from './rules-int.js';
import { LatLng } from './wrappers/latlng.js';
import { Path } from './wrappers/path.js';
import { Reference } from './wrappers/reference.js';
import { Timestamp } from './wrappers/timestamp.js';
import { Vector } from './wrappers/vector.js';

/** Sentinel value for FieldValue.serverTimestamp() in test data. */
export const SERVER_TIMESTAMP = { __type: 'serverTimestamp' } as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const DOC_REF_KEYS = new Set(['id', 'path', 'bypassRules', 'auth', 'env']);

function isSerializedDocRef(obj: Record<string, unknown>): obj is { id: string; path: string } {
  const keys = Object.keys(obj);
  if (keys.length < 2 || !keys.every((k) => DOC_REF_KEYS.has(k))) return false;
  if (typeof obj.id !== 'string' || typeof obj.path !== 'string') return false;
  const segments = obj.path.split('/');
  return (
    segments.length >= 2
    && segments.length % 2 === 0
    && segments.every((s) => s.length > 0)
    && segments[segments.length - 1] === obj.id
  );
}

function base64UrlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64StdDecode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isServerTimestampSentinel(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (
      (value as Record<string, unknown>).__type === 'serverTimestamp'
      || (value as Record<string, unknown>)._methodName === 'serverTimestamp'
      || (value as Record<string, unknown>)._methodName === 'FieldValue.serverTimestamp'
    );
}

/** Recursively replace serverTimestamp sentinels with one server-time value.
 *  Arrays are walked too: the sandbox resolves a sentinel at any depth,
 *  including list elements (FS-MET-4b). */
export function resolveServerTimestamps(
  data: Record<string, unknown>,
  serverTime: Timestamp,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    Object.defineProperty(resolved, key, {
      value: resolveServerTimestampValue(value, serverTime),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return resolved;
}

function resolveServerTimestampValue(value: unknown, serverTime: Timestamp): unknown {
  if (isServerTimestampSentinel(value)) return serverTime;
  if (Array.isArray(value)) return value.map((item) => resolveServerTimestampValue(item, serverTime));
  if (isPlainObject(value)) return resolveServerTimestamps(value, serverTime);
  return value;
}

/**
 * Restore the Firestore numeric and wrapper tags erased by JSON
 * serialization. A number is typed as the Firebase SDKs send it
 * (`hostNumber`): 2^53 and past, `-0` and a fraction are floats.
 */
export function reviveFirestoreNumbers(value: unknown): unknown {
  if (typeof value === 'number') return hostNumber(value);
  if (Array.isArray(value)) return value.map(reviveFirestoreNumbers);
  if (isPlainObject(value)) {
    const unescapedTag = Symbol.for('pyric.unescapedMap');
    if ((value as Record<symbol, unknown>)[unescapedTag] === true) {
      return value;
    }
    if (typeof value.__type === 'string') {
      switch (value.__type) {
        case 'float':
          if (typeof value.value === 'number') return new RulesFloat(value.value);
          break;
        case 'timestamp':
          if (typeof value.seconds === 'number' && typeof value.nanos === 'number') {
            return new Timestamp(value.seconds, value.nanos);
          }
          break;
        case 'bytes':
          if (typeof value.base64 === 'string') {
            return new Bytes(base64UrlDecode(value.base64));
          }
          break;
        case 'latlng':
          if (typeof value.lat === 'number' && typeof value.lng === 'number') {
            return new LatLng(value.lat, value.lng);
          }
          break;
        case 'duration':
          if (typeof value.seconds === 'number' && typeof value.nanos === 'number') {
            return new Duration(value.seconds, value.nanos);
          }
          break;
        case 'reference':
          if (typeof value.path === 'string') {
            return new Reference(value.path);
          }
          break;
        case 'path':
          if (Array.isArray(value.segments)) {
            return new Path(value.segments as string[]);
          }
          break;
      }
    }
    if (
      value.__type__ === '__vector__' &&
      Array.isArray(value.value) &&
      value.value.every((n) => typeof n === 'number')
    ) {
      return new Vector(Object.freeze((value.value as number[]).slice()));
    }
    if (typeof value.type === 'string') {
      switch (value.type) {
        case 'pyric/map/1.0':
          if (Object.keys(value).length === 2 && isPlainObject(value.fields)) {
            const out: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(value.fields)) {
              Object.defineProperty(out, key, {
                value: reviveFirestoreNumbers(child),
                enumerable: true,
                writable: true,
                configurable: true,
              });
            }
            Object.defineProperty(out, unescapedTag, { value: true });
            return out;
          }
          break;
        case 'pyric/number/1.0':
          if (Object.keys(value).length === 2) {
            if (value.value === 'NaN') return new RulesFloat(Number.NaN);
            if (value.value === 'Infinity') return new RulesFloat(Number.POSITIVE_INFINITY);
            if (value.value === '-Infinity') return new RulesFloat(Number.NEGATIVE_INFINITY);
            if (value.value === '-0') return new RulesFloat(-0);
          }
          break;
        case 'firestore/timestamp/1.0':
          if (typeof value.seconds === 'number' && typeof value.nanoseconds === 'number') {
            return new Timestamp(value.seconds, value.nanoseconds);
          }
          break;
        case 'firestore/bytes/1.0':
          if (typeof value.bytes === 'string') {
            return new Bytes(base64StdDecode(value.bytes));
          }
          break;
        case 'firestore/geoPoint/1.0':
          if (typeof value.latitude === 'number' && typeof value.longitude === 'number') {
            return new LatLng(value.latitude, value.longitude);
          }
          break;
        case 'firestore/vectorValue/1.0':
          if (Array.isArray(value.vectorValues)) {
            return new Vector(Object.freeze((value.vectorValues as number[]).slice()));
          }
          break;
      }
    }
    if (isSerializedDocRef(value)) {
      return new Reference(value.path);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, reviveFirestoreNumbers(child)]),
    );
  }
  return value;
}

/**
 * A public case's values as the simulator reads them. A value helper's value
 * (`timestamp()`, `latlng()`, ...) is already a typed value and stays one; a
 * plain map stays the map it is, even one with a `__type` key, because the
 * Rules Test API and a real document read it as a map (FS2-CON-5). Only a
 * number the SDKs send as a double becomes a float (`hostNumber`): a
 * fraction, 2^53 and past, and `-0`. JSON erases nothing else here.
 */
export function reviveCaseLiterals(value: unknown): unknown {
  if (typeof value === 'number') return hostNumber(value);
  if (Array.isArray(value)) return value.map(reviveCaseLiterals);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, reviveCaseLiterals(child)]),
  );
}

function normalizeOrderByMap(
  orderBy: Readonly<Record<string, 'ASC' | 'DESC'>> | string | null | undefined,
): Record<string, 'ASC' | 'DESC'> {
  if (orderBy == null) return {};
  if (typeof orderBy === 'string') {
    const trimmed = orderBy.trim();
    if (!trimmed) return {};
    const parts = trimmed.split(/\s+/);
    const field = parts[0]!;
    const dir = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    return { [field]: dir };
  }
  return { ...orderBy };
}

/** Model the query fields exposed only by Firestore list requests. */
export function requestQuery(tc: TestCase): Record<string, unknown> | undefined {
  if (tc.method !== 'list') return undefined;
  return {
    limit: tc.query?.limit ?? null,
    offset: tc.query?.offset ?? null,
    orderBy: normalizeOrderByMap(tc.query?.orderBy),
  };
}
