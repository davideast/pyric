import type { JsonValue } from './json-value.js';

/** Ordering selector. Stored as a discriminated union so the executor
 *  can switch on the kind without re-parsing. */
export type OrderBy =
  | { kind: 'child'; path: string }
  | { kind: 'key' }
  | { kind: 'priority' }
  | { kind: 'value' };

/** Cursor or filter bound. `startAt`/`endAt` are inclusive; the
 *  `*Exclusive` variants drop the boundary value. `equalTo` collapses
 *  start + end onto the same value (and is sugar for `startAt(v) +
 *  endAt(v)` per the SDK docs). */
export type Bound =
  | { kind: 'startAt'; value: JsonValue; key?: string }
  | { kind: 'startAfter'; value: JsonValue; key?: string }
  | { kind: 'endAt'; value: JsonValue; key?: string }
  | { kind: 'endBefore'; value: JsonValue; key?: string }
  | { kind: 'equalTo'; value: JsonValue; key?: string };

/** Window-size constraint. Mutually exclusive with each other (prod
 *  rejects setting both — we don't reject here but the executor
 *  prioritises the last one set, matching `firebase/database`). */
export type LimitKind = 'limitToFirst' | 'limitToLast';

/**
 * A {@link Query} is a ref + a chain of constraints. The chain is
 * order-independent in terms of declared shape — the executor groups
 * constraints into {order, bounds, limit} during apply.
 */
export interface QuerySpec {
  /** Active ordering. `null` means Firebase's default priority index. */
  orderBy: OrderBy | null;
  /** Range/equality filters. Multiple bounds compose. */
  bounds: Bound[];
  /** Optional limit. Last-wins if set more than once. */
  limit: { kind: LimitKind; n: number } | null;
}
