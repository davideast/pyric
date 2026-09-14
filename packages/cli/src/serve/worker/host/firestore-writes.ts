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
import { rehydrateEncodedDocValue, requireDocumentData, type DocValueEncoding } from 'pyric/firestore/internal/value-codec';
import { FirebaseError } from 'pyric/app';

import type { OpMessage, WriteDescriptor, SentinelMarker, SerializedDocData } from '../protocol.js';
import { serializeDocData, isSentinelMarker } from '../protocol.js';
import { assertAtomicList, requireFirestorePath } from '../protocol/firestore-validation.js';
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
 * Decode document values using the request's declared encoding, then rebuild
 * write transforms. Legacy callers retain their original marker contract.
 * Value decoding never executes a transform; sentinel resolution preserves
 * decoded scalar instances and prepares transforms for the sandbox write.
 */
export function prepareWriteData(value: unknown, valueEncoding?: DocValueEncoding): unknown {
  return resolveSentinels(rehydrateEncodedDocValue(value, valueEncoding));
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

// ─── Atomic write helper ──────────────────────────────────────────────────

type AtomicWriter = {
  set(ref: DocumentReference, data: Record<string, unknown>, options?: SetOptions): void;
  update(ref: DocumentReference, data: Record<string, unknown>): void;
  delete(ref: DocumentReference): void;
};

function applyAtomicWrite(
  db: Firestore,
  writer: AtomicWriter,
  write: WriteDescriptor,
): void {
  const isInvalidWrite = write === null || typeof write !== 'object' || Array.isArray(write);
  if (isInvalidWrite) {
    throw new FirebaseError('invalid-argument', 'Firestore atomic writes must be objects.');
  }
  const path = requireFirestorePath(write.path);
  const ref = pyricDoc(db, path);
  switch (write.method) {
    case 'set': {
      const data = prepareWriteData(write.data, write.valueEncoding) as Record<string, unknown>;
      writer.set(ref, data, write.options);
      return;
    }
    case 'update': {
      const data = prepareWriteData(write.data, write.valueEncoding) as Record<string, unknown>;
      writer.update(ref, data);
      return;
    }
    case 'delete':
      writer.delete(ref);
      return;
    default:
      throw new FirebaseError('invalid-argument', 'Unknown Firestore atomic write method.');
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
        const path = requireFirestorePath(msg.path);
        const ref = pyricDoc(db, path);
        const data = prepareWriteData(msg.data, msg.valueEncoding) as Record<string, unknown>;
        await setDoc(ref, data, msg.options as SetOptions | undefined);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'updateDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const data = prepareWriteData(msg.data, msg.valueEncoding) as Record<string, unknown>;
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
        const data = prepareWriteData(msg.data, msg.valueEncoding) as Record<string, unknown>;
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
        assertAtomicList(msg.writes, 'write');
        const batch = writeBatch(db);
        for (const w of msg.writes) {
          applyAtomicWrite(db, batch, w);
        }
        await batch.commit();
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
       * the declared value encoding before JSON stringification. Raw string
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
       *   1. `rehydrateEncodedDocValue` uses each envelope's encoding and collapses the marker families (`__type`
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
      const canonicalDocJson = (json: string, valueEncoding?: DocValueEncoding): string => {
        let data: unknown;
        try {
          data = JSON.parse(json);
        } catch {
          throw new FirebaseError('invalid-argument', 'Firestore transaction read JSON must contain valid JSON.');
        }
        const document = requireDocumentData(rehydrateEncodedDocValue(data, valueEncoding));
        return JSON.stringify(document, (_key, v: unknown) => {
          const isNonMapValue = v === null || typeof v !== 'object' || Array.isArray(v);
          if (isNonMapValue) return v;
          const o = v as Record<string, unknown>;
          const isNotWrapperClone = typeof o.typeName !== 'string' || o.__type !== undefined;
          if (isNotWrapperClone) return v;
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
            case 'timestamp': {
              const hasTimestampFields = hasExactKeys(o, TS_CLONE_KEYS);
              if (hasTimestampFields) return { __type: 'timestamp', seconds: o.seconds, nanos: o.nanos };
              return v;
            }
            case 'duration': {
              const hasDurationFields = hasExactKeys(o, TS_CLONE_KEYS);
              if (hasDurationFields) return { __type: 'duration', seconds: o.seconds, nanos: o.nanos };
              return v;
            }
            case 'latlng': {
              const hasLocationFields = hasExactKeys(o, ['typeName', 'lat', 'lng']);
              if (hasLocationFields) return { __type: 'latlng', lat: o.lat, lng: o.lng };
              return v;
            }
            case 'reference': {
              const hasReferenceFields = hasExactKeys(o, ['typeName', 'path']);
              if (hasReferenceFields) return { __type: 'reference', path: o.path };
              return v;
            }
            case 'path': {
              const hasPathFields = hasExactKeys(o, ['typeName', 'segments', 'bindings']);
              if (hasPathFields) return { __type: 'path', segments: o.segments };
              return v;
            }
            case 'bytes': {
              // Rebuild the Uint8Array's index-keyed map in canonical base64url form.
              const hasByteFields = hasExactKeys(o, ['typeName', 'data']);
              if (hasByteFields) return { __type: 'bytes', base64: indexMapToBase64Url(o.data) };
              return v;
            }
            default:
              return v;
          }
        });
      };

      try {
        assertAtomicList(msg.writes, 'write');
        assertAtomicList(msg.reads, 'read');
        await runTransaction(db, async (tx) => {
          // ── Step 1: validate the read-set ──────────────────────────────
          // Re-read each doc the client touched and compare its current
          // serialized form against what the client recorded at read time.
          for (const read of msg.reads) {
            const isInvalidRead = read === null || typeof read !== 'object' || Array.isArray(read);
            if (isInvalidRead) {
              throw new FirebaseError('invalid-argument', 'Firestore transaction reads must be objects.');
            }
            const clientData = read.data;
            const isInvalidReadData = clientData !== null && (typeof clientData !== 'object' || Array.isArray(clientData));
            if (isInvalidReadData) {
              throw new FirebaseError('invalid-argument', 'Firestore transaction read data must be a serialized document or null.');
            }
            const isInvalidReadJson = clientData !== null && typeof clientData.json !== 'string';
            if (isInvalidReadJson) {
              throw new FirebaseError('invalid-argument', 'Firestore transaction read JSON must be a string.');
            }
            const clientHadNull = clientData === null;
            const clientJson = clientHadNull ? null : canonicalDocJson(clientData.json, clientData.valueEncoding);
            const path = requireFirestorePath(read.path);
            const ref = pyricDoc(db, path);
            const currentSnap = await tx.get(ref);
            const existsBool = currentSnap.exists();

            // Retain the original short-circuiting and snapshot access timing.
            let currentSerialized: SerializedDocData | null = null;
            const hasCurrentData = existsBool && Boolean(currentSnap.data());
            if (hasCurrentData) {
              currentSerialized = serializeDocData(currentSnap.data() as Record<string, unknown>);
            }

            const workerHasNull = currentSerialized === null;
            const hasChangedExistence = clientHadNull !== workerHasNull;
            if (hasChangedExistence) throw TXN_ABORT;

            const hasChangedData = clientJson !== null && currentSerialized !== null
              && clientJson !== canonicalDocJson(currentSerialized.json, currentSerialized.valueEncoding);
            if (hasChangedData) throw TXN_ABORT;
          }

          // ── Step 2: apply the queued writes ────────────────────────────
          for (const write of msg.writes) {
            applyAtomicWrite(db, tx, write);
          }
        });
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) {
        const isReadConflict = e === TXN_ABORT;
        if (isReadConflict) {
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
