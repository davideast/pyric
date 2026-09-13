import type { JsonValue } from '../sandbox/data-tree.js';
import type { Bound, OrderBy, Priority, QuerySpec } from '../sandbox/query.js';

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
