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
import type { OfflineMutation } from './sandbox/client-offline-overlay.js';
import {
  normalizeMergeFields,
  parseUpdateArguments,
  updateFieldsData,
} from './sandbox/update-fields.js';
import { markUserWriteValue } from './sandbox/unescaped-map.js';
import type { SetOptions } from './writes.js';
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  FirestoreDataConverter,
  PartialWithFieldValue,
  Transaction,
  TransactionOptions,
  WithFieldValue,
  WriteBatch,
} from './types.js';

// ─── Transactions + batches ───────────────────────────────────────────

/** Apply the model converter before the backing adapter captures document data. */
function convertSetData<T>(
  ref: DocumentReference<T>,
  data: PartialWithFieldValue<T> | WithFieldValue<T>,
  options?: SetOptions,
): DocumentData {
  const converter = converterOf(ref) as FirestoreDataConverter<T> | null | undefined;
  let payload: unknown = data;
  if (converter !== undefined && converter !== null) {
    const usesMergeConverter =
      options !== undefined && (Boolean(options.merge) || options.mergeFields !== undefined);
    if (usesMergeConverter) {
      payload = converter.toFirestore(data, options);
    } else {
      payload = converter.toFirestore(data as WithFieldValue<T>);
    }
  }
  return markUserWriteValue(requireDocumentData(payload)) as DocumentData;
}

function assertMatchingDatabaseTarget(owner: Target, candidate: object): void {
  const refTarget = targetOf(candidate);
  const ownerDb = owner.databaseId ?? '(default)';
  const refDb = refTarget.databaseId ?? '(default)';
  if (ownerDb !== refDb) {
    throw new FirebaseError(
      'invalid-argument',
      'Provided document reference is from a different Firestore instance.',
    );
  }
}

export async function runTransaction<R>(
  db: Firestore,
  fn: (tx: Transaction) => Promise<R> | R,
  options?: TransactionOptions,
): Promise<R> {
  const target = targetOf(db);
  const client = clientStateFor(target);
  const missingDb = client.syncMissingDatabaseOfflineState(target);
  if (missingDb) {
    throw new FirebaseError('unavailable', 'Failed to get document because the client is offline.');
  }
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
          assertMatchingDatabaseTarget(target, reference as object);
          const snap = await baseGet(reference);
          if (!writtenPaths.has(reference.path) && !readExistence.has(reference.path)) {
            readExistence.set(reference.path, snap.exists());
          }
          return snap;
        }
        const transaction: Transaction = {
          get,
          set<T = DocumentData>(
            ref: DocumentReference<T>,
            data: PartialWithFieldValue<T> | WithFieldValue<T>,
            options?: SetOptions,
          ) {
            assertMatchingDatabaseTarget(target, ref as object);
            const payload = convertSetData(ref, data, options);
            hasWrites = true;
            writtenPaths.add(ref.path);
            backing.set(database.doc(ref.path), payload, options);
            touchedPaths.add(ref.path);
            return transaction;
          },
          update(ref, dataOrField: unknown, ...rest: unknown[]) {
            assertMatchingDatabaseTarget(target, ref as object);
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
            assertMatchingDatabaseTarget(target, ref as object);
            hasWrites = true;
            writtenPaths.add(ref.path);
            readExistence.set(ref.path, false);
            backing.delete(database.doc(ref.path));
            touchedPaths.add(ref.path);
            return transaction;
          },
        };
        registerAtomicWriterCreate(transaction, (ref, data) => {
          assertMatchingDatabaseTarget(target, ref as object);
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
  client.syncMissingDatabaseOfflineState(target);
  const database = sandboxDb(target);
  const backing = database.batch();
  const touchedPaths = new Set<string>();
  const offlineMutations: OfflineMutation[] = [];
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
    set<T = DocumentData>(
      ref: DocumentReference<T>,
      data: PartialWithFieldValue<T> | WithFieldValue<T>,
      options?: SetOptions,
    ) {
      assertMatchingDatabaseTarget(target, ref as object);
      const payload = convertSetData(ref, data, options);
      withBatchError(() => backing.set(database.doc(ref.path), payload, options));
      let mergeFields: string[] | undefined;
      if (options?.mergeFields !== undefined && options.merge !== true) {
        mergeFields = normalizeMergeFields(options.mergeFields);
      }
      offlineMutations.push({
        kind: 'set',
        path: ref.path,
        data: payload,
        merge: options?.merge === true,
        mergeFields,
      });
      touchedPaths.add(ref.path);
      writes++;
      return batch;
    },
    update(ref, dataOrField: unknown, ...rest: unknown[]) {
      assertMatchingDatabaseTarget(target, ref as object);
      const parsed = parseUpdateArguments('WriteBatch.update', ref.path, dataOrField, rest);
      const args = parseChainUpdate('WriteBatch.update', ref.path, dataOrField, rest);
      withBatchError(() => backing.update(database.doc(ref.path), ...args));
      offlineMutations.push({
        kind: 'update',
        path: ref.path,
        data: updateFieldsData(parsed.map((f) => ({ path: f.path, value: markUserWriteValue(f.value) }))),
      });
      touchedPaths.add(ref.path);
      writes++;
      return batch;
    },
    delete(ref) {
      assertMatchingDatabaseTarget(target, ref as object);
      withBatchError(() => backing.delete(database.doc(ref.path)));
      offlineMutations.push({ kind: 'delete', path: ref.path });
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
          offlineMutations,
        ),
        () => ({ documentWrites: writes, documentDeletes: deletes }),
      );
    },
  };
  registerAtomicWriterCreate(batch, (ref, data) => {
    assertMatchingDatabaseTarget(target, ref as object);
    const payload = convertSetData(ref, data);
    withBatchError(() => backing.create(database.doc(ref.path), payload));
    offlineMutations.push({ kind: 'set', path: ref.path, data: payload });
    touchedPaths.add(ref.path);
    writes++;
  });
  return tag(batch, target);
}
