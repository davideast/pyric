/**
 * `pyric/firestore` — query builder + constraints.
 *
 * `query` and the constraint factories (`where` / `or` / `and` / `orderBy`
 * / `limit` / `limitToLast` and the `startAt` / `startAfter` / `endAt` /
 * `endBefore` cursors). Each constraint applies to the sandbox's chainable
 * query representation.
 */
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
  sandboxDb,
  converterOf,
  parentRebuild,
  tagSandboxRef,
  buildSandboxShell,
} from './state.js';
import { FieldPath } from './field-values.js';
import { toFirestoreFirebaseError } from './errors.js';
import { captureQueryOperand } from './sandbox/query-operand-equality.js';
import { rawDocumentSnapshotForCursor } from './snapshots.js';
import type {
  CollectionReference,
  Query,
  DocumentSnapshot,
  DocumentData,
} from './types.js';

/** Accept modular `where`/`orderBy` field args as string or FieldPath. */
function fieldToString(field: string | FieldPath): string {
  if (typeof field === 'string') return field;
  return field._internalPath.segments.join('.');
}

// ─── Query constraints ────────────────────────────────────────────────

export interface QueryConstraint {
  readonly type?: string;
  applySandbox(q: ChainQuery): ChainQuery;
  prepareSandbox?(owner: object): QueryConstraint;
  /**
   * Internal — the filter representation for composite-filter
   * composition. `where()` populates it as a leaf; `or()` / `and()`
   * combine sub-constraints' filters into a composite tree. Non-filter
   * constraints (`orderBy`, `limit`) leave it undefined; passing one
   * to `or()` / `and()` throws.
   */
  _sandboxFilter?: ChainFilter;
}

export function query<T = DocumentData>(
  source: CollectionReference<T> | Query<T>,
  ...constraints: QueryConstraint[]
): Query<T> {
  const target = targetOf(source);
  const conv = converterOf(source);
  // For sandbox-live, the rebuild closure applies the same constraint chain
  // against a fresh identity-bound handle at operation time.
  const sourceRebuild = parentRebuild(source);
  let prepared: QueryConstraint[];
  let q: ChainQuery;
  try {
    prepared = constraints.map((constraint) => constraint.prepareSandbox?.(target) ?? constraint);
  } catch (error) {
    throw toFirestoreFirebaseError(error);
  }
  const buildAt = (db: SandboxFirestore): ChainQuery => {
    let q = sourceRebuild(db) as ChainQuery;
    for (const c of prepared) q = c.applySandbox(q);
    return q;
  };
  try {
    q = buildAt(sandboxDb(target));
  } catch (error) {
    throw toFirestoreFirebaseError(error);
  }
  const tagged = tagSandboxRef(
    q as unknown as Query<T>,
    target,
    (fresh) => buildAt(fresh) as unknown as object,
  );
  if (conv) {
    return buildSandboxShell(
      tagged as unknown as { id?: string; path?: string },
      target,
      conv,
    ) as Query<T>;
  }
  return tagged as Query<T>;
}

export function where(
  field: string | FieldPath,
  op: WhereFilterOp,
  value: unknown,
): QueryConstraint {
  return whereConstraint(fieldToString(field), op, value, false);
}

function whereConstraint(
  fieldPath: string,
  op: WhereFilterOp,
  value: unknown,
  prepared: boolean,
): QueryConstraint {
  const sandboxFilter: ChainFilter = { kind: 'where', field: fieldPath, op, value };
  return {
    type: 'where',
    applySandbox: (q) => q.where(fieldPath, op, value),
    prepareSandbox: prepared ? undefined : (owner) => {
      const captured = captureQueryOperand(
        value,
        owner,
        op === 'in' || op === 'not-in',
      );
      return whereConstraint(fieldPath, op, captured.executionValue, true);
    },
    _sandboxFilter: sandboxFilter,
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
 * Build a composite QueryConstraint. Extracts each sub-constraint's filter
 * representation and rejects non-filter constraints.
 */
function composite(
  kind: 'and' | 'or',
  filters: QueryConstraint[],
  prepared = false,
): QueryConstraint {
  if (filters.length === 0) {
    throw new TypeError(
      `pyric/firestore: ${kind}() requires at least one filter argument.`,
    );
  }
  const sandboxSubs: ChainFilter[] = [];
  for (const c of filters) {
    if (c._sandboxFilter === undefined) {
      throw new TypeError(
        `pyric/firestore: ${kind}() received a non-filter constraint (orderBy / limit are not valid here).`,
      );
    }
    sandboxSubs.push(c._sandboxFilter);
  }
  const sandboxFilter: ChainFilter = { kind, filters: sandboxSubs };
  return {
    type: kind,
    applySandbox: (q) => q.applyFilter(sandboxFilter),
    prepareSandbox: prepared ? undefined : (owner) => composite(
      kind,
      filters.map((filter) => filter.prepareSandbox?.(owner) ?? filter),
      true,
    ),
    _sandboxFilter: sandboxFilter,
  };
}

export function orderBy(
  field: string | FieldPath,
  direction?: OrderDirection,
): QueryConstraint {
  const fieldPath = fieldToString(field);
  return {
    type: 'orderBy',
    applySandbox: (q) => q.orderBy(fieldPath, direction),
  };
}

export function limit(n: number): QueryConstraint {
  return {
    type: 'limit',
    applySandbox: (q) => q.limit(n),
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
// Each cursor factory accepts a positional values list (one per orderBy
// clause) and passes it into the chainable cursor methods.

/**
 * Limit the query to the LAST `n` documents in the ordered result.
 * Requires at least one `orderBy` on the query (production-aligned —
 * the simulator throws at execute time without one).
 */
export function limitToLast(n: number): QueryConstraint {
  return {
    type: 'limitToLast',
    applySandbox: (q) => q.limitToLast(n),
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
 * `.data` is a function. The public and chainable snapshot shapes both
 * expose `.data()`. Falls back to the values-spread variant for everything
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
    return snapshotCursorConstraint(args[0], true, true);
  }
  return cursorValuesConstraint(args, true, true);
}

/** Same as `startAt`, but EXCLUDES the document at the cursor — the
 *  result starts at the next ordered position. */
export function startAfter(snapshot: DocumentSnapshot): QueryConstraint;
export function startAfter(...values: unknown[]): QueryConstraint;
export function startAfter(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    return snapshotCursorConstraint(args[0], false, true);
  }
  return cursorValuesConstraint(args, false, true);
}

/** End the query at the document whose ordered field values match
 *  the cursor. Inclusive — the document at the cursor IS included. */
export function endAt(snapshot: DocumentSnapshot): QueryConstraint;
export function endAt(...values: unknown[]): QueryConstraint;
export function endAt(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    return snapshotCursorConstraint(args[0], true, false);
  }
  return cursorValuesConstraint(args, true, false);
}

/** Same as `endAt`, but EXCLUDES the document at the cursor — the
 *  result ends at the prior ordered position. */
export function endBefore(snapshot: DocumentSnapshot): QueryConstraint;
export function endBefore(...values: unknown[]): QueryConstraint;
export function endBefore(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    return snapshotCursorConstraint(args[0], false, false);
  }
  return cursorValuesConstraint(args, false, false);
}

function snapshotCursorConstraint(
  snapshot: DocumentSnapshot,
  inclusive: boolean,
  start: boolean,
  prepared = false,
): QueryConstraint {
  return {
    type: start ? 'startAt' : 'endAt',
    applySandbox: (q) => start
      ? q.startCursorFromSnapshot(snapshot as unknown as ChainDocSnap, inclusive)
      : q.endCursorFromSnapshot(snapshot as unknown as ChainDocSnap, inclusive),
    prepareSandbox: prepared ? undefined : () => {
      const raw = rawDocumentSnapshotForCursor(snapshot as object);
      const rawData = raw.data();
      const capturedSnapshot = Object.freeze({
        id: raw.id,
        ref: raw.ref,
        exists: rawData !== undefined,
        // The raw snapshot is already a point-in-time Firestore value. Keep
        // that exact value behind a side-effect-free closure so rebuilding a
        // sandbox-live query never calls the public snapshot or converter.
        data: () => rawData,
      }) as unknown as DocumentSnapshot;
      return snapshotCursorConstraint(capturedSnapshot, inclusive, start, true);
    },
  };
}

function cursorValuesConstraint(
  values: readonly unknown[],
  inclusive: boolean,
  start: boolean,
  prepared = false,
): QueryConstraint {
  return {
    type: start ? 'startAt' : 'endAt',
    applySandbox: (q) => start
      ? q.startCursor([...values], inclusive)
      : q.endCursor([...values], inclusive),
    prepareSandbox: prepared ? undefined : (owner) => cursorValuesConstraint(
      values.map((value) => captureQueryOperand(value, owner).executionValue),
      inclusive,
      start,
      true,
    ),
  };
}

export type QueryConstraintType = 'where' | 'orderBy' | 'limit' | 'limitToLast' | 'startAt' | 'startAfter' | 'endAt' | 'endBefore' | 'or' | 'and';
export type QueryNonFilterConstraint = any;
export type QueryFilterConstraint = any;

export class QueryConstraint {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && ('type' in instance || '_sandboxFilter' in instance || 'applySandbox' in instance));
  }
}

export class QueryFieldFilterConstraint extends QueryConstraint {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && (('type' in instance && (instance as any).type === 'where') || ('_sandboxFilter' in instance && (instance as any)._sandboxFilter?.kind === 'where')));
  }
}

export class QueryCompositeFilterConstraint extends QueryConstraint {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && (('type' in instance && ((instance as any).type === 'and' || (instance as any).type === 'or')) || ('_sandboxFilter' in instance && ((instance as any)._sandboxFilter?.kind === 'and' || (instance as any)._sandboxFilter?.kind === 'or'))));
  }
}

export class QueryOrderByConstraint extends QueryConstraint {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && ('type' in instance && (instance as any).type === 'orderBy'));
  }
}

export class QueryLimitConstraint extends QueryConstraint {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && ('type' in instance && ((instance as any).type === 'limit' || (instance as any).type === 'limitToLast')));
  }
}

export class QueryStartAtConstraint extends QueryConstraint {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && ('type' in instance && ((instance as any).type === 'startAt' || (instance as any).type === 'startAfter')));
  }
}

export class QueryEndAtConstraint extends QueryConstraint {
  static [Symbol.hasInstance](instance: unknown): boolean {
    return Boolean(instance && typeof instance === 'object' && ('type' in instance && ((instance as any).type === 'endAt' || (instance as any).type === 'endBefore')));
  }
}

