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
  chainableOnSnapshot,
  REMOTE_SNAPSHOT_REGISTRAR,
  registerRemoteListener,
  type RemoteSnapshotRegistrar,
} from './listeners.js';
import type { WireConstraint, WireFilter, WireQuerySnap, WireTarget } from './wire-types.js';

/** Immutable query state accumulated by the chainable constraint calls.
 *  Cursors REPLACE on repeat (matching the local arm / production). */
export interface QueryState {
  readonly source: { __ref: 'collection'; path: string } | { __ref: 'group'; collectionId: string };
  readonly filters: readonly WireFilter[];
  readonly orders: readonly { field: string; direction: OrderDirection }[];
  readonly limitCount?: number;
  readonly limitFromEnd: boolean;
  readonly start?: { values: readonly unknown[]; inclusive: boolean };
  readonly end?: { values: readonly unknown[]; inclusive: boolean };
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
    return { kind: 'where', field: filter.field, op: filter.op, value: encodeValue(filter.value) };
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

/** Flatten the accumulated state into the wire's constraint list. */
export function buildDescriptor(state: QueryState): WireTarget {
  const constraints: WireConstraint[] = [...state.filters];
  for (const o of state.orders) {
    constraints.push({ kind: 'orderBy', field: o.field, direction: o.direction });
  }
  if (state.start) {
    constraints.push({
      kind: state.start.inclusive ? 'startAt' : 'startAfter',
      values: state.start.values.map(encodeValue),
    });
  }
  if (state.end) {
    constraints.push({
      kind: state.end.inclusive ? 'endAt' : 'endBefore',
      values: state.end.values.map(encodeValue),
    });
  }
  if (state.limitCount !== undefined) {
    constraints.push(
      state.limitFromEnd
        ? { kind: 'limitToLast', n: state.limitCount }
        : { kind: 'limit', n: state.limitCount },
    );
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
  orders: readonly { field: string }[],
  method: string,
): unknown[] {
  if (orders.length === 0) {
    throw invalidArgument(
      `${method}(snapshot) on a remote sandbox requires at least one explicit orderBy() ` +
        'clause — the relay protocol has no document-key cursor.',
    );
  }
  if (orders.some((o) => o.field === '__name__')) {
    throw invalidArgument(
      `${method}(snapshot) on a remote sandbox does not support orderBy('__name__') — ` +
        'the relay protocol has no document-key cursor, and __name__ is not a data ' +
        'field a value cursor can carry. Order by a real document field instead.',
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
  return orders.map((o) => data[o.field]);
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

    where(field: string, op: WhereFilterOp, value: unknown): Query {
      validateWhereOp(op);
      return clone({
        filters: [...state.filters, { kind: 'where', field, op, value: encodeValue(value) }],
      });
    },
    applyFilter(filter: Filter): Query {
      return clone({ filters: [...state.filters, encodeFilter(filter)] });
    },
    orderBy(field: string, direction: OrderDirection = 'asc'): Query {
      return clone({ orders: [...state.orders, { field, direction }] });
    },
    limit(n: number): Query {
      return clone({ limitCount: n, limitFromEnd: false });
    },
    limitToLast(n: number): Query {
      return clone({ limitCount: n, limitFromEnd: true });
    },
    startCursor(values: unknown[], inclusive: boolean): Query {
      return clone({ start: { values: [...values], inclusive } });
    },
    endCursor(values: unknown[], inclusive: boolean): Query {
      return clone({ end: { values: [...values], inclusive } });
    },
    startCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): Query {
      return clone({
        start: {
          values: cursorValuesFromSnapshot(snapshot, state.orders, inclusive ? 'startAt' : 'startAfter'),
          inclusive,
        },
      });
    },
    endCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): Query {
      return clone({
        end: {
          values: cursorValuesFromSnapshot(snapshot, state.orders, inclusive ? 'endAt' : 'endBefore'),
          inclusive,
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
      const wire = (await armOp(arm, {
        method: 'aggregate',
        source: buildDescriptor(state),
        spec,
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
