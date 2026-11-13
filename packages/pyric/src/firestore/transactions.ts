import { runSdkWrite } from '../sandbox/internal/sdk-write-activity.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { beginFirestoreGroupActivity } from './sdk-activity.js';
import { toFirestoreFirebaseError, withFirestoreFirebaseError } from './errors.js';
/**
 * `pyric/firestore` — transactions + batched writes.
 *
 * `runTransaction` and `writeBatch`. Handles resolve a chainable bound to
 * the current user and freeze that identity for the duration.
 */
import type {
  Transaction as ChainTransaction,
  Query as ChainQuery,
  AdminQuerySnapshot,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  sandboxDb,
  tag,
  converterOf,
  type Target,
} from './state.js';
import { clientStateFor } from './client-state.js';
import { applyConverterToDocSnap, tagSnapshotRefs, wrapSandboxDocSnap } from './snapshots.js';
import { requireDocumentData } from './internal/document-data.js';
import { registerAtomicWriterCreate } from './internal/atomic-create.js';
import { parseChainUpdate } from './chain-update.js';
import { markUserWriteValue } from './sandbox/unescaped-map.js';
import type { SetOptions } from './writes.js';
import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, FirestoreDataConverter, Transaction, TransactionOptions, WriteBatch } from './types.js';

// ─── Transactions + batches ───────────────────────────────────────────

/** Apply the model converter before the backing adapter captures document data. */
function convertSetData(
  ref: DocumentReference<unknown>,
  data: unknown,
  options?: SetOptions,
): DocumentData {
  const converter = converterOf(ref);
  const hasConverter = converter !== undefined && converter !== null;
  let payload = data;
  if (hasConverter) {
    payload = options !== undefined ? converter.toFirestore(data, options) : converter.toFirestore(data);
  }
  return markUserWriteValue(requireDocumentData(payload)) as DocumentData;
}

export async function runTransaction<R>(
  db: Firestore,
  fn: (tx: Transaction) => Promise<R> | R,
  options?: TransactionOptions,
): Promise<R> {
  const target = targetOf(db);
  const client = clientStateFor(target);
  client.markStarted();
  // For sandbox-live, the transaction runs under the auth captured at
  // `runTransaction` start and stays identity-stable until completion.
  const database = sandboxDb(target);
  const touchedPaths = new Set<string>();
  return runSdkWrite(
    beginFirestoreGroupActivity(target, 'runTransaction'),
    async () => {
      const result = await withFirestoreFirebaseError(() => database.runTransaction(async (backing) => {
        touchedPaths.clear();
        let hasWrites = false;
        let stickyError: FirebaseError | undefined;
        const readExistence = new Map<string, boolean>();
        const writtenPaths = new Set<string>();
        const baseGet = modularTransactionRead(backing.get.bind(backing), database, target);
        function get<T = DocumentData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T> & { exists(): boolean }>;
        function get(query: ChainQuery): Promise<AdminQuerySnapshot>;
        async function get<T>(reference: DocumentReference<T> | ChainQuery): Promise<(DocumentSnapshot<T> & { exists(): boolean }) | AdminQuerySnapshot> {
          if (hasWrites) {
            const err = new FirebaseError(
              'invalid-argument',
              'Firestore transactions require all reads to be executed before all writes.',
            );
            stickyError ??= err;
            throw err;
          }
          const readsQuery = 'where' in reference;
          if (readsQuery) return baseGet(reference);
          const snap = await baseGet(reference);
          if (!writtenPaths.has(reference.path) && !readExistence.has(reference.path)) {
            readExistence.set(reference.path, snap.exists());
          }
          return snap;
        }
        const transaction: Transaction = {
          get,
          set(ref, data, options) {
            const payload = convertSetData(ref, data, options);
            hasWrites = true;
            writtenPaths.add(ref.path);
            backing.set(database.doc(ref.path), payload, options);
            touchedPaths.add(ref.path);
            return transaction;
          },
          update(ref, dataOrField: unknown, ...rest: unknown[]) {
            const args = parseChainUpdate('Transaction.update', ref.path, dataOrField, rest);
            hasWrites = true;
            if (readExistence.get(ref.path) === false && !writtenPaths.has(ref.path)) {
              stickyError ??= new FirebaseError(
                'invalid-argument',
                "Can't update a document that doesn't exist.",
              );
              return transaction;
            }
            writtenPaths.add(ref.path);
            backing.update(database.doc(ref.path), ...args);
            touchedPaths.add(ref.path);
            return transaction;
          },
          delete(ref) {
            hasWrites = true;
            writtenPaths.add(ref.path);
            readExistence.set(ref.path, false);
            backing.delete(database.doc(ref.path));
            touchedPaths.add(ref.path);
            return transaction;
          },
        };
        registerAtomicWriterCreate(transaction, (ref, data) => {
          const payload = convertSetData(ref, data);
          hasWrites = true;
          writtenPaths.add(ref.path);
          backing.create(database.doc(ref.path), payload);
          touchedPaths.add(ref.path);
        });
        const out = await fn(transaction);
        if (stickyError) throw stickyError;
        return out;
      }, options));
      for (const path of touchedPaths) client.cachePath(path);
      return result;
    },
  );
}

/** Normalize document results without moving reads outside the transaction. */
function modularTransactionRead(read: ChainTransaction['get'], database: ReturnType<typeof sandboxDb>, target: Target): Transaction['get'] {
  const client = clientStateFor(target);
  function get<T = DocumentData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T> & { exists(): boolean }>;
  function get(query: ChainQuery): Promise<AdminQuerySnapshot>;
  async function get<T>(reference: DocumentReference<T> | ChainQuery): Promise<(DocumentSnapshot<T> & { exists(): boolean }) | AdminQuerySnapshot> {
    const readsQuery = 'where' in reference;
    if (readsQuery) return withFirestoreFirebaseError(() => read(reference));
    const snapshot = await withFirestoreFirebaseError(() => read(database.doc(reference.path)));
    client.cachePath(reference.path);
    const converter = converterOf(reference);
    const hasConverter = converter !== undefined && converter !== null;
    if (hasConverter) {
      return applyConverterToDocSnap(snapshot, converter as FirestoreDataConverter<T>, target, 'document');
    }
    tagSnapshotRefs(snapshot, target);
    return wrapSandboxDocSnap<T>(snapshot, target);
  }
  return get;
}

export function writeBatch(db: Firestore): WriteBatch {
  const target = targetOf(db);
  const client = clientStateFor(target);
  client.markStarted();
  const database = sandboxDb(target);
  const backing = database.batch();
  const touchedPaths = new Set<string>();
  let writes = 0;
  let deletes = 0;
  function withBatchError<R>(fn: () => R): R {
    try {
      return fn();
    } catch (error) {
      throw toFirestoreFirebaseError(error);
    }
  }
  const batch: WriteBatch = {
    set(ref, data, options) {
      const payload = convertSetData(ref, data, options);
      withBatchError(() => backing.set(database.doc(ref.path), payload, options));
      touchedPaths.add(ref.path);
      writes++;
      return batch;
    },
    update(ref, dataOrField: unknown, ...rest: unknown[]) {
      const args = parseChainUpdate('WriteBatch.update', ref.path, dataOrField, rest);
      withBatchError(() => backing.update(database.doc(ref.path), ...args));
      touchedPaths.add(ref.path);
      writes++;
      return batch;
    },
    delete(ref) {
      withBatchError(() => backing.delete(database.doc(ref.path)));
      touchedPaths.add(ref.path);
      deletes++;
      return batch;
    },
    commit(options) {
      return runSdkWrite(
        beginFirestoreGroupActivity(target, 'writeBatch.commit'),
        () => client.runWrite(
          () => withFirestoreFirebaseError(() => backing.commit(options)),
          touchedPaths,
        ),
        () => ({ documentWrites: writes, documentDeletes: deletes }),
      );
    },
  };
  registerAtomicWriterCreate(batch, (ref, data) => {
    const payload = convertSetData(ref, data);
    withBatchError(() => backing.create(database.doc(ref.path), payload));
    touchedPaths.add(ref.path);
    writes++;
  });
  return tag(batch, target);
}
