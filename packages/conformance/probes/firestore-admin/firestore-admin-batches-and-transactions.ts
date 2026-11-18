import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';

interface BatchTxDocSnapLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface BatchTxQuerySnapLike {
  readonly docs: readonly BatchTxDocSnapLike[];
}

export interface BatchTxDocRefLike {
  get(): Promise<BatchTxDocSnapLike>;
  set(data: Record<string, unknown>): Promise<unknown>;
}

export interface BatchTxQueryLike {
  where(fieldPath: string, opStr: '==', value: unknown): BatchTxQueryLike;
  get(): Promise<BatchTxQuerySnapLike>;
}

export interface AdminWriteBatchLike {
  create(ref: BatchTxDocRefLike, data: Record<string, unknown>): AdminWriteBatchLike;
  set(
    ref: BatchTxDocRefLike,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): AdminWriteBatchLike;
  update(ref: BatchTxDocRefLike, data: Record<string, unknown>): AdminWriteBatchLike;
  delete(ref: BatchTxDocRefLike): AdminWriteBatchLike;
  commit(): Promise<unknown>;
}

export interface AdminTransactionLike {
  get(ref: BatchTxDocRefLike): Promise<BatchTxDocSnapLike>;
  get(query: BatchTxQueryLike): Promise<BatchTxQuerySnapLike>;
  create(ref: BatchTxDocRefLike, data: Record<string, unknown>): AdminTransactionLike;
  set(
    ref: BatchTxDocRefLike,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): AdminTransactionLike;
  update(ref: BatchTxDocRefLike, data: Record<string, unknown>): AdminTransactionLike;
  delete(ref: BatchTxDocRefLike): AdminTransactionLike;
}

export interface FirestoreAdminBatchesTxSubject {
  doc(docPath: string): BatchTxDocRefLike;
  collection(collectionPath: string): BatchTxQueryLike;
  batch(): AdminWriteBatchLike;
  runTransaction<R>(
    updateFunction: (tx: AdminTransactionLike) => Promise<R>,
    options?: { readonly readOnly?: boolean; readonly maxAttempts?: number },
  ): Promise<R>;
}

async function didRejectOrThrow(operation: () => Promise<unknown> | unknown): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

export async function observeFirestoreAdminBatchesAndTransactions(
  subject: FirestoreAdminBatchesTxSubject,
  baseDocPath: string,
): Promise<Record<string, unknown>> {
  const bCreateRef = subject.doc(`${baseDocPath}/batch/created`);
  const bSetRef = subject.doc(`${baseDocPath}/batch/merged`);
  const bUpdateRef = subject.doc(`${baseDocPath}/batch/updated`);
  const bDeleteRef = subject.doc(`${baseDocPath}/batch/deleted`);

  await bSetRef.set({ keep: true, stage: 'before' });
  await bUpdateRef.set({ count: 10 });
  await bDeleteRef.set({ gone: false });

  const batch = subject.batch();
  batch
    .create(bCreateRef, { fresh: true })
    .set(bSetRef, { stage: 'after' }, { merge: true })
    .update(bUpdateRef, { count: 25 })
    .delete(bDeleteRef);
  await batch.commit();

  const postCommitMutationThrows = await didRejectOrThrow(() =>
    batch.set(bCreateRef, { afterCommit: true }),
  );

  const [bCreateSnap, bSetSnap, bUpdateSnap, bDeleteSnap] = await Promise.all([
    bCreateRef.get(),
    bSetRef.get(),
    bUpdateRef.get(),
    bDeleteRef.get(),
  ]);

  const failGuardRef = subject.doc(`${baseDocPath}/batch/atomic-guard`);
  await failGuardRef.set({ intact: true });
  const failingBatch = subject.batch();
  failingBatch.set(failGuardRef, { intact: false });
  failingBatch.create(failGuardRef, { duplicate: true });
  const failingBatchRejected = await didRejectOrThrow(() => failingBatch.commit());
  const failGuardAfterSnap = await failGuardRef.get();

  const txColPath = `${baseDocPath}/accounts`;
  const acctARef = subject.doc(`${txColPath}/acct-a`);
  const acctBRef = subject.doc(`${txColPath}/acct-b`);
  const acctLogRef = subject.doc(`${txColPath}/transfer-log`);
  const acctStaleRef = subject.doc(`${txColPath}/stale`);
  await acctARef.set({ active: true, balance: 100 });
  await acctBRef.set({ active: true, balance: 40 });
  await acctStaleRef.set({ active: false, obsolete: true });

  const txReturnValue = await subject.runTransaction(async (tx) => {
    const [snapA, snapB, activeQuerySnap] = await Promise.all([
      tx.get(acctARef),
      tx.get(acctBRef),
      tx.get(subject.collection(txColPath).where('active', '==', true)),
    ]);
    const dataA = snapA.data();
    const dataB = snapB.data();
    const rawBalA = dataA?.balance ?? 0;
    const rawBalB = dataB?.balance ?? 0;
    const balA = Number(rawBalA);
    const balB = Number(rawBalB);
    const activeIds = activeQuerySnap.docs.map((d) => d.id).sort();

    tx.update(acctARef, { balance: balA - 35 })
      .set(acctBRef, { balance: balB + 35 }, { merge: true })
      .create(acctLogRef, { amount: 35, activeIds })
      .delete(acctStaleRef);

    return { transferred: 35, activeIds };
  });

  const [afterAcctA, afterAcctB, afterAcctLog, afterAcctStale] = await Promise.all([
    acctARef.get(),
    acctBRef.get(),
    acctLogRef.get(),
    acctStaleRef.get(),
  ]);

  const readAfterWriteRejected = await didRejectOrThrow(() =>
    subject.runTransaction(async (tx) => {
      tx.set(acctARef, { active: true, balance: 999 });
      await tx.get(acctBRef);
      return 'unreachable';
    }),
  );

  const readOnlyTxBalance = await subject.runTransaction(
    async (tx) => {
      const snap = await tx.get(acctARef);
      const data = snap.data();
      return data?.balance;
    },
    { readOnly: true },
  );

  const readOnlyWriteRejected = await didRejectOrThrow(() =>
    subject.runTransaction(
      async (tx) => {
        await tx.get(acctARef);
        tx.set(acctARef, { active: true, balance: 0 });
        return 'unreachable';
      },
      { readOnly: true },
    ),
  );

  return {
    batchCommit: {
      createdData: bCreateSnap.data(),
      mergedData: bSetSnap.data(),
      updatedData: bUpdateSnap.data(),
      deletedExists: bDeleteSnap.exists,
      postCommitMutationThrows,
    },
    atomicFailedBatch: {
      rejected: failingBatchRejected,
      guardDocData: failGuardAfterSnap.data(),
    },
    transaction: {
      returnValue: txReturnValue,
      acctAData: afterAcctA.data(),
      acctBData: afterAcctB.data(),
      logData: afterAcctLog.data(),
      staleExists: afterAcctStale.exists,
      readAfterWriteRejected,
      readOnlyTxBalance,
      readOnlyWriteRejected,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['admin-firestore'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/firestore WriteBatch atomic create/set/update/delete/commit (including post-commit mutation rejection and failed-batch rollback) and runTransaction with tx.get(docRef), tx.get(query), read-before-write enforcement, and readOnly transactions.',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, fsMod] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);
    const sa = await loadOracleServiceAccount();
    const runId = `fs_admin_tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const app = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-${runId}`);
    const db = fsMod.getFirestore(app);
    const baseDocPath = `pyric_oracle/${runId}`;

    const subject: FirestoreAdminBatchesTxSubject = {
      doc: (path) => db.doc(path) as unknown as BatchTxDocRefLike,
      collection: (path) => db.collection(path) as unknown as BatchTxQueryLike,
      batch: () => db.batch() as unknown as AdminWriteBatchLike,
      runTransaction: (fn, opts) =>
        db.runTransaction(
          fn as unknown as (tx: FirebaseFirestore.Transaction) => Promise<never>,
          opts,
        ),
    };

    try {
      return await observeFirestoreAdminBatchesAndTransactions(subject, baseDocPath);
    } finally {
      await db.recursiveDelete(db.doc(baseDocPath)).catch(() => undefined);
      await adminAppMod.deleteApp(app).catch(() => undefined);
    }
  },
};
