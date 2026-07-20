/**
 * SharedWorker host — Firestore write ops (single writes + batch + transaction).
 *
 * `setDoc`/`updateDoc`/`deleteDoc`/`addDoc`, the all-or-nothing `batchCommit`,
 * and the full-fidelity `txnCommit` (read-set validation for multi-tab
 * correctness). Owns the write-payload preparation helpers: sentinel
 * reconstruction + marker rehydration (`prepareWriteData`), the batch-write
 * applier, and the transaction read-set canonicalizer.
 *
 * Routed here by the host dispatcher (host/dispatch.ts) with the op's resolved
 * Firestore handle (`db`). Never imports the dispatcher.
 */

import {
  doc as pyricDoc,
  collection as pyricCollection,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  runTransaction,
  writeBatch,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  deleteField,
  type Firestore,
  type DocumentReference,
  type SetOptions,
} from 'pyric/firestore';
import { rehydrateDocValue } from 'pyric/firestore/internal/value-codec';

import type { OpMessage, WriteDescriptor, TxnReadEntry, SentinelMarker } from '../protocol.js';
import { serializeDocData, isSentinelMarker } from '../protocol.js';
import { type HostCtx, type PortLike, post, ok, fail, bestEffortFlush } from '../host-context.js';

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
    // Leave CLASS instances intact (Timestamp/Bytes/LatLng rehydrated by
    // prepareWriteData below, or FieldValue objects): walking their entries
    // into a plain object would strip the prototype the sandbox keys on.
    // Sentinel markers only ever live in plain JSON containers.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveSentinels(v);
    }
    return out;
  }
  return value;
}

/**
 * Prepare an incoming WRITE payload for the sandbox: rehydrate marker-shaped
 * scalars into REAL wrapper instances, then rebuild FieldValue sentinels.
 *
 * WHY REHYDRATE WRITES (spike gap 4): over the JSON relay legs a Node-side
 * `Timestamp`/`Bytes`/`GeoPoint` arrives as its `toJSON()` marker
 * (`{ type: 'firestore/timestamp/1.0', … }` or `{ __type: 'timestamp', … }`).
 * Without rehydration the worker STORES the marker as a plain map — reads
 * mask the bug (the read path rehydrates), but in-worker rules comparisons
 * and `orderBy` over that field see a map, not a timestamp. `rehydrateDocValue`
 * is the same canonical codec the read path / persistence uses, so the wire,
 * store, and IDB formats stay one format.
 *
 * Order matters: rehydration first (it passes `__sentinel` markers through
 * as plain objects, rehydrating any marker-shaped values nested inside
 * arrayUnion/arrayRemove), then sentinel resolution (which now skips the
 * freshly rehydrated class instances — see resolveSentinels).
 */
export function prepareWriteData(value: unknown): unknown {
  return resolveSentinels(rehydrateDocValue(value));
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

// ─── Transaction read-set canonicalization helpers ─────────────────────────

/**
 * Rebuild a JSON-flattened `Uint8Array` (an index-keyed `{ "0": n, … }`
 * map) and encode it as base64url without padding — the exact form
 * `pyric/rules`' `Bytes.toBase64()` emits. Backs the transaction read-set
 * canonicalizer's handling of prototype-stripped `Bytes` clones.
 */
/** Timestamp/Duration stripped-clone key set (they share field names). */
const TS_CLONE_KEYS = ['typeName', 'seconds', 'nanos'] as const;

/** Does `o` carry EXACTLY these own enumerable keys (no more, no fewer)?
 *  Backs the transaction canonicalizer's strict clone-shape matching. */
function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => k in o);
}

function indexMapToBase64Url(data: unknown): string {
  const map = (data ?? {}) as Record<string, number>;
  const keys = Object.keys(map);
  const bytes = new Uint8Array(keys.length);
  for (let i = 0; i < keys.length; i++) bytes[i] = map[String(i)] ?? 0;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    const data = prepareWriteData(w.data) as Record<string, unknown>;
    b.set(ref, data, w.options as SetOptions | undefined);
  } else if (w.method === 'update') {
    const data = prepareWriteData(w.data) as Record<string, unknown>;
    b.update(ref, data);
  } else if (w.method === 'delete') {
    b.delete(ref);
  }
}

// ─── Op handler ────────────────────────────────────────────────────────────

/** The write op methods routed to {@link handleFirestoreWriteOp}. */
const WRITE_METHODS = new Set<string>([
  'setDoc',
  'updateDoc',
  'deleteDoc',
  'addDoc',
  'batchCommit',
  'txnCommit',
]);

export function isFirestoreWriteOp(method: OpMessage['method']): boolean {
  return WRITE_METHODS.has(method);
}

export async function handleFirestoreWriteOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
  db: Firestore,
): Promise<void> {
  switch (msg.method) {
    case 'setDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const data = prepareWriteData(msg.data) as Record<string, unknown>;
        await setDoc(ref, data, msg.options as SetOptions | undefined);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'updateDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const data = prepareWriteData(msg.data) as Record<string, unknown>;
        await updateDoc(ref, data);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'deleteDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        await deleteDoc(ref);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'addDoc': {
      try {
        const coll = pyricCollection(db, msg.collectionPath);
        const data = prepareWriteData(msg.data) as Record<string, unknown>;
        const ref = await addDoc(coll, data);
        await bestEffortFlush(ctx);
        ok(port, msg.id, { id: ref.id, path: ref.path });
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
        await bestEffortFlush(ctx);
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
       * SERIALIZED-FORM EQUALITY — VIA THE CANONICAL CODEC
       * ---------------------------------------------------
       * Both JSON strings are CANONICALIZED before comparison:
       * `JSON.stringify(rehydrateDocValue(JSON.parse(json)))`. Raw string
       * equality is NOT safe here even within one process, because the two
       * read paths yield DIFFERENT wrapper classes for the same stored
       * value: `getDoc` (what the client's read-set echoes) returns
       * `firebase/firestore` classes whose `Timestamp.toJSON()` emits
       * `{ seconds, nanoseconds, type }`, while the transaction's
       * validation re-read comes through the admin-compat wrapper whose
       * `Timestamp.toJSON()` emits `{ type, seconds, nanoseconds }` — same
       * value, different key order, different string. Rehydrating both
       * sides through the ONE shared codec
       * (`pyric/firestore/internal/value-codec`)
       * collapses every marker family into the same wrapper classes with
       * deterministic `toJSON()` key order, so string equality ↔ value
       * equality again — an unmodified doc can never phantom-abort (which
       * would livelock the client's retry loop), while a real concurrent
       * write still mismatches. Plain-map key order is preserved by both
       * paths from the same stored object, so it stays comparable.
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

      /**
       * Canonicalize a serialized doc-data JSON string (see
       * SERIALIZED-FORM EQUALITY above). Two normalization passes:
       *
       *   1. `rehydrateDocValue` collapses the marker families (`__type`
       *      persistence markers and `firebase/firestore` `toJSON()`
       *      markers) into the one set of wrapper classes, whose
       *      `toJSON()` re-emits a single deterministic form.
       *   2. The stringify replacer additionally normalizes PROTOTYPE-
       *      STRIPPED wrapper clones — the sandbox transaction's
       *      capture-by-value `structuredClone` turns a stored rules
       *      wrapper into a plain `{ typeName, … }` object that neither
       *      marker family matches, so without this pass an unmodified
       *      typed doc would never compare equal to the client's getDoc
       *      echo (a guaranteed phantom abort → retry livelock).
       */
      const canonicalDocJson = (json: string): string =>
        JSON.stringify(rehydrateDocValue(JSON.parse(json)), (_key, v) => {
          if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
          const o = v as Record<string, unknown>;
          if (typeof o.typeName !== 'string' || o.__type !== undefined) return v;
          // Re-shape a stripped rules-wrapper clone into the wrapper's own
          // canonical toJSON marker form (kept in sync with pyric/rules'
          // simulator/wrappers/* instance fields + toJSON()) — but ONLY
          // when the key set EXACTLY matches that wrapper's own-field
          // shape. A looser match would silently DROP extra keys from
          // user data that merely resembles a clone, collapsing two
          // genuinely different docs into one canonical form and letting
          // a concurrent write commit undetected (false equality). A
          // near-miss map passes through unchanged — worst case is a
          // spurious abort + retry, never a lost update.
          switch (o.typeName) {
            case 'timestamp':
              return hasExactKeys(o, TS_CLONE_KEYS)
                ? { __type: 'timestamp', seconds: o.seconds, nanos: o.nanos }
                : v;
            case 'duration':
              return hasExactKeys(o, TS_CLONE_KEYS)
                ? { __type: 'duration', seconds: o.seconds, nanos: o.nanos }
                : v;
            case 'latlng':
              return hasExactKeys(o, ['typeName', 'lat', 'lng'])
                ? { __type: 'latlng', lat: o.lat, lng: o.lng }
                : v;
            case 'reference':
              return hasExactKeys(o, ['typeName', 'path'])
                ? { __type: 'reference', path: o.path }
                : v;
            case 'path':
              return hasExactKeys(o, ['typeName', 'segments', 'bindings'])
                ? { __type: 'path', segments: o.segments }
                : v;
            case 'bytes':
              // The Uint8Array field serialized as an index-keyed map;
              // rebuild and emit Bytes.toJSON()'s base64url form.
              return hasExactKeys(o, ['typeName', 'data'])
                ? { __type: 'bytes', base64: indexMapToBase64Url(o.data) }
                : v;
            default:
              return v;
          }
        });

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
            if (
              !clientHadNull &&
              !workerHasNull &&
              canonicalDocJson(r.data!.json) !== canonicalDocJson(currentSerialized!.json)
            ) {
              // Data changed by another tab.
              throw TXN_ABORT;
            }
          }

          // ── Step 2: apply the queued writes ────────────────────────────
          for (const w of msg.writes) {
            const ref = pyricDoc(db, w.path);
            if (w.method === 'set') {
              const data = prepareWriteData(w.data) as Record<string, unknown>;
              modularTx.set(ref, data, w.options as SetOptions | undefined);
            } else if (w.method === 'update') {
              const data = prepareWriteData(w.data) as Record<string, unknown>;
              modularTx.update(ref, data);
            } else if (w.method === 'delete') {
              modularTx.delete(ref);
            }
          }
        });
        await bestEffortFlush(ctx);
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

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
