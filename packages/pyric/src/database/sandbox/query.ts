/**
 * RTDB query pipeline — order, filter, limit over an in-memory subtree.
 *
 * The modular SDK's `query(ref, ...constraints)` constructs a tagged
 * `Query` carrying a `QuerySpec`. `get(query)` / `onValue(query, cb)`
 * feed the spec + the current tree-subtree into {@link executeQuery},
 * which runs the documented RTDB pipeline:
 *
 *   1. Enumerate the children at the path (root + immediate children;
 *      primitive values at the path are NOT eligible — `query()` only
 *      makes sense on a collection-shaped node).
 *   2. Order them by the active `orderBy*` constraint (default
 *      priority index with key tie-breaking if none supplied).
 *   3. Apply `startAt` / `startAfter` / `endAt` / `endBefore` / `equalTo`
 *      bounds against the active ordering's comparison value.
 *   4. Apply `limitToFirst(n)` or `limitToLast(n)` — they truncate the
 *      result window from either end.
 *
 * The output is an ordered list of `{ key, value }` pairs ready for the
 * snap-builder to expose via `snap.forEach` and `snap.val()`.
 *
 * Oracle-locked semantics (all observed against blockingfun):
 *   - `startAt`/`endAt` are **inclusive**
 *     (`rtdb-modular-orderbychild-window.json`).
 *   - `startAfter`/`endBefore` are **exclusive**
 *     (`rtdb-modular-startafter-endbefore-exclusive.json`).
 *   - `equalTo(v)` returns ALL children whose ordered key === v — no
 *     uniqueness enforced (`rtdb-modular-equalTo-filter.json`).
 *   - `limitToFirst(n)` keeps the first n; `limitToLast(n)` keeps the
 *     last n (post-order, pre-limit window). Locked by
 *     `rtdb-modular-limittofirst-vs-limittolast.json`.
 *   - `orderByKey()` sorts lexicographically by string-coerced key
 *     (`rtdb-modular-orderbykey-window.json`).
 *   - `orderByValue()` sorts by the child's primitive value (number
 *     before string before boolean is RTDB's documented type order).
 *
 * This module computes query windows only. `.indexOn` enforcement lives in
 * `RulesEvaluator.missingQueryIndex` and `query-index.ts`.
 */
import type { Bound, LimitKind, OrderBy, QuerySpec } from '../internal/query-projection.js';

/** Empty spec — equivalent to "no constraints" (a plain ref query). */
export function emptySpec(): QuerySpec {
  return { orderBy: null, bounds: [], limit: null };
}

type StartKind = 'startAt' | 'startAfter' | 'equalTo';
type EndKind = 'endAt' | 'endBefore' | 'equalTo';

/** Whether a bound sets the start: `startAt`, `startAfter` or `equalTo`. */
function isStartKind(kind: Bound['kind']): kind is StartKind {
  return kind === 'startAt' || kind === 'startAfter' || kind === 'equalTo';
}

/** Whether a bound sets the end: `endAt`, `endBefore` or `equalTo`. */
function isEndKind(kind: Bound['kind']): kind is EndKind {
  return kind === 'endAt' || kind === 'endBefore' || kind === 'equalTo';
}

/** Whether the spec already has a lower-bound (start) constraint. */
function specHasStart(spec: QuerySpec): boolean {
  return spec.bounds.some((b) => isStartKind(b.kind));
}

/** Whether the spec already has an upper-bound (end) constraint. */
function specHasEnd(spec: QuerySpec): boolean {
  return spec.bounds.some((b) => isEndKind(b.kind));
}

/** The public call that set each ordering, as the SDK names it in errors. */
const ORDER_BY_CALL: Record<OrderBy['kind'], string> = {
  child: 'orderByChild',
  key: 'orderByKey',
  priority: 'orderByPriority',
  value: 'orderByValue',
};

// The SDK's texts, kept verbatim: startAt names `startBefore`, and endAt and
// endBefore say "Starting point" for an end point.
const START_ALREADY_SET: Record<StartKind, string> = {
  startAt: 'startAt: Starting point was already set (by another call to startAt, startBefore or equalTo).',
  startAfter: 'startAfter: Starting point was already set (by another call to startAt, startAfter, or equalTo).',
  equalTo: 'equalTo: Starting point was already set (by another call to startAt/startAfter or equalTo).',
};
const END_ALREADY_SET: Record<EndKind, string> = {
  endAt: 'endAt: Starting point was already set (by another call to endAt, endBefore or equalTo).',
  endBefore: 'endBefore: Starting point was already set (by another call to endAt, endBefore or equalTo).',
  equalTo: 'equalTo: Ending point was already set (by another call to endAt/endBefore or equalTo).',
};

/**
 * Append a constraint, returning a NEW spec. (Constraints are immutable
 * values; the query builder threads them via free functions matching
 * `firebase/database`'s shape.)
 *
 * Conflicting constraints throw, mirroring the upstream `_apply` guards
 * (`api/Reference_impl.ts`) — DB-B5. Prod rejects: multiple `orderBy*`,
 * a second `limitToFirst`/`limitToLast`, a second start (`startAt`/
 * `startAfter`/`equalTo`) or end (`endAt`/`endBefore`/`equalTo`).
 */
export function applyConstraint(
  spec: QuerySpec,
  c: Constraint,
): QuerySpec {
  switch (c.kind) {
    case 'orderBy':
      if (spec.orderBy !== null) {
        throw new Error(`${ORDER_BY_CALL[c.spec.kind]}: You can't combine multiple orderBy calls.`);
      }
      return { ...spec, orderBy: c.spec };
    case 'bound': {
      const kind = c.bound.kind;
      if (isStartKind(kind) && specHasStart(spec)) {
        throw new Error(START_ALREADY_SET[kind]);
      }
      if (isEndKind(kind) && specHasEnd(spec)) {
        throw new Error(END_ALREADY_SET[kind]);
      }
      return { ...spec, bounds: [...spec.bounds, c.bound] };
    }
    case 'limit':
      if (spec.limit !== null) {
        throw new Error(
          `${c.limitKind}: Limit was already set (by another call to limitToFirst or limitToLast).`,
        );
      }
      return { ...spec, limit: { kind: c.limitKind, n: c.n } };
  }
}

/**
 * Internal constraint variant — produced by the public `orderBy*`,
 * `startAt`, `limitToFirst`, ... factories and consumed by `query()`
 * which folds them into a `QuerySpec`.
 */
export type Constraint =
  | { kind: 'orderBy'; spec: OrderBy }
  | { kind: 'bound'; bound: Bound }
  | { kind: 'limit'; limitKind: LimitKind; n: number };

export {
  compareValues,
  nameCompare,
  extractOrderValue,
  executeQuery,
  type QueryRow,
  type OrderBy,
  type Priority,
  type Bound,
  type LimitKind,
  type QuerySpec,
} from '../internal/query-projection.js';
