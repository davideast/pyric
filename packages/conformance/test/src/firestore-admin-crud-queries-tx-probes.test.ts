import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../../pyric-admin/src/app/index.js';
import { FieldPath, getFirestore } from '../../../pyric-admin/src/firestore/index.js';
import {
  classifyGrpcOrStringFirestoreError,
  observeFirestoreAdminCrud,
  probe as crudProbe,
  type FirestoreAdminCrudSubject,
} from '../../probes/firestore-admin/firestore-admin-crud-operations.ts';
import {
  observeFirestoreAdminQueriesAndSnapshots,
  probe as queriesAndSnapshotsProbe,
  type AdminQueryCollectionRefLike,
  type AdminQueryDocRefLike,
  type AdminQueryLike,
  type FirestoreAdminQueriesSubject,
} from '../../probes/firestore-admin/firestore-admin-queries-and-snapshots.ts';
import {
  observeFirestoreAdminBatchesAndTransactions,
  probe as batchesAndTransactionsProbe,
  type AdminTransactionLike,
  type AdminWriteBatchLike,
  type BatchTxDocRefLike,
  type BatchTxQueryLike,
  type FirestoreAdminBatchesTxSubject,
} from '../../probes/firestore-admin/firestore-admin-batches-and-transactions.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_FIRESTORE_ADMIN_SLICE9_PROBES = [
  'firestore-admin-crud-operations',
  'firestore-admin-queries-and-snapshots',
  'firestore-admin-batches-and-transactions',
] as const;

describe('staged firestore-admin CRUD, queries/onSnapshot, and batch/transaction probes', () => {
  it('registers all three probes under sdk-probes and tracks staged discovery via expectStagedUntilCaptured', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((item) => item.id);
    for (const id of STAGED_FIRESTORE_ADMIN_SLICE9_PROBES) {
      expect(loadedIds).toContain(id);
    }

    expect(crudProbe.rig).toBe('sdk-probes');
    expect(crudProbe.pendingRowLink).toBe(true);
    expect(crudProbe.rowIds).toEqual([]);
    expect(crudProbe.requires).toEqual(['admin-firestore']);

    expect(queriesAndSnapshotsProbe.rig).toBe('sdk-probes');
    expect(queriesAndSnapshotsProbe.pendingRowLink).toBe(true);
    expect(queriesAndSnapshotsProbe.rowIds).toEqual([]);
    expect(queriesAndSnapshotsProbe.requires).toEqual(['admin-firestore']);

    expect(batchesAndTransactionsProbe.rig).toBe('sdk-probes');
    expect(batchesAndTransactionsProbe.pendingRowLink).toBe(true);
    expect(batchesAndTransactionsProbe.rowIds).toEqual([]);
    expect(batchesAndTransactionsProbe.requires).toEqual(['admin-firestore']);

    expectStagedUntilCaptured(STAGED_FIRESTORE_ADMIN_SLICE9_PROBES, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
    });
  });

  it('produces deterministic two-run observations on pyric-admin/firestore across CRUD, queries/listeners, and batches/transactions', async () => {
    async function runOnce(tag: string) {
      const sandbox = initializeSandbox();
      const app = initializeApp({ sandbox }, `fs-admin-s9-${tag}`);
      const db = getFirestore(app);

      const crudSubject: FirestoreAdminCrudSubject = {
        doc: (path) => db.doc(path),
        createFieldPath: (...names) => new FieldPath(...names),
        classifyError: classifyGrpcOrStringFirestoreError,
      };

      const queriesSubject: FirestoreAdminQueriesSubject = {
        collection: (path) => db.collection(path) as unknown as AdminQueryCollectionRefLike,
        doc: (path) => db.doc(path) as unknown as AdminQueryDocRefLike,
        collectionGroup: (id) => db.collectionGroup(id) as unknown as AdminQueryLike,
      };

      const batchesTxSubject: FirestoreAdminBatchesTxSubject = {
        doc: (path) => db.doc(path) as unknown as BatchTxDocRefLike,
        collection: (path) => db.collection(path) as unknown as BatchTxQueryLike,
        batch: () => db.batch() as unknown as AdminWriteBatchLike,
        runTransaction: (fn, opts) =>
          db.runTransaction(
            fn as unknown as Parameters<typeof db.runTransaction>[0],
            opts,
          ) as Promise<never>,
      };

      try {
        const crud = await observeFirestoreAdminCrud(crudSubject, `pyric_oracle/${tag}_crud`);
        const queries = await observeFirestoreAdminQueriesAndSnapshots(
          queriesSubject,
          `pyric_oracle/${tag}_queries`,
          `cg_${tag}`,
        );
        const batchesTx = await observeFirestoreAdminBatchesAndTransactions(
          batchesTxSubject,
          `pyric_oracle/${tag}_tx`,
        );
        return { crud, queries, batchesTx };
      } finally {
        await Promise.all(getApps().map((item) => deleteApp(item).catch(() => undefined)));
        sandbox.dispose();
      }
    }

    const first = await runOnce('det1');
    const second = await runOnce('det2');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    expect(first.crud.duplicateCreate).toEqual({
      rejected: true,
      category: 'already-exists',
    });
    expect(first.crud.updateMissing).toEqual({
      rejected: true,
      category: 'not-found',
    });
    expect(first.crud.idempotentDeleteAfterDelete).toBe(true);
    expect(first.crud.idempotentDeleteNeverExisted).toBe(true);

    expect(first.queries.equalityFilterIdsSorted).toEqual(['p1', 'p3', 'p4']);
    expect(first.queries.rangeOrderedIds).toEqual(['p2', 'p3', 'p4']);
    expect(first.queries.descLimitTwoIds).toEqual(['p4', 'p3']);
    expect(first.queries.ascLimitToLastTwoIds).toEqual(['p3', 'p4']);
    expect(first.queries.limitToLastWithoutOrderByRejects).toBe(true);
    expect(first.queries.collectionGroupIdsSorted).toEqual(['cg-1', 'cg-2']);
    expect(first.queries.queryOnSnapshotOrderedIds).toEqual([['a'], ['b', 'a']]);

    expect(first.batchesTx.batchCommit).toEqual({
      createdData: { fresh: true },
      mergedData: { keep: true, stage: 'after' },
      updatedData: { count: 25 },
      deletedExists: false,
      postCommitMutationThrows: true,
    });
    expect(first.batchesTx.atomicFailedBatch).toEqual({
      rejected: true,
      guardDocData: { intact: true },
    });
    expect(first.batchesTx.transaction).toEqual({
      returnValue: { transferred: 35, activeIds: ['acct-a', 'acct-b'] },
      acctAData: { active: true, balance: 65 },
      acctBData: { active: true, balance: 75 },
      logData: { amount: 35, activeIds: ['acct-a', 'acct-b'] },
      staleExists: false,
      readAfterWriteRejected: true,
      readOnlyTxBalance: 65,
      readOnlyWriteRejected: true,
    });
  });
});
