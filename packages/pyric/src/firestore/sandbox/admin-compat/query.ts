/** Admin-compatible query builders and snapshot shaping.
 * Candidate gathering, rule enforcement, and execution live behind
 * `LocalEnvironment.runQuery`; this adapter only builds immutable plan
 * structure. Opaque operands retain identity by accepted ADR-0009 policy. */

import type { LocalEnvironment } from 'pyric/sandbox/internal';
import { translateReadData } from './snapshots.js';
import { activityValue } from '../../../firestore/sandbox/activity-query-value.js';
// RULES-B11 — structured `where`/`limit`/`orderBy` view threaded into the
// rule-enforced read paths so the query-proof gate ("rules are not
// filters") can discharge per-doc rule predicates from the query's
// equality constraints.
import type { QueryConstraintPlan } from '../snapshot-listeners.js';
import {
  normalizedQueryOrders,
  type QueryFilter,
  type QueryCursor,
  type QueryExecutionSpec,
  type QueryOrderClause,
  type QueryScope,
} from '../query-execution.js';
import {
  FirestoreCompatError,
  type FirestoreSimError,
  type AggregateField,
  type AggregateQuerySnapshot,
  type AggregateSpec,
  type AuthContext,
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

type OrderClause = QueryOrderClause;
type DocumentRefFactory = (path: string) => DocumentReference;

export interface QueryState {
  env: LocalEnvironment;
  auth: AuthContext;
  collectionPath: string;
  documentRef: DocumentRefFactory;
  clauses?: readonly QueryFilter[];
  orders?: readonly OrderClause[];
  limitCount?: number;
  limitFromEnd?: boolean;
  start?: Cursor;
  end?: Cursor;
  bypassRules?: boolean;
}

export type QueryStatePatch = Partial<Pick<
  QueryState,
  'clauses' | 'orders' | 'limitCount' | 'limitFromEnd' | 'start' | 'end'
>>;

function snapshotQueryValue(value: unknown): unknown {
  // Query operands are deliberately opaque. Reading arrays/maps here would
  // execute user getters or Proxy traps and would replace the stable object
  // identity used by activity diagnostics. Primitive operands (the only
  // values consumed by rules proof) are immutable; structural filter and
  // cursor containers are copied separately.
  return value;
}

function snapshotFilter(filter: Filter | QueryFilter): QueryFilter {
  if (filter.kind === 'where') {
    return Object.freeze({
      kind: 'where',
      field: filter.field,
      op: filter.op,
      value: snapshotQueryValue(filter.value),
    });
  }
  return Object.freeze({
    kind: filter.kind,
    filters: Object.freeze(filter.filters.map(snapshotFilter)),
  }) as QueryFilter;
}

// FS-B8 — the document-key sentinel field. Firestore normalizes every
// query's sort to include an implicit final ordering on the document key
// (`__name__`) so equal-valued docs have a deterministic order and cursors
// can disambiguate them. We model the key value as a reference-like
// `{ path }` so the canonical `compareValues` reference branch orders it.
const KEY_FIELD = '__name__';

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

// ─────────────────────────────────────────────────────────────────────────
// Public surface — QueryImpl.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cursor position along the orderBy fields. `values` is positional —
 * `values[i]` compares against `orders[i].field`. `inclusive`
 * distinguishes startAt/endAt (true) from startAfter/endBefore (false).
 */
type Cursor = QueryCursor;

export class QueryImpl implements Query {
  protected readonly env: LocalEnvironment;
  protected readonly auth: AuthContext;
  protected readonly collectionPath: string;
  protected readonly clauses: readonly QueryFilter[];
  protected readonly orders: readonly OrderClause[];
  protected readonly limitCount?: number;
  protected readonly limitFromEnd: boolean;
  protected readonly start?: Cursor;
  protected readonly end?: Cursor;
  protected readonly bypassRules: boolean;
  private readonly documentRef: DocumentRefFactory;

  constructor(state: QueryState) {
    this.env = state.env;
    this.auth = state.auth;
    this.collectionPath = state.collectionPath;
    this.documentRef = state.documentRef;
    this.clauses = Object.freeze((state.clauses ?? []).map(snapshotFilter));
    this.orders = Object.freeze((state.orders ?? []).map((order) => Object.freeze({ ...order })));
    this.limitCount = state.limitCount;
    this.limitFromEnd = state.limitFromEnd ?? false;
    this.start = state.start === undefined ? undefined : Object.freeze({
      ...state.start,
      values: Object.freeze(state.start.values.map(snapshotQueryValue)),
    });
    this.end = state.end === undefined ? undefined : Object.freeze({
      ...state.end,
      values: Object.freeze(state.end.values.map(snapshotQueryValue)),
    });
    this.bypassRules = state.bypassRules ?? false;
  }

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
  protected clone(overrides: QueryStatePatch): QueryImpl {
    return new QueryImpl({
      env: this.env,
      auth: this.auth,
      collectionPath: this.collectionPath,
      documentRef: this.documentRef,
      clauses: overrides.clauses ?? this.clauses,
      orders: overrides.orders ?? this.orders,
      limitCount: 'limitCount' in overrides ? overrides.limitCount : this.limitCount,
      limitFromEnd: overrides.limitFromEnd ?? this.limitFromEnd,
      start: 'start' in overrides ? overrides.start : this.start,
      end: 'end' in overrides ? overrides.end : this.end,
      bypassRules: this.bypassRules,
    });
  }

  /**
   * Hook subclasses (e.g. `CollectionGroupQueryImpl`) override to
   * describe where the engine gathers this query's candidates.
   */
  protected queryScope(): QueryScope {
    return { kind: 'collection', path: this.collectionPath };
  }

  /**
   * Submit the plan and return the engine's fully executed rows. `get()` and
   * `aggregate()` both run through this rule-enforced path (FS-B1 / RULES-B1), so query
   * reads are rule-checked the same way `DocumentReference.get()` is — a
   * deny-all rule set throws `permission-denied` instead of silently
   * returning the whole collection.
   *
   * `LocalEnvironment.runQuery` owns candidate gathering, RULES-B11 proof,
   * and executable constraints so no raw candidate array crosses the seam.
   */
  protected readQueryRows(opts?: OperationOptions): { path: string; data: DocumentData }[] {
    const auth = opts?.auth !== undefined ? opts.auth : this.auth;
    let result: ReturnType<LocalEnvironment['runQuery']>;
    try {
      result = this.env.runQuery({
        scope: this.queryScope(),
        auth,
        execution: this.executionSpec(),
        bypassRules: this.bypassRules,
        activityQuery: this.activityQuery(),
      });
    } catch (error) {
      const simError = (error as { simError?: unknown })?.simError;
      if (simError) throw new FirestoreCompatError(simError as FirestoreSimError);
      throw error;
    }
    if (!result.allowed) throw new FirestoreCompatError(result.error);
    return result.docs;
  }

  /**
   * Full executable identity for activity monitoring. The rules-proof
   * projection intentionally drops OR branches, rich operands, cursor
   * detail, and most ordering, so it cannot safely identify repeated reads.
   */
  protected activityQuery(): unknown {
    const filter = (value: QueryFilter): unknown => value.kind === 'where'
      ? { kind: 'where', field: value.field, op: value.op, value: activityValue(value.value) }
      : { kind: value.kind, filters: value.filters.map(filter) };
    const cursor = (value: Cursor | undefined): unknown => value === undefined ? null : {
      values: value.values.map((item) => activityValue(item)),
      inclusive: value.inclusive,
      fromSnapshot: value.fromSnapshot,
    };
    return {
      scope: this.activityScope(),
      filters: this.clauses.map(filter),
      orderBy: this.orders.map((order) => ({ ...order })),
      limit: this.limitCount ?? null,
      limitFromEnd: this.limitFromEnd,
      start: cursor(this.start),
      end: cursor(this.end),
    };
  }

  /** Distinguish direct-collection scans from collection-group scans. */
  protected activityScope(): unknown {
    return { kind: 'collection' };
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
    return normalizedQueryOrders(this.executionSpec());
  }

  private executionSpec(): QueryExecutionSpec {
    const execution: QueryExecutionSpec = {
      filters: this.clauses,
      orders: this.orders,
      limitCount: this.limitCount,
      limitFromEnd: this.limitFromEnd,
      start: this.start,
      end: this.end,
    };
    return Object.freeze(execution);
  }

  /**
   * Public, side-effect-free view of this query's `where` / `orderBy` /
   * cursor / `limit` constraints as immutable data. The
   * snapshot-listener path (FS-B2) threads this into the `SnapshotTarget`
   * so a filtered/ordered/limited `onSnapshot(query(...))` delivers the
   * same membership a one-shot `getDocs(query(...))` would — instead of
   * the whole collection. Bare collection listens retain an empty plan so
   * the activity monitor still receives their complete query identity.
   *
   * RULES-B11 — the read engine derives proof constraints from this same
   * execution plan, preventing proof/execution drift.
   */
  snapshotConstraints(): QueryConstraintPlan {
    return Object.freeze({
      execution: this.executionSpec(),
      activityQuery: this.activityQuery(),
    });
  }

  async get(opts?: OperationOptions): Promise<QuerySnapshot> {
    // Query reads enforce security rules (FS-B1) under the query-proof
    // model (RULES-B11): a deny-all rule set throws `permission-denied`,
    // and a doc-data-dependent `list` rule the query's `where()`
    // equalities can't discharge denies the WHOLE query — never a
    // silently filtered subset. The `opts.auth` override threads through
    // to the rule eval the same way the single-doc/write paths use it.
    // Phantom parent docs are a discover-crawler affordance. The engine's
    // candidate gatherer strips them before rule proof and execution.
    const rows = this.readQueryRows(opts);
    const docs: QueryDocumentSnapshot[] = rows.map((d) => {
      const ref = this.documentRef(d.path);
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
    const rows = this.readQueryRows(opts);
    const data: Record<string, number | null> = {};
    for (const alias of Object.keys(spec)) {
      data[alias] = computeAggregate(spec[alias], rows);
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
