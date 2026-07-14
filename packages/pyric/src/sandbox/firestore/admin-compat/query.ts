/**
 * `QueryImpl` + `CollectionRefImpl` — Admin-SDK-compat query / collection
 * surfaces backed by `LocalEnvironment.listDocuments(...)`.
 *
 * Ported from bench's `pilot/src/firestore-wrapper.ts:277-353`.
 *
 * Filtering is done JS-side because `listDocuments` returns the full
 * collection unfiltered. That's the simulator's contract — it's a
 * read-once snapshot, not a query engine — so the wrapper does the
 * `where`/`orderBy`/`limit` work in memory before yielding snapshots.
 *
 * Differences from the bench source:
 *   - Phantom parent docs (synthetic records the SDK injects for any
 *     parent path that has descendants but no own data; see
 *     `LocalEnvironment.listDocuments` JSDoc) are filtered OUT before
 *     query results are returned. Phantom docs are a discover-crawler
 *     affordance, not a query result — production Firestore would not
 *     surface them in a `collection().get()` either.
 *   - `compareValues` and `matchesWhere` use typed narrowing rather
 *     than the bench's `as any` coercion. Same end result for
 *     number/string/boolean/bigint fields (the only types the corpus
 *     exercises today, per the design-doc inventory) and a deterministic
 *     fallback (`String(...)` comparison) for cross-type cases.
 *   - `firestoreValuesEqual` keeps query value matching aligned with
 *     transform dedupe and Firestore value wrappers.
 *
 * Circular import note: `doc-ref.ts` imports `CollectionRefImpl` for
 * `.parent` / `.collection(name)`; this file imports `DocumentRefImpl`
 * for `CollectionRefImpl.doc()` and `QueryImpl.get()`. Both references
 * sit inside method bodies (not class evaluation), so ESM's deferred
 * binding resolves them correctly — no lazy-load machinery needed.
 */

import type { LocalEnvironment } from 'pyric/sandbox/internal';
import { generateAutoId } from 'pyric/sandbox/internal';
import { lastSegment } from './paths.js';
import { translateReadData } from './snapshots.js';
import { DocumentRefImpl } from './doc-ref.js';
// Canonical Firestore value comparison (FS-B3) — type-order-aware,
// NaN-correct. Replaces the old `String().localeCompare` fallback that
// mis-ordered cross-type values + broke NaN. See `value-order.ts`.
import { compareValues, typeOrderRank } from './value-order.js';
import { topK } from '../topk.js';
import { firestoreValuesEqual } from '../value-equality.js';
// RULES-B11 — structured `where`/`limit`/`orderBy` view threaded into the
// rule-enforced read paths so the query-proof gate ("rules are not
// filters") can discharge per-doc rule predicates from the query's
// equality constraints.
import type {
  QueryConstraints,
  QueryWhereConstraint,
} from '../../../rules/simulator/query-proof.js';
import type { QueryConstraintApplier } from '../snapshot-listeners.js';
import {
  FirestoreCompatError,
  type AggregateField,
  type AggregateQuerySnapshot,
  type AggregateSpec,
  type AuthContext,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Filter,
  type OperationOptions,
  type OrderDirection,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  type WhereFilterOp,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Internal clause shapes (not exported — wrapper-internal).
//
// Composite filters: Each query carries an array of `Filter` values.
// Multiple filters AND together (matching multiple `where()` calls).
// Composite OR / AND filters are introduced by `Query.applyFilter`
// (which `pyric/firestore`'s `or()` / `and()` modular factories
// route through).
// ─────────────────────────────────────────────────────────────────────────

interface OrderClause {
  field: string;
  direction: OrderDirection;
}

// FS-B8 — the document-key sentinel field. Firestore normalizes every
// query's sort to include an implicit final ordering on the document key
// (`__name__`) so equal-valued docs have a deterministic order and cursors
// can disambiguate them. We model the key value as a reference-like
// `{ path }` so the canonical `compareValues` reference branch orders it.
const KEY_FIELD = '__name__';

/** Operators that make a `where` clause an inequality filter — these imply
 *  an orderBy on the filtered field (mirrors `getInequalityFilterFields`). */
const INEQUALITY_OPS: ReadonlySet<WhereFilterOp> = new Set<WhereFilterOp>([
  '<', '<=', '>', '>=', '!=', 'not-in',
]);

/** Read the order value for a row at `field`. `__name__` resolves to a
 *  reference-like keyed on the document path so `compareValues` orders it
 *  via its reference branch; all other fields read from the doc data. */
function orderValue(row: { path: string; data: DocumentData }, field: string): unknown {
  return field === KEY_FIELD ? { path: row.path } : row.data[field];
}

/** The set of fields a filter constrains with an inequality operator —
 *  recurses through composite AND/OR filters. Mirrors upstream
 *  `getInequalityFilterFields`. */
function inequalityFields(filter: Filter): string[] {
  if (filter.kind === 'where') {
    return INEQUALITY_OPS.has(filter.op) ? [filter.field] : [];
  }
  // 'and' / 'or' — gather from sub-filters.
  return filter.filters.flatMap(inequalityFields);
}

/** True when a filter (possibly composite) carries any inequality op. */
function hasInequality(filter: Filter): boolean {
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
  op: WhereFilterOp,
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

interface CollectionRow {
  path: string;
  data: DocumentData;
  phantom?: true;
}

/**
 * Resolve a where-clause field against a candidate row. `__name__`
 * (documentId()) is the document key — for collection-scoped queries
 * the modular SDK compares string operands against the document id
 * (last path segment) and DocumentReference operands against that
 * same id (via {@link normalizeNameOperand}).
 */
function filterFieldValue(row: CollectionRow, field: string): unknown {
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
function matchesFilter(row: CollectionRow, filter: Filter): boolean {
  if (filter.kind === 'where') {
    const value = filterFieldValue(row, filter.field);
    const target =
      filter.field === KEY_FIELD
        ? normalizeNameOperand(filter.value)
        : filter.value;
    return matchesWhere(value, filter.op, target);
  }
  if (filter.kind === 'and') {
    return filter.filters.every((sub) => matchesFilter(row, sub));
  }
  // 'or'
  return filter.filters.some((sub) => matchesFilter(row, sub));
}

function applyFilters(
  docs: CollectionRow[],
  filters: Filter[],
): CollectionRow[] {
  return docs.filter((d) => filters.every((f) => matchesFilter(d, f)));
}

/**
 * Pull the cursor values out of a `DocumentSnapshot` at the query's
 * orderBy fields. Backs the `startCursorFromSnapshot` /
 * `endCursorFromSnapshot` overload that mirrors the JS SDK's
 * `startAt(snapshot)` / `startAfter(snapshot)` / `endAt(snapshot)` /
 * `endBefore(snapshot)`.
 *
 * Throws when the query has no `orderBy` clauses — production
 * raises the same precondition. The snapshot's `.data()` is read
 * once and indexed positionally for each clause.
 */
function cursorValuesFromSnapshot(
  snapshot: DocumentSnapshot,
  orders: readonly OrderClause[],
): unknown[] {
  const data = snapshot.data();
  if (data === undefined) {
    // FS-B16 — carry a FirestoreError `.code`. Prod raises `not-found`:
    // "Can't use a DocumentSnapshot that doesn't exist for …()."
    // (clones/.../lite-api/query.ts:newQueryBoundFromDocument).
    throw new FirestoreCompatError({
      code: 'not-found',
      message:
        'Snapshot-based cursors require an existing document — got an empty ' +
        `snapshot for ${snapshot.id ?? '<unknown>'}.`,
    });
  }
  // FS-B8 — `orders` is the NORMALIZED sort (always carries the implicit
  // `__name__` clause), so a `startAt(snapshot)` with no explicit orderBy
  // is legal in prod: it positions on the document key. `__name__` reads
  // the snapshot's ref path; data fields read positionally.
  return orders.map((o) =>
    o.field === KEY_FIELD ? { path: snapshot.ref.path } : data[o.field],
  );
}

/**
 * Compare a row's ordered field values to a cursor's values in the
 * direction of the orderBy clauses. Returns negative when the row
 * precedes the cursor in ordered position, 0 on tie, positive when
 * it follows. Lexicographic across `cursor.values.length` orderBy
 * clauses — any tail of orderBy clauses beyond the cursor length is
 * not consulted (matches production's "prefix cursor" semantics).
 */
function compareToCursor(
  row: { path: string; data: DocumentData },
  cursorValues: readonly unknown[],
  orders: readonly OrderClause[],
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
  rows: CollectionRow[],
  orders: OrderClause[],
  start: { values: readonly unknown[]; inclusive: boolean } | undefined,
  end: { values: readonly unknown[]; inclusive: boolean } | undefined,
): CollectionRow[] {
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
function orderPresent(docs: CollectionRow[], orders: OrderClause[]): CollectionRow[] {
  return docs.filter((d) =>
    orders.every((o) => o.field === KEY_FIELD || d.data[o.field] !== undefined),
  );
}

/** The orderBy comparator over the (normalized) orders. Shared by the full sort
 *  and the top-k fast path so they are guaranteed identical. */
function orderComparator(
  orders: OrderClause[],
): (a: CollectionRow, b: CollectionRow) => number {
  return (a, b) => {
    for (const o of orders) {
      const cmp = compareValues(orderValue(a, o.field), orderValue(b, o.field));
      if (cmp !== 0) return o.direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  };
}

function applyOrder(
  docs: CollectionRow[],
  orders: OrderClause[],
): CollectionRow[] {
  if (orders.length === 0) return docs;
  return orderPresent(docs, orders).sort(orderComparator(orders));
}

// ─────────────────────────────────────────────────────────────────────────
// Public surface — QueryImpl + CollectionRefImpl.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cursor position along the orderBy fields. `values` is positional —
 * `values[i]` compares against `orders[i].field`. `inclusive`
 * distinguishes startAt/endAt (true) from startAfter/endBefore (false).
 */
interface Cursor {
  values: readonly unknown[];
  inclusive: boolean;
  /**
   * FS-B8 — whether this cursor was built from a `DocumentSnapshot`.
   * Snapshot cursors position against the NORMALIZED orderBy (with the
   * implicit `__name__` key), so they are legal without an explicit
   * orderBy. VALUE cursors position against the EXPLICIT orderBy only and
   * throw when they carry more values than explicit orderBy clauses
   * (upstream `boundFromFields`: "Too many arguments").
   */
  fromSnapshot: boolean;
}

export class QueryImpl implements Query {
  constructor(
    protected readonly env: LocalEnvironment,
    protected readonly auth: AuthContext,
    protected readonly collectionPath: string,
    protected readonly clauses: readonly Filter[] = [],
    protected readonly orders: readonly OrderClause[] = [],
    protected readonly limitCount?: number,
    /**
     * When true, the query was built via `limitToLast(n)`. The
     * `applyConstraints` pipeline reverses each orderBy direction
     * before slicing and re-reverses afterwards. Requires at least
     * one `orderBy` clause (the runtime check fires in `get()` /
     * `aggregate()`).
     */
    protected readonly limitFromEnd: boolean = false,
    protected readonly start?: Cursor,
    protected readonly end?: Cursor,
    // Studio admin lens (Gap #2): stamped on the `list`/`get` reads this
    // query issues so rule evaluation is skipped. Preserved across `clone`
    // (so chained `.where`/`.orderBy`/etc keep the bypass) and through to
    // the `DocumentReference`s `.get()` returns. Default false.
    protected readonly bypassRules: boolean = false,
  ) {}

  where(field: string, op: WhereFilterOp, value: unknown): Query {
    return this.clone({ clauses: [...this.clauses, { kind: 'where', field, op, value }] });
  }

  applyFilter(filter: Filter): Query {
    return this.clone({ clauses: [...this.clauses, filter] });
  }

  orderBy(field: string, direction: OrderDirection = 'asc'): Query {
    return this.clone({ orders: [...this.orders, { field, direction }] });
  }

  limit(n: number): Query {
    return this.clone({ limitCount: n, limitFromEnd: false });
  }

  limitToLast(n: number): Query {
    return this.clone({ limitCount: n, limitFromEnd: true });
  }

  startCursor(values: unknown[], inclusive: boolean): Query {
    return this.clone({ start: { values: [...values], inclusive, fromSnapshot: false } });
  }

  endCursor(values: unknown[], inclusive: boolean): Query {
    return this.clone({ end: { values: [...values], inclusive, fromSnapshot: false } });
  }

  startCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): Query {
    return this.clone({
      start: {
        values: cursorValuesFromSnapshot(snapshot, this.normalizedOrders()),
        inclusive,
        fromSnapshot: true,
      },
    });
  }

  endCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): Query {
    return this.clone({
      end: {
        values: cursorValuesFromSnapshot(snapshot, this.normalizedOrders()),
        inclusive,
        fromSnapshot: true,
      },
    });
  }

  /**
   * Build a fresh `QueryImpl` carrying the same identity (collectionPath,
   * auth, env) plus the patches in `overrides`. Subclasses
   * (`CollectionGroupQueryImpl`) override this to construct their own
   * type so chained calls preserve the cross-collection semantics.
   */
  protected clone(overrides: Partial<{
    clauses: readonly Filter[];
    orders: readonly OrderClause[];
    limitCount: number | undefined;
    limitFromEnd: boolean;
    start: Cursor | undefined;
    end: Cursor | undefined;
  }>): QueryImpl {
    return new QueryImpl(
      this.env,
      this.auth,
      this.collectionPath,
      overrides.clauses ?? this.clauses,
      overrides.orders ?? this.orders,
      overrides.limitCount !== undefined || 'limitCount' in overrides ? overrides.limitCount : this.limitCount,
      overrides.limitFromEnd ?? this.limitFromEnd,
      'start' in overrides ? overrides.start : this.start,
      'end' in overrides ? overrides.end : this.end,
      this.bypassRules,
    );
  }

  /**
   * Hook subclasses (e.g. `CollectionGroupQueryImpl`) override to
   * change WHERE docs come from. The default scans this query's
   * `collectionPath` via `listDocuments`. Aggregations and `.get()`
   * both run through this hook so they see the same candidate set.
   */
  protected gatherCandidates(): { path: string; data: DocumentData }[] {
    // Real direct children only, straight from the DocStore seam: `directOnly`
    // excludes deeper descendants, and without `phantoms` we never synthesize a
    // phantom parent (a query can't match one), equivalent to the old
    // `listDocuments(...).filter(!phantom)` without the post-filter.
    return this.env.scanDocuments(this.collectionPath, { directOnly: true });
  }

  /**
   * The collection path the `list` security rule evaluates against.
   * Defaults to this query's `collectionPath`; `CollectionGroupQueryImpl`
   * overrides it to the group-id match path so the group `list` rule
   * fires. Used by {@link readCandidates}.
   */
  protected listRulePath(): string {
    return this.collectionPath;
  }

  /**
   * Gather candidates AND enforce security rules on the read (FS-B1 /
   * RULES-B1). `get()` and `aggregate()` both run through this so query
   * reads are rule-checked the same way `DocumentReference.get()` is — a
   * deny-all rule set throws `permission-denied` instead of silently
   * returning the whole collection.
   *
   * RULES-B11 — enforcement follows production's query-proof model
   * ("rules are not filters"): the structured `where` constraints are
   * threaded into {@link LocalEnvironment.readQueryCandidates} so a
   * doc-data-dependent `list` rule the query's equalities discharge is
   * ALLOWED, and an unprovable query is DENIED whole — never silently
   * filtered to the readable subset.
   *
   * This is the auth-scoped read path. The raw, rules-bypassing
   * {@link LocalEnvironment.listDocuments} stays reserved for explicit
   * admin/crawler access (transaction read-sets, discover) — not exposed
   * through the query surface.
   */
  protected readCandidates(opts?: OperationOptions): { path: string; data: DocumentData }[] {
    const auth = opts?.auth !== undefined ? opts.auth : this.auth;
    const result = this.env.readQueryCandidates(
      this.gatherCandidates(),
      this.listRulePath(),
      auth,
      this.structuredConstraints(),
      this.bypassRules,
    );
    if (!result.allowed) throw new FirestoreCompatError(result.error);
    return result.docs;
  }

  /**
   * RULES-B11 — this query's constraints as DATA (vs. the opaque row
   * transformer {@link applyConstraints} is). `where` carries every leaf
   * equality/inequality reachable through top-level AND composition —
   * the conjunctive spine, where each clause is unconditionally
   * guaranteed for every returned doc. Clauses under an `or(...)` are
   * NOT included (they guarantee nothing individually), and non-primitive
   * operand values are skipped — both omissions are conservative: the
   * proof can only fail to discharge a rule predicate (deny), never
   * falsely discharge one.
   */
  protected structuredConstraints(): QueryConstraints {
    const where: QueryWhereConstraint[] = [];
    const visit = (f: Filter): void => {
      if (f.kind === 'where') {
        const v = f.value;
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          where.push({ field: f.field, op: f.op, value: v });
        }
        return;
      }
      if (f.kind === 'and') f.filters.forEach(visit);
      // 'or' — skip: sub-clauses are not unconditionally guaranteed.
    };
    for (const f of this.clauses) visit(f);
    return {
      where,
      limit: this.limitCount ?? null,
      offset: null,
      orderBy: this.orders.length > 0 ? this.orders[0].field : null,
    };
  }

  /**
   * Apply this query's clauses + orders + limit to a candidate set.
   * Used by both `get()` and `aggregate()` so the filter logic
   * stays single-sourced.
   */
  protected applyConstraints(
    rows: { path: string; data: DocumentData }[],
  ): { path: string; data: DocumentData }[] {
    // 1. WHERE-style filters (leaf + composite OR/AND).
    let filtered = applyFilters(rows, [...this.clauses]);
    // FS-B8 — the NORMALIZED sort: explicit orderBy + an implicit order on
    // each inequality-filtered field + a final `__name__` doc-key tiebreak.
    // It is applied whenever the query needs an ordering (explicit orderBy,
    // an inequality filter, or any cursor); a bare unordered scan keeps the
    // candidate (insertion) order so existing collection-scan expectations
    // hold.
    const normalized = this.normalizedOrders();
    const needsOrder =
      this.orders.length > 0 ||
      this.start !== undefined ||
      this.end !== undefined ||
      this.clauses.some(hasInequality);
    // FAST PATH (Phase 4 top-k): an ordered, forward-limited query with no
    // cursor selects its k results without sorting the whole filtered set. Uses
    // the SAME present-filter + comparator as applyOrder, so the result is
    // identical to applyOrder(filtered).slice(0, limitCount). limitToLast and
    // cursor queries fall through to the full pipeline below.
    if (
      needsOrder &&
      this.limitCount !== undefined &&
      !this.limitFromEnd &&
      this.start === undefined &&
      this.end === undefined
    ) {
      return topK(
        orderPresent(filtered, normalized),
        this.limitCount,
        orderComparator(normalized),
      );
    }
    // 2. ORDER BY — required before cursors / limitToLast take effect.
    if (needsOrder) {
      filtered = applyOrder(filtered, normalized);
    }
    // 3. CURSORS — start/end positions relative to the normalized orderBy.
    //    A SNAPSHOT cursor is legal without an explicit orderBy (FS-B8): the
    //    implicit `__name__` clause positions on the document key. A VALUE
    //    cursor positions against the EXPLICIT orderBy only and must not
    //    carry more values than explicit orderBy clauses (upstream
    //    `boundFromFields` "Too many arguments").
    if (this.start || this.end) {
      for (const c of [this.start, this.end]) {
        if (c && !c.fromSnapshot && c.values.length > this.orders.length) {
          throw new FirestoreCompatError({
            code: 'invalid-argument',
            message:
              'Too many arguments provided to a cursor (startAt / startAfter / ' +
              'endAt / endBefore). The number of cursor values must be less than ' +
              'or equal to the number of orderBy() clauses.',
          });
        }
      }
      filtered = applyCursors(filtered, normalized, this.start, this.end);
    }
    // 4. LIMIT / LIMIT-TO-LAST — slicing happens last. limitToLast
    //    reverses the ordering to take the trailing n, then reverses
    //    back so consumer code still sees ascending-by-orderBy output.
    if (this.limitCount !== undefined) {
      if (this.limitFromEnd) {
        if (this.orders.length === 0) {
          // FS-B16 — FirestoreError `.code` (prod: `invalid-argument`,
          // "limitToLast() queries require specifying at least one orderBy()").
          throw new FirestoreCompatError({
            code: 'invalid-argument',
            message: 'limitToLast() queries require at least one orderBy clause.',
          });
        }
        const tail = filtered.slice(-this.limitCount);
        filtered = tail;
      } else {
        filtered = filtered.slice(0, this.limitCount);
      }
    }
    return filtered;
  }

  /**
   * FS-B8 — the normalized sort order, mirroring upstream
   * `core/query.ts:queryNormalizedOrderBy`:
   *   1. explicit orderBy clauses as-is;
   *   2. an implicit order on each inequality-filtered field not already
   *      ordered (direction = last explicit direction, or asc);
   *   3. a final `__name__` doc-key clause when the key is not explicitly
   *      ordered, so equal-valued docs are deterministic and cursors can
   *      disambiguate them.
   */
  protected normalizedOrders(): OrderClause[] {
    const out: OrderClause[] = [...this.orders];
    const seen = new Set(out.map((o) => o.field));
    const lastDir: OrderDirection =
      this.orders.length > 0 ? this.orders[this.orders.length - 1].direction : 'asc';
    // Inequality fields, in first-seen order, not already explicitly ordered.
    for (const f of this.clauses) {
      for (const field of inequalityFields(f)) {
        if (field !== KEY_FIELD && !seen.has(field)) {
          seen.add(field);
          out.push({ field, direction: lastDir });
        }
      }
    }
    if (!seen.has(KEY_FIELD)) {
      out.push({ field: KEY_FIELD, direction: lastDir });
    }
    return out;
  }

  /**
   * Public, side-effect-free view of this query's `where` / `orderBy` /
   * cursor / `limit` constraints as a pure row transformer. The
   * snapshot-listener path (FS-B2) threads this into the `SnapshotTarget`
   * so a filtered/ordered/limited `onSnapshot(query(...))` delivers the
   * same membership a one-shot `getDocs(query(...))` would — instead of
   * the whole collection. Returns `undefined` when the query carries no
   * constraints (a bare collection listen) so the listener path can skip
   * the transform entirely.
   *
   * RULES-B11 — the applier also carries the structured constraints (see
   * {@link structuredConstraints}) so the listener read path can run the
   * query-proof gate against the matched `list` rule.
   */
  snapshotConstraints(): QueryConstraintApplier | undefined {
    if (
      this.clauses.length === 0 &&
      this.orders.length === 0 &&
      this.limitCount === undefined &&
      this.start === undefined &&
      this.end === undefined
    ) {
      return undefined;
    }
    const applier: QueryConstraintApplier = (rows) => this.applyConstraints(rows);
    applier.structured = this.structuredConstraints();
    return applier;
  }

  async get(opts?: OperationOptions): Promise<QuerySnapshot> {
    // Query reads enforce security rules (FS-B1) under the query-proof
    // model (RULES-B11): a deny-all rule set throws `permission-denied`,
    // and a doc-data-dependent `list` rule the query's `where()`
    // equalities can't discharge denies the WHOLE query — never a
    // silently filtered subset. The `opts.auth` override threads through
    // to the rule eval the same way the single-doc/write paths use it.
    // Phantom parent docs are a discover-crawler affordance — already
    // stripped by `gatherCandidates`; the rule-enforced read preserves
    // that (see file header).
    const filtered = this.applyConstraints(this.readCandidates(opts));
    const docs: QueryDocumentSnapshot[] = filtered.map((d) => {
      const ref = new DocumentRefImpl(this.env, this.auth, d.path, this.bypassRules);
      // Translate timestamps + future typed values on the read path.
      // Done eagerly per row so .data() callers don't pay translation
      // cost twice if they invoke it more than once.
      const translated = translateReadData(d.data);
      // QueryDocumentSnapshot narrows `data()` to non-undefined — by
      // construction we never include missing docs, so this is sound.
      return {
        id: ref.id,
        ref,
        exists: true,
        data: () => translated,
      };
    });
    return {
      size: docs.length,
      empty: docs.length === 0,
      docs,
      forEach(cb: (snap: QueryDocumentSnapshot) => void) { docs.forEach(cb); },
    };
  }

  async aggregate(spec: AggregateSpec, opts?: OperationOptions): Promise<AggregateQuerySnapshot> {
    // Aggregates read through the rule-enforced path too (FS-B1) — the
    // count/sum/avg is computed only over docs the caller can read.
    const filtered = this.applyConstraints(this.readCandidates(opts));
    const data: Record<string, number | null> = {};
    for (const alias of Object.keys(spec)) {
      data[alias] = computeAggregate(spec[alias], filtered);
    }
    return { data: () => data };
  }
}

/**
 * Run one aggregate against a filtered doc set. Non-numeric values
 * are skipped silently (Firestore production behavior on heterogeneous
 * fields). Empty inputs produce `0` for count/sum and `null` for
 * average — the latter matches the JS SDK's
 * `AggregateField.average(...)` contract.
 */
/**
 * Read a (possibly dotted) field path from a document. Aggregates accept
 * nested paths like `sum('metadata.pages')` the same way `where`/`orderBy`
 * do for data fields — top-level `data[field]` would miss nested values.
 */
function aggregateFieldValue(data: DocumentData, fieldPath: string): unknown {
  if (!fieldPath.includes('.')) return data[fieldPath];
  let cursor: unknown = data;
  for (const seg of fieldPath.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as DocumentData)[seg];
  }
  return cursor;
}

function computeAggregate(
  field: AggregateField,
  rows: { data: DocumentData }[],
): number | null {
  if (field.kind === 'count') return rows.length;
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const v = aggregateFieldValue(row.data, field.field);
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  if (field.kind === 'sum') return sum;
  // average — undefined for empty/all-non-numeric sets
  return n === 0 ? null : sum / n;
}

/**
 * Cross-collection query — walks `env.snapshot()` (the in-memory
 * keyspace) and returns every document whose immediate parent
 * collection equals `collectionId`. Backs `Firestore.collectionGroup`.
 *
 * `collectionId` is matched on the second-to-last segment of each
 * stored doc path. For doc `parents/X/items/Y`, segments are
 * `[parents, X, items, Y]` so the parent collection is `items`.
 *
 * Inherits all `where` / `orderBy` / `limit` / `aggregate` plumbing
 * from `QueryImpl`. Overrides only `gatherCandidates()` so the base
 * class's get/aggregate machinery picks up the cross-collection scan
 * automatically.
 */
export class CollectionGroupQueryImpl extends QueryImpl {
  private readonly collectionId: string;

  constructor(
    env: LocalEnvironment,
    auth: AuthContext,
    collectionId: string,
    clauses: readonly Filter[] = [],
    orders: readonly OrderClause[] = [],
    limitCount?: number,
    limitFromEnd: boolean = false,
    start?: Cursor,
    end?: Cursor,
    bypassRules: boolean = false,
  ) {
    // Pass an empty `collectionPath` to the parent — we never use it
    // (gatherCandidates overrides the env.listDocuments call).
    super(env, auth, '', clauses, orders, limitCount, limitFromEnd, start, end, bypassRules);
    this.collectionId = collectionId;
  }

  /**
   * Subclass clone: hand back a fresh `CollectionGroupQueryImpl`
   * so chained calls (`where`, `applyFilter`, `orderBy`, `limit`,
   * `limitToLast`, cursors) preserve the cross-collection
   * identity. The base-class methods all dispatch through this
   * hook — no per-method overrides needed.
   */
  protected override clone(overrides: Partial<{
    clauses: readonly Filter[];
    orders: readonly OrderClause[];
    limitCount: number | undefined;
    limitFromEnd: boolean;
    start: Cursor | undefined;
    end: Cursor | undefined;
  }>): QueryImpl {
    return new CollectionGroupQueryImpl(
      this.env,
      this.auth,
      this.collectionId,
      overrides.clauses ?? this.clauses,
      overrides.orders ?? this.orders,
      'limitCount' in overrides ? overrides.limitCount : this.limitCount,
      overrides.limitFromEnd ?? this.limitFromEnd,
      'start' in overrides ? overrides.start : this.start,
      'end' in overrides ? overrides.end : this.end,
      this.bypassRules,
    );
  }

  /**
   * Cross-collection candidate gathering. Walks the in-memory
   * snapshot once and keeps docs whose immediate parent collection
   * matches `collectionId`. Snapshot is a copy so iteration is safe
   * even if writes interleave.
   */
  protected override gatherCandidates(): { path: string; data: DocumentData }[] {
    const out: { path: string; data: DocumentData }[] = [];
    const snap = this.env.snapshot();
    for (const path of Object.keys(snap)) {
      if (parentCollectionName(path) === this.collectionId) {
        out.push({ path, data: snap[path] });
      }
    }
    return out;
  }

  /**
   * Group reads span many parent collections, so there's no single
   * concrete collection path to evaluate the `list` rule against. Use
   * the group id as the representative match path — per-doc `get`
   * enforcement (against each real candidate path) still runs, so a
   * doc the caller can't read is dropped regardless of where it lives.
   */
  protected override listRulePath(): string {
    return this.collectionId;
  }
}

/**
 * Return the name of the collection a doc path lives directly in.
 * For `parents/X/items/Y`, returns `'items'`. For `items/Y`, returns
 * `'items'`. Returns `null` when the path isn't a valid doc path
 * (odd-segment count).
 */
function parentCollectionName(path: string): string | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length % 2 !== 0) return null;
  return segments[segments.length - 2];
}

export class CollectionRefImpl extends QueryImpl implements CollectionReference {
  readonly id: string;
  readonly path: string;

  constructor(env: LocalEnvironment, auth: AuthContext, path: string, bypassRules: boolean = false) {
    super(env, auth, path, [], [], undefined, false, undefined, undefined, bypassRules);
    this.path = path;
    this.id = lastSegment(path);
  }

  doc(id?: string): DocumentReference {
    const finalId = id ?? generateAutoId();
    return new DocumentRefImpl(this.env, this.auth, `${this.path}/${finalId}`, this.bypassRules);
  }

  async add(data: DocumentData, opts?: OperationOptions): Promise<DocumentReference> {
    const ref = this.doc();
    await ref.set(data, opts);
    return ref;
  }
}
