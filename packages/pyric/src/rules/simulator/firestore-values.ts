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

/** Recursively replace serverTimestamp sentinels with one server-time value. */
export function resolveServerTimestamps(
  data: Record<string, unknown>,
  serverTime: Timestamp,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isServerTimestampSentinel(value)) resolved[key] = serverTime;
    else if (isPlainObject(value)) resolved[key] = resolveServerTimestamps(value, serverTime);
    else resolved[key] = value;
  }
  return resolved;
}

/** Restore the Firestore numeric tag erased by JSON's single Number type. */
export function reviveFirestoreNumbers(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isInteger(value)) return new RulesFloat(value);
  if (Array.isArray(value)) return value.map(reviveFirestoreNumbers);
  if (isPlainObject(value)) {
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
