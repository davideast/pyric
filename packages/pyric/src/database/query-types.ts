import type { Constraint, QuerySpec } from './sandbox/query.js';
import type { DatabaseReference } from './database-types.js';

/**
 * Hidden brand on every {@link Query} (and on every QueryConstraint).
 * Distinct from `TARGET_SYMBOL`; this brand is only used to dispatch
 * `get` / `onValue` between plain refs and query-wrapped refs.
 */
export const QUERY_SYMBOL: unique symbol = Symbol('pyric/database/query');

/** Hidden brand on every {@link QueryConstraint}. */
export const CONSTRAINT_SYMBOL: unique symbol = Symbol('pyric/database/query-constraint');

/**
 * RTDB-shaped Query — a ref + an immutable constraint chain. Mirrors
 * `firebase/database`'s `Query` for the subset of methods the modular
 * SDK uses idiomatically.
 *
 * Construct with {@link query}; pass to {@link get} or {@link onValue}.
 */
export interface Query {
  /** The Query's location. Used by `query()` chaining + listener fan-out. */
  readonly ref: DatabaseReference;
  /** Resolves to the same URL the ref would. */
  toString(): string;
  /** Internal — the constraint chain that built this query (sandbox path). */
  readonly _spec: QuerySpec;
  readonly [QUERY_SYMBOL]: true;
}

/**
 * Opaque constraint produced by `orderByChild` / `equalTo` / `limitToFirst`
 * etc. Pass to {@link query}.
 */
export interface QueryConstraint {
  /** The constraint's variant — surfaces as the SDK's
   *  `QueryConstraintType` strings. */
  readonly type:
    | 'orderByChild'
    | 'orderByKey'
    | 'orderByValue'
    | 'startAt'
    | 'startAfter'
    | 'endAt'
    | 'endBefore'
    | 'equalTo'
    | 'limitToFirst'
    | 'limitToLast';
  readonly [CONSTRAINT_SYMBOL]: Constraint;
}

export function buildConstraint(
  type: QueryConstraint['type'],
  internal: Constraint,
): QueryConstraint {
  return Object.freeze({
    type,
    [CONSTRAINT_SYMBOL]: internal,
  });
}

export function isQuery(v: object): v is Query {
  return QUERY_SYMBOL in v;
}

