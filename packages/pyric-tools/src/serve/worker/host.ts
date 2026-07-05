/**
 * SharedWorker host — op handlers and subscription registry.
 *
 * WHY INJECTED DEPS
 * -----------------
 * The host is deliberately decoupled from `SharedWorkerGlobalScope` so
 * unit tests can drive it with a REAL pyric sandbox + fake MessagePort
 * objects — no browser or SharedWorker runtime required. The entry point
 * (`entry.ts`) creates the real sandbox + db and wires the connecting ports
 * to this module.
 *
 * ARCHITECTURE
 * ------------
 * One `HostCtx` is shared across ALL connected ports. It holds:
 *   - `db` — the single modular Firestore handle (from pyric/firestore's
 *     `getFirestore(sandbox)` — sandbox-live mode so auth changes propagate).
 *   - `sandbox` — the underlying Sandbox, needed for `setRules` and for
 *     constructing sentinels via FieldValue.
 *   - `subs` — per-port subscription registry: Map<PortLike, Map<subId, unsub>>
 *
 * Each connecting port calls `handleMessage(ctx, port, msg)`. The function
 * is exported so tests can call it directly.
 *
 * SENTINEL RESOLUTION
 * -------------------
 * Write data crossing the port may contain `SentinelMarker` objects
 * (`{ __sentinel: 'serverTimestamp' }` etc.). Before passing data to the
 * sandbox we walk the payload and replace each marker with the real
 * FieldValue object from `pyric/firestore`'s sentinel factories. The
 * sandbox's value-resolver then executes them as usual.
 *
 * SUBSCRIPTION FAN-OUT
 * --------------------
 * Because all ports share ONE sandbox, an onSnapshot listener registered
 * via the sandbox automatically fires for writes from ANY port. We just
 * need to forward the snapshot to the correct originating port(s).
 *
 * TRANSACTIONS + READ-SET VALIDATION
 * ------------------------------------
 * `runTransaction` on the worker is the full-fidelity path: the host calls
 * the sandbox's `runTransaction`, which runs the update function, handles
 * optimistic-concurrency retries, and commits atomically. The client now
 * sends a `reads` array alongside `writes`; the worker re-reads each doc
 * inside the sandbox transaction and validates that no concurrent write
 * changed any of them between the client's read and this commit. A mismatch
 * signals `{ code: 'aborted' }` on the wire so the client can re-run
 * `updateFn` — see `txnCommit` handler for full details.
 */

import {
  getFirestore as pyricGetFirestore,
  getAdminFirestore as pyricGetAdminFirestore,
  doc as pyricDoc,
  collection as pyricCollection,
  collectionGroup as pyricCollectionGroup,
  query as pyricQuery,
  where as pyricWhere,
  orderBy as pyricOrderBy,
  limit as pyricLimit,
  limitToLast as pyricLimitToLast,
  startAt as pyricStartAt,
  startAfter as pyricStartAfter,
  endAt as pyricEndAt,
  endBefore as pyricEndBefore,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  onSnapshot,
  getCountFromServer,
  runTransaction,
  writeBatch,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  deleteField,
  SandboxError,
  type Firestore,
  type DocumentReference,
  type CollectionReference,
  type Query,
  type SetOptions,
} from 'pyric/firestore';
import type { Sandbox, PersistenceBackend, AuthLens } from 'pyric/sandbox';
import { serializeToBuckets, bundleRecords, parseBundle, deserializeFromBuckets } from 'pyric/sandbox';
import { sandbox as sandboxOps } from 'pyric/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { initializeApp } from 'pyric/app';
import {
  getStorage,
  ref as storageRef,
  listAll as storageListAll,
  getMetadata as storageGetMetadata,
  type FirebaseStorage,
} from 'pyric/storage';

import type {
  InboundMessage,
  OpMessage,
  FirestoreSubMessage,
  UnsubMessage,
  ToolMessage,
  TargetDescriptor,
  QueryConstraintDescriptor,
  WriteDescriptor,
  TxnReadEntry,
  SentinelMarker,
} from './protocol.js';
import {
  serializeError,
  serializeDocData,
  isSentinelMarker,
  isAuthSub,
  isEventSub,
} from './protocol.js';
// The canonical agent tool dispatcher — reused on the worker so a bridged agent
// executes against THIS sandbox (one backend for app + Studio + agent), instead
// of a separate in-page sandbox.
import { buildSandboxDispatcher } from '../../bridge/client/dispatch.js';

import { type HostCtx, type PortLike, post, ok, fail } from './host-context.js';
import {
  authSubsFor,
  isAuthOp,
  handleAuthOp,
  handleAuthSub,
  handleAuthUnsub,
  portSession,
  cleanupPortSession,
} from './host-auth.js';
import {
  eventSubsFor,
  handleEventSub,
  handleEventUnsub,
} from './host-events.js';

// Re-export so host.ts's public surface is unchanged after the decomposition.
export { ensureAuth, portSession } from './host-auth.js';
export type { HostCtx, PortLike } from './host-context.js';

/** Build hash injected by the bundler's esbuild `define`. Undefined when the
 *  compiled host is imported directly (tests) — guarded with `typeof`. */
declare const __PYRIC_WORKER_VERSION__: string;

/**
 * Per-SharedWorker instance id — generated once and persisted to the RAW idb
 * (local-only, like the session record above; it must NEVER reach the
 * committable server file). Because IndexedDB is per (origin + browser profile),
 * two profiles on the same `localhost:<port>` get two distinct ids — which is
 * exactly how the UI tells same-port-different-profile sandboxes apart.
 */
export const INSTANCE_ID_KEY = 'pyric:worker:instance';

/**
 * `crypto.randomUUID()` is secure-context-only (https or localhost), so it is
 * `undefined` over plain http on a non-localhost host (a Tailscale or LAN
 * hostname). `crypto.getRandomValues` is NOT gated, so build a v4 UUID from it as
 * the fallback. Without this the worker throws on init over Tailscale and the
 * whole sandbox (auth, firestore, bridge) silently fails to come up.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

export async function getOrCreateInstanceId(idb: PersistenceBackend): Promise<string> {
  const rec = (await idb.getRecord(INSTANCE_ID_KEY, 'id')) as { value?: string } | undefined;
  if (rec && typeof rec.value === 'string') return rec.value;
  const id = randomUuid();
  await idb.putRecords(INSTANCE_ID_KEY, new Map([['id', { value: id }]]));
  return id;
}

// ── Phase 3: named branches ─────────────────────────────────────────────────
// A branch is a named saved state bundle in the RAW idb (local-only, like the
// instance id + session; it must NEVER reach the committable server file). They
// let one instance keep several named states it can switch between
// (switchBranch = loadSnapshot the bundle, a clobber). A registry record holds
// the ordered name list, since the backend lists records WITHIN a key, not keys.
export const BRANCH_PREFIX = 'pyric:worker:branch:';
export const BRANCH_REGISTRY_KEY = 'pyric:worker:branches';

export async function listBranchNames(idb?: PersistenceBackend): Promise<string[]> {
  if (!idb) return [];
  const rec = (await idb.getRecord(BRANCH_REGISTRY_KEY, 'names')) as { value?: string[] } | undefined;
  return Array.isArray(rec?.value) ? rec.value : [];
}

async function writeBranchRegistry(idb: PersistenceBackend, names: string[]): Promise<void> {
  await idb.putRecords(BRANCH_REGISTRY_KEY, new Map([['names', { value: names }]]));
}

// ─── Descriptor → live ref resolution ───────────────────────────────────

/**
 * Resolve a TargetDescriptor into a live pyric ref or query.
 *
 * WHY WE RESOLVE ON THE WORKER
 * The client never holds live pyric refs — it holds plain `DocRef`/
 * `CollRef`/`GroupRef`/`QueryDescriptor` objects that serialize cleanly
 * across the MessagePort. On every op the worker rebuilds the live ref
 * from these descriptors. This keeps the client completely stateless with
 * respect to sandbox internals and makes retries trivially correct.
 */
function resolveTarget(
  db: Firestore,
  target: TargetDescriptor,
): DocumentReference | CollectionReference | Query {
  if (target.__ref === 'doc') {
    return pyricDoc(db, target.path);
  }
  if (target.__ref === 'collection') {
    return pyricCollection(db, target.path);
  }
  if (target.__ref === 'group') {
    return pyricCollectionGroup(db, target.collectionId);
  }
  // query descriptor
  const source = resolveTarget(db, target.source) as CollectionReference | Query;
  const constraints = target.constraints.map((c) => resolveConstraint(c));
  return pyricQuery(source, ...constraints);
}

function resolveConstraint(c: QueryConstraintDescriptor): ReturnType<typeof pyricWhere> {
  switch (c.kind) {
    case 'where':
      return pyricWhere(c.field, c.op as Parameters<typeof pyricWhere>[1], c.value);
    case 'orderBy':
      return pyricOrderBy(c.field, c.direction);
    case 'limit':
      return pyricLimit(c.n);
    case 'limitToLast':
      return pyricLimitToLast(c.n);
    case 'startAt':
      return pyricStartAt(...c.values);
    case 'startAfter':
      return pyricStartAfter(...c.values);
    case 'endAt':
      return pyricEndAt(...c.values);
    case 'endBefore':
      return pyricEndBefore(...c.values);
  }
}

// ─── Sentinel resolution ──────────────────────────────────────────────────

/**
 * Walk a write payload and replace every `SentinelMarker` with the
 * corresponding pyric/firestore FieldValue sentinel object.
 *
 * WHY: FieldValue class instances don't survive structured clone — they
 * arrive as plain objects and lose their prototype, breaking sandbox
 * sentinel detection. The client sends `{ __sentinel: 'serverTimestamp' }`
 * etc. and we reconstruct the real FieldValue here before the sandbox sees
 * the data.
 *
 * The sandbox's sentinel-capture code (sentinel-capture.ts) recognizes
 * FieldValue objects by their internal `__type` property, which the
 * factories produce correctly.
 */
function resolveSentinels(value: unknown): unknown {
  if (isSentinelMarker(value)) {
    return resolveSentinel(value);
  }
  if (Array.isArray(value)) {
    return value.map(resolveSentinels);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveSentinels(v);
    }
    return out;
  }
  return value;
}

function resolveSentinel(marker: SentinelMarker): unknown {
  switch (marker.__sentinel) {
    case 'serverTimestamp': return serverTimestamp();
    case 'increment':       return increment(marker.n);
    case 'arrayUnion':      return arrayUnion(...marker.values);
    case 'arrayRemove':     return arrayRemove(...marker.values);
    case 'deleteField':     return deleteField();
  }
}

// ─── Snapshot serialization ───────────────────────────────────────────────

/**
 * Serialize a document snapshot to cross-port form.
 * Uses JSON-via-serializeDocData so Timestamp/Bytes/LatLng survive.
 */
function serializeDocSnap(snap: {
  id: string;
  path?: string;
  ref?: { path?: string };
  exists: boolean | (() => boolean);
  data(): Record<string, unknown> | undefined;
}): { id: string; path?: string; exists: boolean; data?: { json: string } } {
  const existsBool = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
  const data = existsBool ? snap.data() : undefined;
  return {
    id: snap.id,
    // Doc snapshots carry a top-level `path`; QUERY doc snapshots carry it on
    // `.ref.path`. Read both so query rows serialize their FULL path (Studio's
    // browse resolves the document detail from it).
    path: snap.path ?? snap.ref?.path,
    exists: existsBool,
    data: data ? serializeDocData(data) : undefined,
  };
}

// ─── Auth lens (Pyric Studio) ─────────────────────────────────────────────

/**
 * Resolve the Firestore handle an op runs against, given its `actAs` lens
 * (Pyric Studio auth lens, T2 — implements the C2 protocol seam).
 *
 * Resolution by `actAs.mode` (absent ⇒ the app's session):
 *
 *   - `app-session` (and `actAs` absent): `ctx.db` — the shared sandbox-live
 *     handle. Reads `sandbox.currentUser` per op, so rules evaluate under
 *     whoever the served app is signed in as. This is the unchanged default
 *     and the ONLY lens the app itself ever uses.
 *
 *   - `{ mode: 'as', uid }` (impersonation — the rules-debugging primitive):
 *     a FROZEN-identity `getFirestore(sandbox.withAuth({ uid }))` handle.
 *     Security rules APPLY and evaluate as that user — `request.auth.uid`
 *     resolves to `uid`. This lets Studio "re-run this denied op as the user
 *     who attempted it" (Wave-2 rules-debugging, F4). Handles are cached
 *     per-uid on `ctx.lensHandles`.
 *
 *   - `{ mode: 'admin' }` (rule bypass): a modular `getAdminFirestore(sandbox)`
 *     handle (pyric Gap #2) whose ops skip security-rule evaluation while still
 *     reading/writing the same store and emitting events. This is Studio's
 *     "edit anything as admin" surface (F2). Cached on `ctx.adminDb`.
 *
 * WRITE-IMPERSONATION GATING (open micro-decision #1, honoured): the resolver
 * itself is symmetric — an `{ mode: 'as', uid }` lens applies to BOTH reads and
 * writes (a write-as-user is denied/allowed exactly as that user's rules say).
 * The POLICY decision — "read-as-user always; write-as-user only on an explicit
 * reproduce path" — is enforced at the CALLER (the Studio client / UI chooses
 * when to attach a write op's `actAs`), NOT here. Default behaviour stays admin/
 * app-session unless a caller sets `actAs`; no UI is added by T2.
 */
function lensDb(ctx: HostCtx, actAs?: AuthLens): Firestore {
  // Absent / app-session → the app's live session handle.
  if (!actAs || actAs.mode === 'app-session') {
    return ctx.db;
  }

  // { mode: 'admin' } → a modular rules-bypass handle (cached per ctx).
  if (actAs.mode === 'admin') {
    return (ctx.adminDb ??= pyricGetAdminFirestore(ctx.sandbox));
  }

  // { mode: 'as', uid } → a frozen-identity handle; rules evaluate as `uid`.
  const handles = (ctx.lensHandles ??= new Map());
  let handle = handles.get(actAs.uid);
  if (!handle) {
    handle = pyricGetFirestore(ctx.sandbox.withAuth({ uid: actAs.uid }));
    handles.set(actAs.uid, handle);
  }
  return handle;
}

/**
 * Normalise a per-op `actAs` lens to the {@link AuthLens} provenance shape that
 * the unified sandbox event stream stamps on each event's `authLens` field.
 *
 * Absent ⇒ `{ mode: 'app-session' }` (the app's own session) — matching how
 * `EventProvenance.authLens` reads when omitted. C1 added the field to events;
 * T1 owns the EMIT path that actually writes it. T2's job is to thread the lens
 * THROUGH the host so T1 has the value at emit time: see the call in `handleOp`
 * where the resolved lens is passed to the sandbox via `withLens` when that
 * emit seam exists. Today the sandbox event emitters infer `authLens` from the
 * acting identity (the impersonation handle's frozen `auth` is `{ uid }`, so a
 * rules eval already carries that uid); this helper exists so the host has a
 * single canonical normaliser when the explicit emit-time stamp lands.
 */
function lensProvenance(actAs?: AuthLens): AuthLens {
  return actAs ?? { mode: 'app-session' };
}

/**
 * Resolve the data handle for an op/sub carrying NO explicit lens: the
 * PORT'S SESSION (#754). A signed-in port gets a per-uid cached
 * `getFirestore(sandbox.withAuth(session.state))` handle — rules evaluate
 * under its uid + custom claims, exactly like a globally signed-in user. A
 * signed-out port falls back to `ctx.db` (sandbox-live; `currentUser` is
 * never set in served mode, so that is the unauthenticated view).
 *
 * This is NOT the impersonation lens: the session was minted by validated
 * sign-in on this port (`sandbox.mintSession`), so both reads and writes
 * legitimately run as that user — the write-impersonation gate on the
 * Studio `as` lens does not apply to a port's own session.
 *
 * Known staleness (same class as `lensHandles`): a claims change via
 * `auth.adminUpdateUser` is not reflected in an existing session's handle
 * until that user session is re-established (real Firebase behaves the same
 * until token refresh).
 */
function sessionDb(ctx: HostCtx, port: PortLike): Firestore {
  const session = portSession(ctx, port);
  if (!session) return ctx.db;
  const cache = (ctx.sessionDbs ??= new Map());
  let handle = cache.get(session.user.uid);
  if (!handle) {
    handle = pyricGetFirestore(ctx.sandbox.withAuth(session.state));
    cache.set(session.user.uid, handle);
  }
  return handle;
}

// ─── Op handlers ──────────────────────────────────────────────────────────

/** The shared Storage handle, lazily created (Pyric Studio data browse): one per
 *  worker, over an app bound to the shared sandbox. The high-level
 *  `pyric/storage` ops enforce rules, so the host reads through them. */
function ensureStorage(ctx: HostCtx): FirebaseStorage {
  return (ctx.storage ??= getStorage(initializeApp({ sandbox: ctx.sandbox })));
}

async function handleOp(ctx: HostCtx, port: PortLike, msg: OpMessage): Promise<void> {
  const { sandbox } = ctx;
  // Explicit lens (Studio admin / as / app-session) → lensDb; no lens → the
  // PORT'S SESSION (#754), so app ops run as whoever this tab signed in as.
  const db = msg.actAs ? lensDb(ctx, msg.actAs) : sessionDb(ctx, port);
  // Provenance the op runs under. Stamped onto the unified event stream's
  // `authLens` by the emit path (C1 field / T1 emit). For `{ mode: 'as', uid }`
  // the resolved `db` already carries `auth: { uid }`, so a rules eval emits
  // under that identity; `lens` is the canonical normalised value the host
  // hands forward when the explicit emit-time stamp seam exists (see lensProvenance).
  const lens = lensProvenance(msg.actAs);
  void lens;

  switch (msg.method) {
    case 'getDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const snap = await getDoc(ref);
        ok(port, msg.id, serializeDocSnap(snap as Parameters<typeof serializeDocSnap>[0]));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'getDocs': {
      try {
        const source = resolveTarget(db, msg.source);
        // CollectionReference is always also queryable — getDocs accepts Query<T>
        // and CollectionReference is structurally compatible at runtime even though
        // the type system doesn't know that (CollectionReference has no `_isQuery`
        // brand). Cast through Query to satisfy the type checker.
        const snap = await getDocs(source as Query);
        const docs = snap.docs.map((d) =>
          serializeDocSnap(d as Parameters<typeof serializeDocSnap>[0]),
        );
        ok(port, msg.id, { docs });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'setDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const data = resolveSentinels(msg.data) as Record<string, unknown>;
        await setDoc(ref, data, msg.options as SetOptions | undefined);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'updateDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const data = resolveSentinels(msg.data) as Record<string, unknown>;
        await updateDoc(ref, data);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'deleteDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        await deleteDoc(ref);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'addDoc': {
      try {
        const coll = pyricCollection(db, msg.collectionPath);
        const data = resolveSentinels(msg.data) as Record<string, unknown>;
        const ref = await addDoc(coll, data);
        ok(port, msg.id, { id: ref.id, path: ref.path });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'count': {
      try {
        const source = resolveTarget(db, msg.source);
        const snap = await getCountFromServer(source as Query);
        ok(port, msg.id, { count: snap.data().count });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'listRootCollections': {
      // Keyspace enumeration (Pyric Studio data browse). Lens-independent: it
      // lists the collection ids present, not rule-gated reads.
      try {
        ok(port, msg.id, { ids: getInternalEnv(sandbox).listRootCollections() });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'listSubcollections': {
      try {
        ok(port, msg.id, { ids: getInternalEnv(sandbox).listSubcollections(msg.docPath) });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'batchCommit': {
      /**
       * WHY: writeBatch in pyric/firestore buffers set/update/delete calls
       * and commits them as one unit through the sandbox backend. We
       * reconstruct the batch here from the wire write descriptors.
       * Atomicity guarantee: the sandbox backend applies all writes or none
       * (per-collection lock semantics of LocalEnvironment.batch()).
       */
      try {
        const batch = writeBatch(db);
        for (const w of msg.writes) {
          applyWriteToBatch(db, batch, w);
        }
        await (batch as { commit(): Promise<void> }).commit();
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'txnCommit': {
      /**
       * READ-SET VALIDATION FOR MULTI-TAB CORRECTNESS
       * -----------------------------------------------
       * The client sends `{ method: 'txnCommit', reads, writes }` after its
       * `updateFn` callback has resolved. `reads` is the set of docs the
       * client read during `updateFn` (each entry is `{ path, data }` where
       * `data` is the serialized snapshot the client saw, or null if the doc
       * was missing).
       *
       * WHY READ-SET VALIDATION IS NECESSARY
       * -------------------------------------
       * A transaction spans two messages: the client's `txn.get` RPC (sent
       * during `updateFn`) and this `txnCommit` RPC. Between those messages
       * the event loop is free — another tab's write to any of the read docs
       * can land in that gap via a separate `setDoc` message. Without
       * validation that would be a silent lost update: the client computed
       * its writes using stale data, committed them, and the other tab's
       * changes were silently overwritten.
       *
       * HOW WE VALIDATE (no per-doc version/updateTime in the sandbox)
       * ---------------------------------------------------------------
       * Inside a real `runTransaction(db, callback)`, the callback re-reads
       * every doc from the read-set via `tx.get(ref)`, serializes its current
       * data to the same JSON form the client produced (using `serializeDocData`
       * on both sides), and compares the JSON strings. If any doc's current
       * serialized form differs from what the client recorded, another tab
       * wrote it between the client's read and this commit — we throw an abort
       * sentinel so the sandbox rolls back the transaction, and we return
       * `{ ok: false, error: { code: 'aborted' } }` on the wire. The client's
       * retry loop then re-runs `updateFn` with fresh reads.
       *
       * SERIALIZED-FORM EQUALITY
       * ------------------------
       * Comparing JSON strings is valid here because `serializeDocData` uses
       * `JSON.stringify(data)` on both sides with the same value codec (the
       * persistence serializer's toJSON markers). Within a single V8 process
       * (the worker), `JSON.stringify` is deterministic for objects with the
       * same insertion-order keys, so string equality ↔ deep equality for
       * the sandbox's doc data.
       *
       * NOTE ON tx.set/update/delete SIGNATURE
       * ---------------------------------------
       * The modular pyric/firestore Transaction (wrapping the admin-compat
       * TransactionWrapper) takes `tx.set(docRef, data)` where `docRef` is a
       * real `DocumentReference` — NOT a path string. We build refs via
       * `pyricDoc(db, path)` for each write.
       */

      /** Sentinel thrown inside the transaction callback to signal an abort. */
      const TXN_ABORT = Symbol('txn-abort');

      try {
        await runTransaction(db, async (tx) => {
          // ── Step 1: validate the read-set ──────────────────────────────
          // Re-read each doc the client touched and compare its current
          // serialized form against what the client recorded at read time.
          const modularTx = tx as {
            get(ref: DocumentReference): Promise<{ exists: boolean | (() => boolean); data(): Record<string, unknown> | undefined }>;
            set(ref: DocumentReference, data: Record<string, unknown>, opts?: SetOptions): void;
            update(ref: DocumentReference, data: Record<string, unknown>): void;
            delete(ref: DocumentReference): void;
          };

          for (const r of (msg as { reads: TxnReadEntry[]; writes: typeof msg.writes }).reads) {
            const ref = pyricDoc(db, r.path);
            const currentSnap = await modularTx.get(ref);
            const existsBool = typeof currentSnap.exists === 'function'
              ? (currentSnap.exists as () => boolean)()
              : currentSnap.exists as boolean;

            // Compute the serialized form of the current doc state.
            const currentSerialized = existsBool && currentSnap.data()
              ? serializeDocData(currentSnap.data() as Record<string, unknown>)
              : null;

            // Compare against what the client recorded:
            //   both null → ok (doc still doesn't exist)
            //   both present + same JSON → ok
            //   anything else → conflict
            const clientHadNull = r.data === null;
            const workerHasNull = currentSerialized === null;

            if (clientHadNull !== workerHasNull) {
              // Existence changed (created or deleted by another tab).
              throw TXN_ABORT;
            }
            if (!clientHadNull && !workerHasNull && r.data!.json !== currentSerialized!.json) {
              // Data changed by another tab.
              throw TXN_ABORT;
            }
          }

          // ── Step 2: apply the queued writes ────────────────────────────
          for (const w of msg.writes) {
            const ref = pyricDoc(db, w.path);
            if (w.method === 'set') {
              const data = resolveSentinels(w.data) as Record<string, unknown>;
              modularTx.set(ref, data, w.options as SetOptions | undefined);
            } else if (w.method === 'update') {
              const data = resolveSentinels(w.data) as Record<string, unknown>;
              modularTx.update(ref, data);
            } else if (w.method === 'delete') {
              modularTx.delete(ref);
            }
          }
        });
        ok(port, msg.id, null);
      } catch (e) {
        if (e === TXN_ABORT) {
          // Read-set conflict — signal the client to retry its updateFn.
          const abortErr = { code: 'aborted', message: 'Transaction read-set conflict: a concurrent write invalidated the read snapshot.' };
          post(port, { t: 'res', id: msg.id, ok: false, error: abortErr });
        } else {
          fail(port, msg.id, e);
        }
      }
      break;
    }

    case 'setRules': {
      try {
        const result = sandboxOps.setRules(db, msg.source);
        ok(port, msg.id, { warnings: result.warnings });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'getVersion': {
      // The build hash is injected by the bundler (esbuild `define`). `typeof`
      // guards the non-bundled path (tests import the compiled host directly,
      // where the global is undefined) → reports 'dev'.
      ok(port, msg.id, {
        version: typeof __PYRIC_WORKER_VERSION__ !== 'undefined' ? __PYRIC_WORKER_VERSION__ : 'dev',
        instanceId: ctx.instanceId,
      });
      break;
    }

    case 'exportState': {
      // Phase 2 (transfer): serialize the FULL sandbox state to a portable bundle
      // string using the SAME chunk format the persist layer uses, so wrapper
      // types (Timestamp / Bytes / GeoPoint / VectorValue) round-trip. The string
      // crosses the MessagePort cleanly (unlike the raw snapshot object).
      const snap = ctx.sandbox.snapshot();
      ok(port, msg.id, { bundle: bundleRecords(serializeToBuckets(snap.firestore, snap.services, 0)) });
      break;
    }

    case 'importState': {
      // Phase 2 (clobber): replace this sandbox's ENTIRE state with the imported
      // bundle via the public loadSnapshot() (reset + rebuild firestore + restore
      // services; listeners re-evaluate, persist re-flushes).
      ctx.sandbox.loadSnapshot(deserializeFromBuckets(parseBundle(msg.bundle)));
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'saveBranch': {
      // Phase 3: snapshot the live sandbox into a named branch bundle (raw idb).
      if (!ctx.sessionBackend) {
        ok(port, msg.id, { ok: false, error: 'no persistence backend' });
        break;
      }
      const snap = ctx.sandbox.snapshot();
      const bundle = bundleRecords(serializeToBuckets(snap.firestore, snap.services, 0));
      await ctx.sessionBackend.putRecords(BRANCH_PREFIX + msg.name, new Map([['bundle', { value: bundle }]]));
      const names = await listBranchNames(ctx.sessionBackend);
      if (!names.includes(msg.name)) await writeBranchRegistry(ctx.sessionBackend, [...names, msg.name]);
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'listBranches': {
      ok(port, msg.id, { branches: await listBranchNames(ctx.sessionBackend) });
      break;
    }

    case 'switchBranch': {
      // Phase 3: loadSnapshot the named branch bundle (a clobber).
      const rec = ctx.sessionBackend
        ? ((await ctx.sessionBackend.getRecord(BRANCH_PREFIX + msg.name, 'bundle')) as { value?: string } | undefined)
        : undefined;
      if (!rec?.value) {
        ok(port, msg.id, { ok: false, error: `no such branch: ${msg.name}` });
        break;
      }
      ctx.sandbox.loadSnapshot(deserializeFromBuckets(parseBundle(rec.value)));
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'deleteBranch': {
      if (ctx.sessionBackend) {
        await ctx.sessionBackend.clear(BRANCH_PREFIX + msg.name);
        await writeBranchRegistry(
          ctx.sessionBackend,
          (await listBranchNames(ctx.sessionBackend)).filter((n) => n !== msg.name),
        );
      }
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'setPolicy': {
      // Store the dial's PolicyRequest as the worker-side runtime governance
      // (Pyric Studio F3). This is the source of truth Studio reflects + a
      // future in-worker agent runtime consults. It does NOT push into a
      // running bridge process — see the limitation note on `ctx.policy` /
      // `PolicyRequest`. Additive + idempotent: last write wins.
      ctx.policy = msg.policy;
      ok(port, msg.id, null);
      break;
    }

    case 'getPolicy': {
      // Read back the active runtime policy (null until the dial set one), so
      // Studio can reflect persisted state across reconnects within a worker
      // lifetime and a freshly-connecting port can hydrate the dial.
      ok(port, msg.id, ctx.policy ?? null);
      break;
    }

    case 'getSnapshot': {
      // Export the current sandbox snapshot (Pyric Studio rules re-run): Studio
      // forks it locally to test edited rules / re-issue as the user on a branch.
      ok(port, msg.id, ctx.sandbox.snapshot());
      break;
    }

    case 'storage.listAll': {
      // Object browse. `listAll` enforces `read` rules on the scanned prefix.
      try {
        const storage = ensureStorage(ctx);
        const result = await storageListAll(storageRef(storage, msg.path));
        ok(port, msg.id, {
          items: result.items.map((r) => ({ fullPath: r.fullPath, name: r.name })),
          prefixes: result.prefixes.map((r) => ({ fullPath: r.fullPath, name: r.name })),
        });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.getMetadata': {
      try {
        const storage = ensureStorage(ctx);
        // FullMetadata is plain JSON (bucket/fullPath/name/size/contentType/...).
        ok(port, msg.id, await storageGetMetadata(storageRef(storage, msg.path)));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      // Auth ops (`auth.*`) are routed to handleAuthOp by handleMessage before
      // reaching here, so any method landing in this default is genuinely
      // unknown. (We can't use a `never` exhaustiveness check anymore because
      // OpMessage now includes the auth variants this switch deliberately skips.)
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}

// ─── Batch write helper ───────────────────────────────────────────────────

type BatchHandle = {
  set(ref: DocumentReference, data: Record<string, unknown>, options?: SetOptions): void;
  update(ref: DocumentReference, data: Record<string, unknown>): void;
  delete(ref: DocumentReference): void;
};

function applyWriteToBatch(
  db: Firestore,
  batch: unknown,
  w: WriteDescriptor,
): void {
  const b = batch as BatchHandle;
  const ref = pyricDoc(db, w.path);
  if (w.method === 'set') {
    const data = resolveSentinels(w.data) as Record<string, unknown>;
    b.set(ref, data, w.options as SetOptions | undefined);
  } else if (w.method === 'update') {
    const data = resolveSentinels(w.data) as Record<string, unknown>;
    b.update(ref, data);
  } else if (w.method === 'delete') {
    b.delete(ref);
  }
}

// ─── Subscription handler ─────────────────────────────────────────────────

/**
 * Session-bound sub registry (#754): the original sub message for every
 * listener a port opened WITHOUT an explicit lens, so a port session change
 * can re-establish it under the new identity (see resubscribeSessionSubs).
 * Parallel to `ctx.subs` (which holds only the unsub fns).
 */
const _sessionSubs = new WeakMap<HostCtx, Map<PortLike, Map<string, FirestoreSubMessage>>>();

function sessionSubsFor(ctx: HostCtx, port: PortLike): Map<string, FirestoreSubMessage> {
  let byPort = _sessionSubs.get(ctx);
  if (!byPort) {
    byPort = new Map();
    _sessionSubs.set(ctx, byPort);
  }
  let bySubId = byPort.get(port);
  if (!bySubId) {
    bySubId = new Map();
    byPort.set(port, bySubId);
  }
  return bySubId;
}

/**
 * Re-establish a port's session-bound listeners under its CURRENT session —
 * invoked (via the ctx hook) on every port session change. Mirrors prod's
 * stream re-establishment on auth transitions: each listener is torn down and
 * re-registered through `sessionDb`, so the fresh evaluation either delivers
 * a snapshot (allowed) or a `permission-denied` snap-error (revoked). A
 * signed-out page no longer keeps receiving auth-gated data.
 */
function resubscribeSessionSubs(ctx: HostCtx, port: PortLike): void {
  const bound = _sessionSubs.get(ctx)?.get(port);
  if (!bound || bound.size === 0) return;
  const portSubs = ctx.subs.get(port);
  for (const [subId, msg] of [...bound]) {
    const unsub = portSubs?.get(subId);
    if (unsub) unsub();
    portSubs?.delete(subId);
    bound.delete(subId); // handleSub re-records it
    handleSub(ctx, port, msg);
  }
}

function handleSub(ctx: HostCtx, port: PortLike, msg: FirestoreSubMessage): void {
  // Resolve the listener's data handle through the SAME lens path ops use
  // (Pyric Studio F4 "watch as user"): `{ mode: 'as', uid }` registers the
  // listener as that user so its rule evals impersonate, `{ mode: 'admin' }`
  // bypasses rules. Absent ⇒ the PORT'S SESSION (#754), so an app listener
  // evaluates rules as whoever this tab signed in as.
  const db = msg.actAs ? lensDb(ctx, msg.actAs) : sessionDb(ctx, port);
  ensurePortSubs(ctx, port);
  const portSubs = ctx.subs.get(port)!;

  if (portSubs.has(msg.subId)) return; // idempotent

  // Session-bound listeners re-establish on this port's auth transitions.
  if (!msg.actAs) {
    ctx.resubscribePortSubs ??= (p) => resubscribeSessionSubs(ctx, p);
    sessionSubsFor(ctx, port).set(msg.subId, msg);
  }

  let target: DocumentReference | CollectionReference | Query;
  let unsub: () => void;
  try {
    target = resolveTarget(db, msg.target);
    unsub = registerListener(ctx, port, msg, target);
  } catch (e) {
    // resolveTarget / onSnapshot can throw synchronously (e.g. an invalid
    // query or a rules-rejected target). Deliver it to the client's onSnapshot
    // error callback as a snap-error instead of letting it escape handleMessage
    // as an unhandled rejection (which would silently deliver NOTHING).
    const { code, message } = serializeError(e);
    post(port, { t: 'snap', subId: msg.subId, value: { __error: { code, message } } });
    return;
  }

  portSubs.set(msg.subId, unsub);
}

/** Register the real sandbox listener for a resolved target; returns its unsub.
 *  Split out of handleSub so the throwing surface (resolveTarget + onSnapshot)
 *  is inside handleSub's try/catch. */
function registerListener(
  _ctx: HostCtx,
  port: PortLike,
  msg: FirestoreSubMessage,
  target: DocumentReference | CollectionReference | Query,
): () => void {
  return onSnapshot(
    target as DocumentReference | Query,
    (snap) => {
      // Detect doc vs query snapshot by shape.
      const snapAny = snap as {
        id?: string;
        path?: string;
        exists?: boolean | (() => boolean);
        data?: () => Record<string, unknown> | undefined;
        docs?: Array<{
          id: string;
          path?: string;
          exists: boolean | (() => boolean);
          data(): Record<string, unknown>;
        }>;
      };

      if (Array.isArray(snapAny.docs)) {
        // Query snapshot
        const docs = snapAny.docs.map((d) =>
          serializeDocSnap(d as Parameters<typeof serializeDocSnap>[0]),
        );
        post(port, { t: 'snap', subId: msg.subId, value: { docs } });
      } else if (snapAny.id !== undefined) {
        // Doc snapshot
        post(port, {
          t: 'snap',
          subId: msg.subId,
          value: serializeDocSnap(snapAny as Parameters<typeof serializeDocSnap>[0]),
        });
      }
    },
    (err) => {
      // Snapshot listener error (e.g. rules changed to deny).
      // We forward as a snap with an __error field so the client can
      // surface it to the original onSnapshot error callback.
      const { code, message } = serializeError(err);
      post(port, { t: 'snap', subId: msg.subId, value: { __error: { code, message } } });
    },
  );
}

function handleUnsub(ctx: HostCtx, port: PortLike, msg: UnsubMessage): void {
  // Drop the session-bound record first — even when the live listener never
  // registered (it errored at sub time), the record must not resurrect the
  // sub on a later session change.
  _sessionSubs.get(ctx)?.get(port)?.delete(msg.subId);
  const portSubs = ctx.subs.get(port);
  if (!portSubs) return;
  const unsub = portSubs.get(msg.subId);
  if (!unsub) return;
  unsub();
  portSubs.delete(msg.subId);
}

// ─── Main dispatch ────────────────────────────────────────────────────────

/**
 * Handle one inbound message from a port.
 *
 * This is the primary unit-testable seam. Tests create a real `HostCtx`
 * backed by an in-memory pyric sandbox and call this function directly
 * with fake port objects, exercising the full op+subscription lifecycle
 * without a real SharedWorker.
 */
/**
 * Agent tool-call dispatch. The bridge peer forwards `tool` messages so the
 * agent runs the canonical sandbox tool set against THIS worker's sandbox (the
 * same instance the app + Studio use) instead of a separate in-page backend.
 * Replies with a `res` whose value is the `{ ok, summary, data }` result.
 */
async function handleTool(ctx: HostCtx, port: PortLike, msg: ToolMessage): Promise<void> {
  try {
    ctx.toolDispatch ??= buildSandboxDispatcher(ctx.sandbox);
    const result = await ctx.toolDispatch(msg.name, msg.args ?? {});
    // Pre-serialize via JSON BEFORE the structured-clone hop over the port. Read
    // results carry real firebase wrapper instances (Timestamp/GeoPoint/Bytes/
    // VectorValue) whose toJSON() produces the canonical agent-facing shapes.
    // structuredClone would strip those prototypes (losing toJSON) and post
    // mangled internals, and would throw DataCloneError on any non-cloneable
    // field. JSON.stringify here runs toJSON() while the instances are intact and
    // yields a plain, clone-safe object — matching the in-page path, which
    // JSON-stringified at the bridge. A serialization error lands in the catch
    // below, never in postMessage.
    ok(port, msg.id, JSON.parse(JSON.stringify(result)));
  } catch (e) {
    fail(port, msg.id, e);
  }
}

export async function handleMessage(
  ctx: HostCtx,
  port: PortLike,
  msg: InboundMessage,
): Promise<void> {
  if (msg.t === 'op') {
    if (isAuthOp(msg.method)) {
      await handleAuthOp(ctx, port, msg);
    } else {
      await handleOp(ctx, port, msg);
    }
  } else if (msg.t === 'sub') {
    if (isAuthSub(msg)) {
      handleAuthSub(ctx, port, msg);
    } else if (isEventSub(msg)) {
      handleEventSub(ctx, port, msg);
    } else {
      handleSub(ctx, port, msg);
    }
  } else if (msg.t === 'unsub') {
    // An unsub may target an auth sub, an event-stream sub, or a Firestore
    // listener — try the cheap routing registries first, then fall through to
    // the Firestore listener teardown.
    if (
      !handleAuthUnsub(ctx, port, msg.subId) &&
      !handleEventUnsub(ctx, port, msg.subId)
    ) {
      handleUnsub(ctx, port, msg);
    }
  } else if (msg.t === 'tool') {
    await handleTool(ctx, port, msg);
  }
}

// ─── Port cleanup ─────────────────────────────────────────────────────────

/**
 * Tear down all subscriptions for a disconnected port.
 * Called when a port's `close` event fires (browser best-effort) or
 * when the entry point explicitly cleans up a port.
 */
export function cleanupPort(ctx: HostCtx, port: PortLike): void {
  // Drop the port's auth subscriptions (routing entries — no real listener
  // to tear down), its per-port session, and its session-bound sub records
  // (#754).
  authSubsFor(ctx).delete(port);
  cleanupPortSession(ctx, port);
  _sessionSubs.get(ctx)?.delete(port);

  // Drop the port's event-stream subscriptions too (also routing entries off
  // the single shared `sandbox.onEvent` subscription — nothing to unsubscribe,
  // just stop fanning out to a dead port).
  eventSubsFor(ctx).delete(port);

  const portSubs = ctx.subs.get(port);
  if (!portSubs) return;
  for (const unsub of portSubs.values()) {
    unsub();
  }
  ctx.subs.delete(port);
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function ensurePortSubs(ctx: HostCtx, port: PortLike): void {
  if (!ctx.subs.has(port)) {
    ctx.subs.set(port, new Map());
  }
}
