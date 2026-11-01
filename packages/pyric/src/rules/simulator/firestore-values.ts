import type { TestCase } from '../test/spec.js';
import { Bytes } from './wrappers/bytes.js';
import { Duration } from './wrappers/duration.js';
import { RulesFloat } from './wrappers/float.js';
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
    resolved[key] = resolveServerTimestampValue(value, serverTime);
  }
  return resolved;
}

function resolveServerTimestampValue(value: unknown, serverTime: Timestamp): unknown {
  if (isServerTimestampSentinel(value)) return serverTime;
  if (Array.isArray(value)) return value.map((item) => resolveServerTimestampValue(item, serverTime));
  if (isPlainObject(value)) return resolveServerTimestamps(value, serverTime);
  return value;
}

/** Restore the Firestore numeric and wrapper tags erased by JSON serialization. */
export function reviveFirestoreNumbers(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isInteger(value)) return new RulesFloat(value);
  if (Array.isArray(value)) return value.map(reviveFirestoreNumbers);
  if (isPlainObject(value)) {
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
    if (value.__type__ === '__vector__' && Array.isArray(value.value)) {
      return new Vector(Object.freeze((value.value as number[]).slice()));
    }
    if (typeof value.type === 'string') {
      switch (value.type) {
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
 * fractional number becomes a float, as JSON erases nothing else here.
 */
export function reviveCaseLiterals(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isInteger(value)) return new RulesFloat(value);
  if (Array.isArray(value)) return value.map(reviveCaseLiterals);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, reviveCaseLiterals(child)]),
  );
}

/** Model the nullable query fields exposed only by Firestore list requests. */
export function requestQuery(tc: TestCase): Record<string, unknown> | undefined {
  if (tc.method !== 'list') return undefined;
  return {
    limit: tc.query?.limit ?? null,
    offset: tc.query?.offset ?? null,
    orderBy: tc.query?.orderBy ?? null,
  };
}
