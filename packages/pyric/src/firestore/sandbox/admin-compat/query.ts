/** Admin-compatible query builders and snapshot shaping.
 * Candidate gathering, rule enforcement, and execution live behind
 * `LocalEnvironment.runQuery`; this adapter only builds immutable plans. */

import type { LocalEnvironment } from 'pyric/sandbox/internal';
import { generateAutoId } from 'pyric/sandbox/internal';
import { lastSegment } from './paths.js';
import { translateReadData } from './snapshots.js';
import { DocumentRefImpl } from './doc-ref.js';
import { activityValue } from '../../../firestore/sandbox/activity-query-value.js';
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
  executeQuery,
  normalizedQueryOrders,
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

type OrderClause = QueryOrderClause;

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

/**
 * Compare a row's ordered field values to a cursor's values in the
 * direction of the orderBy clauses. Returns negative when the row
 * precedes the cursor in ordered position, 0 on tie, positive when
 * it follows. Lexicographic across `cursor.values.length` orderBy
 * clauses — any tail of orderBy clauses beyond the cursor length is
 * not consulted (matches production's "prefix cursor" semantics).
 */
// ─────────────────────────────────────────────────────────────────────────
// Public surface — QueryImpl + CollectionRefImpl.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cursor position along the orderBy fields. `values` is positional —
 * `values[i]` compares against `orders[i].field`. `inclusive`
 * distinguishes startAt/endAt (true) from startAfter/endBefore (false).
 */
type Cursor = QueryCursor;

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
   * Describe where the engine gathers this query's candidates.
   */
  protected queryScope(): QueryScope {
    return { kind: 'collection', path: this.collectionPath };
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
   * `LocalEnvironment.runQuery` owns candidate gathering, RULES-B11 proof,
   * and executable constraints so no raw candidate array crosses the seam.
   */
  protected readCandidates(opts?: OperationOptions): { path: string; data: DocumentData }[] {
    const auth = opts?.auth !== undefined ? opts.auth : this.auth;
    let result: ReturnType<LocalEnvironment['runQuery']>;
    try {
      result = this.env.runQuery(
        this.queryScope(),
        this.listRulePath(),
        auth,
        this.executionSpec(),
        this.structuredConstraints(),
        this.bypassRules,
        this.activityQuery(),
      );
    } catch (error) {
      const simError = (error as { simError?: unknown })?.simError;
      if (simError) throw new FirestoreCompatError(simError as FirestoreSimError);
      throw error;
    }
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
   * Full executable identity for activity monitoring. The rules-proof
   * projection above intentionally drops OR branches, rich operands, cursor
   * detail, and most ordering, so it cannot safely identify repeated reads.
   */
  protected activityQuery(): unknown {
    const filter = (value: Filter): unknown => value.kind === 'where'
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
   * Apply this query's clauses + orders + limit to a candidate set.
   * Used by both `get()` and `aggregate()` so the filter logic
   * stays single-sourced.
   */
  protected applyConstraints(
    rows: { path: string; data: DocumentData }[],
  ): { path: string; data: DocumentData }[] {
    return executeQuery(rows, this.executionSpec());
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
    return {
      filters: this.clauses,
      orders: this.orders,
      limitCount: this.limitCount,
      limitFromEnd: this.limitFromEnd,
      start: this.start,
      end: this.end,
    };
  }

  /**
   * Public, side-effect-free view of this query's `where` / `orderBy` /
   * cursor / `limit` constraints as a pure row transformer. The
   * snapshot-listener path (FS-B2) threads this into the `SnapshotTarget`
   * so a filtered/ordered/limited `onSnapshot(query(...))` delivers the
   * same membership a one-shot `getDocs(query(...))` would — instead of
   * the whole collection. Bare collection listens retain a no-op applier so
   * the activity monitor still receives their complete query identity.
   *
   * RULES-B11 — the applier also carries the structured constraints (see
   * {@link structuredConstraints}) so the listener read path can run the
   * query-proof gate against the matched `list` rule.
   */
  snapshotConstraints(): QueryConstraintApplier {
    const applier: QueryConstraintApplier = (rows) => this.applyConstraints(rows);
    applier.structured = this.structuredConstraints();
    applier.activityQuery = this.activityQuery();
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
    const filtered = this.readCandidates(opts);
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
    const filtered = this.readCandidates(opts);
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

/** Cross-collection query plan for `Firestore.collectionGroup`. */
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
    // The engine uses queryScope(), not the empty collectionPath.
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
  protected override queryScope(): QueryScope {
    return { kind: 'collection-group', collectionId: this.collectionId };
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

  protected override activityScope(): unknown {
    return { kind: 'collection-group' };
  }
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
