import type { JsonValue } from '../sandbox/data-tree.js';

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

/**
 * Compare two `JsonValue`s under RTDB's documented type-order rules.
 * Locked by the upstream contract (Firebase docs: null < false < true
 * < number < string < object). The sandbox's ordering only needs to
 * match against same-type-or-null/undefined.
 *
 * Returns -1 / 0 / 1.
 */
export function compareValues(a: JsonValue, b: JsonValue): number {
  const areEqual = a === b;
  if (areEqual) return 0;
  // null sorts first.
  const isLeftNull = a === null;
  if (isLeftNull) return -1;
  const isRightNull = b === null;
  if (isRightNull) return 1;
  const ta = typeofRank(a);
  const tb = typeofRank(b);
  const haveDifferentTypes = ta !== tb;
  if (haveDifferentTypes) return ta - tb;
  // Same type — value comparison.
  const areNumbers = typeof a === 'number' && typeof b === 'number';
  if (areNumbers) {
    const isLower = a < b;
    if (isLower) return -1;
    const isHigher = a > b;
    return isHigher ? 1 : 0;
  }
  const areBooleans = typeof a === 'boolean' && typeof b === 'boolean';
  if (areBooleans) {
    const isLeftTrue = a === true;
    return isLeftTrue ? 1 : -1;
  }
  const areStrings = typeof a === 'string' && typeof b === 'string';
  if (areStrings) {
    const isLower = a < b;
    if (isLower) return -1;
    const isHigher = a > b;
    return isHigher ? 1 : 0;
  }
  // Objects/arrays are "greater" than primitives, but two object-valued
  // children are ORDER-EQUAL under RTDB's model — the tie is broken by
  // key, NOT by an invented JSON-string ordering (DB-B11; mirrors
  // `ChildrenNode.ts:386-400` where ChildrenNodes compare equal). Return
  // 0 so the caller's key tie-break takes over.
  return 0;
}

function typeofRank(v: JsonValue): number {
  // null = 0; boolean = 1; number = 2; string = 3; object/array = 4.
  const isNull = v === null;
  if (isNull) return 0;
  const isBoolean = typeof v === 'boolean';
  if (isBoolean) return 1;
  const isNumber = typeof v === 'number';
  if (isNumber) return 2;
  const isString = typeof v === 'string';
  if (isString) return 3;
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
  const looksLikeInteger = INTEGER_REGEXP.test(str);
  if (looksLikeInteger) {
    const intVal = Number(str);
    const fitsIntegerKeyRange = intVal >= INTEGER_32_MIN && intVal <= INTEGER_32_MAX;
    if (fitsIntegerKeyRange) {
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
  const areEqual = a === b;
  if (areEqual) return 0;
  const aAsInt = tryParseInt(a);
  const bAsInt = tryParseInt(b);
  const isLeftInteger = aAsInt !== null;
  const isRightInteger = bAsInt !== null;
  if (isLeftInteger) {
    if (isRightInteger) {
      const difference = aAsInt - bAsInt;
      const haveSameInteger = difference === 0;
      return haveSameInteger ? a.length - b.length : difference;
    }
    // Integer keys sort before non-integer keys.
    return -1;
  } else if (isRightInteger) {
    return 1;
  }
  const comesBefore = a < b;
  return comesBefore ? -1 : 1;
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
      const hasNoChildren = value === null || typeof value !== 'object' || Array.isArray(value);
      if (hasNoChildren) {
        return null;
      }
      // Path may be a slash-separated dotted path (`'profile/name'`).
      const segs = o.path.split('/').filter((s) => s.length > 0);
      let cur: JsonValue = value;
      for (const s of segs) {
        const hasNoDescendant = cur === null || typeof cur !== 'object' || Array.isArray(cur);
        if (hasNoDescendant) return null;
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
  // Scalar inputs have no child rows. Snapshot callers handle scalar values.
  const hasNoChildren = pathData === null || typeof pathData !== 'object' || Array.isArray(pathData);
  if (hasNoChildren) {
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
    const haveDifferentOrderValues = cmp !== 0;
    if (haveDifferentOrderValues) return cmp;
    // Tie-break by key under nameCompare (RTDB's documented behavior —
    // orderByChild / orderByValue ties break by key, numeric-first).
    return nameCompare(a.key, b.key);
  });

  // ─── 2. Bounds ────────────────────────────────────────────────────
  for (const b of spec.bounds) {
    rows = rows.filter((row) => boundMatches(b, row, spec.orderBy));
  }

  // ─── 3. Limit ─────────────────────────────────────────────────────
  const limit = spec.limit;
  const hasLimit = limit !== null;
  if (hasLimit) {
    const n = limit.n;
    const takesFirst = limit.kind === 'limitToFirst';
    if (takesFirst) {
      rows = rows.slice(0, n);
    } else {
      const includesAllRows = n >= rows.length;
      if (includesAllRows) return rows;
      rows = rows.slice(rows.length - n);
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
  let cmp: number;
  if (orderingByKey) {
    cmp = nameCompare(row.key, String(b.value));
  } else {
    const orderValue = extractOrderValue(orderBy, row.key, row.value, row.priority);
    cmp = compareValues(orderValue, b.value);
  }
  const keyCmp = (other: string): number => nameCompare(row.key, other);
  const isAfter = cmp > 0;
  const isBefore = cmp < 0;
  const differsFromBound = cmp !== 0;
  switch (b.kind) {
    case 'startAt': {
      if (isAfter) return true;
      if (isBefore) return false;
      // Equal: defer to optional key tie-breaker.
      const boundaryKey = b.key;
      const hasNoBoundaryKey = boundaryKey === undefined;
      return hasNoBoundaryKey || keyCmp(boundaryKey) >= 0;
    }
    case 'startAfter': {
      if (isAfter) return true;
      if (isBefore) return false;
      // Equal: row passes only if key strictly past the tie-breaker.
      const boundaryKey = b.key;
      const hasNoBoundaryKey = boundaryKey === undefined;
      if (hasNoBoundaryKey) return false;
      return keyCmp(boundaryKey) > 0;
    }
    case 'endAt': {
      if (isBefore) return true;
      if (isAfter) return false;
      const boundaryKey = b.key;
      const hasNoBoundaryKey = boundaryKey === undefined;
      return hasNoBoundaryKey || keyCmp(boundaryKey) <= 0;
    }
    case 'endBefore': {
      if (isBefore) return true;
      if (isAfter) return false;
      const boundaryKey = b.key;
      const hasNoBoundaryKey = boundaryKey === undefined;
      if (hasNoBoundaryKey) return false;
      return keyCmp(boundaryKey) < 0;
    }
    case 'equalTo': {
      if (differsFromBound) return false;
      const boundaryKey = b.key;
      const hasNoBoundaryKey = boundaryKey === undefined;
      return hasNoBoundaryKey || keyCmp(boundaryKey) === 0;
    }
  }
}
