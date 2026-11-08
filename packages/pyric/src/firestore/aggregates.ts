/**
 * `pyric/firestore` — aggregation queries.
 *
 * `count` / `sum` / `average` field descriptors and the
 * `getCountFromServer` / `getAggregateFromServer` executors.
 */
import { beginFirestoreActivity } from './sdk-activity.js';
import { finishSdkRead } from '../sandbox/internal/sdk-activity.js';
import { withFirestoreFirebaseError } from './errors.js';
import type {
  AggregateField as ChainAggregateField,
  AggregateSpec as ChainAggregateSpec,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  chainQueryFor,
  refToTarget,
} from './state.js';
import { clientStateFor } from './client-state.js';
import { queryEqual } from './equality.js';
import type { FieldPath } from './field-values.js';
import type { Query, CollectionReference } from './types.js';

function normalizeAggregateField(field: string | FieldPath): { field: string; path?: readonly string[] } {
  if (typeof field === 'string') return { field };
  const segments = field._internalPath.segments;
  const joined = segments.join('.');
  if (segments.some((s) => s.includes('.'))) {
    return { field: joined, path: segments };
  }
  return { field: joined };
}

// ─── Aggregates (Tier 2) ──────────────────────────────────────────────
//
// Modular Web-SDK shape:
//
//   import { getCountFromServer, getAggregateFromServer,
//            count, sum, average } from 'pyric/firestore';
//
//   const c = await getCountFromServer(query(coll, where(...)));
//   c.data().count // → number
//
//   const a = await getAggregateFromServer(coll, {
//     n:           count(),
//     totalPrice:  sum('price'),
//     avgRating:   average('rating'),
//   });
//   a.data() // → { n, totalPrice, avgRating: number|null }
//
// `AggregateField` is a sandbox descriptor constructed before a query runs.

/**
 * Aggregate-field descriptor returned by `count()` / `sum(field)` /
 * `average(field)`.
 */
export type AggregateFieldType = 'count' | 'sum' | 'average';
export type AggregateType = 'count' | 'sum' | 'average';
export type AggregateSpecData<T> = Record<string, unknown>;

export interface AggregateField {
  readonly kind: AggregateFieldType;
  readonly field?: string;
  readonly path?: readonly string[];
}
export class AggregateField {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && 'kind' in instance && ((instance as any).kind === 'count' || (instance as any).kind === 'sum' || (instance as any).kind === 'average'));
  }
}

/** Spec passed to `getAggregateFromServer(query, spec)`. */
export type AggregateSpec = Record<string, AggregateField>;

/**
 * Snapshot returned by `getCountFromServer` /
 * `getAggregateFromServer`. `.data()` returns the computed numbers
 * keyed by the spec's aliases (or `{ count: number }` for the
 * count-only entry point).
 */
export interface AggregateQuerySnapshot<T extends Record<string, number | null> = Record<string, number | null>> {
  readonly type: 'AggregateQuerySnapshot';
  readonly query: Query | CollectionReference;
  data(): T;
}
export class AggregateQuerySnapshot<T extends Record<string, number | null> = Record<string, number | null>> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && 'data' in instance && typeof (instance as any).data === 'function' && !('exists' in instance) && !('docs' in instance));
  }
}

export function aggregateFieldEqual(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.field !== b.field) return false;
  if (a.path || b.path) {
    let pathA: readonly string[] = [];
    if (a.path) pathA = a.path;
    else if (typeof a.field === 'string') pathA = a.field.split('.');
    let pathB: readonly string[] = [];
    if (b.path) pathB = b.path;
    else if (typeof b.field === 'string') pathB = b.field.split('.');
    return JSON.stringify(pathA) === JSON.stringify(pathB);
  }
  return true;
}

function aggregateSnapshotQueriesEqual(qA: unknown, qB: unknown): boolean {
  if (qA === qB) return true;
  if (!qA || !qB || typeof qA !== 'object' || typeof qB !== 'object') return false;
  if (refToTarget.has(qA) || refToTarget.has(qB)) {
    if (!refToTarget.has(qA) || !refToTarget.has(qB)) return false;
    return queryEqual(qA as Query, qB as Query);
  }
  if ('__kind' in qA && '__kind' in qB && 'descriptor' in qA && 'descriptor' in qB) {
    const wA = qA as { port?: unknown; converter?: unknown; descriptor?: unknown };
    const wB = qB as { port?: unknown; converter?: unknown; descriptor?: unknown };
    return wA.port === wB.port
      && wA.converter === wB.converter
      && JSON.stringify(wA.descriptor) === JSON.stringify(wB.descriptor);
  }
  return false;
}

export function aggregateQuerySnapshotEqual(a: any, b: any): boolean {
  if (!a || !b || typeof a.data !== 'function' || typeof b.data !== 'function') return false;
  if (a.query !== undefined || b.query !== undefined) {
    if (!aggregateSnapshotQueriesEqual(a.query, b.query)) return false;
  }
  const dataA = a.data();
  const dataB = b.data();
  if (!dataA || !dataB || typeof dataA !== 'object' || typeof dataB !== 'object') return false;
  const keysA = Object.keys(dataA);
  const keysB = Object.keys(dataB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(dataB, key)) return false;
    if (!Object.is(dataA[key], dataB[key])) return false;
  }
  return true;
}

/** Factory: count() aggregate. */
export function count(): AggregateField {
  return { kind: 'count' };
}

/** Factory: sum-of-`field` aggregate. */
export function sum(field: string | FieldPath): AggregateField {
  return { kind: 'sum', ...normalizeAggregateField(field) };
}

/** Factory: average-of-`field` aggregate. */
export function average(field: string | FieldPath): AggregateField {
  return { kind: 'average', ...normalizeAggregateField(field) };
}

/**
 * Count documents matching the query. Returns a snapshot whose
 * `.data()` yields `{ count: N }` — same shape `firebase/firestore`'s
 * `getCountFromServer` produces.
 */
export async function getCountFromServer(
  source: Query | CollectionReference,
): Promise<AggregateQuerySnapshot<{ count: number }>> {
  const target = targetOf(source);
  clientStateFor(target).markStarted();
  const activity = beginFirestoreActivity(target, source, 'getCountFromServer', 'operation');
  try {
    const snap = await withFirestoreFirebaseError(() => chainQueryFor(target, source).aggregate({ count: { kind: 'count' } }));
    const data = snap.data();
    return finishSdkRead(activity, {
      type: 'AggregateQuerySnapshot',
      query: source,
      data: () => ({ count: (data.count ?? 0) as number }),
    });
  } catch (error) { activity.fail(); throw error; }
}

/**
 * Run a multi-field aggregate against the query. Spec entries are
 * keyed by caller-chosen aliases; the returned snapshot's `.data()`
 * uses the same keys.
 *
 * The sandbox target dispatches straight into the chainable adapter.
 */
export async function getAggregateFromServer<S extends AggregateSpec>(
  source: Query | CollectionReference,
  spec: S,
): Promise<AggregateQuerySnapshot<{ [K in keyof S]: number | null }>> {
  const target = targetOf(source);
  clientStateFor(target).markStarted();
  const activity = beginFirestoreActivity(target, source, 'getAggregateFromServer', 'operation');
  try {
    const chainSpec: ChainAggregateSpec = {};
    for (const alias of Object.keys(spec)) chainSpec[alias] = spec[alias] as ChainAggregateField;
    const snap = await withFirestoreFirebaseError(() => chainQueryFor(target, source).aggregate(chainSpec));
    return finishSdkRead(activity, {
      type: 'AggregateQuerySnapshot',
      query: source,
      data: () => snap.data() as { [K in keyof S]: number | null },
    });
  } catch (error) { activity.fail(); throw error; }
}
