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
import { applyConverterToDocSnap, tagSnapshotRefs, wrapSandboxDocSnap } from './snapshots.js';
import { requireDocumentData } from './internal/document-data.js';
import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, FirestoreDataConverter, Transaction, TransactionOptions, WriteBatch } from './types.js';

// ─── Transactions + batches ───────────────────────────────────────────

/** Apply the model converter before the backing adapter captures document data. */
function convertSetData(ref: DocumentReference<unknown>, data: unknown): DocumentData {
  const converter = converterOf(ref);
  const hasConverter = converter !== undefined && converter !== null;
  let payload = data;
  if (hasConverter) payload = converter.toFirestore(data);
  return requireDocumentData(payload);
}

export async function runTransaction<R>(
  db: Firestore,
  fn: (tx: Transaction) => Promise<R> | R,
  options?: TransactionOptions,
): Promise<R> {
  const target = targetOf(db);
  // For sandbox-live, the transaction runs under the auth captured at
  // `runTransaction` start and stays identity-stable until completion.
  const database = sandboxDb(target);
  return database.runTransaction((backing) => {
    const transaction: Transaction = {
      get: modularTransactionRead(backing.get.bind(backing), database, target),
      set(ref, data, options) {
        const payload = convertSetData(ref, data);
        backing.set(database.doc(ref.path), payload, options);
        return transaction;
      },
      update(ref, data) {
        backing.update(database.doc(ref.path), data);
        return transaction;
      },
      delete(ref) {
        backing.delete(database.doc(ref.path));
        return transaction;
      },
    };
    return fn(transaction);
  }, options);
}

/** Normalize document results without moving reads outside the transaction. */
function modularTransactionRead(read: ChainTransaction['get'], database: ReturnType<typeof sandboxDb>, target: Target): Transaction['get'] {
  function get<T = DocumentData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T> & { exists(): boolean }>;
  function get(query: ChainQuery): Promise<AdminQuerySnapshot>;
  async function get<T>(reference: DocumentReference<T> | ChainQuery): Promise<(DocumentSnapshot<T> & { exists(): boolean }) | AdminQuerySnapshot> {
    const readsQuery = 'where' in reference;
    if (readsQuery) return read(reference);
    const snapshot = await read(database.doc(reference.path));
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
  const database = sandboxDb(target);
  const backing = database.batch();
  const batch: WriteBatch = {
    set(ref, data, options) {
      const payload = convertSetData(ref, data);
      backing.set(database.doc(ref.path), payload, options);
      return batch;
    },
    update(ref, data) {
      backing.update(database.doc(ref.path), data);
      return batch;
    },
    delete(ref) {
      backing.delete(database.doc(ref.path));
      return batch;
    },
    commit(options) {
      return backing.commit(options);
    },
  };
  return tag(batch, target);
}
