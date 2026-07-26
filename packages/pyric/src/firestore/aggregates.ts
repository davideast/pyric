/**
 * `pyric/firestore` — aggregation queries.
 *
 * `count` / `sum` / `average` field descriptors and the
 * `getCountFromServer` / `getAggregateFromServer` executors.
 */
import type {
  AggregateField as ChainAggregateField,
  AggregateSpec as ChainAggregateSpec,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  chainQueryFor,
} from './state.js';
import type { Query, CollectionReference } from './types.js';

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
  data(): T;
}
export class AggregateQuerySnapshot<T extends Record<string, number | null> = Record<string, number | null>> {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && 'data' in instance && typeof (instance as any).data === 'function' && !('exists' in instance) && !('docs' in instance));
  }
}

export function aggregateFieldEqual(a: any, b: any): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.field === b.field;
}

export function aggregateQuerySnapshotEqual(a: any, b: any): boolean {
  if (!a || !b) return false;
  return JSON.stringify(a.data()) === JSON.stringify(b.data());
}

/** Factory: count() aggregate. */
export function count(): AggregateField {
  return { kind: 'count' };
}

/** Factory: sum-of-`field` aggregate. */
export function sum(field: string): AggregateField {
  return { kind: 'sum', field };
}

/** Factory: average-of-`field` aggregate. */
export function average(field: string): AggregateField {
  return { kind: 'average', field };
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
  const snap = await chainQueryFor(target, source).aggregate({ count: { kind: 'count' } });
  const data = snap.data();
  return { data: () => ({ count: (data.count ?? 0) as number }) };
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
  const chainSpec: ChainAggregateSpec = {};
  for (const alias of Object.keys(spec)) chainSpec[alias] = spec[alias] as ChainAggregateField;
  const snap = await chainQueryFor(target, source).aggregate(chainSpec);
  return { data: () => snap.data() as { [K in keyof S]: number | null } };
}
