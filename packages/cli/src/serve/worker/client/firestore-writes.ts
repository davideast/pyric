import { runSdkWrite, sdkActivity } from 'pyric/sandbox/internal';
import { beginWorkerFirestoreActivity } from './sdk-activity.js';
/**
 * Firestore write execution — single-document writes, `writeBatch`, and
 * `runTransaction` with read-set validation + retry for multi-tab correctness.
 */

import type { WriteDescriptor, TxnReadEntry } from '../protocol.js';
import { encodeDocValue, requireDocumentData, DOC_VALUE_ENCODING } from 'pyric/firestore/internal/value-codec';
import { nextId, dataRpc } from './core.js';
import type { ClientDb, DocRefHandle, CollRefHandle } from './handles.js';
import { makeDocSnapshot } from './snapshots.js';
import type { RawDocResult, ClientDocSnapshot } from './snapshots.js';
import { createDocumentReference } from './firestore-reference.js';
import type { DocumentData } from 'pyric/firestore';

interface ClientSetOptions {
  merge?: boolean;
  mergeFields?: string[];
}

function captureSetOptions(options: ClientSetOptions | undefined): ClientSetOptions | undefined {
  const hasOptions = options !== undefined;
  if (hasOptions) return { ...options, mergeFields: options.mergeFields?.slice() };
  return undefined;
}

/** Convert models before encoding; update payloads bypass model converters. */
function convertSetData(ref: DocRefHandle, data: unknown): DocumentData {
  const converter = ref.converter;
  const hasConverter = converter !== null;
  let payload = data;
  if (hasConverter) payload = converter.toFirestore(data);
  return requireDocumentData(payload);
}

export async function setDoc<T = DocumentData>(
  ref: DocRefHandle<T>,
  data: T,
  options?: ClientSetOptions,
): Promise<void> {
  return runSdkWrite(beginWorkerFirestoreActivity(ref, 'setDoc', 'operation'), async () => {
    const payload = convertSetData(ref, data);
    await dataRpc(ref.port, {
      t: 'op',
      id: nextId(),
      method: 'setDoc',
      path: ref.descriptor.path,
      data: encodeDocValue(payload),
      valueEncoding: DOC_VALUE_ENCODING,
      options,
    });
  });
}

export async function updateDoc(
  ref: DocRefHandle,
  data: Record<string, unknown>,
): Promise<void> {
  return runSdkWrite(beginWorkerFirestoreActivity(ref, 'updateDoc', 'operation'), async () => {
    await dataRpc(ref.port, {
      t: 'op',
      id: nextId(),
      method: 'updateDoc',
      path: ref.descriptor.path,
      data: encodeDocValue(data),
      valueEncoding: DOC_VALUE_ENCODING,
    });
  });
}

export async function deleteDoc(ref: DocRefHandle): Promise<void> {
  return runSdkWrite(beginWorkerFirestoreActivity(ref, 'deleteDoc', 'operation'), async () => {
    await dataRpc(ref.port, {
      t: 'op',
      id: nextId(),
      method: 'deleteDoc',
      path: ref.descriptor.path,
    });
  });
}

export async function addDoc(
  coll: CollRefHandle,
  data: Record<string, unknown>,
): Promise<DocRefHandle> {
  return runSdkWrite(beginWorkerFirestoreActivity(coll, 'addDoc', 'operation'), async () => {
    const result = await dataRpc(coll.port, {
      t: 'op',
      id: nextId(),
      method: 'addDoc',
      collectionPath: coll.descriptor.path,
      data: encodeDocValue(data),
      valueEncoding: DOC_VALUE_ENCODING,
    }) as { id: string; path: string };

    return createDocumentReference(coll.port, result.path);
  });
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
  set<T = DocumentData>(ref: DocRefHandle<T>, data: T, options?: ClientSetOptions): ClientWriteBatch;
  update(ref: DocRefHandle, data: Record<string, unknown>): ClientWriteBatch;
  delete(ref: DocRefHandle): ClientWriteBatch;
  commit(): Promise<void>;
}

export function writeBatch(db: ClientDb): ClientWriteBatch {
  const writes: WriteDescriptor[] = [];
  const port = db.port;

  const batch: ClientWriteBatch = {
    set(ref, data, options) {
      const capturedOptions = captureSetOptions(options);
      const payload = convertSetData(ref, data);
      writes.push({ method: 'set', path: ref.descriptor.path, data: encodeDocValue(payload), valueEncoding: DOC_VALUE_ENCODING, options: capturedOptions });
      return batch;
    },
    update(ref, data) {
      writes.push({ method: 'update', path: ref.descriptor.path, data: encodeDocValue(data), valueEncoding: DOC_VALUE_ENCODING });
      return batch;
    },
    delete(ref) {
      writes.push({ method: 'delete', path: ref.descriptor.path });
      return batch;
    },
    async commit() {
      await runSdkWrite(beginGroupActivity(db, 'writeBatch.commit'), () => dataRpc(port, {
        t: 'op',
        id: nextId(),
        method: 'batchCommit',
        writes: [...writes],
      }), () => ({
        documentWrites: writes.filter(write => write.method !== 'delete').length,
        documentDeletes: writes.filter(write => write.method === 'delete').length,
      }));
    },
  };
  return batch;
}

// ─── runTransaction ──────────────────────────────────────────────────────

/** Client-side transaction handle. */
export interface ClientTransaction {
  get<T = DocumentData>(ref: DocRefHandle<T>): Promise<ClientDocSnapshot<T>>;
  set<T = DocumentData>(ref: DocRefHandle<T>, data: T, options?: ClientSetOptions): void;
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
  return runSdkWrite(beginGroupActivity(db, 'runTransaction'), async () => {
    const port = db.port;

    let attemptsRemaining = TXN_MAX_ATTEMPTS;
    let hasAttempts = attemptsRemaining > 0;
    while (hasAttempts) {
      attemptsRemaining -= 1;
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
            activity: { groupKind: 'transaction' },
          }) as RawDocResult;

          // Record the raw serialized data (or null) in the read-set.
          // We preserve the wire-form SerializedDocData so the worker can
          // re-serialize the current doc and compare JSON strings.
          const serialized = rawResult.data;
          const hasData = rawResult.exists && serialized !== undefined;
          reads.push({
            path: ref.descriptor.path,
            data: hasData ? serialized : null,
          });

          return makeDocSnapshot(rawResult, ref.port, ref);
        },
        set(ref, data, options) {
          const capturedOptions = captureSetOptions(options);
          const payload = convertSetData(ref, data);
          writes.push({ method: 'set', path: ref.descriptor.path, data: encodeDocValue(payload), valueEncoding: DOC_VALUE_ENCODING, options: capturedOptions });
        },
        update(ref, data) {
          writes.push({ method: 'update', path: ref.descriptor.path, data: encodeDocValue(data), valueEncoding: DOC_VALUE_ENCODING });
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
        const isErrorObject = err !== null && typeof err === 'object';
        const isConflict = isErrorObject && 'code' in err && err.code === 'aborted';
        if (isConflict) {
          // Conflict detected — retry updateFn on the next attempt.
          hasAttempts = attemptsRemaining > 0;
          continue;
        }
        // Permission-denied, not-found, etc. — propagate immediately.
        throw err;
      }
    }

    // Exceeded max attempts.
    const abortErr = Object.assign(
      new Error(
        `Transaction failed after ${TXN_MAX_ATTEMPTS} attempts due to repeated conflicts. ` +
        'Another tab is concurrently writing to the same documents.',
      ),
      { code: 'aborted' },
    );
    throw abortErr;
  });
}

function beginGroupActivity(db: ClientDb, method: string) {
  return sdkActivity.begin({ app: db.port, method, kind: 'operation',
    source: { service: 'firestore', target: '/', key: 'database' } });
}
