/**
 * Chainable `Query` for the remote arm — accumulates `where`/`orderBy`/
 * cursor/`limit` state immutably (mirroring the local arm's `QueryImpl`)
 * and flattens it into the wire's constraint list on execution.
 *
 * KNOWN CURSOR LIMITS: the wire has no document-key cursor, so snapshot
 * cursors require explicit non-`__name__` orderBy fields and lose the
 * implicit `__name__` tie-break — see {@link cursorValuesFromSnapshot}.
 */

import { SandboxError } from 'pyric/sandbox';
import type {
  AggregateQuerySnapshot,
  AggregateSpec,
  DocumentSnapshot,
  Filter,
  OperationOptions,
  OrderDirection,
  Query,
  QuerySnapshot,
  WhereFilterOp,
} from 'pyric/sandbox/admin-compat';
import { armOp, type RemoteArm } from './channel.js';
import { invalidArgument } from './errors.js';
import { encodeValue } from './value-codec.js';
import { makeQuerySnapshot } from './snapshots.js';
import {
  FieldPath,
  fieldPathSegments,
  getSnapshotField,
  type SnapshotFieldPath,
} from '../../../firestore/sandbox/admin-compat/field-path.js';
import {
  fieldPathArgumentSegments,
  fieldPathKey,
  fieldPathKeySegments,
} from '../../../firestore/sandbox/update-fields.js';
import { normalizeQueryOrders } from '../../../firestore/internal/implicit-order.js';
import {
  chainableOnSnapshot,
  REMOTE_SNAPSHOT_REGISTRAR,
  registerRemoteListener,
  type RemoteSnapshotRegistrar,
} from './listeners.js';
import type { WireConstraint, WireFilter, WireQuerySnap, WireTarget } from './wire-types.js';

/** Immutable query state accumulated by the chainable constraint calls.
 *  Cursors REPLACE on repeat (matching the local arm / production). */
export interface CursorState {
  readonly values: readonly unknown[];
  readonly inclusive: boolean;
  readonly snapshot?: DocumentSnapshot;
  readonly method?: string;
}

export interface QueryState {
  readonly source: { __ref: 'collection'; path: string } | { __ref: 'group'; collectionId: string };
  readonly filters: readonly WireFilter[];
  readonly orders: readonly {
    field: string;
    fieldSegments?: readonly string[];
    direction: OrderDirection;
  }[];
  readonly limitCount?: number;
  readonly limitFromEnd: boolean;
  readonly start?: CursorState;
  readonly end?: CursorState;
}

/** Brand for `Transaction.get`'s doc-vs-query runtime dispatch and the
 *  descriptor recovery it needs. */
const QUERY_STATE: unique symbol = Symbol('pyric/sandbox/admin-firestore/remoteQueryState');

export function queryStateOf(value: unknown): QueryState | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return (value as { [QUERY_STATE]?: QueryState })[QUERY_STATE];
}

function encodeFilter(filter: Filter): WireFilter {
  if (filter.kind === 'where') {
    validateWhereOp(filter.op);
    const normalized = validateQueryField(filter.field);
    const wireFilter: Extract<WireFilter, { kind: 'where' }> = {
      kind: 'where',
      field: normalized.field,
      op: filter.op,
      value: encodeValue(filter.value),
    };
    if (normalized.fieldSegments !== undefined) {
      wireFilter.fieldSegments = normalized.fieldSegments;
    }
    return wireFilter;
  }
  return { kind: filter.kind, filters: filter.filters.map(encodeFilter) };
}

const WHERE_OPS: ReadonlySet<string> = new Set([
  '<', '<=', '==', '!=', '>=', '>',
  'in', 'not-in', 'array-contains', 'array-contains-any',
]);

function validateWhereOp(op: WhereFilterOp): void {
  if (!WHERE_OPS.has(op)) {
    throw invalidArgument(`invalid where operator: ${String(op)}`);
  }
}

const INEQUALITY_OPS: ReadonlySet<string> = new Set([
  '<', '<=', '>', '>=', '!=', 'not-in',
]);

function canonicalOrderFieldKey(item: { field: string; fieldSegments?: readonly string[] }): string {
  if (item.fieldSegments !== undefined) {
    return fieldPathKey(item.fieldSegments);
  }
  return fieldPathKey(item.field.split('.'));
}

function collectInequalityFields(filters: readonly WireFilter[]): string[] {
  const fields: string[] = [];
  for (const filter of filters) {
    if (filter.kind === 'where') {
      if (INEQUALITY_OPS.has(filter.op)) {
        fields.push(canonicalOrderFieldKey(filter));
      }
      continue;
    }
    fields.push(...collectInequalityFields(filter.filters));
  }
  return fields;
}

/** Flatten the accumulated state into the wire's constraint list. */
export function buildDescriptor(state: QueryState): WireTarget {
  const constraints: WireConstraint[] = [...state.filters];
  for (const o of state.orders) {
    const orderConstraint: Extract<WireConstraint, { kind: 'orderBy' }> = {
      kind: 'orderBy',
      field: o.field,
      direction: o.direction,
    };
    if (o.fieldSegments !== undefined) {
      orderConstraint.fieldSegments = o.fieldSegments;
    }
    constraints.push(orderConstraint);
  }
  if (state.start) {
    const startKind = state.start.inclusive ? 'startAt' : 'startAfter';
    const startConstraint: Extract<WireConstraint, { kind: 'startAt' | 'startAfter' }> = {
      kind: startKind,
      values: state.start.values.map(encodeValue),
    };
    if (state.start.snapshot) {
      startConstraint.fromSnapshot = true;
    }
    constraints.push(startConstraint);
  }
  if (state.end) {
    const endKind = state.end.inclusive ? 'endAt' : 'endBefore';
    const endConstraint: Extract<WireConstraint, { kind: 'endAt' | 'endBefore' }> = {
      kind: endKind,
      values: state.end.values.map(encodeValue),
    };
    if (state.end.snapshot) {
      endConstraint.fromSnapshot = true;
    }
    constraints.push(endConstraint);
  }
  if (state.limitCount !== undefined) {
    const limitKind = state.limitFromEnd ? 'limitToLast' : 'limit';
    constraints.push({ kind: limitKind, n: state.limitCount });
  }
  if (constraints.length === 0) return state.source;
  return { __ref: 'query', source: state.source, constraints };
}

/**
 * Pull cursor values off a `DocumentSnapshot` at the query's EXPLICIT
 * orderBy fields — the remote mirror of the local
 * `cursorValuesFromSnapshot`.
 *
 * HONEST FIDELITY LIMITS (the relay's value-cursor constraints cannot
 * express a document-key cursor; extending the wire with one is filed
 * for later — no protocol change here):
 *
 *   1. Zero explicit orderBy → THROW. The local arm positions on the
 *      implicit `__name__` key; the wire cannot.
 *   2. An explicit `orderBy('__name__')` → THROW. `__name__` is not a
 *      data field — reading `data()['__name__']` would yield `undefined`
 *      and the cursor would silently match NOTHING/EVERYTHING.
 *   3. TIE-BREAK GAP (documented, not thrown — it is only detectable at
 *      the data level): the local arm's snapshot cursors also carry the
 *      implicit `__name__` tie-break value, so `orderBy('v')
 *      .startAfter(snapOfB)` with ties on `v` still positions PAST the
 *      exact document. The remote cursor carries only the explicit
 *      field values, so under EQUAL orderBy values the boundary is the
 *      VALUE, not the document: `startAfter(snap)` skips every doc tied
 *      with `snap` (deterministically — the whole tie group), where the
 *      local arm keeps the tied docs that sort after it by key. Break
 *      ties with an explicit second orderBy field to paginate exactly.
 */
function cursorValuesFromSnapshot(
  snapshot: DocumentSnapshot,
  filters: readonly WireFilter[],
  orders: readonly {
    field: string;
    fieldSegments?: readonly string[];
    direction: OrderDirection;
  }[],
  method: string,
): unknown[] {
  const canonicalOrders = orders.map((o) => ({
    field: canonicalOrderFieldKey(o),
    direction: o.direction,
  }));
  if (canonicalOrders.some((o) => o.field === '__name__')) {
    throw invalidArgument(
      `${method}(snapshot) on a remote sandbox does not support orderBy('__name__') — ` +
        'the relay protocol has no document-key cursor, and __name__ is not a data ' +
        'field a value cursor can carry. Order by a real document field instead.',
    );
  }
  const effectiveOrders = normalizeQueryOrders(
    canonicalOrders,
    collectInequalityFields(filters),
  ).filter((o) => o.field !== '__name__');
  if (effectiveOrders.length === 0) {
    throw invalidArgument(
      `${method}(snapshot) on a remote sandbox requires at least one explicit orderBy() ` +
        'clause; the relay protocol has no document-key cursor.',
    );
  }
  const data = snapshot.data();
  if (data === undefined) {
    throw new SandboxError(
      'not-found',
      'Snapshot-based cursors require an existing document — got an empty ' +
        `snapshot for ${snapshot.id ?? '<unknown>'}.`,
    );
  }
  return effectiveOrders.map((o) => {
    const lookupField = new FieldPath(...fieldPathKeySegments(o.field));
    const value = getSnapshotField(data, lookupField);
    if (value === undefined) {
      throw invalidArgument(
        `Field "${o.field}" is missing in the provided DocumentSnapshot for ${method}().`,
      );
    }
    return value;
  });
}

function validateQueryField(field: SnapshotFieldPath): {
  field: string;
  fieldSegments?: readonly string[];
} {
  try {
    const segments = fieldPathSegments(field);
    if (typeof field === 'string') {
      return { field };
    }
    return { field: fieldPathKey(segments), fieldSegments: [...segments] };
  } catch (error) {
    throw invalidArgument((error as Error).message);
  }
}

function validateStringAggregateField(field: SnapshotFieldPath): string {
  try {
    const segments = fieldPathSegments(field);
    return typeof field === 'string' ? field : segments.join('.');
  } catch (error) {
    throw invalidArgument((error as Error).message);
  }
}

function cloneCursorOperand(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Uint8Array.prototype.slice.call(value);
  }
  if (Array.isArray(value)) {
    return value.map(cloneCursorOperand);
  }
  return value;
}

function assertValidLimit(n: number): void {
  const isPositiveInteger = typeof n === 'number' && Number.isInteger(n) && n > 0;
  if (!isPositiveInteger) {
    throw invalidArgument('Query limit must be a positive integer.');
  }
}

function recomputeSnapshotCursor(
  cursor: CursorState | undefined,
  filters: readonly WireFilter[],
  orders: readonly {
    field: string;
    fieldSegments?: readonly string[];
    direction: OrderDirection;
  }[],
  defaultInclusiveMethod: string,
  defaultExclusiveMethod: string,
): CursorState | undefined {
  if (!cursor?.snapshot) return cursor;
  const fallbackMethod = cursor.inclusive ? defaultInclusiveMethod : defaultExclusiveMethod;
  const method = cursor.method ?? fallbackMethod;
  return {
    values: cursorValuesFromSnapshot(cursor.snapshot, filters, orders, method),
    inclusive: cursor.inclusive,
    snapshot: cursor.snapshot,
    method,
  };
}

function normalizeWireAggregateSpec(spec: AggregateSpec): Record<string, unknown> {
  const wireSpec: Record<string, unknown> = {};
  for (const [alias, entry] of Object.entries(spec)) {
    if (entry.kind === 'count') {
      wireSpec[alias] = { kind: 'count' };
      continue;
    }
    const segments = fieldPathArgumentSegments(entry.field);
    if (segments !== undefined) {
      const wireEntry: { kind: 'sum' | 'average'; field: string; path?: readonly string[] } = {
        kind: entry.kind,
        field: segments.join('.'),
      };
      if (segments.some((segment) => segment.includes('.'))) {
        wireEntry.path = [...segments];
      }
      wireSpec[alias] = wireEntry;
      continue;
    }
    const validatedField = validateStringAggregateField(entry.field);
    const wireEntry: { kind: 'sum' | 'average'; field: string; path?: readonly string[] } = {
      kind: entry.kind,
      field: validatedField,
    };
    if (entry.path !== undefined) {
      wireEntry.path = [...entry.path];
    }
    wireSpec[alias] = wireEntry;
  }
  return wireSpec;
}

export function makeQuery(arm: RemoteArm, state: QueryState): Query {
  const clone = (patch: Partial<QueryState>): Query =>
    makeQuery(arm, { ...state, ...patch });

  const query: Query & {
    [QUERY_STATE]: QueryState;
    [REMOTE_SNAPSHOT_REGISTRAR]: RemoteSnapshotRegistrar;
    onSnapshot: typeof chainableOnSnapshot;
  } = {
    [QUERY_STATE]: state,

    where(field: SnapshotFieldPath, op: WhereFilterOp, value: unknown): Query {
      validateWhereOp(op);
      const normalized = validateQueryField(field);
      const whereFilter: Extract<WireFilter, { kind: 'where' }> = {
        kind: 'where',
        field: normalized.field,
        op,
        value: encodeValue(value),
      };
      if (normalized.fieldSegments !== undefined) {
        whereFilter.fieldSegments = normalized.fieldSegments;
      }
      const filters: WireFilter[] = [...state.filters, whereFilter];
      const start = recomputeSnapshotCursor(state.start, filters, state.orders, 'startAt', 'startAfter');
      const end = recomputeSnapshotCursor(state.end, filters, state.orders, 'endAt', 'endBefore');
      return clone({ filters, start, end });
    },
    applyFilter(filter: Filter): Query {
      const filters: WireFilter[] = [...state.filters, encodeFilter(filter)];
      const start = recomputeSnapshotCursor(state.start, filters, state.orders, 'startAt', 'startAfter');
      const end = recomputeSnapshotCursor(state.end, filters, state.orders, 'endAt', 'endBefore');
      return clone({ filters, start, end });
    },
    orderBy(field: SnapshotFieldPath, direction: OrderDirection = 'asc'): Query {
      const normalized = validateQueryField(field);
      if (direction !== 'asc' && direction !== 'desc') {
        throw invalidArgument("orderBy() direction must be 'asc' or 'desc'.");
      }
      const orderEntry: QueryState['orders'][number] = {
        field: normalized.field,
        direction,
      };
      if (normalized.fieldSegments !== undefined) {
        (orderEntry as { fieldSegments?: readonly string[] }).fieldSegments = normalized.fieldSegments;
      }
      const orders = [...state.orders, orderEntry];
      const start = recomputeSnapshotCursor(state.start, state.filters, orders, 'startAt', 'startAfter');
      const end = recomputeSnapshotCursor(state.end, state.filters, orders, 'endAt', 'endBefore');
      return clone({ orders, start, end });
    },
    limit(n: number): Query {
      assertValidLimit(n);
      return clone({ limitCount: n, limitFromEnd: false });
    },
    limitToLast(n: number): Query {
      assertValidLimit(n);
      return clone({ limitCount: n, limitFromEnd: true });
    },
    startCursor(values: unknown[], inclusive: boolean): Query {
      return clone({ start: { values: values.map(cloneCursorOperand), inclusive } });
    },
    endCursor(values: unknown[], inclusive: boolean): Query {
      return clone({ end: { values: values.map(cloneCursorOperand), inclusive } });
    },
    startCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): Query {
      const method = inclusive ? 'startAt' : 'startAfter';
      return clone({
        start: {
          values: cursorValuesFromSnapshot(snapshot, state.filters, state.orders, method),
          inclusive,
          snapshot,
          method,
        },
      });
    },
    endCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): Query {
      const method = inclusive ? 'endAt' : 'endBefore';
      return clone({
        end: {
          values: cursorValuesFromSnapshot(snapshot, state.filters, state.orders, method),
          inclusive,
          snapshot,
          method,
        },
      });
    },

    async get(_opts?: OperationOptions): Promise<QuerySnapshot> {
      validateExecutable(state);
      const wire = (await armOp(arm, {
        method: 'getDocs',
        source: buildDescriptor(state),
      })) as WireQuerySnap;
      return makeQuerySnapshot(arm, wire);
    },

    async aggregate(spec: AggregateSpec): Promise<AggregateQuerySnapshot> {
      validateExecutable(state);
      const wireSpec = normalizeWireAggregateSpec(spec);
      const wire = (await armOp(arm, {
        method: 'aggregate',
        source: buildDescriptor(state),
        spec: wireSpec,
      })) as { data: Record<string, number | null> };
      return { data: () => wire.data };
    },

    [REMOTE_SNAPSHOT_REGISTRAR]: (options, onNext, onError) => {
      validateExecutable(state);
      return registerRemoteListener(arm, buildDescriptor(state), options, onNext, onError);
    },
    onSnapshot: chainableOnSnapshot,
  };
  return query;
}

/** Client-side runtime checks matching the local arm's execution-time
 *  contract, so the failure surfaces with the same code + guidance
 *  instead of a worker round-trip. */
export function validateExecutable(state: QueryState): void {
  if (state.limitFromEnd && state.orders.length === 0) {
    throw invalidArgument('limitToLast() queries require at least one orderBy clause.');
  }
}
