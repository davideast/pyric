import type { TestCase } from '../test/spec.js';
import { RulesFloat } from './wrappers/float.js';
import { Timestamp } from './wrappers/timestamp.js';

/** Sentinel value for FieldValue.serverTimestamp() in test data. */
export const SERVER_TIMESTAMP = { __type: 'serverTimestamp' } as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isServerTimestampSentinel(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as Record<string, unknown>).__type === 'serverTimestamp';
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

/** Restore the Firestore numeric tag erased by JSON's single Number type. */
export function reviveFirestoreNumbers(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isInteger(value)) return new RulesFloat(value);
  if (Array.isArray(value)) return value.map(reviveFirestoreNumbers);
  if (isPlainObject(value)) {
    if (value.__type === 'float' && typeof value.value === 'number') {
      return new RulesFloat(value.value);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, reviveFirestoreNumbers(child)]),
    );
  }
  return value;
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
