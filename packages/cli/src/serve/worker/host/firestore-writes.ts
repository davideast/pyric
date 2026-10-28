import { sdkActivity } from 'pyric/sandbox/internal';
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
  FieldPath,
  type Firestore,
  type DocumentReference,
  type SetOptions,
  type Transaction as ModularTransaction,
  type WriteBatch,
} from 'pyric/firestore';
import { atomicWriterCreate } from 'pyric/firestore/internal';
import { assertEncodedDocValueDepth, rehydrateEncodedDocValue, requireDocumentData, type DocValueEncoding } from 'pyric/firestore/internal/value-codec';
import {
  Bytes as RulesBytes,
  Duration as RulesDuration,
  LatLng as RulesLatLng,
  Path as RulesPath,
  Reference as RulesReference,
  Timestamp as RulesTimestamp,
  Vector as RulesVector,
} from 'pyric/rules/internal';
import { FirebaseError } from 'pyric/app';

import type { OpMessage, WriteDescriptor, SentinelMarker, UpdatePayload } from '../protocol.js';
import { isSentinelMarker } from '../protocol.js';
import { assertAtomicList, requireFirestorePath, requireSingleUpdateForm, requireUpdateFields } from '../protocol/firestore-validation.js';
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
  assertEncodedDocValueDepth(value);
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
 * Project a hydrated Firestore document/value tree into a collision-free
 * tagged AST before JSON stringification.
 *
 * WHY NOT `JSON.stringify(document)` WITH `.toJSON()`?
 * ----------------------------------------------------
 * Calling `JSON.stringify` directly on a rehydrated document invokes
 * `RulesValue.toJSON()`, which emits `{ __type: 'timestamp', seconds, nanos }`
 * AFTER `rehydrateEncodedDocValue` has ALREADY unwrapped `{ type: 'pyric/map/1.0', fields }`
 * on user plain maps — causing a real `Timestamp` and a plain user map
 * `{ __type: 'timestamp', seconds, nanos }` to serialize to the exact same
 * JSON string! Disjoint node tags (`['ts', ...]`, `['bytes', ...]`,
 * `['path', ...]`, `['map', ...]`, etc.) guarantee distinct types and plain
 * user maps can NEVER collide.
 */
function canonicalizeHydratedValue(value: unknown): unknown {
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['bool', value];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['num', 'NaN'];
    if (value === Infinity) return ['num', 'Infinity'];
    if (value === -Infinity) return ['num', '-Infinity'];
    if (Object.is(value, -0)) return ['num', '-0'];
    return ['num', value];
  }
  if (typeof value === 'string') return ['str', value];
  if (Array.isArray(value)) return ['arr', value.map(canonicalizeHydratedValue)];
  if (value instanceof RulesTimestamp) return ['ts', value.seconds, value.nanos];
  if (value instanceof RulesBytes) return ['bytes', value.toBase64()];
  if (value instanceof RulesLatLng) return ['geo', value.lat, value.lng];
  if (value instanceof RulesDuration) return ['dur', value.seconds, value.nanos];
  if (value instanceof RulesReference) return ['ref', value.path];
  if (value instanceof RulesPath) {
    const bindings = Object.entries(value.bindings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return ['path', [...value.segments], bindings];
  }
  if (value instanceof RulesVector) return ['vec', [...value.value]];
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      canonicalizeHydratedValue(v),
    ]);
    return ['map', entries];
  }
  return ['unknown', String(value)];
}

function canonicalizeHydratedDoc(document: unknown): string {
  return JSON.stringify(canonicalizeHydratedValue(document));
}

// ─── Update arguments ─────────────────────────────────────────────────────

type UpdateArguments = [Record<string, unknown>] | [FieldPath, unknown, ...unknown[]];

/**
 * Rebuild the `update` arguments of an update payload. A field list becomes
 * the field-and-value form with one `FieldPath` per segment vector, so a
 * segment that contains `.` stays one literal field name.
 */
function prepareUpdateArguments(payload: UpdatePayload, valueEncoding?: DocValueEncoding): UpdateArguments {
  // Batch and transaction descriptors reach here without inbound validation.
  requireSingleUpdateForm(payload);
  const fields = payload.fields;
  if (fields === undefined) {
    return [prepareWriteData(payload.data, valueEncoding) as Record<string, unknown>];
  }
  requireUpdateFields(fields);
  if (fields.length === 0) return [{}];
  const args: unknown[] = [];
  for (const field of fields) {
    args.push(new FieldPath(...field.path), prepareWriteData(field.value, valueEncoding));
  }
  return args as [FieldPath, unknown, ...unknown[]];
}

/** Call an overloaded `update` with prepared arguments in either form. */
function callUpdate<R>(
  args: UpdateArguments,
  withData: (data: Record<string, unknown>) => R,
  withFields: (field: FieldPath, value: unknown, ...moreFieldsAndValues: unknown[]) => R,
): R {
  const [first, value, ...moreFieldsAndValues] = args;
  const isDataForm = args.length === 1;
  if (isDataForm) return withData(first as Record<string, unknown>);
  return withFields(first as FieldPath, value, ...moreFieldsAndValues);
}

// ─── Atomic write helper ──────────────────────────────────────────────────

function applyAtomicWrite(
  db: Firestore,
  writer: WriteBatch | ModularTransaction,
  write: WriteDescriptor,
): void {
  const isInvalidWrite = write === null || typeof write !== 'object' || Array.isArray(write);
  if (isInvalidWrite) {
    throw new FirebaseError('invalid-argument', 'Firestore atomic writes must be objects.');
  }
  const path = requireFirestorePath(write.path);
  const ref = pyricDoc(db, path);
  switch (write.method) {
    case 'create': {
      const data = prepareWriteData(write.data, write.valueEncoding) as Record<string, unknown>;
      atomicWriterCreate(writer, ref, data);
      return;
    }
    case 'set': {
      const data = prepareWriteData(write.data, write.valueEncoding) as Record<string, unknown>;
      writer.set(ref, data, write.options);
      return;
    }
    case 'update':
      callUpdate(
        prepareUpdateArguments(write, write.valueEncoding),
        (data) => writer.update(ref, data),
        (field, value, ...more) => writer.update(ref, field, value, ...more),
      );
      return;
    case 'delete':
      writer.delete(ref);
      return;
    default:
      throw new FirebaseError('invalid-argument', 'Unknown Firestore atomic write method.');
  }
}

// ─── Op handler ────────────────────────────────────────────────────────────

/** The write op methods routed to {@link handleFirestoreWriteOp}. */
const WRITE_METHODS = [
  'setDoc',
  'updateDoc',
  'deleteDoc',
  'addDoc',
  'batchCommit',
  'txnCommit',
] as const satisfies readonly OpMessage['method'][];

const writeMethods = new Set<string>(WRITE_METHODS);

export function isFirestoreWriteOp(method: OpMessage['method']): method is typeof WRITE_METHODS[number] {
  return writeMethods.has(method);
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
        await sdkActivity.silence(() => setDoc(ref, data, msg.options as SetOptions | undefined));
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'updateDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const args = prepareUpdateArguments(msg, msg.valueEncoding);
        await sdkActivity.silence(() => callUpdate(
          args,
          (data) => updateDoc(ref, data),
          (field, value, ...more) => updateDoc(ref, field, value, ...more),
        ));
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'deleteDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        await sdkActivity.silence(() => deleteDoc(ref));
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'addDoc': {
      try {
        const coll = pyricCollection(db, msg.collectionPath);
        const data = prepareWriteData(msg.data, msg.valueEncoding) as Record<string, unknown>;
        const ref = await sdkActivity.silence(() => addDoc(coll, data));
        await bestEffortFlush(ctx, msg.method);
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
        await sdkActivity.silence(() => batch.commit());
        await bestEffortFlush(ctx, msg.method);
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
      const canonicalClientDoc = (json: string, valueEncoding?: DocValueEncoding): string => {
        let data: unknown;
        try {
          data = JSON.parse(json);
        } catch {
          throw new FirebaseError('invalid-argument', 'Firestore transaction read JSON must contain valid JSON.');
        }
        assertEncodedDocValueDepth(data);
        const document = requireDocumentData(rehydrateEncodedDocValue(data, valueEncoding));
        return canonicalizeHydratedDoc(document);
      };

      try {
        assertAtomicList(msg.writes, 'write');
        assertAtomicList(msg.reads, 'read');
        await sdkActivity.silence(() => runTransaction(db, async (tx) => {
          // ── Step 1: validate the read-set ──────────────────────────────
          // Re-read each doc the client touched and compare its live hydrated
          // AST against the client's recorded snapshot AST.
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
            const clientCanonical = clientHadNull ? null : canonicalClientDoc(clientData.json, clientData.valueEncoding);
            const path = requireFirestorePath(read.path);
            const ref = pyricDoc(db, path);
            const currentSnap = await tx.get(ref);
            const existsBool = currentSnap.exists();
            const liveDoc = existsBool ? (ctx.sandbox.admin.getDocument(path) ?? currentSnap.data() ?? null) : null;

            const workerHasNull = liveDoc === null;
            const hasChangedExistence = clientHadNull !== workerHasNull;
            if (hasChangedExistence) throw TXN_ABORT;

            const hasChangedData = clientCanonical !== null && liveDoc !== null
              && clientCanonical !== canonicalizeHydratedDoc(liveDoc);
            if (hasChangedData) throw TXN_ABORT;
          }

          // ── Step 2: apply the queued writes ────────────────────────────
          for (const write of msg.writes) {
            applyAtomicWrite(db, tx, write);
          }
        }));
        await bestEffortFlush(ctx, msg.method);
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
