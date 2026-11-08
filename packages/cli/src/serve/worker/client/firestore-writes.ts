import { runSdkWrite, sdkActivity } from 'pyric/sandbox/internal';
import { beginWorkerFirestoreActivity } from './sdk-activity.js';
/**
 * Firestore write execution — single-document writes, `writeBatch`, and
 * `runTransaction` with read-set validation + retry for multi-tab correctness.
 */

import type { WriteDescriptor, TxnReadEntry, UpdateFieldDescriptor } from '../protocol.js';
import { normalizeMergeFields, parseUpdateArguments } from 'pyric/firestore/internal/update-fields';
import { encodeDocValue, requireDocumentData, DOC_VALUE_ENCODING } from 'pyric/firestore/internal/value-codec';
import { nextId, dataRpc } from './core.js';
import type { ClientDb, DocRefHandle, CollRefHandle } from './handles.js';
import { makeDocSnapshot } from './snapshots.js';
import type { RawDocResult, ClientDocSnapshot } from './snapshots.js';
import { createDocumentReference } from './firestore-reference.js';
import type { DocumentData, FieldPath, FirestoreDataConverter } from 'pyric/firestore';
import { FirebaseError } from 'pyric/app';

interface ClientSetOptions {
  merge?: boolean;
  mergeFields?: readonly (string | FieldPath)[];
}

function captureSetOptions(
  options: ClientSetOptions | undefined,
): { merge?: boolean; mergeFields?: string[] } | undefined {
  if (options === undefined) return undefined;
  const captured: { merge?: boolean; mergeFields?: string[] } = {};
  if (options.merge !== undefined) captured.merge = options.merge;
  if (options.mergeFields !== undefined) {
    captured.mergeFields = normalizeMergeFields(options.mergeFields);
  }
  return captured;
}

/** Convert models before encoding; update payloads bypass model converters. */
function convertSetData(
  ref: { converter: FirestoreDataConverter<unknown> | null },
  data: unknown,
): DocumentData {
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
    const capturedOptions = captureSetOptions(options);
    const payload = convertSetData(ref, data);
    await dataRpc(ref.port, {
      t: 'op',
      id: nextId(),
      method: 'setDoc',
      path: ref.descriptor.path,
      data: encodeDocValue(payload),
      valueEncoding: DOC_VALUE_ENCODING,
      options: capturedOptions,
    });
  });
}

/**
 * Parse an update call with the Web SDK's rules and encode each field for
 * the wire. Field paths travel as segment vectors, so a `FieldPath` segment
 * that contains `.` stays one literal field name.
 */
function encodeUpdate(
  methodName: string,
  ref: DocRefHandle,
  dataOrField: unknown,
  rest: readonly unknown[],
): UpdateFieldDescriptor[] {
  return parseUpdateArguments(methodName, ref.descriptor.path, dataOrField, rest)
    .map((field) => ({ path: [...field.path], value: encodeDocValue(field.value) }));
}

export function updateDoc(ref: DocRefHandle, data: Record<string, unknown>): Promise<void>;
export function updateDoc(
  ref: DocRefHandle,
  field: string | FieldPath,
  value: unknown,
  ...moreFieldsAndValues: unknown[]
): Promise<void>;
export function updateDoc(
  ref: DocRefHandle,
  dataOrField: Record<string, unknown> | string | FieldPath,
  ...valueAndMoreFieldsAndValues: unknown[]
): Promise<void> {
  const fields = encodeUpdate('updateDoc', ref, dataOrField, valueAndMoreFieldsAndValues);
  return runSdkWrite(beginWorkerFirestoreActivity(ref, 'updateDoc', 'operation'), async () => {
    await dataRpc(ref.port, {
      t: 'op',
      id: nextId(),
      method: 'updateDoc',
      path: ref.descriptor.path,
      fields,
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
    const payload = convertSetData(coll, data);
    const result = await dataRpc(coll.port, {
      t: 'op',
      id: nextId(),
      method: 'addDoc',
      collectionPath: coll.descriptor.path,
      data: encodeDocValue(payload),
      valueEncoding: DOC_VALUE_ENCODING,
    }) as { id: string; path: string };

    return createDocumentReference(coll.port, result.path, coll.converter);
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
  update(ref: DocRefHandle, field: string | FieldPath, value: unknown, ...moreFieldsAndValues: unknown[]): ClientWriteBatch;
  delete(ref: DocRefHandle): ClientWriteBatch;
  commit(): Promise<void>;
}

export function writeBatch(db: ClientDb): ClientWriteBatch {
  const writes: WriteDescriptor[] = [];
  const port = db.port;
  let committed = false;

  function assertNotCommitted(): void {
    if (committed) {
      throw new FirebaseError('failed-precondition', 'WriteBatch has already been committed.');
    }
  }

  const batch: ClientWriteBatch = {
    set(ref, data, options) {
      assertNotCommitted();
      const capturedOptions = captureSetOptions(options);
      const payload = convertSetData(ref, data);
      writes.push({ method: 'set', path: ref.descriptor.path, data: encodeDocValue(payload), valueEncoding: DOC_VALUE_ENCODING, options: capturedOptions });
      return batch;
    },
    update(ref: DocRefHandle, dataOrField: unknown, ...rest: unknown[]) {
      assertNotCommitted();
      const fields = encodeUpdate('WriteBatch.update', ref, dataOrField, rest);
      writes.push({ method: 'update', path: ref.descriptor.path, fields, valueEncoding: DOC_VALUE_ENCODING });
      return batch;
    },
    delete(ref) {
      assertNotCommitted();
      writes.push({ method: 'delete', path: ref.descriptor.path });
      return batch;
    },
    async commit() {
      assertNotCommitted();
      committed = true;
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
  set<T = DocumentData>(ref: DocRefHandle<T>, data: T, options?: ClientSetOptions): ClientTransaction;
  update(ref: DocRefHandle, data: Record<string, unknown>): ClientTransaction;
  update(ref: DocRefHandle, field: string | FieldPath, value: unknown, ...moreFieldsAndValues: unknown[]): ClientTransaction;
  delete(ref: DocRefHandle): ClientTransaction;
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
  options?: { maxAttempts?: number },
): Promise<R> {
  return runSdkWrite(beginGroupActivity(db, 'runTransaction'), async () => {
    const port = db.port;
    const maxAttempts = options?.maxAttempts ?? TXN_MAX_ATTEMPTS;

    let attemptsRemaining = maxAttempts;
    let hasAttempts = attemptsRemaining > 0;
    while (hasAttempts) {
      attemptsRemaining -= 1;
      // Fresh read-set and write buffer for each attempt.
      const reads: TxnReadEntry[] = [];
      const writes: WriteDescriptor[] = [];
      let hasWrites = false;
      let stickyError: FirebaseError | undefined;
      const readExistence = new Map<string, boolean>();
      const writtenPaths = new Set<string>();

      const txn: ClientTransaction = {
        async get(ref) {
          if (hasWrites) {
            const err = new FirebaseError(
              'invalid-argument',
              'Firestore transactions require all reads to be executed before all writes.',
            );
            stickyError ??= err;
            throw err;
          }
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
          let readData: typeof serialized | null = null;
          if (hasData) {
            readData = serialized;
          }
          reads.push({
            path: ref.descriptor.path,
            data: readData,
          });
          if (!writtenPaths.has(ref.descriptor.path) && !readExistence.has(ref.descriptor.path)) {
            readExistence.set(ref.descriptor.path, Boolean(rawResult.exists));
          }

          return makeDocSnapshot(rawResult, ref.port, ref);
        },
        set(ref, data, options) {
          const capturedOptions = captureSetOptions(options);
          const payload = convertSetData(ref, data);
          hasWrites = true;
          writtenPaths.add(ref.descriptor.path);
          writes.push({ method: 'set', path: ref.descriptor.path, data: encodeDocValue(payload), valueEncoding: DOC_VALUE_ENCODING, options: capturedOptions });
          return txn;
        },
        update(ref: DocRefHandle, dataOrField: unknown, ...rest: unknown[]) {
          const fields = encodeUpdate('Transaction.update', ref, dataOrField, rest);
          hasWrites = true;
          if (readExistence.get(ref.descriptor.path) === false && !writtenPaths.has(ref.descriptor.path)) {
            stickyError ??= new FirebaseError(
              'invalid-argument',
              "Can't update a document that doesn't exist.",
            );
            return txn;
          }
          writtenPaths.add(ref.descriptor.path);
          writes.push({ method: 'update', path: ref.descriptor.path, fields, valueEncoding: DOC_VALUE_ENCODING });
          return txn;
        },
        delete(ref) {
          hasWrites = true;
          writtenPaths.add(ref.descriptor.path);
          readExistence.set(ref.descriptor.path, false);
          writes.push({ method: 'delete', path: ref.descriptor.path });
          return txn;
        },
      };

      const result = await updateFn(txn);
      if (stickyError) throw stickyError;

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
    throw new FirebaseError(
      'failed-precondition',
      `Transaction failed after ${maxAttempts} attempts due to repeated conflicts. ` +
        'Another tab is concurrently writing to the same documents.',
    );
  });
}

function beginGroupActivity(db: ClientDb, method: string) {
  return sdkActivity.begin({ app: db.port, method, kind: 'operation',
    source: { service: 'firestore', target: '/', key: 'database' } });
}
