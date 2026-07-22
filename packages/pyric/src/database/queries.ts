import type { JsonValue } from './sandbox/data-tree.js';
import { applyConstraint, emptySpec, type QuerySpec } from './sandbox/query.js';
import { buildConstraint, isQuery } from './query-shape.js';
import { CONSTRAINT_SYMBOL, QUERY_SYMBOL, type DatabaseReference, type Query, type QueryConstraint } from './types.js';

// ─── Queries (Tier 3) ────────────────────────────────────────────────

/**
 * `query(ref, ...constraints)` — wrap a ref in an immutable
 * constraint chain. The resulting {@link Query} routes through
 * {@link get}/{@link onValue} and applies the ordering + filtering +
 * limit pipeline on the sandbox backend.
 *
 * Chaining is supported — `query(query(ref, orderByChild('x')),
 * limitToFirst(2))` folds both constraints into one spec.
 *
 * Locked semantics (oracle):
 *   - `orderByChild('p') + startAt(v) + endAt(w)` is BOTH-inclusive
 *     (`rtdb-modular-orderbychild-window.json`).
 *   - `orderByKey() + startAt('b') + endAt('d')` matches `[b, c, d]`
 *     (`rtdb-modular-orderbykey-window.json`).
 *   - `orderByValue() + limitToFirst(3)` returns the 3 smallest by
 *     value (`rtdb-modular-orderbyvalue-numeric.json` — note: prod
 *     requires `.indexOn: ".value"`; sandbox does not enforce indexes).
 *   - `orderByChild('group') + equalTo('b')` returns ALL matching
 *     children (`rtdb-modular-equalTo-filter.json`).
 *   - `limitToFirst(N)` / `limitToLast(N)` take from the start / end of
 *     the ordered window (`rtdb-modular-limittofirst-vs-limittolast.json`).
 *   - `startAfter` / `endBefore` are EXCLUSIVE
 *     (`rtdb-modular-startafter-endbefore-exclusive.json`).
 */
export function query(
  refOrQuery: DatabaseReference | Query,
  ...constraints: QueryConstraint[]
): Query {
  // Resolve base — could be a ref or a prior query (chaining).
  let baseRef: DatabaseReference;
  let baseSpec: QuerySpec;
  if (isQuery(refOrQuery as object)) {
    const prior = refOrQuery as Query;
    baseRef = prior.ref;
    baseSpec = prior._spec;
  } else {
    baseRef = refOrQuery as DatabaseReference;
    baseSpec = emptySpec();
  }
  let spec = baseSpec;
  for (const c of constraints) {
    spec = applyConstraint(spec, c[CONSTRAINT_SYMBOL]);
  }
  const q: Query = {
    ref: baseRef,
    _spec: spec,
    [QUERY_SYMBOL]: true,
    toString() {
      return baseRef.toString();
    },
  };
  return q;
}

/** `orderByChild('path')` — order children by the value at the nested
 *  child path. Locked by oracle observation
 *  `rtdb-modular-orderbychild-window.json`. */
export function orderByChild(path: string): QueryConstraint {
  return buildConstraint('orderByChild', {
    kind: 'orderBy',
    spec: { kind: 'child', path },
  });
}

/** `orderByKey()` — order children lexicographically by key string.
 *  Locked by oracle observation `rtdb-modular-orderbykey-window.json`. */
export function orderByKey(): QueryConstraint {
  return buildConstraint('orderByKey', {
    kind: 'orderBy',
    spec: { kind: 'key' },
  });
}

/** `orderByPriority()` — order children by their RTDB priority metadata,
 * with Firebase's key ordering as the tie-breaker. */
export function orderByPriority(): QueryConstraint {
  return buildConstraint('orderByPriority', {
    kind: 'orderBy',
    spec: { kind: 'priority' },
  });
}

/** `orderByValue()` — order children by primitive value. Prod requires
 *  `.indexOn: ".value"` (oracle: `rtdb-modular-orderbyvalue-numeric.json`
 *  threw `Index not defined` against blockingfun); sandbox does NOT
 *  enforce indexes (the rules engine here checks read-allow only, not
 *  query-index conformance). */
export function orderByValue(): QueryConstraint {
  return buildConstraint('orderByValue', {
    kind: 'orderBy',
    spec: { kind: 'value' },
  });
}

/** `startAt(value, key?)` — INCLUSIVE lower bound under the active
 *  ordering. Optional `key` is the tie-breaker when ordering by
 *  child/value and multiple children share the bound's value. */
export function startAt(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('startAt', {
    kind: 'bound',
    bound: { kind: 'startAt', value, key },
  });
}

/** `startAfter(value, key?)` — EXCLUSIVE lower bound. Locked by
 *  `rtdb-modular-startafter-endbefore-exclusive.json`. */
export function startAfter(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('startAfter', {
    kind: 'bound',
    bound: { kind: 'startAfter', value, key },
  });
}

/** `endAt(value, key?)` — INCLUSIVE upper bound. Adjacent to startAt;
 *  same key tie-breaker semantics. */
export function endAt(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('endAt', {
    kind: 'bound',
    bound: { kind: 'endAt', value, key },
  });
}

/** `endBefore(value, key?)` — EXCLUSIVE upper bound. Locked by
 *  `rtdb-modular-startafter-endbefore-exclusive.json`. */
export function endBefore(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('endBefore', {
    kind: 'bound',
    bound: { kind: 'endBefore', value, key },
  });
}

/** `equalTo(value, key?)` — sugar for `startAt(value, key) +
 *  endAt(value, key)`. Returns ALL matching children (no uniqueness).
 *  Locked by oracle observation `rtdb-modular-equalTo-filter.json`. */
export function equalTo(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('equalTo', {
    kind: 'bound',
    bound: { kind: 'equalTo', value, key },
  });
}

/** `limitToFirst(n)` — keep the first N children of the ordered window.
 *  Locked by oracle observation `rtdb-modular-limittofirst-vs-limittolast.json`. */
export function limitToFirst(n: number): QueryConstraint {
  return buildConstraint('limitToFirst', {
    kind: 'limit',
    limitKind: 'limitToFirst',
    n,
  });
}

/** `limitToLast(n)` — keep the last N children of the ordered window.
 *  Locked by oracle observation `rtdb-modular-limittofirst-vs-limittolast.json`. */
export function limitToLast(n: number): QueryConstraint {
  return buildConstraint('limitToLast', {
    kind: 'limit',
    limitKind: 'limitToLast',
    n,
  });
}
