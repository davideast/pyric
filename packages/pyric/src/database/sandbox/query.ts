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
 *     In prod this requires `.indexOn: ".value"` — sandbox does NOT
 *     enforce indexes (no rules-engine integration here). Locked by
 *     `rtdb-modular-orderbyvalue-numeric.json` (note: the prod probe
 *     threw `Index not defined`; the sandbox returns the ordered window
 *     directly. Tests configure default-allow rules so the sandbox
 *     match is the semantic one — not the index-enforcement one).
 *
 * Note: this module deliberately does NOT model `.indexOn` rules — the
 * sandbox is for unit-test-fast iteration where the consumer's intent
 * is the query result, not rules conformance. Rules-engine-driven index
 * enforcement is a deferred follow-up (would naturally hang off
 * `RulesEvaluator` not here).
 */
import type { JsonValue } from './data-tree.js';

/** Ordering selector. Stored as a discriminated union so the executor
 *  can switch on the kind without re-parsing. */
export type OrderBy =
  | { kind: 'child'; path: string }
  | { kind: 'key' }
  | { kind: 'priority' }
  | { kind: 'value' };

export type Priority = string | number | null;

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

/** Empty spec — equivalent to "no constraints" (a plain ref query). */
export function emptySpec(): QuerySpec {
  return { orderBy: null, bounds: [], limit: null };
}

/** Whether the spec already has a lower-bound (start) constraint. A
 *  `startAt`/`startAfter`/`equalTo` all set the start. */
function specHasStart(spec: QuerySpec): boolean {
  return spec.bounds.some(
    (b) => b.kind === 'startAt' || b.kind === 'startAfter' || b.kind === 'equalTo',
  );
}

/** Whether the spec already has an upper-bound (end) constraint. A
 *  `endAt`/`endBefore`/`equalTo` all set the end. */
function specHasEnd(spec: QuerySpec): boolean {
  return spec.bounds.some(
    (b) => b.kind === 'endAt' || b.kind === 'endBefore' || b.kind === 'equalTo',
  );
}

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
        throw new Error("You can't combine multiple orderBy calls.");
      }
      return { ...spec, orderBy: c.spec };
    case 'bound': {
      const setsStart =
        c.bound.kind === 'startAt' || c.bound.kind === 'startAfter' || c.bound.kind === 'equalTo';
      const setsEnd =
        c.bound.kind === 'endAt' || c.bound.kind === 'endBefore' || c.bound.kind === 'equalTo';
      if (setsStart && specHasStart(spec)) {
        throw new Error(
          `${c.bound.kind}: Starting point was already set (by another call to startAt, startAfter, or equalTo).`,
        );
      }
      if (setsEnd && specHasEnd(spec)) {
        throw new Error(
          `${c.bound.kind}: Ending point was already set (by another call to endAt, endBefore, or equalTo).`,
        );
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

/**
 * Compare two `JsonValue`s under RTDB's documented type-order rules.
 * Locked by the upstream contract (Firebase docs: null < false < true
 * < number < string < object). The sandbox's ordering only needs to
 * match against same-type-or-null/undefined.
 *
 * Returns -1 / 0 / 1.
 */
export function compareValues(a: JsonValue, b: JsonValue): number {
  if (a === b) return 0;
  // null sorts first.
  if (a === null) return -1;
  if (b === null) return 1;
  const ta = typeofRank(a);
  const tb = typeofRank(b);
  if (ta !== tb) return ta - tb;
  // Same type — value comparison.
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  // Objects/arrays are "greater" than primitives, but two object-valued
  // children are ORDER-EQUAL under RTDB's model — the tie is broken by
  // key, NOT by an invented JSON-string ordering (DB-B11; mirrors
  // `ChildrenNode.ts:386-400` where ChildrenNodes compare equal). Return
  // 0 so the caller's key tie-break takes over.
  return 0;
}

function typeofRank(v: JsonValue): number {
  // null = 0; boolean = 1; number = 2; string = 3; object/array = 4.
  if (v === null) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (typeof v === 'string') return 3;
  return 4;
}

/** Used to test for integer-looking strings. Mirrors `INTEGER_REGEXP_`
 *  (`core/util/util.ts:496`). */
const INTEGER_REGEXP = /^-?(0*)\d{1,10}$/;
const INTEGER_32_MIN = -2147483648;
const INTEGER_32_MAX = 2147483647;

/** If the string is a 32-bit integer, return it; else `null`. Mirrors
 *  `tryParseInt` (`core/util/util.ts:511-520`). */
function tryParseInt(str: string): number | null {
  if (INTEGER_REGEXP.test(str)) {
    const intVal = Number(str);
    if (intVal >= INTEGER_32_MIN && intVal <= INTEGER_32_MAX) {
      return intVal;
    }
  }
  return null;
}

/**
 * Compare two Firebase key names under RTDB's `nameCompare` ordering:
 * integer-looking keys sort FIRST (numerically; ties broken by string
 * length so `"01"` follows `"1"`), then non-integer keys sort
 * lexicographically. Mirrors `nameCompare` (`core/util/util.ts:253-276`).
 *
 * This is RTDB's universal key order — it drives `orderByKey()`, the
 * tie-break for `orderByChild`/`orderByValue`, and the `key` argument of
 * `startAt(value, key)` / `endAt(value, key)` cursors. Plain
 * lexicographic compare (DB-B4) put `"10"` before `"2"`.
 */
export function nameCompare(a: string, b: string): number {
  if (a === b) return 0;
  const aAsInt = tryParseInt(a);
  const bAsInt = tryParseInt(b);
  if (aAsInt !== null) {
    if (bAsInt !== null) {
      return aAsInt - bAsInt === 0 ? a.length - b.length : aAsInt - bAsInt;
    }
    // Integer keys sort before non-integer keys.
    return -1;
  } else if (bAsInt !== null) {
    return 1;
  }
  return a < b ? -1 : 1;
}

/**
 * Extract the value the ordering uses to compare a child. For
 * `orderByKey()` it's the key string; for `orderByValue()` the child's
 * raw value; for `orderByChild(path)` the nested field at `path`
 * (which may itself be missing → `null`).
 */
export function extractOrderValue(
  spec: OrderBy | null,
  key: string,
  value: JsonValue,
  priority: Priority = null,
): JsonValue {
  const o = spec ?? { kind: 'priority' as const };
  switch (o.kind) {
    case 'key':
      return key;
    case 'value':
      return value;
    case 'priority':
      return priority;
    case 'child': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
      }
      // Path may be a slash-separated dotted path (`'profile/name'`).
      const segs = o.path.split('/').filter((s) => s.length > 0);
      let cur: JsonValue = value;
      for (const s of segs) {
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
        cur = (cur as Record<string, JsonValue>)[s] ?? null;
      }
      return cur;
    }
  }
}

/** Result row — kept minimal so the snap-builder can render it cheaply. */
export interface QueryRow {
  key: string;
  value: JsonValue;
  priority: Priority;
}

/**
 * Run a {@link QuerySpec} against the data at a path. The caller passes
 * the raw value at the path (a `Record<string, JsonValue>` if it's a
 * collection, anything else → empty result).
 *
 * Returns an ordered, filtered, limited list of rows.
 */
export function executeQuery(
  pathData: JsonValue,
  spec: QuerySpec,
  priorityForKey: (key: string) => Priority = () => null,
): QueryRow[] {
  // Non-collection input → no rows. RTDB's `query()` on a primitive
  // path returns an empty snapshot.
  if (pathData === null || typeof pathData !== 'object' || Array.isArray(pathData)) {
    return [];
  }
  const obj = pathData as Record<string, JsonValue>;
  // Enumerate immediate children only — RTDB's query model is one-level.
  let rows: QueryRow[] = Object.entries(obj).map(([key, value]) => ({
    key,
    value,
    priority: priorityForKey(key),
  }));

  // ─── 1. Order ─────────────────────────────────────────────────────
  const orderingByKey = spec.orderBy?.kind === 'key';
  rows.sort((a, b) => {
    if (orderingByKey) {
      // `orderByKey` compares keys under RTDB's nameCompare directly
      // (numeric-keys-first) — there's no separate tie-break.
      return nameCompare(a.key, b.key);
    }
    const va = extractOrderValue(spec.orderBy, a.key, a.value, a.priority);
    const vb = extractOrderValue(spec.orderBy, b.key, b.value, b.priority);
    const cmp = compareValues(va, vb);
    if (cmp !== 0) return cmp;
    // Tie-break by key under nameCompare (RTDB's documented behavior —
    // orderByChild / orderByValue ties break by key, numeric-first).
    return nameCompare(a.key, b.key);
  });

  // ─── 2. Bounds ────────────────────────────────────────────────────
  for (const b of spec.bounds) {
    rows = rows.filter((row) => boundMatches(b, row, spec.orderBy));
  }

  // ─── 3. Limit ─────────────────────────────────────────────────────
  if (spec.limit) {
    const n = spec.limit.n;
    if (spec.limit.kind === 'limitToFirst') {
      rows = rows.slice(0, n);
    } else {
      rows = n >= rows.length ? rows : rows.slice(rows.length - n);
    }
  }

  return rows;
}

/**
 * Does `row` pass the bound `b` under the active ordering?
 *
 * The bound's `value` is compared against the row's `extractOrderValue`.
 * The optional `key` arg (for `startAt(value, key)`) is a tie-breaker
 * for matching rows whose ordered-value equals `value` — the row passes
 * only if its key is also at-or-past the supplied key.
 */
function boundMatches(b: Bound, row: QueryRow, orderBy: OrderBy | null): boolean {
  const orderingByKey = orderBy?.kind === 'key';
  // Under `orderByKey`, the bound's `value` IS the comparison key and is
  // compared with nameCompare (numeric-first), NOT the value type-order.
  // Under value/child ordering, compare the ordered value, then break
  // ties on the key with nameCompare.
  const cmp = orderingByKey
    ? nameCompare(row.key, String(b.value))
    : compareValues(extractOrderValue(orderBy, row.key, row.value, row.priority), b.value);
  const keyCmp = (other: string): number => nameCompare(row.key, other);
  switch (b.kind) {
    case 'startAt':
      if (cmp > 0) return true;
      if (cmp < 0) return false;
      // Equal: defer to optional key tie-breaker.
      return b.key === undefined || keyCmp(b.key) >= 0;
    case 'startAfter':
      if (cmp > 0) return true;
      if (cmp < 0) return false;
      // Equal: row passes only if key strictly past the tie-breaker.
      return b.key === undefined ? false : keyCmp(b.key) > 0;
    case 'endAt':
      if (cmp < 0) return true;
      if (cmp > 0) return false;
      return b.key === undefined || keyCmp(b.key) <= 0;
    case 'endBefore':
      if (cmp < 0) return true;
      if (cmp > 0) return false;
      return b.key === undefined ? false : keyCmp(b.key) < 0;
    case 'equalTo':
      if (cmp !== 0) return false;
      return b.key === undefined || keyCmp(b.key) === 0;
  }
}
