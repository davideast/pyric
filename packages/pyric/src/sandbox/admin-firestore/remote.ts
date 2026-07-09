/**
 * Remote arm of the admin-shaped Firestore surface (remote sandbox,
 * slice 2 / checkpoint 2).
 *
 * A PARALLEL channel-backed implementation of `pyric/sandbox/admin-compat`'s
 * type surface (`Firestore` / `DocumentReference` / `Query` / `WriteBatch` /
 * `Transaction`), per the remote-Firestore spike verdict: the local
 * admin-compat layer is welded to `LocalEnvironment`'s SYNCHRONOUS engine
 * seam and cannot run over a WebSocket, so the remote arm re-implements the
 * SHAPE over `RemoteSandboxChannel.op`/`subscribe` worker-relay frames —
 * exactly the fork `pyric-admin/database` took for RTDB. The two arms share
 * the type surface and the conformance assertions, not the implementation.
 *
 * DEPENDENCY DIRECTION: this module lives in `pyric` and may only consume
 * the STRUCTURAL channel contract from `pyric/sandbox`'s remote seam
 * (`RemoteSandboxChannel` — one loose `op`, one loose `subscribe`). The
 * concrete worker-protocol unions live in `pyric-tools`, which `pyric`
 * cannot import; ops are spelled loosely (`{ method: 'getDoc', path,
 * actAs }`) and kept structurally identical to
 * `pyric-tools/src/serve/worker/protocol.ts`.
 *
 * IDENTITY: every op and every subscription pins an EXPLICIT `actAs` lens.
 * An ABSENT lens resolves worker-side to the browser tab's PORT SESSION —
 * whoever happens to be signed in in the tab — which is never what a
 * server-side handle means. `getAdminFirestore` pins `{ mode: 'admin' }`
 * (rules bypass); `getFirestore(ctx)` pins `{ mode: 'as', uid, token? }`
 * for a signed identity or `{ mode: 'anon' }` for `withAuth(null)`. The
 * `as` lens carries the FULL `AuthState` (uid + custom-claims token): the
 * worker host resolves it via `sandbox.withAuth({ uid, token })`, so there
 * is no identity-fidelity loss versus the local arm.
 *
 * VALUE CODEC: write payloads are encoded CLIENT-side to the plain-JSON
 * marker forms the worker host rehydrates (`prepareWriteData`): admin
 * `FieldValue` sentinels (`{ __type: 'increment', value }`) become wire
 * `SentinelMarker`s (`{ __sentinel: 'increment', n }`), and Timestamp /
 * Date / rules-wrapper scalars become their `toJSON()` marker shapes — so
 * the worker STORES real typed values (rules comparisons and `orderBy`
 * see a Timestamp, not a map). Read payloads arrive as the
 * `SerializedDocData` JSON envelope and are rehydrated with the ONE shared
 * codec (`pyric/firestore-values`' `rehydrateDocValue`) then translated to
 * the compat field shapes (`translateReadData`) — the same shapes the
 * local arm's read path yields.
 *
 * KNOWN CODEC DIVERGENCE (accepted): user data that happens to be SHAPED
 * like a codec marker — a plain map such as `{ __type: 'timestamp',
 * seconds, nanos }` or `{ type: 'firestore/timestamp/1.0', … }` — is
 * TRANSMUTED into the real typed value on the relayed path (the host's
 * `prepareWriteData` / constraint rehydration cannot tell an intentional
 * marker from a lookalike), while an in-page `setDoc` of the same map
 * stores a plain map. This is the persistence codec's own behavior (an
 * IndexedDB save/reload transmutes the same shapes), so the relay is
 * consistent with the sandbox's durability semantics rather than with
 * the in-page live path — marker-shaped user data is already reserved
 * vocabulary in this system.
 *
 * KNOWN CURSOR LIMITS: the wire has no document-key cursor, so snapshot
 * cursors require explicit non-`__name__` orderBy fields and lose the
 * implicit `__name__` tie-break — see {@link cursorValuesFromSnapshot}.
 *
 * TRANSACTIONS: the worker exposes no interactive transaction session; the
 * protocol is optimistic — every `tx.get` is an ordinary `getDoc`/`getDocs`
 * op recorded into a client-held read-set, and ONE `txnCommit` op ships
 * `{ reads, writes }`. The worker re-reads each path inside a real sandbox
 * transaction and compares SERIALIZED JSON STRINGS. The read-set therefore
 * echoes the worker's ORIGINAL `SerializedDocData.json` strings verbatim —
 * re-serializing rehydrated data on this side would risk cross-process
 * key-order/format drift and phantom aborts (livelock under retry). On
 * `{ code: 'aborted' }` the update function is re-run with a fresh
 * transaction, up to {@link TXN_MAX_ATTEMPTS} attempts (the worker client's
 * model, which itself matches the Firestore SDK default).
 */

import {
  SandboxError,
  type AuthLens,
  type DenialContext,
  type SandboxErrorCode,
} from 'pyric/sandbox';
import type { RemoteSandbox } from 'pyric/sandbox';
import { rehydrateDocValue } from 'pyric/firestore-values';
import {
  Timestamp as CompatTimestamp,
  type AggregateQuerySnapshot,
  type AggregateSpec,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type FieldValueSentinel,
  type Filter,
  type OperationOptions,
  type OrderDirection,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  type SetOptions,
  type Transaction,
  type WhereFilterOp,
  type WriteBatch,
} from 'pyric/sandbox/admin-compat';
import { translateReadData } from '../firestore/admin-compat/read-translation.js';
import {
  isCollectionPath,
  isDocumentPath,
  lastSegment,
  parentCollectionPath,
} from '../firestore/admin-compat/paths.js';
import { generateAutoId } from '../firestore/auto-id.js';
import { READ_AFTER_WRITE_MESSAGE } from '../firestore/transaction-types.js';
import {
  buildDocumentSnapshot,
  buildQuerySnapshot,
} from '../firestore/snapshot-listeners.js';
import type { SandboxFirestore } from './index.js';

// ─── Loose wire shapes (structural mirrors of the worker protocol) ────────

/** Wire form of a doc/collection/group/query target. Mirrors
 *  `pyric-tools`' `TargetDescriptor` — plain JSON, spelled loosely here
 *  because `pyric` cannot import the protocol module. */
type WireTarget =
  | { __ref: 'doc'; path: string }
  | { __ref: 'collection'; path: string }
  | { __ref: 'group'; collectionId: string }
  | {
      __ref: 'query';
      source: { __ref: 'doc'; path: string } | { __ref: 'collection'; path: string } | { __ref: 'group'; collectionId: string };
      constraints: WireConstraint[];
    };

type WireFilter =
  | { kind: 'where'; field: string; op: string; value: unknown }
  | { kind: 'and'; filters: WireFilter[] }
  | { kind: 'or'; filters: WireFilter[] };

type WireConstraint =
  | WireFilter
  | { kind: 'orderBy'; field: string; direction?: 'asc' | 'desc' }
  | { kind: 'limit'; n: number }
  | { kind: 'limitToLast'; n: number }
  | { kind: 'startAt'; values: unknown[] }
  | { kind: 'startAfter'; values: unknown[] }
  | { kind: 'endAt'; values: unknown[] }
  | { kind: 'endBefore'; values: unknown[] };

/** Mirrors the protocol's `WriteDescriptor`. */
type WireWrite =
  | { method: 'set'; path: string; data: unknown; options?: { merge?: boolean; mergeFields?: string[] } }
  | { method: 'update'; path: string; data: unknown }
  | { method: 'delete'; path: string };

/** Mirrors the protocol's `SerializedDocData` — the JSON string envelope. */
interface WireDocData {
  json: string;
}

/** Mirrors the protocol's `TxnReadEntry`. `data` is the worker's ORIGINAL
 *  serialized envelope (or null for a missing doc) — never re-serialized. */
interface WireTxnRead {
  path: string;
  data: WireDocData | null;
}

/** `getDoc` result / doc-listener snap value on the wire. */
interface WireDocSnap {
  id: string;
  path?: string;
  exists: boolean;
  data?: WireDocData;
}

/** `getDocs` result / query-listener snap value on the wire. */
interface WireQuerySnap {
  docs: Array<{ id: string; path?: string; exists?: boolean; data?: WireDocData }>;
}

// ─── Error translation ─────────────────────────────────────────────────────

/**
 * Wire errors arrive as `Error & { code, denialContext? }` (the channel
 * reconstructs them from the protocol's `SerializedError`). Re-shape them
 * into the SAME `SandboxError` the local arm throws, re-attaching the
 * structured `denialContext` when the worker carried one — so
 * `err instanceof SandboxError && err.code === 'permission-denied'` and
 * `err.denialContext` work identically on both arms.
 */
function toRemoteSandboxError(err: unknown): unknown {
  if (err instanceof SandboxError) return err;
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; denialContext?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      const denialContext =
        e.denialContext !== null && typeof e.denialContext === 'object'
          ? (e.denialContext as DenialContext)
          : undefined;
      return new SandboxError(e.code as SandboxErrorCode, e.message, denialContext);
    }
  }
  return err;
}

function invalidArgument(message: string): SandboxError {
  return new SandboxError('invalid-argument', message);
}

// ─── Write-data encoding (client → wire marker forms) ─────────────────────

const SENTINEL_TYPES: ReadonlySet<string> = new Set([
  'serverTimestamp',
  'increment',
  'arrayUnion',
  'arrayRemove',
  'deleteField',
]);

function isFieldValueSentinel(v: unknown): v is FieldValueSentinel {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { __type?: unknown }).__type === 'string' &&
    SENTINEL_TYPES.has((v as { __type: string }).__type)
  );
}

/** Admin `FieldValue` sentinel (`__type` shape) → the documented wire
 *  `SentinelMarker` (`__sentinel` shape) the worker host resolves. */
function encodeSentinel(s: FieldValueSentinel): unknown {
  switch (s.__type) {
    case 'serverTimestamp':
      return { __sentinel: 'serverTimestamp' };
    case 'increment':
      return { __sentinel: 'increment', n: s.value };
    case 'arrayUnion':
      return { __sentinel: 'arrayUnion', values: s.values.map(encodeValue) };
    case 'arrayRemove':
      return { __sentinel: 'arrayRemove', values: s.values.map(encodeValue) };
    case 'deleteField':
      return { __sentinel: 'deleteField' };
  }
}

/**
 * Encode ONE value for the wire: sentinels → markers, typed scalars →
 * their `toJSON()` marker shapes, containers walked recursively.
 *
 * Typed scalars are encoded EXPLICITLY (not left for a JSON leg to
 * flatten) so the wire form is transport-independent — the same frames
 * work over structured clone and over the double-JSON WS relay. The
 * host's `prepareWriteData` rehydrates every marker family back into
 * real wrapper instances before the write, which is what makes the
 * worker STORE typed values (the spike's gap-4 semantics).
 */
function encodeValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (isFieldValueSentinel(v)) return encodeSentinel(v);
  if (v instanceof CompatTimestamp) return v.toJSON();
  if (v instanceof Date) return CompatTimestamp.fromDate(v).toJSON();
  if (Array.isArray(v)) return v.map(encodeValue);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    // Non-plain instance (rules-wrapper Bytes/LatLng/Duration/… — the
    // shapes the local read path hands back). Their `toJSON()` emits the
    // canonical `__type` marker the shared codec rehydrates. Instances
    // without a toJSON have no wire form — surface that honestly.
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return (toJSON as () => unknown).call(v);
    }
    throw invalidArgument(
      `remote Firestore: cannot serialize a ${proto.constructor?.name ?? 'class'} ` +
        'instance for the wire — use plain data, Timestamp, Date, or FieldValue sentinels.',
    );
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = encodeValue(val);
  }
  return out;
}

function encodeWriteData(data: DocumentData): unknown {
  return encodeValue(data);
}

// ─── Read-data decoding (wire → compat shapes) ─────────────────────────────

/** Parse the JSON envelope with the shared codec, but keep the values in
 *  their RULES-INTERNAL wrapper form (what the local engine stores). Used
 *  where a downstream helper does its own compat translation. */
function decodeInternal(serialized: WireDocData): DocumentData {
  return rehydrateDocValue(JSON.parse(serialized.json)) as DocumentData;
}

/** Full read-path decode: shared codec rehydration + the same
 *  internal→compat field-shape translation the local arm applies
 *  (`Timestamp{seconds,nanoseconds}`, not the rules wrapper). */
function decodeDocData(serialized: WireDocData): DocumentData {
  return translateReadData(decodeInternal(serialized));
}

// ─── Channel plumbing ──────────────────────────────────────────────────────

/** Per-handle immutable state: the relay channel + the pinned lens. */
interface RemoteArm {
  readonly sandbox: RemoteSandbox;
  readonly lens: AuthLens;
}

/** Dispatch one worker op with the handle's lens pinned; wire errors
 *  re-shape into `SandboxError`. */
async function armOp(arm: RemoteArm, op: Record<string, unknown>): Promise<unknown> {
  try {
    return await arm.sandbox.channel.op({
      ...(op as { method: string }),
      actAs: arm.lens,
    });
  } catch (e) {
    throw toRemoteSandboxError(e);
  }
}

// ─── Admin-shaped snapshots (one-shot reads) ───────────────────────────────

function makeDocumentSnapshot(ref: DocumentReference, wire: WireDocSnap): DocumentSnapshot {
  const data = wire.exists && wire.data ? decodeDocData(wire.data) : undefined;
  return {
    id: ref.id,
    ref,
    exists: wire.exists,
    data: () => data,
  };
}

function makeQuerySnapshot(
  arm: RemoteArm,
  wire: WireQuerySnap,
): QuerySnapshot {
  const docs: QueryDocumentSnapshot[] = wire.docs.map((row) => {
    const path = row.path ?? row.id;
    const ref = makeDocRef(arm, path);
    const data = row.data ? decodeDocData(row.data) : {};
    return {
      id: ref.id,
      ref,
      exists: true,
      data: () => data,
    };
  });
  return {
    size: docs.length,
    empty: docs.length === 0,
    docs,
    forEach(callback: (snap: QueryDocumentSnapshot) => void): void {
      docs.forEach((d) => callback(d));
    },
  };
}

// ─── onSnapshot plumbing ───────────────────────────────────────────────────

/**
 * Hidden hook the free `onSnapshot(ref, …)` in `index.ts` dispatches on:
 * every remote ref/query exposes a registrar under this symbol that takes
 * the NORMALIZED argument set and returns the unsubscribe. `Symbol.for` is
 * unnecessary here (single module graph inside `pyric`), but a plain
 * unique symbol keeps it invisible to consumer code.
 */
const REMOTE_SNAPSHOT_REGISTRAR: unique symbol = Symbol(
  'pyric/sandbox/admin-firestore/remoteSnapshotRegistrar',
);

type RemoteSnapshotRegistrar = (
  options: { includeMetadataChanges?: boolean },
  onNext: ((snapshot: unknown) => void) | undefined,
  onError: ((error: unknown) => void) | undefined,
) => () => void;

/** Is this ref one of the remote arm's (carries the registrar hook)? */
export function getRemoteSnapshotRegistrar(ref: unknown): RemoteSnapshotRegistrar | undefined {
  if (ref === null || typeof ref !== 'object') return undefined;
  const registrar = (ref as { [REMOTE_SNAPSHOT_REGISTRAR]?: unknown })[REMOTE_SNAPSHOT_REGISTRAR];
  return typeof registrar === 'function' ? (registrar as RemoteSnapshotRegistrar) : undefined;
}

/**
 * Late-bound reference to the free `onSnapshot` from `index.ts`, backing
 * the chainable `ref.onSnapshot(...)` method on remote refs (parity with
 * the local arm's Proxy-synthesized shim). Registered at module init from
 * `index.ts` — a static import back would be a cycle at runtime.
 */
type FreeOnSnapshot = (ref: unknown, ...args: unknown[]) => () => void;
let freeOnSnapshot: FreeOnSnapshot | null = null;

export function registerRemoteOnSnapshotImpl(fn: FreeOnSnapshot): void {
  freeOnSnapshot = fn;
}

function chainableOnSnapshot(this: unknown, ...args: unknown[]): () => void {
  if (freeOnSnapshot === null) {
    throw new SandboxError(
      'failed-precondition',
      'remote Firestore: onSnapshot is not wired yet — import pyric-admin/firestore (or pyric/sandbox/admin-firestore) before subscribing.',
    );
  }
  return freeOnSnapshot(this, ...args);
}

/** Register a worker subscription for a resolved target and adapt snap
 *  frames into the Web-SDK-shaped live snapshots the local `onSnapshot`
 *  delivers. Wire `__error` snaps (establishment AND mid-stream, e.g. a
 *  rules redeploy turning the read into a denial) surface through
 *  `onError` as `SandboxError`s with `denialContext` when carried. */
function registerRemoteListener(
  arm: RemoteArm,
  target: WireTarget,
  options: { includeMetadataChanges?: boolean },
  onNext: ((snapshot: unknown) => void) | undefined,
  onError: ((error: unknown) => void) | undefined,
): () => void {
  const excludesMetadataChanges = options.includeMetadataChanges !== true;
  // Previous query rows, kept so `docChanges()` diffs across fires the
  // same way the local listener path does.
  let prevDocs: Array<{ path: string; data: DocumentData }> | undefined;

  let detach: () => void;
  try {
    detach = arm.sandbox.channel.subscribe(
      { target, actAs: arm.lens },
      (value) => {
        if (!onNext) return;
        const snap = value as Partial<WireDocSnap> & Partial<WireQuerySnap>;
        if (Array.isArray(snap.docs)) {
          // Query fire. `buildQuerySnapshot` translates the internal-form
          // data to compat shapes itself, so decode WITHOUT translation.
          const docList = snap.docs.map((row) => ({
            path: row.path ?? row.id,
            data: row.data ? decodeInternal(row.data) : {},
          }));
          const queryPath = target.__ref === 'query'
            ? (target.source.__ref === 'group' ? target.source.collectionId : target.source.path)
            : target.__ref === 'group'
              ? target.collectionId
              : target.path;
          const querySnap = buildQuerySnapshot(
            { path: queryPath },
            docList,
            { excludesMetadataChanges },
            prevDocs,
          );
          prevDocs = docList;
          onNext(querySnap);
        } else if (typeof snap.id === 'string') {
          // Doc fire.
          const path = snap.path ?? snap.id;
          const data = snap.exists && snap.data ? decodeInternal(snap.data) : null;
          onNext(buildDocumentSnapshot(path, data));
        }
      },
      (err) => {
        const translated = toRemoteSandboxError(err);
        if (onError) onError(translated);
        else console.error('pyric remote Firestore: uncaught onSnapshot error:', translated);
      },
    );
  } catch (e) {
    throw toRemoteSandboxError(e);
  }
  return detach;
}

// ─── Refs + queries ────────────────────────────────────────────────────────

/** Immutable query state accumulated by the chainable constraint calls.
 *  Cursors REPLACE on repeat (matching the local arm / production). */
interface QueryState {
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

function queryStateOf(value: unknown): QueryState | undefined {
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
function buildDescriptor(state: QueryState): WireTarget {
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

function makeQuery(arm: RemoteArm, state: QueryState): Query {
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
function validateExecutable(state: QueryState): void {
  if (state.limitFromEnd && state.orders.length === 0) {
    throw invalidArgument('limitToLast() queries require at least one orderBy clause.');
  }
}

function makeCollectionRef(arm: RemoteArm, path: string): CollectionReference {
  const base = makeQuery(arm, {
    source: { __ref: 'collection', path },
    filters: [],
    orders: [],
    limitFromEnd: false,
  });
  const coll: CollectionReference = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    id: lastSegment(path),
    path,
    doc(id?: string): DocumentReference {
      const finalId = id ?? generateAutoId();
      return makeDocRef(arm, `${path}/${finalId}`);
    },
    async add(data: DocumentData, _opts?: OperationOptions): Promise<DocumentReference> {
      // The worker mints the id (`addDoc`), so creation is one round-trip
      // and the id is authoritative from the shared sandbox.
      const res = (await armOp(arm, {
        method: 'addDoc',
        collectionPath: path,
        data: encodeWriteData(data),
      })) as { id: string; path: string };
      return makeDocRef(arm, res.path);
    },
  });
  return coll;
}

function makeDocRef(arm: RemoteArm, path: string): DocumentReference {
  const ref: DocumentReference & {
    [REMOTE_SNAPSHOT_REGISTRAR]: RemoteSnapshotRegistrar;
    onSnapshot: typeof chainableOnSnapshot;
  } = {
    id: lastSegment(path),
    path,
    get parent(): CollectionReference {
      return makeCollectionRef(arm, parentCollectionPath(path));
    },
    collection(name: string): CollectionReference {
      const sub = `${path}/${name}`;
      if (!isCollectionPath(sub)) {
        throw invalidArgument(`collection path must have an odd number of segments: ${sub}`);
      }
      return makeCollectionRef(arm, sub);
    },
    async get(_opts?: OperationOptions): Promise<DocumentSnapshot> {
      const wire = (await armOp(arm, { method: 'getDoc', path })) as WireDocSnap;
      return makeDocumentSnapshot(ref, wire);
    },
    async set(data: DocumentData, options?: SetOptions): Promise<void> {
      await armOp(arm, {
        method: 'setDoc',
        path,
        data: encodeWriteData(data),
        ...(setOptionsForWire(options) ? { options: setOptionsForWire(options) } : {}),
      });
    },
    async update(data: DocumentData, _opts?: OperationOptions): Promise<void> {
      await armOp(arm, { method: 'updateDoc', path, data: encodeWriteData(data) });
    },
    async delete(_opts?: OperationOptions): Promise<void> {
      await armOp(arm, { method: 'deleteDoc', path });
    },
    [REMOTE_SNAPSHOT_REGISTRAR]: (options, onNext, onError) =>
      registerRemoteListener(arm, { __ref: 'doc', path }, options, onNext, onError),
    onSnapshot: chainableOnSnapshot,
  };
  return ref;
}

function setOptionsForWire(
  options?: SetOptions,
): { merge?: boolean; mergeFields?: string[] } | undefined {
  if (!options) return undefined;
  const wire: { merge?: boolean; mergeFields?: string[] } = {};
  if (options.merge !== undefined) wire.merge = options.merge;
  if (options.mergeFields !== undefined) wire.mergeFields = [...options.mergeFields];
  return wire.merge !== undefined || wire.mergeFields !== undefined ? wire : undefined;
}

// ─── WriteBatch ────────────────────────────────────────────────────────────

function makeWriteBatch(arm: RemoteArm): WriteBatch {
  const writes: WireWrite[] = [];
  let committed = false;
  const batch: WriteBatch = {
    set(ref: DocumentReference, data: DocumentData): WriteBatch {
      assertNotCommitted();
      writes.push({ method: 'set', path: ref.path, data: encodeWriteData(data) });
      return batch;
    },
    update(ref: DocumentReference, data: DocumentData): WriteBatch {
      assertNotCommitted();
      writes.push({ method: 'update', path: ref.path, data: encodeWriteData(data) });
      return batch;
    },
    delete(ref: DocumentReference): WriteBatch {
      assertNotCommitted();
      writes.push({ method: 'delete', path: ref.path });
      return batch;
    },
    async commit(_opts?: OperationOptions): Promise<void> {
      assertNotCommitted();
      committed = true;
      await armOp(arm, { method: 'batchCommit', writes });
    },
  };
  function assertNotCommitted(): void {
    if (committed) {
      throw new SandboxError('failed-precondition', 'WriteBatch has already been committed.');
    }
  }
  return batch;
}

// ─── Transaction ───────────────────────────────────────────────────────────

/** Matches the worker client's retry cap (and the Firestore SDK default). */
const TXN_MAX_ATTEMPTS = 5;

async function runRemoteTransaction<R>(
  arm: RemoteArm,
  fn: (tx: Transaction) => Promise<R> | R,
): Promise<R> {
  for (let attempt = 0; attempt < TXN_MAX_ATTEMPTS; attempt++) {
    // Fresh read-set + write buffer per attempt.
    const reads: WireTxnRead[] = [];
    const writes: WireWrite[] = [];

    // READS-BEFORE-WRITES: the local arm's engine transaction throws
    // `failed-precondition` (ReadAfterWriteError) when a read follows any
    // write — the Admin SDK contract. The remote arm buffers writes
    // client-side, so without this gate a `tx.get` after `tx.set` would
    // issue a plain getDoc against PRE-transaction state and commit
    // silently on stale data. Enforce the same contract, same message.
    const assertReadsAllowed = (): void => {
      if (writes.length > 0) {
        throw new SandboxError('failed-precondition', READ_AFTER_WRITE_MESSAGE);
      }
    };

    const tx: Transaction = {
      // Overloaded on the surface (doc ref vs query); runtime dispatch on
      // the remote query brand — mirrors the local structural `isQuery`.
      get(refOrQuery: DocumentReference | Query): Promise<never> {
        assertReadsAllowed();
        const state = queryStateOf(refOrQuery);
        if (state !== undefined) {
          return txGetQuery(state) as Promise<never>;
        }
        return txGetDoc(refOrQuery as DocumentReference) as Promise<never>;
      },
      set(ref: DocumentReference, data: DocumentData): Transaction {
        writes.push({ method: 'set', path: ref.path, data: encodeWriteData(data) });
        return tx;
      },
      update(ref: DocumentReference, data: DocumentData): Transaction {
        writes.push({ method: 'update', path: ref.path, data: encodeWriteData(data) });
        return tx;
      },
      delete(ref: DocumentReference): Transaction {
        writes.push({ method: 'delete', path: ref.path });
        return tx;
      },
    };

    async function txGetDoc(ref: DocumentReference): Promise<DocumentSnapshot> {
      const wire = (await armOp(arm, { method: 'getDoc', path: ref.path })) as WireDocSnap;
      // READ-SET INVARIANT: record the worker's ORIGINAL serialized
      // envelope verbatim. The worker validates by re-serializing the
      // current doc IN ITS OWN process and comparing JSON strings —
      // echoing its bytes back is what keeps the comparison deterministic
      // (re-serializing rehydrated data here would phantom-abort).
      reads.push({
        path: wire.path ?? ref.path,
        data: wire.exists && wire.data ? wire.data : null,
      });
      return makeDocumentSnapshot(ref, wire);
    }

    async function txGetQuery(state: QueryState): Promise<QuerySnapshot> {
      validateExecutable(state);
      const wire = (await armOp(arm, {
        method: 'getDocs',
        source: buildDescriptor(state),
      })) as WireQuerySnap;
      // Register every returned doc in the read-set (the local arm's
      // `simTx.getAll` registration) — again echoing the original bytes.
      for (const row of wire.docs) {
        reads.push({ path: row.path ?? row.id, data: row.data ?? null });
      }
      return makeQuerySnapshot(arm, wire);
    }

    const result = await fn(tx);

    try {
      await armOp(arm, { method: 'txnCommit', reads, writes });
      return result;
    } catch (err) {
      if (err instanceof SandboxError && err.code === 'aborted') {
        continue; // read-set conflict — re-run fn with fresh reads
      }
      throw err;
    }
  }

  throw new SandboxError(
    'aborted',
    `Transaction failed after ${TXN_MAX_ATTEMPTS} attempts due to repeated conflicts. ` +
      'Another writer is concurrently updating the same documents.',
  );
}

// ─── The handle ────────────────────────────────────────────────────────────

/** Canonical remediating throw for sync-only sandbox members that cannot
 *  span the wire. Mirrors the slice-1 handle's error style. */
function syncOnlyRemotely(member: string, remedy: string): SandboxError {
  return new SandboxError(
    'unimplemented',
    `SandboxFirestore.${member} is not available on a remote sandbox — its return ` +
      `value is synchronous and the data lives in the browser worker. ${remedy}`,
  );
}

/**
 * Build the channel-backed `SandboxFirestore` for a remote sandbox handle.
 * `lens` is pinned on EVERY op and subscription (see the module header for
 * the identity mapping); path-shape validation matches the local arm so
 * `invalid-argument` failures surface at the call site without a
 * round-trip.
 */
export function createRemoteFirestore(
  sandbox: RemoteSandbox,
  lens: AuthLens,
): SandboxFirestore {
  const arm: RemoteArm = { sandbox, lens };

  return {
    // ── Production-shaped surface ────────────────────────────────────
    collection(path: string): CollectionReference {
      if (!isCollectionPath(path)) {
        throw invalidArgument(`collection path must have an odd number of segments: ${path}`);
      }
      return makeCollectionRef(arm, path);
    },
    doc(path: string): DocumentReference {
      if (!isDocumentPath(path)) {
        throw invalidArgument(`document path must have an even number of segments: ${path}`);
      }
      return makeDocRef(arm, path);
    },
    collectionGroup(collectionId: string): Query {
      if (collectionId.length === 0 || collectionId.includes('/')) {
        throw invalidArgument(
          `collection group id must be a single non-empty segment with no '/': ${collectionId}`,
        );
      }
      return makeQuery(arm, {
        source: { __ref: 'group', collectionId },
        filters: [],
        orders: [],
        limitFromEnd: false,
      });
    },
    batch(): WriteBatch {
      return makeWriteBatch(arm);
    },
    runTransaction<R>(
      fn: (tx: Transaction) => Promise<R> | R,
      _opts?: OperationOptions,
    ): Promise<R> {
      return runRemoteTransaction(arm, fn);
    },

    // ── Sandbox-only surface (sync contracts — remediating throws) ───
    setRules(): never {
      throw syncOnlyRemotely(
        'setRules',
        "Deploy rules asynchronously through the relay instead: `await sandbox.channel.op({ method: 'setFirestoreRules', source })`.",
      );
    },
    seed(): never {
      throw syncOnlyRemotely(
        'seed',
        'The relay has no atomic seed op; write seed docs through this handle ' +
          "(`db.doc(path).set(data)` / `db.batch()`), or drive `sandbox.channel.op({ method: 'admin.setDocument', path, data })` per document.",
      );
    },
    snapshot(): never {
      throw syncOnlyRemotely(
        'snapshot',
        "Read the worker state asynchronously instead: `await sandbox.channel.op({ method: 'admin.readState' })`.",
      );
    },
  };
}
