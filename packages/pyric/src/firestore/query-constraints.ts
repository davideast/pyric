/**
 * `pyric/firestore` — query builder + constraints.
 *
 * `query` and the constraint factories (`where` / `or` / `and` / `orderBy`
 * / `limit` / `limitToLast` and the `startAt` / `startAfter` / `endAt` /
 * `endBefore` cursors). Each constraint carries a per-target apply function
 * so `query` never re-discriminates the backend.
 */
import * as fb from 'firebase/firestore';
import type {
  SandboxFirestore,
  Query as ChainQuery,
  Filter as ChainFilter,
  WhereFilterOp,
  OrderDirection,
  AdminDocumentSnapshot as ChainDocSnap,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  isSandboxKind,
  sandboxDb,
  converterOf,
  parentRebuild,
  tagSandboxRef,
  buildSandboxShell,
  tag,
  asFbQuery,
} from './state.js';
import type {
  CollectionReference,
  Query,
  DocumentSnapshot,
  DocumentData,
} from './types.js';

// ─── Query constraints ────────────────────────────────────────────────

export interface QueryConstraint {
  // Apply against either backend's query type. Each constraint factory
  // builds a per-target apply function so query() doesn't need to
  // re-discriminate.
  applySandbox(q: ChainQuery): ChainQuery;
  applyProd(q: fb.Query): fb.Query;
  /**
   * Internal — the filter representation for composite-filter
   * composition. `where()` populates it as a leaf; `or()` / `and()`
   * combine sub-constraints' filters into a composite tree. Non-filter
   * constraints (`orderBy`, `limit`) leave it undefined; passing one
   * to `or()` / `and()` throws.
   */
  _sandboxFilter?: ChainFilter;
  _fbFilter?: fb.QueryFilterConstraint;
}

export function query<T = DocumentData>(
  source: CollectionReference<T> | Query<T>,
  ...constraints: QueryConstraint[]
): Query<T> {
  const target = targetOf(source);
  const conv = converterOf(source);
  if (isSandboxKind(target)) {
    // Apply constraints to the source's chainable query. For
    // sandbox-live we rebuild via the parent's rebuild closure under
    // a transient handle so the resulting tagged query has a known
    // shape; the rebuild closure we record below applies the same
    // constraint chain against a *fresh* handle at op time.
    const sourceRebuild = parentRebuild(source);
    const buildAt = (db: SandboxFirestore): ChainQuery => {
      let q = sourceRebuild(db) as ChainQuery;
      for (const c of constraints) q = c.applySandbox(q);
      return q;
    };
    const q = buildAt(sandboxDb(target));
    const tagged = tagSandboxRef(
      q as unknown as Query<T>,
      target,
      (fresh) => buildAt(fresh) as unknown as object,
    );
    // Propagate any converter from a typed source through the new query.
    if (conv) {
      return buildSandboxShell(
        tagged as unknown as { id?: string; path?: string },
        target,
        conv,
      ) as Query<T>;
    }
    return tagged as Query<T>;
  }
  let q = asFbQuery(source);
  for (const c of constraints) q = c.applyProd(q);
  return tag(q as unknown as object, target) as Query<T>;
}

export function where(field: string, op: WhereFilterOp, value: unknown): QueryConstraint {
  const sandboxFilter: ChainFilter = { kind: 'where', field, op, value };
  const fbFilter = fb.where(field, op as fb.WhereFilterOp, value);
  return {
    applySandbox: (q) => q.where(field, op, value),
    applyProd: (q) => fb.query(q, fbFilter),
    _sandboxFilter: sandboxFilter,
    _fbFilter: fbFilter,
  };
}

/**
 * OR composite — at least one of the inner constraints must match.
 * Each argument must itself be a filter constraint (`where()`, or
 * nested `or()` / `and()`); passing `orderBy()` or `limit()` here is
 * a type error at runtime.
 *
 * Mirrors `firebase/firestore`'s `or(...filters)` shape.
 */
export function or(...filters: QueryConstraint[]): QueryConstraint {
  return composite('or', filters);
}

/**
 * AND composite. Same shape as `or()` but every inner constraint
 * must match. Useful inside an `or()` to combine constraints that
 * would otherwise be at the top level.
 */
export function and(...filters: QueryConstraint[]): QueryConstraint {
  return composite('and', filters);
}

/**
 * Build a composite QueryConstraint. Extracts each sub-constraint's
 * sandbox + fb filter representations; throws when any input is a
 * non-filter (`orderBy` / `limit`).
 */
function composite(
  kind: 'and' | 'or',
  filters: QueryConstraint[],
): QueryConstraint {
  if (filters.length === 0) {
    throw new TypeError(
      `pyric/firestore: ${kind}() requires at least one filter argument.`,
    );
  }
  const sandboxSubs: ChainFilter[] = [];
  const fbSubs: fb.QueryFilterConstraint[] = [];
  for (const c of filters) {
    if (c._sandboxFilter === undefined || c._fbFilter === undefined) {
      throw new TypeError(
        `pyric/firestore: ${kind}() received a non-filter constraint (orderBy / limit are not valid here).`,
      );
    }
    sandboxSubs.push(c._sandboxFilter);
    fbSubs.push(c._fbFilter);
  }
  const sandboxFilter: ChainFilter = { kind, filters: sandboxSubs };
  const fbFilter = kind === 'or' ? fb.or(...fbSubs) : fb.and(...fbSubs);
  return {
    applySandbox: (q) => q.applyFilter(sandboxFilter),
    applyProd: (q) => fb.query(q, fbFilter),
    _sandboxFilter: sandboxFilter,
    _fbFilter: fbFilter,
  };
}

export function orderBy(field: string, direction?: OrderDirection): QueryConstraint {
  return {
    applySandbox: (q) => q.orderBy(field, direction),
    applyProd: (q) => fb.query(q, fb.orderBy(field, direction as fb.OrderByDirection | undefined)),
  };
}

export function limit(n: number): QueryConstraint {
  return {
    applySandbox: (q) => q.limit(n),
    applyProd: (q) => fb.query(q, fb.limit(n)),
  };
}

// ─── Cursor pagination + limitToLast (Tier 3) ────────────────────────
//
// Modular Web-SDK shape:
//
//   query(coll,
//     orderBy('priority'),
//     startAfter(prevPagePriority),
//     limit(10),
//   );
//
// Each cursor factory accepts a positional values list (one per
// orderBy clause). For sandbox-target, the values pass straight into
// the chainable Query.startCursor / endCursor methods; for prod, we
// spread into `fb.startAt(...values)` etc. The DocumentSnapshot
// overload (`startAt(snapshot)`) lands in a follow-up commit.

/**
 * Limit the query to the LAST `n` documents in the ordered result.
 * Requires at least one `orderBy` on the query (production-aligned —
 * the simulator throws at execute time without one).
 */
export function limitToLast(n: number): QueryConstraint {
  return {
    applySandbox: (q) => q.limitToLast(n),
    applyProd: (q) => fb.query(q, fb.limitToLast(n)),
  };
}

/**
 * Cursor argument — either a positional list of field values or a
 * `DocumentSnapshot` to extract the values from. Mirrors the JS
 * SDK's overloaded `startAt` / `startAfter` / `endAt` / `endBefore`
 * shape.
 */
type CursorArg = DocumentSnapshot | unknown;

/**
 * Heuristic for the snapshot overload: a single argument whose
 * `.data` is a function. Both the chainable adapter's
 * `AdminDocumentSnapshot` and `firebase/firestore`'s
 * `DocumentSnapshot` expose `.data()` so this catches both targets
 * cleanly. Falls back to the values-spread variant for everything
 * else (including a single non-snapshot scalar arg, which is
 * legitimate when the orderBy is on one field).
 */
function isDocumentSnapshot(args: unknown[]): args is [DocumentSnapshot] {
  if (args.length !== 1) return false;
  const a = args[0];
  return (
    a !== null &&
    typeof a === 'object' &&
    'data' in a &&
    typeof (a as { data: unknown }).data === 'function'
  );
}

/**
 * Start the query at the document whose ordered field values match
 * the cursor. Inclusive — the document at the cursor IS included in
 * the result. Two overloads:
 *
 *   `startAt(snapshot)` — values come from `snapshot.data()` indexed
 *     by the query's orderBy fields.
 *   `startAt(...values)` — explicit positional values (one per
 *     orderBy clause).
 */
export function startAt(snapshot: DocumentSnapshot): QueryConstraint;
export function startAt(...values: unknown[]): QueryConstraint;
export function startAt(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    const snap = args[0];
    return {
      applySandbox: (q) => q.startCursorFromSnapshot(snap as unknown as ChainDocSnap, true),
      applyProd: (q) => fb.query(q, fb.startAt(snap as unknown as fb.DocumentSnapshot)),
    };
  }
  return {
    applySandbox: (q) => q.startCursor(args, true),
    applyProd: (q) => fb.query(q, fb.startAt(...args)),
  };
}

/** Same as `startAt`, but EXCLUDES the document at the cursor — the
 *  result starts at the next ordered position. */
export function startAfter(snapshot: DocumentSnapshot): QueryConstraint;
export function startAfter(...values: unknown[]): QueryConstraint;
export function startAfter(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    const snap = args[0];
    return {
      applySandbox: (q) => q.startCursorFromSnapshot(snap as unknown as ChainDocSnap, false),
      applyProd: (q) => fb.query(q, fb.startAfter(snap as unknown as fb.DocumentSnapshot)),
    };
  }
  return {
    applySandbox: (q) => q.startCursor(args, false),
    applyProd: (q) => fb.query(q, fb.startAfter(...args)),
  };
}

/** End the query at the document whose ordered field values match
 *  the cursor. Inclusive — the document at the cursor IS included. */
export function endAt(snapshot: DocumentSnapshot): QueryConstraint;
export function endAt(...values: unknown[]): QueryConstraint;
export function endAt(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    const snap = args[0];
    return {
      applySandbox: (q) => q.endCursorFromSnapshot(snap as unknown as ChainDocSnap, true),
      applyProd: (q) => fb.query(q, fb.endAt(snap as unknown as fb.DocumentSnapshot)),
    };
  }
  return {
    applySandbox: (q) => q.endCursor(args, true),
    applyProd: (q) => fb.query(q, fb.endAt(...args)),
  };
}

/** Same as `endAt`, but EXCLUDES the document at the cursor — the
 *  result ends at the prior ordered position. */
export function endBefore(snapshot: DocumentSnapshot): QueryConstraint;
export function endBefore(...values: unknown[]): QueryConstraint;
export function endBefore(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    const snap = args[0];
    return {
      applySandbox: (q) => q.endCursorFromSnapshot(snap as unknown as ChainDocSnap, false),
      applyProd: (q) => fb.query(q, fb.endBefore(snap as unknown as fb.DocumentSnapshot)),
    };
  }
  return {
    applySandbox: (q) => q.endCursor(args, false),
    applyProd: (q) => fb.query(q, fb.endBefore(...args)),
  };
}
