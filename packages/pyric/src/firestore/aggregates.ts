/**
 * `pyric/firestore` — aggregation queries.
 *
 * `count` / `sum` / `average` field descriptors and the
 * `getCountFromServer` / `getAggregateFromServer` executors. Descriptors
 * are target-agnostic; the prod path translates them to
 * `firebase/firestore` AggregateField instances at the call site.
 */
import * as fb from 'firebase/firestore';
import type {
  AggregateField as ChainAggregateField,
  AggregateSpec as ChainAggregateSpec,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  isSandboxKind,
  chainQueryFor,
  asFbQuery,
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
// `AggregateField` is target-agnostic at construction time
// (`{ kind: 'count' | 'sum' | 'average', field? }`) and gets translated
// to `firebase/firestore`'s native `fb.AggregateField` instances at
// the prod call site.

/**
 * Aggregate-field descriptor returned by `count()` / `sum(field)` /
 * `average(field)`. Pyric-native; both targets accept it.
 */
export type AggregateField =
  | { readonly kind: 'count' }
  | { readonly kind: 'sum'; readonly field: string }
  | { readonly kind: 'average'; readonly field: string };

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
  if (isSandboxKind(target)) {
    const snap = await chainQueryFor(target, source).aggregate({ count: { kind: 'count' } });
    const data = snap.data();
    return { data: () => ({ count: (data.count ?? 0) as number }) };
  }
  const snap = await fb.getCountFromServer(asFbQuery(source));
  return { data: () => ({ count: snap.data().count }) };
}

/**
 * Run a multi-field aggregate against the query. Spec entries are
 * keyed by caller-chosen aliases; the returned snapshot's `.data()`
 * uses the same keys.
 *
 * Sandbox target dispatches straight into the chainable adapter.
 * Prod target translates pyric's `AggregateField` shapes into
 * `firebase/firestore` AggregateField instances (`fb.count()`,
 * `fb.sum(...)`, `fb.average(...)`) before delegating.
 */
export async function getAggregateFromServer<S extends AggregateSpec>(
  source: Query | CollectionReference,
  spec: S,
): Promise<AggregateQuerySnapshot<{ [K in keyof S]: number | null }>> {
  const target = targetOf(source);
  if (isSandboxKind(target)) {
    // The sandbox spec shape is structurally identical to ours, but
    // we re-construct so the type system sees `ChainAggregateSpec`
    // explicitly (avoids a chained cast at the call site).
    const chainSpec: ChainAggregateSpec = {};
    for (const alias of Object.keys(spec)) chainSpec[alias] = spec[alias] as ChainAggregateField;
    const snap = await chainQueryFor(target, source).aggregate(chainSpec);
    return { data: () => snap.data() as { [K in keyof S]: number | null } };
  }
  // Prod — translate spec to firebase/firestore AggregateField objects.
  const fbSpec: Record<string, fb.AggregateField<unknown>> = {};
  for (const alias of Object.keys(spec)) {
    const f = spec[alias];
    if (f.kind === 'count')   fbSpec[alias] = fb.count();
    else if (f.kind === 'sum')     fbSpec[alias] = fb.sum(f.field);
    else                           fbSpec[alias] = fb.average(f.field);
  }
  const snap = await fb.getAggregateFromServer(asFbQuery(source), fbSpec);
  return { data: () => snap.data() as { [K in keyof S]: number | null } };
}
