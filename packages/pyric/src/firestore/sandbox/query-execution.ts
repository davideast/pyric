import { topK } from './topk.js';
import { firestoreValuesEqual } from './value-equality.js';
import { compareValues, typeOrderRank } from './query-value-order.js';
import { FirestoreCompatError } from './firestore-compat-error.js';
import type { DocStore } from './local-state.js';
import type { QueryConstraints } from './list-query-proof.js';
import type { FirestoreSimError } from './errors.js';

export type QueryDocumentData = Record<string, unknown>;
export type QueryWhereFilterOp =
  | '<' | '<=' | '==' | '!=' | '>=' | '>'
  | 'in' | 'not-in'
  | 'array-contains' | 'array-contains-any';
export type QueryOrderDirection = 'asc' | 'desc';
export type QueryFilter =
  | { kind: 'where'; field: string; op: QueryWhereFilterOp; value: unknown }
  | { kind: 'and'; filters: QueryFilter[] }
  | { kind: 'or'; filters: QueryFilter[] };
export interface QueryOrderClause {
  field: string;
  direction: QueryOrderDirection;
}
export interface QueryCursor {
  values: readonly unknown[];
  inclusive: boolean;
  fromSnapshot: boolean;
}
export interface QueryExecutionSpec {
  filters: readonly QueryFilter[];
  orders: readonly QueryOrderClause[];
  limitCount?: number;
  limitFromEnd: boolean;
  start?: QueryCursor;
  end?: QueryCursor;
}
export interface QueryRow {
  path: string;
  data: QueryDocumentData;
  phantom?: true;
}
export type QueryScope =
  | { kind: 'collection'; path: string }
  | { kind: 'collection-group'; collectionId: string };
export interface RunQueryRequest {
  scope: QueryScope;
  listPath: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  execution: QueryExecutionSpec;
  proof?: QueryConstraints;
  bypassRules?: boolean;
  activityQuery?: unknown;
}
export type RunQueryResult =
  | { allowed: true; docs: QueryRow[] }
  | { allowed: false; error: FirestoreSimError };

export function gatherQueryRows(state: DocStore, scope: QueryScope): QueryRow[] {
  if (scope.kind === 'collection') {
    return state.scan(scope.path, { directOnly: true });
  }
  const rows: QueryRow[] = [];
  for (const [path, data] of Object.entries(state.snapshot())) {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    if (
      segments.length > 0 &&
      segments.length % 2 === 0 &&
      segments[segments.length - 2] === scope.collectionId
    ) {
      rows.push({ path, data });
    }
  }
  return rows;
}

const KEY_FIELD = '__name__';

/** Operators that make a `where` clause an inequality filter — these imply
 *  an orderBy on the filtered field (mirrors `getInequalityFilterFields`). */
const INEQUALITY_OPS: ReadonlySet<QueryWhereFilterOp> = new Set<QueryWhereFilterOp>([
  '<', '<=', '>', '>=', '!=', 'not-in',
]);

/** Read the order value for a row at `field`. `__name__` resolves to a
 *  reference-like keyed on the document path so `compareValues` orders it
 *  via its reference branch; all other fields read from the doc data. */
function orderValue(row: { path: string; data: QueryDocumentData }, field: string): unknown {
  return field === KEY_FIELD ? { path: row.path } : row.data[field];
}

/** The set of fields a filter constrains with an inequality operator —
 *  recurses through composite AND/OR filters. Mirrors upstream
 *  `getInequalityFilterFields`. */
function inequalityFields(filter: QueryFilter): string[] {
  if (filter.kind === 'where') {
    return INEQUALITY_OPS.has(filter.op) ? [filter.field] : [];
  }
  // 'and' / 'or' — gather from sub-filters.
  return filter.filters.flatMap(inequalityFields);
}

/** True when a filter (possibly composite) carries any inequality op. */
function hasInequality(filter: QueryFilter): boolean {
  return inequalityFields(filter).length > 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Range comparators (FS-B3) — canonical, type-order-aware.
//
// Firestore range filters (`<` `<=` `>` `>=`) only match values of the
// SAME canonical type as the operand (a `>` 5 never matches a string),
// so the comparators short-circuit to `false` across type ranks and
// delegate within-type to the canonical `compareValues`. This replaces
// the old `String(a) < String(b)` cross-type fallback that produced
// lexicographic nonsense for timestamps/numbers and broke NaN.
// ─────────────────────────────────────────────────────────────────────────

/** True when `a` and `b` share a canonical type rank (and so are
 *  range-comparable). NaN is a number for ranking but Firestore's
 *  inequality filters never match NaN — guarded by the callers. */
function sameType(a: unknown, b: unknown): boolean {
  return typeOrderRank(a) === typeOrderRank(b);
}

function lessThan(a: unknown, b: unknown): boolean {
  return sameType(a, b) && compareValues(a, b) < 0;
}

function lessOrEqual(a: unknown, b: unknown): boolean {
  return sameType(a, b) && compareValues(a, b) <= 0;
}

function greaterThan(a: unknown, b: unknown): boolean {
  return sameType(a, b) && compareValues(a, b) > 0;
}

function greaterOrEqual(a: unknown, b: unknown): boolean {
  return sameType(a, b) && compareValues(a, b) >= 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Where / order / limit application.
// ─────────────────────────────────────────────────────────────────────────

function matchesWhere(
  value: unknown,
  op: QueryWhereFilterOp,
  target: unknown,
): boolean {
  // FS-B7 — a missing field (value === undefined) never matches any
  // filter except via the existence rules below; mirrors upstream
  // `FieldFilter.matches`, where `doc.data.field(...) === null` (absent)
  // short-circuits every operator to false.
  const present = value !== undefined;
  switch (op) {
    case '==': return present && firestoreValuesEqual(value, target);
    case '!=':
      // != requires the field to EXIST and be non-null, then differ.
      // (clones/.../core/filter.ts FieldFilter.matches NOT_EQUAL branch.)
      return present && value !== null && !firestoreValuesEqual(value, target);
    case '<': return present && lessThan(value, target);
    case '<=': return present && lessOrEqual(value, target);
    case '>': return present && greaterThan(value, target);
    case '>=': return present && greaterOrEqual(value, target);
    case 'in':
      return present && Array.isArray(target) && target.some((t) => firestoreValuesEqual(value, t));
    case 'not-in':
      // not-in requires existence + non-null; a null in the operand list
      // makes the filter match nothing (clones/.../core/filter.ts
      // NotInFilter.matches). Field must also not equal any operand.
      if (!Array.isArray(target)) return false;
      if (target.some((t) => t === null)) return false;
      return present && value !== null && !target.some((t) => firestoreValuesEqual(value, t));
    case 'array-contains':
      return Array.isArray(value) && value.some((v) => firestoreValuesEqual(v, target));
    case 'array-contains-any':
      return Array.isArray(value)
        && Array.isArray(target)
        && target.some((t) => value.some((v) => firestoreValuesEqual(v, t)));
  }
}

/**
 * Resolve a where-clause field against a candidate row. `__name__`
 * (documentId()) is the document key — for collection-scoped queries
 * the modular SDK compares string operands against the document id
 * (last path segment) and DocumentReference operands against that
 * same id (via {@link normalizeNameOperand}).
 */
function filterFieldValue(row: QueryRow, field: string): unknown {
  if (field === KEY_FIELD) {
    const parts = row.path.split('/');
    return parts[parts.length - 1] ?? row.path;
  }
  return row.data[field];
}

/**
 * Normalize a `documentId()` / `__name__` operand so string ids and
 * DocumentReference-like values compare as document ids.
 */
function normalizeNameOperand(target: unknown): unknown {
  if (Array.isArray(target)) {
    return target.map(normalizeNameOperand);
  }
  if (target && typeof target === 'object') {
    const ref = target as { id?: unknown; path?: unknown };
    if (typeof ref.id === 'string') return ref.id;
    if (typeof ref.path === 'string') {
      const parts = ref.path.split('/');
      return parts[parts.length - 1] ?? ref.path;
    }
  }
  return target;
}

/**
 * Recursive filter evaluator. `where` leaves call into the existing
 * scalar-op matcher; AND / OR composite filters short-circuit
 * across their sub-filter list.
 */
function matchesQueryFilter(row: QueryRow, filter: QueryFilter): boolean {
  if (filter.kind === 'where') {
    const value = filterFieldValue(row, filter.field);
    const target =
      filter.field === KEY_FIELD
        ? normalizeNameOperand(filter.value)
        : filter.value;
    return matchesWhere(value, filter.op, target);
  }
  if (filter.kind === 'and') {
    return filter.filters.every((sub) => matchesQueryFilter(row, sub));
  }
  // 'or'
  return filter.filters.some((sub) => matchesQueryFilter(row, sub));
}

function applyQueryFilters(
  docs: QueryRow[],
  filters: QueryFilter[],
): QueryRow[] {
  return docs.filter((d) => filters.every((f) => matchesQueryFilter(d, f)));
}

function compareToCursor(
  row: { path: string; data: QueryDocumentData },
  cursorValues: readonly unknown[],
  orders: readonly QueryOrderClause[],
): number {
  for (let i = 0; i < cursorValues.length; i++) {
    const cmp = compareValues(orderValue(row, orders[i].field), cursorValues[i]);
    if (cmp !== 0) {
      return orders[i].direction === 'desc' ? -cmp : cmp;
    }
  }
  return 0;
}

/**
 * Slice `rows` to the portion of the ordering between (optionally)
 * `start` and `end` cursors. `rows` must already be sorted per
 * `orders`. Inclusive flags switch ≥ / >  for start and ≤ / < for
 * end.
 */
function applyCursors(
  rows: QueryRow[],
  orders: QueryOrderClause[],
  start: { values: readonly unknown[]; inclusive: boolean } | undefined,
  end: { values: readonly unknown[]; inclusive: boolean } | undefined,
): QueryRow[] {
  return rows.filter((row) => {
    if (start) {
      const cmp = compareToCursor(row, start.values, orders);
      if (start.inclusive ? cmp < 0 : cmp <= 0) return false;
    }
    if (end) {
      const cmp = compareToCursor(row, end.values, orders);
      if (end.inclusive ? cmp > 0 : cmp >= 0) return false;
    }
    return true;
  });
}

// FS-B3: Firestore excludes docs that are missing ANY orderBy field (an
// orderBy on a field implies the field must exist). Sorting them in with
// `compareValues(undefined, …)` would surface docs a production query never
// returns. `__name__` is always present (the doc key), so the implicit FS-B8
// key order never excludes a doc.
function orderPresent(docs: QueryRow[], orders: QueryOrderClause[]): QueryRow[] {
  return docs.filter((d) =>
    orders.every((o) => o.field === KEY_FIELD || d.data[o.field] !== undefined),
  );
}

/** The orderBy comparator over the (normalized) orders. Shared by the full sort
 *  and the top-k fast path so they are guaranteed identical. */
function orderComparator(
  orders: QueryOrderClause[],
): (a: QueryRow, b: QueryRow) => number {
  return (a, b) => {
    for (const o of orders) {
      const cmp = compareValues(orderValue(a, o.field), orderValue(b, o.field));
      if (cmp !== 0) return o.direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  };
}

function applyOrder(
  docs: QueryRow[],
  orders: QueryOrderClause[],
): QueryRow[] {
  if (orders.length === 0) return docs;
  return orderPresent(docs, orders).sort(orderComparator(orders));
}


export function normalizedQueryOrders(spec: QueryExecutionSpec): QueryOrderClause[] {
  const out: QueryOrderClause[] = [...spec.orders];
  const seen = new Set(out.map((order) => order.field));
  const lastDirection: QueryOrderDirection =
    spec.orders.length > 0 ? spec.orders[spec.orders.length - 1]!.direction : 'asc';
  for (const filter of spec.filters) {
    for (const field of inequalityFields(filter)) {
      if (field !== KEY_FIELD && !seen.has(field)) {
        seen.add(field);
        out.push({ field, direction: lastDirection });
      }
    }
  }
  if (!seen.has(KEY_FIELD)) {
    out.push({ field: KEY_FIELD, direction: lastDirection });
  }
  return out;
}

export function executeQuery(
  rows: QueryRow[],
  spec: QueryExecutionSpec,
): QueryRow[] {
  let filtered = applyQueryFilters(rows, [...spec.filters]);
  const normalized = normalizedQueryOrders(spec);
  const needsOrder =
    spec.orders.length > 0 ||
    spec.start !== undefined ||
    spec.end !== undefined ||
    spec.filters.some(hasInequality);

  if (
    needsOrder &&
    spec.limitCount !== undefined &&
    !spec.limitFromEnd &&
    spec.start === undefined &&
    spec.end === undefined
  ) {
    return topK(
      orderPresent(filtered, normalized),
      spec.limitCount,
      orderComparator(normalized),
    );
  }
  if (needsOrder) filtered = applyOrder(filtered, normalized);

  if (spec.start || spec.end) {
    for (const cursor of [spec.start, spec.end]) {
      if (cursor && !cursor.fromSnapshot && cursor.values.length > spec.orders.length) {
        throw new FirestoreCompatError({
          code: 'invalid-argument',
          message:
            'Too many arguments provided to a cursor (startAt / startAfter / ' +
            'endAt / endBefore). The number of cursor values must be less than ' +
            'or equal to the number of orderBy() clauses.',
        });
      }
    }
    filtered = applyCursors(filtered, normalized, spec.start, spec.end);
  }

  if (spec.limitCount !== undefined) {
    if (spec.limitFromEnd) {
      if (spec.orders.length === 0) {
        throw new FirestoreCompatError({
          code: 'invalid-argument',
          message: 'limitToLast() queries require at least one orderBy clause.',
        });
      }
      filtered = filtered.slice(-spec.limitCount);
    } else {
      filtered = filtered.slice(0, spec.limitCount);
    }
  }
  return filtered;
}
