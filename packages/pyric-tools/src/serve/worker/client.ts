/**
 * Worker client SDK — mirrors `pyric/firestore` for the SharedWorker path.
 *
 * WHY THIS EXISTS
 * ---------------
 * When the SharedWorker is available, app code should be able to swap its
 * `pyric/firestore` import for this module (via an import-map) and have
 * every operation transparently route to the single worker-hosted sandbox
 * instead of running an in-page sandbox. The API surface is identical:
 * same function names, same argument shapes, same return types.
 *
 * DESIGN SPLIT
 * ------------
 * Client-side only (no RPC — build descriptor objects in-page):
 *   `getFirestore`, `doc`, `collection`, `collectionGroup`, `query`,
 *   `where`, `orderBy`, `limit`, `limitToLast`, `startAt`, `startAfter`,
 *   `endAt`, `endBefore`
 *
 *   These return `ClientDb`, `DocRefHandle`, `CollRefHandle`, `QueryHandle`
 *   objects that carry the port + a serializable descriptor. No RPC fires
 *   until an execution function is called.
 *
 *   WHY IN-PAGE: Firebase's `doc()` / `collection()` / `query()` are
 *   synchronous — they build ref objects. Making them async (RPC) would
 *   break every existing app pattern. Since path-building needs no data
 *   from the sandbox, it's correct and cheap to do it in-page.
 *
 * Sentinel factories (client-side markers, worker resolves them):
 *   `serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `deleteField`
 *
 *   Return `SentinelMarker` objects that embed in write data.
 *   The host's `resolveSentinels` converts them before writing.
 *
 * Execution functions (RPC — send op to worker, await reply):
 *   `getDoc`, `getDocs`, `setDoc`, `updateDoc`, `deleteDoc`, `addDoc`,
 *   `onSnapshot`, `getCountFromServer`, `runTransaction`, `writeBatch`
 *
 * TRANSACTION SEMANTICS + MULTI-TAB CORRECTNESS
 * -----------------------------------------------
 * `runTransaction(db, updateFn)` on the client:
 *   1. Runs `updateFn(txn)` locally — `txn.get(ref)` RPCs a getDoc, records
 *      `{ path, data }` in the per-attempt read-set, returns the snapshot.
 *   2. `txn.set/update/delete` buffer writes locally in `txn`.
 *   3. When `updateFn` resolves, sends `{ method:'txnCommit', reads, writes }`.
 *   4. The worker re-reads each read-set doc inside a sandbox transaction,
 *      compares the JSON-serialized current data against the recorded data,
 *      and aborts with `{ code:'aborted' }` on any mismatch.
 *   5. On `aborted`, the client re-runs `updateFn` with a fresh txn object
 *      (up to 5 attempts). All other errors are propagated immediately.
 *
 * WHY RETRY IS NECESSARY (multi-tab gap):
 * A transaction spans two messages: the `txn.get` RPC and `txnCommit`. Another
 * tab can write to a read doc in between (the event loop is free between
 * messages). Without read-set validation that produces a silent lost update.
 * The retry loop mirrors real Firestore SDK behaviour.
 *
 * SNAPSHOT DESERIALIZATION
 * ------------------------
 * The worker sends document data as `{ json: string }` (SerializedDocData).
 * `deserializeDocData` (protocol.ts) parses the JSON and calls
 * `rehydrateDocValue` (from pyric/sandbox) to reconstruct REAL class
 * instances — Timestamp with `.seconds`/`.nanos`, Bytes with `.data`, LatLng
 * with `.lat`/`.lng`. The wire format == the IDB persistence format.
 */

import type {
  DocRef,
  CollRef,
  GroupRef,
  QueryDescriptor,
  QueryConstraintDescriptor,
  FilterConstraintDescriptor,
  AggregateFieldDescriptor,
  AggregateSpecDescriptor,
  TargetDescriptor,
  SentinelMarker,
  WriteDescriptor,
  TxnReadEntry,
  InboundMessage,
  OutboundMessage,
  SerializedDocData,
  SerializedUser,
  SerializedUserCredential,
  SerializedIdTokenResult,
  AuthPersistenceMode,
  ResolvedIdentity,
} from './protocol.js';
import type { PolicyRequest } from './protocol.js';
import {
  deserializeDocData,
  isSentinelMarker,
  bytesToBase64,
  base64ToBytes,
  storagePayloadTooLarge,
  MAX_STORAGE_OP_BYTES,
} from './protocol.js';
// TYPE-ONLY — the generic worker-relay wire payloads (op/sub messages minus
// the port-level ids this module re-mints). Erased at build; `bridge/
// protocol.ts` itself has no runtime imports, so no engine code is pulled in.
import type { WorkerOpPayload, WorkerSubPayload } from '../../bridge/protocol.js';
// TYPE-ONLY — the auth-lens contract + the cross-service event envelope, shared
// with the worker host + the sandbox's event provenance. Erased at build, so the
// leaf client bundle stays engine-free.
import type { AuthLens, SandboxEvent, SandboxSnapshot } from 'pyric/sandbox';
// TYPE-ONLY (erased at build, so the leaf client stays engine-free): the admin
// user-DB record + request shapes for the Pyric Studio data-browse auth ops.
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
// TYPE-ONLY: the object metadata shape for the Pyric Studio storage inspector.
import type { FullMetadata } from 'pyric/storage';

// ─── Rehydration (class instance restoration) ─────────────────────────────

/**
 * Deserialize doc data from wire form to real class instances.
 *
 * `deserializeDocData` (protocol.ts) now calls `rehydrateDocValue` from
 * pyric/sandbox, which reconstructs REAL Timestamp, Bytes, and LatLng
 * instances — not plain-object look-alikes. This means:
 *   - `snap.data().createdAt` is a real `Timestamp` with `.seconds`/`.nanos`
 *   - `snap.data().blob` is a real `Bytes` with `.data` (Uint8Array)
 *   - `snap.data().where` is a real `LatLng` with `.lat`/`.lng`
 * Consumer code that uses `instanceof` checks or method calls will work
 * correctly after deserialization.
 */
function rehydrateDocData(serialized: SerializedDocData): Record<string, unknown> {
  return deserializeDocData(serialized) as Record<string, unknown>;
}

// ─── Handle types ──────────────────────────────────────────────────────────

/** Opaque client-side Firestore handle. Holds the MessagePort to the worker. */
export interface ClientDb {
  readonly __kind: 'client-db';
  readonly port: MessagePort;
}

export interface ClientRtdb {
  readonly __kind: 'client-rtdb';
  readonly port: MessagePort;
}

export interface RtdbRefHandle {
  readonly __kind: 'rtdb-ref';
  readonly port: MessagePort;
  readonly path: string;
  readonly key: string | null;
  readonly parent: RtdbRefHandle | null;
  readonly root: RtdbRefHandle;
  toString(): string;
}

export interface RtdbDataSnapshot {
  readonly key: string | null;
  readonly size: number;
  exists(): boolean;
  val(): unknown;
  child(path: string): RtdbDataSnapshot;
  hasChild(path: string): boolean;
  hasChildren(): boolean;
  exportVal(): unknown;
  toJSON(): unknown;
  forEach(cb: (child: RtdbDataSnapshot) => boolean | void): boolean;
  readonly ref: RtdbRefHandle;
}

/** Client-side document reference — carries a DocRef descriptor + port. */
export interface DocRefHandle {
  readonly __kind: 'doc-ref';
  readonly descriptor: DocRef;
  readonly port: MessagePort;
  readonly id: string;
  readonly path: string;
}

/** Client-side collection reference. */
export interface CollRefHandle {
  readonly __kind: 'coll-ref';
  readonly descriptor: CollRef;
  readonly port: MessagePort;
  readonly id: string;
  readonly path: string;
}

/** Client-side query. */
export interface QueryHandle {
  readonly __kind: 'query';
  readonly descriptor: QueryDescriptor;
  readonly port: MessagePort;
}

/** Union of all client handles. */
export type AnyHandle = ClientDb | DocRefHandle | CollRefHandle | QueryHandle;

function lastSegment(path: string): string {
  return path.split('/').at(-1) ?? path;
}

// ─── Port + correlation machinery ─────────────────────────────────────────

let _opCounter = 0;
let _subCounter = 0;

function nextId(): string { return `op-${++_opCounter}`; }
function nextSubId(): string { return `sub-${++_subCounter}`; }

/**
 * Pending RPC resolvers. Keyed by correlation id.
 * Resolves with the `value` field on success; rejects with a typed error
 * on failure.
 */
const _pending = new Map<string, {
  resolve: (v: unknown) => void;
  reject: (e: Error & { code: string }) => void;
}>();

/**
 * Active snapshot subscribers. Keyed by subId.
 * `next` is the user-supplied callback; `error` is the optional error handler.
 */
const _snapSubs = new Map<string, {
  next: (snap: unknown) => void;
  error?: (err: unknown) => void;
}>();

/**
 * Active event-stream subscribers (Pyric Studio keystone). Keyed by subId.
 * `next` receives each delivered BATCH of `SandboxEvent`s — the first batch is
 * the initial `history()` snapshot, subsequent batches are single live events.
 */
const _eventSubs = new Map<string, (events: readonly SandboxEvent[]) => void>();

/** Wire up the port's onmessage handler (idempotent per-port). */
function wirePort(port: MessagePort): void {
  port.onmessage = (ev: MessageEvent<OutboundMessage>) => {
    const msg = ev.data;
    if (msg.t === 'res') {
      const pending = _pending.get(msg.id);
      if (!pending) return;
      _pending.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.value);
      } else {
        const err = new Error(msg.error.message) as Error & { code: string };
        err.code = msg.error.code;
        pending.reject(err);
      }
    } else if (msg.t === 'snap') {
      const sub = _snapSubs.get(msg.subId);
      if (!sub) return;
      // Auth snaps carry `SerializedUser | null` — a null value is a valid
      // "signed out" payload, not an error, so guard the __error sniff.
      const value = (msg.value ?? {}) as Record<string, unknown>;
      if (value.__error) {
        const errPayload = value.__error as { code: string; message: string };
        const err = new Error(errPayload.message) as Error & { code: string };
        err.code = errPayload.code;
        // Surface an unobserved listener error instead of swallowing it — the
        // worker-path twin of the in-page default (a denied listener after a
        // rules change / sign-out must not fail silently on the page console).
        if (sub.error) sub.error(err);
        else console.error('pyric/firestore: Uncaught Error in snapshot listener:', err);
        return;
      }
      sub.next(msg.value);
    } else if (msg.t === 'event') {
      // Event-stream batch (Pyric Studio keystone). Plain JSON SandboxEvents —
      // no rehydration. Deliver the whole batch to the registered subscriber.
      const cb = _eventSubs.get(msg.subId);
      if (cb) cb(msg.events);
    }
  };
}

// ─── Auth lens (Pyric Studio) ──────────────────────────────────────────────
//
// The default per-op auth lens carried on every FIRESTORE DATA op this client
// sends. The host resolves a data handle from it (`lensDb` in host.ts):
//   - `{ mode: 'app-session' }` (the default): the served app's own session.
//   - `{ mode: 'as', uid }`: impersonate — rules evaluate as that user.
//   - `{ mode: 'admin' }`: admin lens (rule bypass; see host.ts gap note).
//
// Studio sets this so its data grids / rules-debug "re-run as user" views run
// under the chosen identity without threading `actAs` through every call. AUTH
// ops (`auth.*`) and `getVersion` are NEVER lensed — they operate the worker's
// session, not data — so the lens is stamped only on the data-op path.

/** Module-level default lens. `undefined` ⇒ the worker treats the op as the
 *  app's session (the additive default — existing senders omit `actAs`). */
let _defaultLens: AuthLens | undefined;

/**
 * Set the default auth lens applied to subsequent Firestore DATA ops from this
 * client (Pyric Studio). Pass `{ mode: 'as', uid }` to read/write AS a user
 * (rules apply), `{ mode: 'admin' }` for the admin lens, or
 * `{ mode: 'app-session' }` / `undefined` to revert to the app's own session.
 *
 * The lens is process-wide for this client module (one served page = one
 * worker port), mirroring how Studio drives a single active identity at a time.
 * Auth ops are unaffected — they always operate the real session.
 */
export function setLens(lens: AuthLens | undefined): void {
  _defaultLens = lens && lens.mode === 'app-session' ? undefined : lens;
}

/** The active default lens (read-only view), for Studio UI to reflect state. */
export function getLens(): AuthLens | undefined {
  return _defaultLens;
}

/** Send an op and return a promise for its result. */
function rpc(port: MessagePort, msg: InboundMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const opMsg = msg as { id: string };
    _pending.set(opMsg.id, { resolve, reject: reject as (e: Error & { code: string }) => void });
    port.postMessage(msg);
  });
}

/**
 * Like {@link rpc} but stamps the active default auth lens onto the op message
 * (Pyric Studio). Used by data-service ops so a `setLens(...)` choice
 * carries per op without every call site threading `actAs`. Auth ops + version
 * use the bare {@link rpc} so they never carry a lens.
 *
 * `actAs` is only attached when a lens is active — when none is set the wire
 * message is byte-identical to before, preserving the additive contract.
 */
function dataRpc(port: MessagePort, msg: InboundMessage & { t: 'op' }): Promise<unknown> {
  const withLens = _defaultLens ? { ...msg, actAs: _defaultLens } : msg;
  return rpc(port, withLens);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Connect to the SharedWorker and return a client Firestore handle.
 *
 * Pass the URL of the SharedWorker script as `workerUrl`. Under `pyric dev`
 * this is `/__pyric/sdk/worker.js`; for tests or standalone use, pass the path
 * explicitly.
 *
 * `getFirestore` mirrors `pyric/firestore`'s `getFirestore(sandbox)` shape
 * but returns a `ClientDb` backed by a `MessagePort` instead of a sandbox.
 */
export function getFirestore(workerUrl: string | URL, name?: string): ClientDb {
  if (typeof SharedWorker === 'undefined') {
    throw new Error(
      'SharedWorker is not available. ' +
      'Open this page over http:// (not file://) and use a supported browser ' +
      '(Chrome 4+, Firefox 29+, Safari 16.4+).',
    );
  }
  const worker = new SharedWorker(workerUrl, {
    type: 'classic',
    name: name ?? 'pyric-shared-worker',
  });
  const port = worker.port;
  port.start();
  wirePort(port);
  return { __kind: 'client-db', port };
}

/**
 * Ask the worker for its baked build version (staleness guard). The page
 * compares it to the served bundle version and warns when a still-running OLD
 * worker is older than what's served (a SharedWorker can't hot-update).
 */
export async function getWorkerVersion(db: ClientDb): Promise<string> {
  const r = (await rpc(db.port, { t: 'op', id: nextId(), method: 'getVersion' })) as { version: string };
  return r.version;
}

/**
 * Ask the worker for its stable per-instance id (see host `INSTANCE_ID_KEY`).
 * Studio renders a human-friendly form so a user can tell which sandbox instance
 * they're looking at — the same `localhost:<port>` in a different browser profile
 * is a SEPARATE sandbox (a separate SharedWorker + IndexedDB), and this is how
 * the two are told apart.
 */
export async function getWorkerInstanceId(db: ClientDb): Promise<string> {
  const r = (await rpc(db.port, { t: 'op', id: nextId(), method: 'getVersion' })) as { instanceId?: string };
  return r.instanceId ?? '';
}

/**
 * Phase 2 (transfer): export the FULL sandbox state as a portable bundle string
 * (the chunk format the persist layer uses, so wrapper types round-trip). Save
 * it to a file and {@link importWorkerState} it into another instance.
 */
export async function exportWorkerState(db: ClientDb): Promise<string> {
  const r = (await rpc(db.port, { t: 'op', id: nextId(), method: 'exportState' })) as { bundle: string };
  return r.bundle;
}

/** Phase 2 (clobber): replace this sandbox's ENTIRE state with `bundle`. */
export async function importWorkerState(db: ClientDb, bundle: string): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'importState', bundle });
}

/** Phase 3: save the live sandbox as a named branch (a saved state bundle). */
export async function saveWorkerBranch(db: ClientDb, name: string): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'saveBranch', name });
}

/** Phase 3: list this instance's saved branch names. */
export async function listWorkerBranches(db: ClientDb): Promise<string[]> {
  const r = (await rpc(db.port, { t: 'op', id: nextId(), method: 'listBranches' })) as { branches?: string[] };
  return r.branches ?? [];
}

/** Phase 3 (clobber): switch the live sandbox to a named branch's state. */
export async function switchWorkerBranch(db: ClientDb, name: string): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'switchBranch', name });
}

/** Phase 3: delete a named branch. */
export async function deleteWorkerBranch(db: ClientDb, name: string): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'deleteBranch', name });
}

/**
 * Forward an agent tool-call to the worker so it executes against the SAME
 * sandbox the app + Studio use. The worker runs the canonical tool dispatcher
 * (`buildSandboxDispatcher`) and replies with the `{ ok, summary, data }`
 * result. Used by the bridge peer on the worker path (`connectBridgePeer` in
 * `entries/runtime.ts`) so the agent shares the one authoritative sandbox.
 */
export async function callTool(
  db: ClientDb,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; summary: string; data?: unknown }> {
  return (await rpc(db.port, { t: 'tool', id: nextId(), name, args })) as {
    ok: boolean;
    summary: string;
    data?: unknown;
  };
}

// ─── Generic worker relay (remote sandbox, slice 1) ────────────────────────
//
// The bridge peer forwards `worker-op` / `worker-sub` frames from the Node
// side (`connectRemoteSandbox`) into the SharedWorker through these two
// functions (see `workerRelay` in `bridge/client/bridge.ts` + the wiring in
// `entries/runtime.ts`). Ids are re-minted LOCALLY (`nextId`/`nextSubId`) so
// relayed traffic shares this page's pending/sub maps without any chance of
// colliding with the page's own ids — the bridge correlates by ITS frame id.

/**
 * Relay one raw worker-protocol op into the SharedWorker. `op` is the op
 * message minus `t`/`id` (the `WorkerOpPayload` wire shape); resolves with
 * the worker's `res.value`, rejects with an Error carrying `.code`.
 */
export function relayWorkerOp(db: ClientDb, op: WorkerOpPayload): Promise<unknown> {
  return rpc(db.port, { ...op, t: 'op', id: nextId() } as InboundMessage);
}

/**
 * Relay a raw worker-protocol subscription into the SharedWorker. `sub` is
 * the sub message minus `t`/`subId` (the `WorkerSubPayload` wire shape).
 * `onValue` receives every snap value VERBATIM — including the worker host's
 * `{ __error: { code, message } }` establishment-failure convention (listener
 * errors are re-wrapped into the same shape so the far side sees one form).
 * Returns the unsubscribe function.
 *
 * The unified event stream (`target: 'events'`) is NOT relayable yet — its
 * history batches aren't coalescible, so it needs bounded backpressure first
 * (slice 2).
 */
export function relayWorkerSub(
  db: ClientDb,
  sub: WorkerSubPayload,
  onValue: (value: unknown) => void,
): () => void {
  if (sub.target === 'events') {
    throw new Error(
      'event-stream subscriptions cannot be relayed over the bridge yet (needs bounded backpressure — slice 2)',
    );
  }
  const subId = nextSubId();
  _snapSubs.set(subId, {
    next: onValue,
    error: (err) =>
      onValue({
        __error: {
          code: (err as { code?: string }).code ?? 'unknown',
          message: err instanceof Error ? err.message : String(err),
        },
      }),
  });
  db.port.postMessage({ ...sub, t: 'sub', subId } as InboundMessage);
  return () => {
    _snapSubs.delete(subId);
    db.port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}

// ─── Path factories (client-side only — no RPC) ──────────────────────────

/**
 * Build a document reference. Mirrors `pyric/firestore`'s `doc(db, path)`.
 *
 * WHY CLIENT-SIDE: Firebase's `doc()` is synchronous and path-only — it
 * needs no data from the sandbox. We build a descriptor object here and
 * include the port so execution calls can route to the worker.
 */
export function doc(
  parent: ClientDb | CollRefHandle,
  ...pathSegments: string[]
): DocRefHandle {
  const port = 'port' in parent ? parent.port : (parent as ClientDb).port;
  let path: string;

  if (parent.__kind === 'client-db') {
    if (pathSegments.length === 0) throw new TypeError('doc(db, path) requires a path segment.');
    path = pathSegments.join('/');
  } else {
    // parent is a CollRefHandle
    const collPath = (parent as CollRefHandle).descriptor.path;
    path = pathSegments.length > 0
      ? `${collPath}/${pathSegments.join('/')}`
      : collPath; // caller will get auto-id via addDoc; doc() without id is unusual
  }

  const descriptor: DocRef = { __ref: 'doc', path };
  return {
    __kind: 'doc-ref',
    descriptor,
    port,
    id: lastSegment(path),
    path,
  };
}

/**
 * Build a collection reference. Mirrors `pyric/firestore`'s `collection(db, path)`.
 */
export function collection(
  parent: ClientDb | DocRefHandle,
  ...pathSegments: string[]
): CollRefHandle {
  const port = parent.port;
  if (pathSegments.length === 0) throw new TypeError('collection() requires a path segment.');

  let path: string;
  if (parent.__kind === 'client-db') {
    path = pathSegments.join('/');
  } else {
    const docPath = (parent as DocRefHandle).descriptor.path;
    path = `${docPath}/${pathSegments.join('/')}`;
  }

  const descriptor: CollRef = { __ref: 'collection', path };
  return {
    __kind: 'coll-ref',
    descriptor,
    port,
    id: lastSegment(path),
    path,
  };
}

/**
 * Build a collection-group query. Mirrors `pyric/firestore`'s `collectionGroup(db, id)`.
 */
export function collectionGroup(db: ClientDb, collectionId: string): QueryHandle {
  const descriptor: QueryDescriptor = {
    __ref: 'query',
    source: { __ref: 'group', collectionId },
    constraints: [],
  };
  return { __kind: 'query', descriptor, port: db.port };
}

// ─── Query constraint factories (client-side) ─────────────────────────────

/** Opaque query constraint — carries its descriptor for embedding in queries. */
export interface QueryConstraintHandle {
  readonly _descriptor: QueryConstraintDescriptor;
}

export function where(field: string, op: string, value: unknown): QueryConstraintHandle {
  return { _descriptor: { kind: 'where', field, op, value } };
}

/**
 * Extract a constraint's FILTER descriptor for composite embedding — throws
 * the same TypeError `pyric/firestore`'s `and()`/`or()` raise when handed a
 * non-filter (`orderBy` / `limit` / cursors are not valid inside composites).
 */
function toFilterDescriptor(
  kind: 'and' | 'or',
  c: QueryConstraintHandle,
): FilterConstraintDescriptor {
  const d = c._descriptor;
  if (d.kind !== 'where' && d.kind !== 'and' && d.kind !== 'or') {
    throw new TypeError(
      `pyric worker client: ${kind}() received a non-filter constraint (orderBy / limit are not valid here).`,
    );
  }
  return d;
}

function composite(kind: 'and' | 'or', filters: QueryConstraintHandle[]): QueryConstraintHandle {
  if (filters.length === 0) {
    throw new TypeError(`pyric worker client: ${kind}() requires at least one filter argument.`);
  }
  return { _descriptor: { kind, filters: filters.map((f) => toFilterDescriptor(kind, f)) } };
}

/**
 * OR composite filter — at least one operand must match. Operands must be
 * filters (`where()`, or nested `or()`/`and()`). Mirrors `pyric/firestore`'s
 * `or(...)`; the worker rebuilds it with the real modular factory.
 */
export function or(...filters: QueryConstraintHandle[]): QueryConstraintHandle {
  return composite('or', filters);
}

/** AND composite filter — every operand must match. See {@link or}. */
export function and(...filters: QueryConstraintHandle[]): QueryConstraintHandle {
  return composite('and', filters);
}

export function orderBy(field: string, direction?: 'asc' | 'desc'): QueryConstraintHandle {
  return { _descriptor: { kind: 'orderBy', field, direction } };
}

export function limit(n: number): QueryConstraintHandle {
  return { _descriptor: { kind: 'limit', n } };
}

export function limitToLast(n: number): QueryConstraintHandle {
  return { _descriptor: { kind: 'limitToLast', n } };
}

export function startAt(...values: unknown[]): QueryConstraintHandle {
  return { _descriptor: { kind: 'startAt', values } };
}

export function startAfter(...values: unknown[]): QueryConstraintHandle {
  return { _descriptor: { kind: 'startAfter', values } };
}

export function endAt(...values: unknown[]): QueryConstraintHandle {
  return { _descriptor: { kind: 'endAt', values } };
}

export function endBefore(...values: unknown[]): QueryConstraintHandle {
  return { _descriptor: { kind: 'endBefore', values } };
}

/**
 * Apply query constraints to a source ref or query.
 * Mirrors `pyric/firestore`'s `query(source, ...constraints)`.
 */
export function query(
  source: CollRefHandle | QueryHandle,
  ...constraints: QueryConstraintHandle[]
): QueryHandle {
  const sourceDescriptor: TargetDescriptor =
    source.__kind === 'coll-ref'
      ? (source as CollRefHandle).descriptor
      : (source as QueryHandle).descriptor;

  const existingConstraints: readonly QueryConstraintDescriptor[] =
    source.__kind === 'query'
      ? (source as QueryHandle).descriptor.constraints
      : [];

  const descriptor: QueryDescriptor = {
    __ref: 'query',
    source: sourceDescriptor.__ref === 'query'
      ? (sourceDescriptor as QueryDescriptor).source
      : (sourceDescriptor as DocRef | CollRef | GroupRef),
    constraints: [
      ...existingConstraints,
      ...constraints.map((c) => c._descriptor),
    ],
  };
  return { __kind: 'query', descriptor, port: source.port };
}

// ─── Sentinel factories (client-side markers) ────────────────────────────

export function serverTimestamp(): SentinelMarker {
  return { __sentinel: 'serverTimestamp' };
}

export function increment(n: number): SentinelMarker {
  return { __sentinel: 'increment', n };
}

export function arrayUnion(...values: unknown[]): SentinelMarker {
  return { __sentinel: 'arrayUnion', values };
}

export function arrayRemove(...values: unknown[]): SentinelMarker {
  return { __sentinel: 'arrayRemove', values };
}

export function deleteField(): SentinelMarker {
  return { __sentinel: 'deleteField' };
}

// ─── Snapshot deserialization helpers ────────────────────────────────────

interface RawDocResult {
  id: string;
  path?: string;
  exists: boolean;
  data?: SerializedDocData;
}

function makeDocSnapshot(raw: RawDocResult): ClientDocSnapshot {
  const data = raw.exists && raw.data ? rehydrateDocData(raw.data) : undefined;
  const path = raw.path ?? raw.id;
  return {
    id: raw.id,
    path,
    // The modular SDK contract (and `@pyric/ui`'s grids) read `snap.ref.path`
    // off query docs; mirror it so the worker snapshot is a drop-in. A
    // lightweight ref (id + path) is all consumers read; a full handle is
    // rebuilt from the path when an op is needed.
    ref: { id: raw.id, path },
    exists: () => raw.exists,
    data: () => data,
  };
}

interface RawQueryResult {
  docs: RawDocResult[];
}

function makeQuerySnapshot(raw: RawQueryResult): ClientQuerySnapshot {
  const docs = raw.docs.map(makeDocSnapshot);
  return {
    size: docs.length,
    empty: docs.length === 0,
    docs,
  };
}

// ─── Client snapshot types ────────────────────────────────────────────────

export interface ClientDocSnapshot {
  readonly id: string;
  readonly path: string;
  /** Lightweight document ref (id + path), mirroring the modular SDK's
   *  `snap.ref` that `@pyric/ui` reads off query docs. */
  readonly ref: { readonly id: string; readonly path: string };
  exists(): boolean;
  data(): Record<string, unknown> | undefined;
}

export interface ClientQuerySnapshot {
  readonly size: number;
  readonly empty: boolean;
  readonly docs: ClientDocSnapshot[];
}

// ─── Execution functions (RPC) ────────────────────────────────────────────

export async function getDoc(ref: DocRefHandle): Promise<ClientDocSnapshot> {
  const result = await dataRpc(ref.port, {
    t: 'op',
    id: nextId(),
    method: 'getDoc',
    path: ref.descriptor.path,
  }) as RawDocResult;
  return makeDocSnapshot(result);
}

export async function getDocs(
  source: CollRefHandle | QueryHandle,
): Promise<ClientQuerySnapshot> {
  const result = await dataRpc(source.port, {
    t: 'op',
    id: nextId(),
    method: 'getDocs',
    source: source.__kind === 'coll-ref'
      ? (source as CollRefHandle).descriptor
      : (source as QueryHandle).descriptor,
  }) as RawQueryResult;
  return makeQuerySnapshot(result);
}

/**
 * Enumerate root collection ids (Pyric Studio data browse). The modular SDK has
 * no client `listCollections`, so the host scans the sandbox keyspace and
 * returns the ids. Lens is attached (via dataRpc) but the host enumeration is
 * lens-independent.
 */
export async function listRootCollections(db: ClientDb): Promise<string[]> {
  const r = (await dataRpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'listRootCollections',
  })) as { ids: string[] };
  return r.ids;
}

/** Enumerate subcollection ids under a document path (Pyric Studio data browse). */
export async function listSubcollections(db: ClientDb, docPath: string): Promise<string[]> {
  const r = (await dataRpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'listSubcollections',
    docPath,
  })) as { ids: string[] };
  return r.ids;
}

export async function setDoc(
  ref: DocRefHandle,
  data: Record<string, unknown>,
  options?: { merge?: boolean; mergeFields?: string[] },
): Promise<void> {
  await dataRpc(ref.port, {
    t: 'op',
    id: nextId(),
    method: 'setDoc',
    path: ref.descriptor.path,
    data,
    options,
  });
}

export async function updateDoc(
  ref: DocRefHandle,
  data: Record<string, unknown>,
): Promise<void> {
  await dataRpc(ref.port, {
    t: 'op',
    id: nextId(),
    method: 'updateDoc',
    path: ref.descriptor.path,
    data,
  });
}

export async function deleteDoc(ref: DocRefHandle): Promise<void> {
  await dataRpc(ref.port, {
    t: 'op',
    id: nextId(),
    method: 'deleteDoc',
    path: ref.descriptor.path,
  });
}

export async function addDoc(
  coll: CollRefHandle,
  data: Record<string, unknown>,
): Promise<DocRefHandle> {
  const result = await dataRpc(coll.port, {
    t: 'op',
    id: nextId(),
    method: 'addDoc',
    collectionPath: coll.descriptor.path,
    data,
  }) as { id: string; path: string };

  return {
    __kind: 'doc-ref',
    descriptor: { __ref: 'doc', path: result.path },
    port: coll.port,
    id: result.id,
    path: result.path,
  };
}

export async function getCountFromServer(
  source: CollRefHandle | QueryHandle,
): Promise<{ data(): { count: number } }> {
  const result = await dataRpc(source.port, {
    t: 'op',
    id: nextId(),
    method: 'count',
    source: source.__kind === 'coll-ref'
      ? (source as CollRefHandle).descriptor
      : (source as QueryHandle).descriptor,
  }) as { count: number };
  return { data: () => ({ count: result.count }) };
}

// ─── Multi-field aggregates (count / sum / average) ───────────────────────

/** Factory: count() aggregate field. Mirrors `pyric/firestore`'s `count()`. */
export function count(): AggregateFieldDescriptor {
  return { kind: 'count' };
}

/** Factory: sum-of-`field` aggregate. Mirrors `pyric/firestore`'s `sum()`. */
export function sum(field: string): AggregateFieldDescriptor {
  return { kind: 'sum', field };
}

/** Factory: average-of-`field` aggregate. Empty input yields `null`. */
export function average(field: string): AggregateFieldDescriptor {
  return { kind: 'average', field };
}

/**
 * Run a multi-field aggregate on the worker. Mirrors `pyric/firestore`'s
 * `getAggregateFromServer(query, spec)`: spec entries are keyed by
 * caller-chosen aliases; `.data()` returns the numbers under the same keys
 * (`average` over no rows is `null`).
 */
export async function getAggregateFromServer<S extends AggregateSpecDescriptor>(
  source: CollRefHandle | QueryHandle,
  spec: S,
): Promise<{ data(): { [K in keyof S]: number | null } }> {
  const result = await dataRpc(source.port, {
    t: 'op',
    id: nextId(),
    method: 'aggregate',
    source: source.__kind === 'coll-ref'
      ? (source as CollRefHandle).descriptor
      : (source as QueryHandle).descriptor,
    spec,
  }) as { data: { [K in keyof S]: number | null } };
  return { data: () => result.data };
}

// ─── onSnapshot ──────────────────────────────────────────────────────────

export type Unsubscribe = () => void;

/**
 * Subscribe to a document or query. Mirrors `pyric/firestore`'s `onSnapshot`.
 *
 * Returns an `unsub` function. Sends `{ t:'unsub', subId }` to the worker
 * to deregister the listener on the worker side.
 */
export function onSnapshot(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  callback: (snap: ClientDocSnapshot | ClientQuerySnapshot) => void,
  errorCallback?: (err: unknown) => void,
): Unsubscribe {
  const subId = nextSubId();
  const port = target.port;

  _snapSubs.set(subId, {
    next: (raw) => {
      const r = raw as Record<string, unknown>;
      if ('docs' in r) {
        callback(makeQuerySnapshot(r as unknown as RawQueryResult));
      } else {
        callback(makeDocSnapshot(r as unknown as RawDocResult));
      }
    },
    error: errorCallback,
  });

  const descriptor: TargetDescriptor =
    target.__kind === 'doc-ref'
      ? (target as DocRefHandle).descriptor
      : target.__kind === 'coll-ref'
        ? (target as CollRefHandle).descriptor
        : (target as QueryHandle).descriptor;

  // Stamp the active default lens onto the sub (Pyric Studio "watch as user")
  // exactly as `dataRpc` does for ops, so a `setLens({mode:'as',uid})` choice
  // makes listeners impersonate too. Omitted when no lens is set → byte-identical
  // wire message, preserving the additive contract.
  port.postMessage(
    (_defaultLens
      ? { t: 'sub', subId, target: descriptor, actAs: _defaultLens }
      : { t: 'sub', subId, target: descriptor }) satisfies InboundMessage,
  );

  return () => {
    _snapSubs.delete(subId);
    port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}

// ─── writeBatch ──────────────────────────────────────────────────────────

/**
 * Client-side write batch. Buffers `set`/`update`/`delete` calls and
 * sends them all to the worker on `.commit()`.
 *
 * Mirrors `pyric/firestore`'s `writeBatch(db)` shape:
 *   const batch = writeBatch(db);
 *   batch.set(ref, { ... });
 *   batch.delete(ref2);
 *   await batch.commit();
 */
export interface ClientWriteBatch {
  set(ref: DocRefHandle, data: Record<string, unknown>, options?: { merge?: boolean; mergeFields?: string[] }): ClientWriteBatch;
  update(ref: DocRefHandle, data: Record<string, unknown>): ClientWriteBatch;
  delete(ref: DocRefHandle): ClientWriteBatch;
  commit(): Promise<void>;
}

export function writeBatch(db: ClientDb): ClientWriteBatch {
  const writes: WriteDescriptor[] = [];
  const port = db.port;

  const batch: ClientWriteBatch = {
    set(ref, data, options) {
      writes.push({ method: 'set', path: ref.descriptor.path, data, options });
      return batch;
    },
    update(ref, data) {
      writes.push({ method: 'update', path: ref.descriptor.path, data });
      return batch;
    },
    delete(ref) {
      writes.push({ method: 'delete', path: ref.descriptor.path });
      return batch;
    },
    async commit() {
      await dataRpc(port, {
        t: 'op',
        id: nextId(),
        method: 'batchCommit',
        writes: [...writes],
      });
    },
  };
  return batch;
}

// ─── runTransaction ──────────────────────────────────────────────────────

/** Client-side transaction handle. */
export interface ClientTransaction {
  get(ref: DocRefHandle): Promise<ClientDocSnapshot>;
  set(ref: DocRefHandle, data: Record<string, unknown>, options?: { merge?: boolean; mergeFields?: string[] }): void;
  update(ref: DocRefHandle, data: Record<string, unknown>): void;
  delete(ref: DocRefHandle): void;
}

/**
 * Maximum number of times the client will retry `updateFn` on a
 * worker-reported conflict (`aborted`). Matches Firestore SDK default.
 */
const TXN_MAX_ATTEMPTS = 5;

/**
 * Run a transaction. Mirrors `pyric/firestore`'s `runTransaction(db, fn)`.
 *
 * MULTI-TAB CORRECTNESS — READ-SET VALIDATION + RETRY
 * ----------------------------------------------------
 * A transaction spans two messages: the `txn.get` RPC (read) and the
 * `txnCommit` RPC (commit). Between those two messages another tab may
 * write to a doc the current tab read — a silent lost update without
 * validation. We fix this the standard way:
 *
 *   1. Each `txn.get(ref)` records `{ path, data }` in a per-attempt
 *      read-set (`data` is the raw `SerializedDocData` the worker
 *      returned, or `null` if the doc was missing).
 *   2. `txnCommit` carries both `reads` (the read-set) and `writes`.
 *   3. The worker re-reads each doc inside a sandbox transaction, re-
 *      serializes it the same way, and compares the JSON strings.
 *      Any mismatch → `{ ok: false, error: { code: 'aborted' } }`.
 *   4. On `aborted`, the client discards the result of `updateFn` and
 *      re-runs it with a fresh transaction object (fresh reads, empty
 *      write buffer). Up to `TXN_MAX_ATTEMPTS` attempts are made.
 *   5. After the cap, throws an error with `.code === 'aborted'`.
 *
 * This matches real Firestore's behaviour: the SDK retries `updateFn`
 * on conflict rather than surfacing the error immediately.
 */
export async function runTransaction<R>(
  db: ClientDb,
  updateFn: (txn: ClientTransaction) => Promise<R> | R,
): Promise<R> {
  const port = db.port;

  for (let attempt = 0; attempt < TXN_MAX_ATTEMPTS; attempt++) {
    // Fresh read-set and write buffer for each attempt.
    const reads: TxnReadEntry[] = [];
    const writes: WriteDescriptor[] = [];

    const txn: ClientTransaction = {
      async get(ref) {
        // RPC to the worker — capture the raw result before rehydration.
        const rawResult = await dataRpc(ref.port, {
          t: 'op',
          id: nextId(),
          method: 'getDoc',
          path: ref.descriptor.path,
        }) as RawDocResult;

        // Record the raw serialized data (or null) in the read-set.
        // We preserve the wire-form SerializedDocData so the worker can
        // re-serialize the current doc and compare JSON strings.
        reads.push({
          path: ref.descriptor.path,
          data: (rawResult.exists && rawResult.data) ? rawResult.data : null,
        });

        return makeDocSnapshot(rawResult);
      },
      set(ref, data, options) {
        writes.push({ method: 'set', path: ref.descriptor.path, data, options });
      },
      update(ref, data) {
        writes.push({ method: 'update', path: ref.descriptor.path, data });
      },
      delete(ref) {
        writes.push({ method: 'delete', path: ref.descriptor.path });
      },
    };

    const result = await updateFn(txn);

    // Send read-set + writes to the worker for validation and commit.
    try {
      await dataRpc(port, {
        t: 'op',
        id: nextId(),
        method: 'txnCommit',
        reads: [...reads],
        writes: [...writes],
      });
      return result;
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'aborted') {
        // Conflict detected — retry updateFn on the next attempt.
        continue;
      }
      // Permission-denied, not-found, etc. — propagate immediately.
      throw err;
    }
  }

  // Exceeded max attempts.
  const abortErr = new Error(
    `Transaction failed after ${TXN_MAX_ATTEMPTS} attempts due to repeated conflicts. ` +
    'Another tab is concurrently writing to the same documents.',
  ) as Error & { code: string };
  abortErr.code = 'aborted';
  throw abortErr;
}

// ─── setRules ────────────────────────────────────────────────────────────

/**
 * Deploy new rules to the worker's sandbox. Active onSnapshot listeners
 * that were allowed by the old rules may start receiving error callbacks
 * if the new rules deny them.
 */
export async function setRules(db: ClientDb, source: string): Promise<{ warnings: unknown[] }> {
  const result = await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'setRules',
    source,
  });
  return result as { warnings: unknown[] };
}

export async function setFirestoreRules(
  db: ClientDb,
  source: string,
): Promise<{ ok: boolean; warnings: unknown[]; messages: unknown[] }> {
  const result = await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'setFirestoreRules',
    source,
  });
  return result as { ok: boolean; warnings: unknown[]; messages: unknown[] };
}

export async function setDatabaseRules(
  db: ClientDb | ClientRtdb,
  source: unknown,
): Promise<{ ok: boolean; messages: unknown[] }> {
  const result = await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'setDatabaseRules',
    source,
  });
  return result as { ok: boolean; messages: unknown[] };
}

export async function getActiveRules(
  db: ClientDb | ClientRtdb,
  service?: 'firestore' | 'database',
): Promise<unknown> {
  return rpc(db.port, { t: 'op', id: nextId(), method: 'getActiveRules', service });
}

export async function getRulesStatus(
  db: ClientDb | ClientRtdb,
  service?: 'firestore' | 'database',
): Promise<unknown> {
  return rpc(db.port, { t: 'op', id: nextId(), method: 'getRulesStatus', service });
}

export async function adminGetDocument(db: ClientDb, path: string): Promise<Record<string, unknown> | null> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'admin.getDocument', path })) as Record<string, unknown> | null;
}

export async function adminListDocuments(
  db: ClientDb,
  path: string,
): Promise<Array<{ path: string; data: unknown; phantom?: boolean }>> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'admin.listDocuments', path })) as Array<{ path: string; data: unknown; phantom?: boolean }>;
}

export async function adminSetDocument(db: ClientDb, path: string, data: unknown): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'admin.setDocument', path, data });
}

export async function adminDeleteDocument(db: ClientDb, path: string): Promise<boolean> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'admin.deleteDocument', path })) as boolean;
}

export async function adminReadState(
  db: ClientDb,
  opts: { path?: string; maxDepth?: number } = {},
): Promise<Record<string, unknown>> {
  return (await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'admin.readState',
    ...opts,
  })) as Record<string, unknown>;
}

// ─── RTDB shared-worker modular subset ────────────────────────────────────

export function rtdbGetDatabase(source?: ClientDb | string | URL, name?: string): ClientRtdb {
  if (source && typeof source === 'object' && 'port' in source) {
    return { __kind: 'client-rtdb', port: source.port as MessagePort };
  }
  const firestore = getFirestore(source ?? '/__pyric/sdk/worker.js', name);
  return { __kind: 'client-rtdb', port: firestore.port };
}

function normalizeRtdbPath(path?: string): string {
  const joined = (path ?? '/').split('/').filter(Boolean).join('/');
  return joined ? `/${joined}` : '/';
}

function rtdbKey(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? null;
}

const RTDB_PUSH_CHARS =
  '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastRtdbPushTime = 0;
const lastRtdbRandChars: number[] = new Array(12).fill(0);

function generateRtdbPushId(now: number = Date.now()): string {
  const duplicateTime = now === lastRtdbPushTime;
  lastRtdbPushTime = now;

  const timeStampChars: string[] = new Array(8);
  let ts = now;
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = RTDB_PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  if (ts !== 0) throw new Error('RTDB push-id: timestamp overflow.');

  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) lastRtdbRandChars[i] = Math.floor(Math.random() * 64);
  } else {
    let i: number;
    for (i = 11; i >= 0 && lastRtdbRandChars[i] === 63; i--) lastRtdbRandChars[i] = 0;
    if (i < 0) {
      for (let j = 0; j < 12; j++) lastRtdbRandChars[j] = Math.floor(Math.random() * 64);
    } else {
      lastRtdbRandChars[i] = (lastRtdbRandChars[i] ?? 0) + 1;
    }
  }

  let id = timeStampChars.join('');
  for (let i = 0; i < 12; i++) id += RTDB_PUSH_CHARS.charAt(lastRtdbRandChars[i]!);
  return id;
}

function makeRtdbRef(port: MessagePort, path: string): RtdbRefHandle {
  const normalized = normalizeRtdbPath(path);
  const parts = normalized.split('/').filter(Boolean);
  const parentPath = parts.length > 0 ? `/${parts.slice(0, -1).join('/')}` : '/';
  const self: RtdbRefHandle = {
    __kind: 'rtdb-ref',
    port,
    path: normalized,
    key: rtdbKey(normalized),
    get parent() {
      return normalized === '/' ? null : makeRtdbRef(port, parentPath);
    },
    get root() {
      return makeRtdbRef(port, '/');
    },
    toString() {
      return `worker://rtdb${normalized}`;
    },
  };
  return self;
}

export function rtdbRef(db: ClientRtdb, path?: string): RtdbRefHandle {
  return makeRtdbRef(db.port, path ?? '/');
}

export function rtdbChild(parent: RtdbRefHandle, path: string): RtdbRefHandle {
  return makeRtdbRef(parent.port, `${parent.path}/${path}`);
}

function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split('/').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

function makeRtdbSnapshot(refHandle: RtdbRefHandle, value: unknown, exists?: boolean): RtdbDataSnapshot {
  const childValue = (path: string) => valueAt(value, path);
  const size =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).length
      : 0;
  const snapshot: RtdbDataSnapshot = {
    key: refHandle.key,
    size,
    exists: () => exists ?? (value !== null && value !== undefined),
    val: () => value ?? null,
    child: (path) => makeRtdbSnapshot(rtdbChild(refHandle, path), childValue(path)),
    hasChild: (path) => childValue(path) !== null && childValue(path) !== undefined,
    hasChildren: () => size > 0,
    exportVal: () => value ?? null,
    toJSON: () => value ?? null,
    forEach: (cb) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      for (const [key, childVal] of Object.entries(value as Record<string, unknown>)) {
        if (cb(makeRtdbSnapshot(rtdbChild(refHandle, key), childVal)) === true) return true;
      }
      return false;
    },
    ref: refHandle,
  };
  return snapshot;
}

function hydrateRtdbSnapshot(refHandle: RtdbRefHandle, wire: unknown): RtdbDataSnapshot {
  const payload = wire as { value?: unknown; exists?: boolean; key?: string | null };
  return makeRtdbSnapshot(refHandle, payload.value ?? null, payload.exists);
}

export async function rtdbGet(r: RtdbRefHandle): Promise<RtdbDataSnapshot> {
  return hydrateRtdbSnapshot(
    r,
    await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.get', path: r.path }),
  );
}

export async function adminReadRtdbState(db: ClientDb | ClientRtdb): Promise<unknown> {
  return rpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.adminSnapshot' });
}

export async function adminSetRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  value: unknown,
): Promise<void> {
  await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'rtdb.set',
    path,
    value,
    actAs: { mode: 'admin' },
  });
}

export async function adminUpdateRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  values: Record<string, unknown>,
): Promise<void> {
  await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'rtdb.update',
    path,
    values,
    actAs: { mode: 'admin' },
  });
}

export async function adminDeleteRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
): Promise<void> {
  await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'rtdb.remove',
    path,
    actAs: { mode: 'admin' },
  });
}

export async function rtdbSet(r: RtdbRefHandle, value: unknown): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.set', path: r.path, value });
}

export async function rtdbUpdate(r: RtdbRefHandle, values: Record<string, unknown>): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.update', path: r.path, values });
}

export async function rtdbRemove(r: RtdbRefHandle): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.remove', path: r.path });
}

export function rtdbPush(r: RtdbRefHandle, value?: unknown): RtdbRefHandle & PromiseLike<RtdbRefHandle> {
  const key = generateRtdbPushId();
  const pushed = makeRtdbRef(r.port, `${r.path}/${key}`);
  const settledRef = makeRtdbRef(r.port, pushed.path);
  const promise = dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.push', path: r.path, key, value })
    .then(() => settledRef);
  return Object.assign(pushed, {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  });
}

export function rtdbOnValue(
  r: RtdbRefHandle,
  next: (snap: RtdbDataSnapshot) => void,
  error?: (err: unknown) => void,
): Unsubscribe {
  const subId = nextSubId();
  _snapSubs.set(subId, {
    next: (wire) => next(hydrateRtdbSnapshot(r, wire)),
    error,
  });
  const msg: InboundMessage = _defaultLens
    ? { t: 'sub', subId, target: { service: 'rtdb', path: r.path }, actAs: _defaultLens }
    : { t: 'sub', subId, target: { service: 'rtdb', path: r.path } };
  r.port.postMessage(msg);
  return () => {
    _snapSubs.delete(subId);
    r.port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}

export function rtdbOff(_r: RtdbRefHandle, _eventType?: unknown, _callback?: unknown): void {
  // Firebase's `off` is callback-specific. The worker bridge exposes unsubscribe
  // functions from `onValue`; this no-op preserves common app code that calls it
  // defensively during cleanup.
}

export function rtdbServerTimestamp(): { readonly __rtdbSentinel: 'serverTimestamp' } {
  return { __rtdbSentinel: 'serverTimestamp' };
}

export function rtdbConnectDatabaseEmulator(): void {
  // Shared worker sandbox is already local.
}

// ════════════════════════════════════════════════════════════════════════
//  EVENT STREAM (Pyric Studio keystone — onEvent/history over the port)
// ════════════════════════════════════════════════════════════════════════
//
// Surfaces the worker sandbox's unified cross-service event stream to the page.
// `subscribeEvents(db, cb)` registers a stream sub: the worker first delivers
// `sandbox.history()` as one batch, then streams each live `SandboxEvent` as a
// single-element batch. `eventHistory(db)` is a one-shot history fetch (a fresh
// short-lived sub) for consumers that want a snapshot without staying live.
//
// These mirror `sandbox.onEvent(cb)` / `sandbox.history()` so a consumer can
// adapt them into the same `{ onEvent, history }`-shaped source the in-process
// sandbox exposes (e.g. Studio's `feedFromSandboxLike`).

/**
 * Subscribe to the worker sandbox's unified event stream. The callback fires
 * with each delivered BATCH of events — the FIRST call carries the initial
 * `history()` snapshot (possibly empty), each subsequent call carries one live
 * event. Returns an unsubscribe that deregisters on the worker.
 *
 * This is the live counterpart to `sandbox.onEvent` + an initial `history()`
 * fold, collapsed into one subscription so a late subscriber never misses the
 * backlog.
 */
export function subscribeEvents(
  db: ClientDb,
  callback: (events: readonly SandboxEvent[]) => void,
): Unsubscribe {
  const subId = nextSubId();
  const port = db.port;
  _eventSubs.set(subId, callback);
  port.postMessage({ t: 'sub', subId, target: 'events' } satisfies InboundMessage);
  return () => {
    _eventSubs.delete(subId);
    port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}

/**
 * Fetch the worker sandbox's event history as a one-shot snapshot (every event
 * so far). Opens a transient stream sub, resolves with the initial history
 * batch, and tears the sub down immediately — so it never holds a live
 * subscription. Useful for a late, snapshot-only consumer.
 */
export function eventHistory(db: ClientDb): Promise<readonly SandboxEvent[]> {
  return new Promise((resolve) => {
    const unsub = subscribeEvents(db, (events) => {
      // The first delivery is the history snapshot; resolve + unsubscribe.
      unsub();
      resolve(events);
    });
  });
}

// ════════════════════════════════════════════════════════════════════════
//  RUNTIME CONFIRM-POLICY (Pyric Studio F3 — permission dial)
// ════════════════════════════════════════════════════════════════════════
//
// The permission dial pushes a `PolicyRequest` describing the governance the
// served sandbox/agent runtime should honour. `setPolicy` stores it on the
// worker (the worker-side store); `getPolicy` reads the active one back (null
// until the dial set one), so a freshly-connecting Studio tab hydrates the dial.
//
// HONEST LIMITATION (re-stated where the seam is used): this updates the
// WORKER-SIDE store, NOT a running bridge process's confirm handler (built once
// at bridge startup, in a separate node process). Pushing live to a running
// bridge needs a separate transport. See `PolicyRequest` in protocol.ts.

/** Push the active runtime confirm-policy to the worker (Pyric Studio F3). */
export async function setPolicy(db: ClientDb, policy: PolicyRequest): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'setPolicy', policy });
}

/** Read the active runtime confirm-policy back (null until the dial set one). */
export async function getPolicy(db: ClientDb): Promise<PolicyRequest | null> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'getPolicy' })) as
    | PolicyRequest
    | null;
}

/**
 * Export the current sandbox snapshot (Pyric Studio rules re-run). Studio forks
 * it locally to test a denied op against edited rules or re-issue it as the
 * attempting user, on a throwaway branch (no live mutation).
 */
export async function getSnapshot(db: ClientDb): Promise<SandboxSnapshot> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'getSnapshot' })) as SandboxSnapshot;
}

// ════════════════════════════════════════════════════════════════════════
//  AUTH SURFACE (mirrors `pyric/auth` / `firebase/auth`)
// ════════════════════════════════════════════════════════════════════════
//
// PER-PORT SESSIONS (#754)
// ------------------------
// The worker hosts ONE sandbox (one user pool, one data store, one ruleset)
// but each port (tab / client) owns its OWN session: sign-ins bind to THIS
// port, `onAuthStateChanged` fires for THIS port's transitions only, and
// data ops from this port evaluate rules under its session. Two tabs can be
// two different users on the same live backend — the multi-user testing
// surface a single-identity sandbox can't provide. Session persistence
// across reloads is client-side (SessionStore + `restorePortSession`).
//
// CLIENT-SIDE currentUser MIRROR
// ------------------------------
// The worker holds the one real `User`. The client keeps a local
// `ClientUser` mirror updated from the authState stream, so `auth.currentUser`
// is synchronously readable (matching firebase/auth). Token accessors RPC to
// the worker (the worker owns token minting).

/**
 * Client-side User — a snapshot of the worker's `User` with token accessors
 * that RPC back to the worker. Mirrors `firebase/auth`'s `User` shape.
 */
export interface ClientUser {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly isAnonymous: boolean;
  readonly providerId: string | null;
  readonly providerData: SerializedUser['providerData'];
  getIdToken(forceRefresh?: boolean): Promise<string>;
  getIdTokenResult(forceRefresh?: boolean): Promise<SerializedIdTokenResult>;
}

/** Client-side UserCredential — mirrors `firebase/auth`. */
export interface ClientUserCredential {
  user: ClientUser;
  providerId: string | null;
  operationType: 'signIn' | 'reauthenticate' | 'link';
}

/**
 * Client-side Auth handle. Holds the port + a local `currentUser` mirror.
 * Returned by `getAuth(db | workerUrl)`. Mirrors `firebase/auth`'s `Auth`.
 */
export interface ClientAuth {
  readonly __kind: 'client-auth';
  readonly port: MessagePort;
  /** Local mirror of the worker's currentUser, updated from the stream. */
  currentUser: ClientUser | null;
}

/** Hidden per-`ClientUser` port handle so the top-level `updateProfile(user, …)`
 *  free function can RPC without an `auth` handle in scope (mirrors
 *  `firebase/auth`'s user-only signature). Non-enumerable — never serialized. */
const CLIENT_USER_PORT: unique symbol = Symbol('pyric.clientUser.port');

/** Build a token-capable ClientUser from a wire SerializedUser. */
function makeClientUser(port: MessagePort, raw: SerializedUser): ClientUser {
  const user: ClientUser = {
    uid: raw.uid,
    email: raw.email,
    emailVerified: raw.emailVerified,
    displayName: raw.displayName,
    photoURL: raw.photoURL,
    phoneNumber: raw.phoneNumber,
    isAnonymous: raw.isAnonymous,
    providerId: raw.providerId,
    providerData: raw.providerData,
    async getIdToken(forceRefresh?: boolean) {
      return (await rpc(port, {
        t: 'op', id: nextId(), method: 'auth.getIdToken', forceRefresh,
      })) as string;
    },
    async getIdTokenResult(forceRefresh?: boolean) {
      return (await rpc(port, {
        t: 'op', id: nextId(), method: 'auth.getIdTokenResult', forceRefresh,
      })) as SerializedIdTokenResult;
    },
  };
  Object.defineProperty(user, CLIENT_USER_PORT, { value: port, enumerable: false });
  return user;
}

/** Convert a wire SerializedUser|null to a ClientUser|null. */
function toClientUser(port: MessagePort, raw: SerializedUser | null): ClientUser | null {
  return raw ? makeClientUser(port, raw) : null;
}

/**
 * Get the worker-backed Auth handle.
 *
 * Mirrors `pyric/auth`'s `getAuth(sandbox)` / `firebase/auth`'s
 * `getAuth(app)` — but the input is either an existing `ClientDb` (reusing
 * its port, the common case in serve where Firestore + auth share one
 * worker) or a worker URL (standalone).
 *
 * The returned handle seeds its `currentUser` mirror by opening an internal
 * authState subscription that keeps it live across tabs.
 */
export function getAuth(source: ClientDb | string | URL, name?: string): ClientAuth {
  let port: MessagePort;
  if (typeof source === 'object' && '__kind' in source && source.__kind === 'client-db') {
    port = source.port;
  } else {
    if (typeof SharedWorker === 'undefined') {
      throw new Error(
        'SharedWorker is not available. ' +
        'Open this page over http:// (not file://) and use a supported browser ' +
        '(Chrome 4+, Firefox 29+, Safari 16.4+).',
      );
    }
    const worker = new SharedWorker(source as string | URL, {
      type: 'classic',
      name: name ?? 'pyric-shared-worker',
    });
    port = worker.port;
    port.start();
    wirePort(port);
  }

  const auth: ClientAuth = { __kind: 'client-auth', port, currentUser: null };

  // Internal authState subscription keeps `auth.currentUser` live. Per-port
  // sessions (#754): only THIS port's sign-ins/outs (and its session restore)
  // fire here — another tab's sign-in is another user, not an update to us.
  const subId = nextSubId();
  _snapSubs.set(subId, {
    next: (raw) => {
      auth.currentUser = toClientUser(port, raw as SerializedUser | null);
    },
  });
  port.postMessage({ t: 'sub', subId, target: 'authState' } satisfies InboundMessage);

  return auth;
}

/**
 * Connect to the auth emulator. No-op shim over the worker: the worker's
 * sandbox IS the emulator-equivalent backend, so there's nothing to point at.
 * Present for surface parity so app code that calls it doesn't break.
 */
export function connectAuthEmulator(
  _auth: ClientAuth,
  _url: string,
  _options?: { disableWarnings?: boolean },
): void {
  // Intentional no-op — the worker's sandbox is the local auth backend.
}

// ─── Sign-in / out / create (RPC) ─────────────────────────────────────────

export async function createUserWithEmailAndPassword(
  auth: ClientAuth,
  email: string,
  password: string,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.createUser', email, password,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

// ─── Admin user-DB ops (Pyric Studio data browse) ─────────────────────────
// Mirror `pyric/auth`'s `sandbox.{listUsers,createUser,updateUser,deleteUser,
// clearUsers}` over the port. No lens (admin control surface), so bare `rpc`.

export async function listUsers(auth: ClientAuth): Promise<AuthUserRecord[]> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.listUsers',
  })) as AuthUserRecord[];
}

export async function adminCreateUser(
  auth: ClientAuth,
  request: CreateUserRequest,
): Promise<AuthUserRecord> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.adminCreateUser',
    request: request as unknown as Record<string, unknown>,
  })) as AuthUserRecord;
}

export async function adminUpdateUser(
  auth: ClientAuth,
  uid: string,
  request: UpdateUserRequest,
): Promise<AuthUserRecord> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.adminUpdateUser', uid,
    request: request as unknown as Record<string, unknown>,
  })) as AuthUserRecord;
}

export async function adminDeleteUser(auth: ClientAuth, uid: string): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.adminDeleteUser', uid });
}

export async function adminClearUsers(auth: ClientAuth): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.adminClearUsers' });
}

export async function signInWithEmailAndPassword(
  auth: ClientAuth,
  email: string,
  password: string,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.signInEmail', email, password,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signInAnonymously(auth: ClientAuth): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.signInAnonymously',
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function signOut(auth: ClientAuth): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.signOut' });
  // The authState stream will also clear the mirror; set eagerly so a
  // synchronous read right after `await signOut()` reflects the change.
  auth.currentUser = null;
}

/**
 * Bridge a provider identity resolved IN-PAGE to the worker (the provider
 * sign-in seam). The entry adapter's worker-path `signInWithPopup`/
 * `signInWithRedirect` runs the in-page `AuthFlowResolver` (which can't cross
 * the worker port), then calls this with the picked identity; the worker seeds
 * it + signs it in, returning a worker-backed credential. The mirror updates
 * eagerly (like the email/anon paths) so a synchronous `auth.currentUser`
 * read right after the await reflects the new user.
 */
export async function acceptProviderCredential(
  auth: ClientAuth,
  identity: ResolvedIdentity,
): Promise<ClientUserCredential> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.acceptIdentity', identity,
  })) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

/**
 * Re-establish THIS PORT's session for an existing identity (#754) — the
 * per-tab reload restore. The page persists its uid in web storage
 * (SessionStore); runtime.ts calls this at boot BEFORE app code runs. Soft:
 * returns null (and leaves the port signed out) when the uid no longer
 * resolves, so a stale record never throws.
 */
export async function restorePortSession(
  auth: ClientAuth,
  uid: string,
): Promise<ClientUser | null> {
  const raw = (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.restorePortSession', uid,
  })) as SerializedUser | null;
  const user = toClientUser(auth.port, raw);
  if (user) auth.currentUser = user;
  return user;
}

function hydrateCred(auth: ClientAuth, raw: SerializedUserCredential): ClientUserCredential {
  const user = makeClientUser(auth.port, raw.user);
  // Eagerly update the mirror so `auth.currentUser` is correct immediately
  // after the await, before the broadcast stream lands.
  auth.currentUser = user;
  return { user, providerId: raw.providerId, operationType: raw.operationType };
}

// ─── Persistence ──────────────────────────────────────────────────────────

/** Persistence markers — mirror `firebase/auth` / `pyric/auth`. */
export const inMemoryPersistence = { type: 'NONE' } as const;
export const browserSessionPersistence = { type: 'SESSION' } as const;
export const browserLocalPersistence = { type: 'LOCAL' } as const;

export type ClientPersistence = { readonly type: AuthPersistenceMode };

/**
 * Record the session-persistence mode on the worker (surface parity). The
 * effective persistence is CLIENT-side (#754): the entry adapter mirrors the
 * mode into the page's SessionStore, which decides where — or whether — this
 * tab's session uid is stored for reload restore.
 */
export async function setPersistence(
  auth: ClientAuth,
  persistence: ClientPersistence,
): Promise<void> {
  await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.setPersistence', mode: persistence.type,
  });
}

// ─── Observers (streaming subs) ────────────────────────────────────────────

/**
 * Subscribe to auth-state changes. Mirrors `firebase/auth`'s
 * `onAuthStateChanged`. Fires immediately with THIS PORT's current session,
 * then on every change to it (#754: sessions are per-port — another tab's
 * sign-in is a different user, not an update to this one). Updates the
 * handle's `currentUser` mirror before invoking the callback.
 */
export function onAuthStateChanged(
  auth: ClientAuth,
  callback: (user: ClientUser | null) => void,
): Unsubscribe {
  return openAuthSub(auth, 'authState', callback);
}

/**
 * Subscribe to ID-token changes. Mirrors `firebase/auth`'s
 * `onIdTokenChanged` — fires on THIS PORT's identity transitions (per-port
 * sessions, #754).
 */
export function onIdTokenChanged(
  auth: ClientAuth,
  callback: (user: ClientUser | null) => void,
): Unsubscribe {
  return openAuthSub(auth, 'idToken', callback);
}

function openAuthSub(
  auth: ClientAuth,
  target: 'authState' | 'idToken',
  callback: (user: ClientUser | null) => void,
): Unsubscribe {
  const subId = nextSubId();
  const port = auth.port;

  _snapSubs.set(subId, {
    next: (raw) => {
      const user = toClientUser(port, raw as SerializedUser | null);
      auth.currentUser = user;
      callback(user);
    },
  });

  port.postMessage({ t: 'sub', subId, target } satisfies InboundMessage);

  return () => {
    _snapSubs.delete(subId);
    port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}

// ─── Token accessors (top-level mirrors) ──────────────────────────────────

/** Top-level mirror of `firebase/auth`'s `getIdToken(user)`. */
export async function getIdToken(user: ClientUser, forceRefresh?: boolean): Promise<string> {
  return user.getIdToken(forceRefresh);
}

/** Top-level mirror of `firebase/auth`'s `getIdTokenResult(user)`. */
export async function getIdTokenResult(
  user: ClientUser,
  forceRefresh?: boolean,
): Promise<SerializedIdTokenResult> {
  return user.getIdTokenResult(forceRefresh);
}

/**
 * Top-level mirror of `firebase/auth`'s `updateProfile(user, profile)` over
 * the worker. RPCs `auth.updateProfile` for THIS PORT's session (the worker
 * owns the real `User`), then mutates the passed `user` mirror in place with
 * the returned fields so a synchronous read right after the await is
 * consistent. `null` clears a field; an absent field is left untouched.
 *
 * The port is recovered from the hidden {@link CLIENT_USER_PORT} handle stamped
 * on every `ClientUser`, so this works without an `auth` handle in scope.
 */
export async function updateProfile(
  user: ClientUser,
  profile: { displayName?: string | null; photoURL?: string | null },
): Promise<void> {
  const port = (user as { [CLIENT_USER_PORT]?: MessagePort })[CLIENT_USER_PORT];
  if (!port) {
    const err = new Error(
      'updateProfile: unrecognized user — was it produced by a worker-path sign-in?',
    ) as Error & { code: string };
    err.code = 'auth/invalid-user-token';
    throw err;
  }
  const raw = (await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.updateProfile',
    displayName: profile.displayName, photoURL: profile.photoURL,
  })) as SerializedUser;
  // Mutate the passed mirror in place (readonly at the type level, plain data
  // at runtime) so held references reflect the change immediately.
  const mutable = user as { -readonly [K in keyof ClientUser]: ClientUser[K] };
  mutable.displayName = raw.displayName;
  mutable.photoURL = raw.photoURL;
  mutable.providerData = raw.providerData;
}

// ─── Provider flows — NOT supported over the worker yet ───────────────────

/**
 * Provider sign-in (`signInWithCredential`, `signInWithPopup`,
 * `signInWithRedirect`) needs the AuthFlowResolver, which lives in-page and
 * can't cross the worker port. NOT SUPPORTED over the SharedWorker in v1 —
 * a clear error rather than silent breakage. Tracked as a Phase 2 follow-up:
 * thread the resolver through, or run provider flows in-page and hand the
 * resulting credential to the worker.
 */
export function signInWithCredential(): Promise<never> {
  return Promise.reject(makeUnsupported('signInWithCredential'));
}

function makeUnsupported(api: string): Error & { code: string } {
  const err = new Error(
    `${api} is not supported over the SharedWorker yet (provider flows need ` +
    'the in-page AuthFlowResolver). Follow-up: thread the resolver through or ' +
    'run the flow in-page and hand the credential to the worker.',
  ) as Error & { code: string };
  err.code = 'auth/operation-not-supported-in-this-environment';
  return err;
}

// ─── Storage (Pyric Studio data browse) ───────────────────────────────────
// A worker-backed `FirebaseStorage` mirror: `ref` is client-side (path math),
// `listAll`/`getMetadata`/`getBlob` RPC to the host (which enforces rules).
// Mutations are a follow-up.

/** Worker-backed Storage handle (carries the shared `MessagePort`). */
export interface ClientFirebaseStorage {
  readonly __kind: 'client-storage';
  readonly port: MessagePort;
}

/** Worker-backed Storage reference (path + name; carries the port for ops). */
export interface ClientStorageReference {
  readonly __kind: 'storage-ref';
  readonly port: MessagePort;
  readonly fullPath: string;
  readonly name: string;
}

/** Strip leading/trailing slashes (the worker keyspace uses bare paths). */
function normalizeStorageRefPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * Get the worker-backed Storage handle. Like `getAuth`, accepts an existing
 * `ClientDb` (reusing its port) or a worker URL (standalone).
 */
export function getStorage(source: ClientDb | string | URL, name?: string): ClientFirebaseStorage {
  let port: MessagePort;
  if (typeof source === 'object' && '__kind' in source && source.__kind === 'client-db') {
    port = source.port;
  } else {
    if (typeof SharedWorker === 'undefined') {
      throw new Error(
        'SharedWorker is not available. ' +
        'Open this page over http:// (not file://) and use a supported browser.',
      );
    }
    const worker = new SharedWorker(source as string | URL, {
      type: 'classic',
      name: name ?? 'pyric-shared-worker',
    });
    port = worker.port;
    port.start();
    wirePort(port);
  }
  return { __kind: 'client-storage', port };
}

/** Build a Storage reference. Mirrors `pyric/storage`'s `ref(storage, path?)` /
 *  `ref(parentRef, path)`. Client-side path math; no RPC. */
export function ref(
  parent: ClientFirebaseStorage | ClientStorageReference,
  path?: string,
): ClientStorageReference {
  const rel = normalizeStorageRefPath(path ?? '');
  let fullPath: string;
  if (parent.__kind === 'client-storage') {
    fullPath = rel;
  } else {
    const base = parent.fullPath;
    fullPath = rel ? (base ? `${base}/${rel}` : rel) : base;
  }
  return { __kind: 'storage-ref', port: parent.port, fullPath, name: lastSegment(fullPath) };
}

/** Enumerate immediate child items + sub-prefixes under a ref (Pyric Studio
 *  data browse). The host enforces `read` rules on the scanned prefix. */
export async function listAll(
  reference: ClientStorageReference,
): Promise<{ items: ClientStorageReference[]; prefixes: ClientStorageReference[] }> {
  const r = (await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.listAll', path: reference.fullPath,
  })) as { items: Array<{ fullPath: string; name: string }>; prefixes: Array<{ fullPath: string; name: string }> };
  const mk = (e: { fullPath: string; name: string }): ClientStorageReference => ({
    __kind: 'storage-ref', port: reference.port, fullPath: e.fullPath, name: e.name,
  });
  return { items: r.items.map(mk), prefixes: r.prefixes.map(mk) };
}

/** Read an object's metadata (Pyric Studio inspector). */
export async function getMetadata(reference: ClientStorageReference): Promise<FullMetadata> {
  return (await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getMetadata', path: reference.fullPath,
  })) as FullMetadata;
}

/** Read an object's bytes as a Blob (Pyric Studio inspector preview).
 *  MessagePort-only — a Blob cannot cross the JSON bridge relay. */
export async function getBlob(reference: ClientStorageReference): Promise<Blob> {
  return (await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getBlob', path: reference.fullPath,
  })) as Blob;
}

// ─── Storage mutations + JSON-safe reads (worker-mode byte ops) ───────────
// Backed by the base64 `storage.putBytes` / `storage.getBytes` /
// `storage.deleteObject` ops (remote sandbox, slice 2). No `actAs` lens is
// attached: page callers run under the worker's page storage handle (same
// model as `listAll`/`getMetadata` above). Storage rules apply only when the
// HOST configured them on the sandbox's storage service — the served worker
// currently configures none, so worker-mode storage is effectively open
// today; the admin lens matters for embedding/test hosts that pre-open the
// service with rules. Raw payloads are capped at 8 MiB
// (`MAX_STORAGE_OP_BYTES`) — same cap the host enforces.

/** Mirror of `pyric/storage`'s `SettableMetadata` (plain JSON on the wire). */
export interface ClientSettableMetadata {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: { [key: string]: string };
}

/** Upload bytes at the reference's path (replaces existing content).
 *  Mirrors `pyric/storage`'s `uploadBytes` result shape. */
export async function uploadBytes(
  reference: ClientStorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata?: ClientSettableMetadata,
): Promise<{ ref: ClientStorageReference; metadata: FullMetadata }> {
  const bytes =
    data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data;
  if (bytes.byteLength > MAX_STORAGE_OP_BYTES) {
    throw storagePayloadTooLarge(bytes.byteLength, `uploadBytes payload for '${reference.fullPath}'`);
  }
  // contentType precedence mirrors pyric/storage: caller metadata → Blob.type.
  const contentType =
    metadata?.contentType ?? (data instanceof Blob && data.type ? data.type : undefined);
  const stored = (await rpc(reference.port, {
    t: 'op',
    id: nextId(),
    method: 'storage.putBytes',
    path: reference.fullPath,
    dataB64: bytesToBase64(bytes),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
  })) as FullMetadata;
  return { ref: reference, metadata: stored };
}

/** Read an object's bytes (JSON-safe base64 op → `ArrayBuffer`). Mirrors
 *  `pyric/storage`'s `getBytes`, including the optional client-side cap. */
export async function getBytes(
  reference: ClientStorageReference,
  maxDownloadSizeBytes?: number,
): Promise<ArrayBuffer> {
  const res = (await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getBytes', path: reference.fullPath,
  })) as { dataB64: string; size: number };
  if (typeof maxDownloadSizeBytes === 'number' && res.size > maxDownloadSizeBytes) {
    const err = new Error(
      `storage/quota-exceeded: object at '${reference.fullPath}' is ${res.size} bytes — ` +
        `over the requested maxDownloadSizeBytes (${maxDownloadSizeBytes}).`,
    ) as Error & { code: string };
    err.code = 'storage/quota-exceeded';
    throw err;
  }
  const bytes = base64ToBytes(res.dataB64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Delete the object at the reference's path (idempotent — missing = no-op,
 *  matching the sandbox backend's delete semantics). */
export async function deleteObject(reference: ClientStorageReference): Promise<void> {
  await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.deleteObject', path: reference.fullPath,
  });
}
