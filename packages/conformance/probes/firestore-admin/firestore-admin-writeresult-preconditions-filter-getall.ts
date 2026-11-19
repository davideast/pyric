import type { Filter, WhereFilterOp } from 'firebase-admin/firestore';
import type { Probe } from '../../rigs/types.ts';

export type AdminParityErrorCategory =
  | 'already-exists'
  | 'not-found'
  | 'invalid-argument'
  | 'failed-precondition'
  | 'aborted'
  | 'other';

export interface AdminTimestampLike {
  readonly seconds: number;
  readonly nanoseconds: number;
  toMillis(): number;
}

export interface AdminWriteResultLike {
  readonly writeTime: AdminTimestampLike;
  isEqual(other: AdminWriteResultLike): boolean;
}

export interface AdminDocSnapshotLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface AdminQuerySnapshotLike {
  readonly docs: readonly AdminDocSnapshotLike[];
}

interface AdminAggregateSnapshotLike {
  data(): Record<string, unknown>;
}

interface AdminAggregateQueryLike {
  get(): Promise<AdminAggregateSnapshotLike>;
}

export interface AdminDocRefLike {
  get(): Promise<AdminDocSnapshotLike>;
  create(data: Record<string, unknown>): Promise<AdminWriteResultLike>;
  set(data: Record<string, unknown>, options?: Record<string, unknown>): Promise<AdminWriteResultLike>;
  update(data: Record<string, unknown>, precondition?: Record<string, unknown>): Promise<AdminWriteResultLike>;
  delete(precondition?: Record<string, unknown>): Promise<AdminWriteResultLike>;
}

export interface AdminQueryLike {
  where(fieldOrFilter: unknown, opStr?: string, value?: unknown): AdminQueryLike;
  orderBy(fieldPath: string, directionStr?: 'asc' | 'desc'): AdminQueryLike;
  startAt(...fieldValuesOrDocSnap: unknown[]): AdminQueryLike;
  startAfter(...fieldValuesOrDocSnap: unknown[]): AdminQueryLike;
  endAt(...fieldValuesOrDocSnap: unknown[]): AdminQueryLike;
  endBefore(...fieldValuesOrDocSnap: unknown[]): AdminQueryLike;
  aggregate(spec: Record<string, unknown>): AdminAggregateQueryLike;
  get(): Promise<AdminQuerySnapshotLike>;
}

export interface AdminCollectionRefLike extends AdminQueryLike {
  doc(docPath: string): AdminDocRefLike;
}

interface AdminWriteBatchParityLike {
  create(ref: AdminDocRefLike, data: Record<string, unknown>): AdminWriteBatchParityLike;
  set(ref: AdminDocRefLike, data: Record<string, unknown>, options?: Record<string, unknown>): AdminWriteBatchParityLike;
  update(ref: AdminDocRefLike, data: Record<string, unknown>, precondition?: Record<string, unknown>): AdminWriteBatchParityLike;
  delete(ref: AdminDocRefLike, precondition?: Record<string, unknown>): AdminWriteBatchParityLike;
  commit(): Promise<AdminWriteResultLike[]>;
}

interface AdminTransactionParityLike {
  get(ref: AdminDocRefLike): Promise<AdminDocSnapshotLike>;
  getAll(...refs: AdminDocRefLike[]): Promise<AdminDocSnapshotLike[]>;
  set(ref: AdminDocRefLike, data: Record<string, unknown>): AdminTransactionParityLike;
  update(ref: AdminDocRefLike, data: Record<string, unknown>, precondition?: Record<string, unknown>): AdminTransactionParityLike;
  delete(ref: AdminDocRefLike, precondition?: Record<string, unknown>): AdminTransactionParityLike;
}

export interface FirestoreAdminWriteResultFilterGetAllSubject {
  doc(docPath: string): AdminDocRefLike;
  collection(collectionPath: string): AdminCollectionRefLike;
  batch(): AdminWriteBatchParityLike;
  runTransaction<R>(fn: (tx: AdminTransactionParityLike) => Promise<R>): Promise<R>;
  filterWhere(fieldPath: string, opStr: string, value: unknown): unknown;
  filterOr(...filters: unknown[]): unknown;
  filterAnd(...filters: unknown[]): unknown;
  aggregateCount(): unknown;
  aggregateSum(field: string): unknown;
  aggregateAverage(field: string): unknown;
  epochZeroTimestamp(): AdminTimestampLike;
  classifyError(err: unknown): AdminParityErrorCategory;
}

export function classifyAdminParityError(err: unknown): AdminParityErrorCategory {
  if (typeof err !== 'object' || err === null) {
    return 'other';
  }
  const code = (err as { code?: unknown }).code;
  if (code === 6 || code === 'already-exists') return 'already-exists';
  if (code === 5 || code === 'not-found') return 'not-found';
  if (code === 3 || code === 'invalid-argument') return 'invalid-argument';
  if (code === 9 || code === 'failed-precondition') return 'failed-precondition';
  if (code === 10 || code === 'aborted') return 'aborted';
  return 'other';
}

function isWriteResultWithTimestamp(value: unknown): value is AdminWriteResultLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { writeTime?: unknown; isEqual?: unknown };
  if (typeof candidate.isEqual !== 'function') return false;
  if (typeof candidate.writeTime !== 'object' || candidate.writeTime === null) return false;
  const ts = candidate.writeTime as { seconds?: unknown; nanoseconds?: unknown; toMillis?: unknown };
  return (
    typeof ts.seconds === 'number' &&
    Number.isInteger(ts.seconds) &&
    ts.seconds > 0 &&
    typeof ts.nanoseconds === 'number' &&
    Number.isInteger(ts.nanoseconds) &&
    ts.nanoseconds >= 0 &&
    typeof ts.toMillis === 'function'
  );
}

async function captureWriteOutcome(
  subject: FirestoreAdminWriteResultFilterGetAllSubject,
  op: () => Promise<AdminWriteResultLike>,
): Promise<{ ok: true; hasWriteTime: boolean } | { ok: false; category: AdminParityErrorCategory }> {
  try {
    const res = await op();
    return { ok: true, hasWriteTime: isWriteResultWithTimestamp(res) };
  } catch (err) {
    return { ok: false, category: subject.classifyError(err) };
  }
}

async function captureGenericOutcome(
  subject: FirestoreAdminWriteResultFilterGetAllSubject,
  op: () => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; category: AdminParityErrorCategory }> {
  try {
    await op();
    return { ok: true };
  } catch (err) {
    return { ok: false, category: subject.classifyError(err) };
  }
}

export async function observeFirestoreAdminWriteResultFilterGetAll(
  subject: FirestoreAdminWriteResultFilterGetAllSubject,
  baseDocPath: string,
): Promise<Record<string, unknown>> {
  const itemRef = subject.doc(`${baseDocPath}/crud/item-1`);
  const createRes = await itemRef.create({ title: 'v1', count: 1 });
  const setRes = await itemRef.set({ title: 'v2', count: 2 });

  const updateExistsTrueOnExisting = await captureWriteOutcome(subject, () =>
    itemRef.update({ count: 3 }, { exists: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const baselineUpdateRes = await itemRef.update({ count: 4 });
  const exactWriteTime = baselineUpdateRes.writeTime;

  await new Promise((resolve) => setTimeout(resolve, 10));
  const updateExactLastUpdateTime = await captureWriteOutcome(subject, () =>
    itemRef.update({ count: 5 }, { lastUpdateTime: exactWriteTime }),
  );
  const updateStaleLastUpdateTime = await captureWriteOutcome(subject, () =>
    itemRef.update({ count: 6 }, { lastUpdateTime: exactWriteTime }),
  );
  const deleteExistsFalseOnExisting = await captureWriteOutcome(subject, () =>
    itemRef.delete({ exists: false }),
  );
  const deleteStaleLastUpdateTime = await captureWriteOutcome(subject, () =>
    itemRef.delete({ lastUpdateTime: exactWriteTime }),
  );
  const deleteExistsTrueOnExisting = await captureWriteOutcome(subject, () =>
    itemRef.delete({ exists: true }),
  );
  const deleteExistsTrueOnMissing = await captureWriteOutcome(subject, () =>
    itemRef.delete({ exists: true }),
  );
  const deleteExistsFalseOnMissing = await captureWriteOutcome(subject, () =>
    itemRef.delete({ exists: false }),
  );
  const updateExistsTrueOnMissing = await captureWriteOutcome(subject, () =>
    itemRef.update({ count: 99 }, { exists: true }),
  );

  const scoresCol = subject.collection(`${baseDocPath}/scores`);
  await scoresCol.doc('p1').set({ tier: 'gold', active: false, score: 10 });
  await scoresCol.doc('p2').set({ tier: 'silver', active: true, score: 20 });
  await scoresCol.doc('p3').set({ tier: 'gold', active: true, score: 30 });
  await scoresCol.doc('p4').set({ tier: 'bronze', active: true, score: 40 });

  const orSnap = await scoresCol
    .where(
      subject.filterOr(
        subject.filterWhere('tier', '==', 'gold'),
        subject.filterWhere('score', '==', 40),
      ),
    )
    .get();
  const andSnap = await scoresCol
    .where(
      subject.filterAnd(
        subject.filterWhere('tier', '==', 'gold'),
        subject.filterWhere('active', '==', true),
      ),
    )
    .get();
  const nestedFilterSnap = await scoresCol
    .where(
      subject.filterAnd(
        subject.filterOr(
          subject.filterWhere('score', '==', 10),
          subject.filterWhere('score', '==', 30),
          subject.filterWhere('score', '==', 40),
        ),
        subject.filterWhere('score', '>=', 20),
      ),
    )
    .orderBy('score', 'asc')
    .get();

  const aggQuery = scoresCol.aggregate({
    total: subject.aggregateCount(),
    sumScore: subject.aggregateSum('score'),
    avgScore: subject.aggregateAverage('score'),
  });
  const aggSnap = await aggQuery.get();

  const ordered = scoresCol.orderBy('score', 'asc');
  const startAt20 = await ordered.startAt(20).get();
  const startAfter20 = await ordered.startAfter(20).get();
  const endAt30 = await ordered.endAt(30).get();
  const endBefore30 = await ordered.endBefore(30).get();
  const window20To30 = await ordered.startAt(20).endAt(30).get();

  const snapP2 = await scoresCol.doc('p2').get();
  const snapP3 = await scoresCol.doc('p3').get();
  const startAtSnapP2 = await ordered.startAt(snapP2).get();
  const startAfterSnapP2 = await ordered.startAfter(snapP2).get();
  const endAtSnapP3 = await ordered.endAt(snapP3).get();
  const endBeforeSnapP3 = await ordered.endBefore(snapP3).get();

  const bCreated = subject.doc(`${baseDocPath}/batch/created`);
  const bSet = subject.doc(`${baseDocPath}/batch/set_doc`);
  const bExisting = subject.doc(`${baseDocPath}/batch/existing`);
  const bToDelete = subject.doc(`${baseDocPath}/batch/to_delete`);
  await bExisting.set({ v: 1 });
  await bToDelete.set({ v: 2 });

  const okBatch = subject.batch();
  okBatch
    .create(bCreated, { v: 10 })
    .set(bSet, { v: 20 })
    .update(bExisting, { v: 11 }, { exists: true })
    .delete(bToDelete, { exists: true });
  const batchResults = await okBatch.commit();

  const guardRef = subject.doc(`${baseDocPath}/batch/guard`);
  const missingBatchRef = subject.doc(`${baseDocPath}/batch/missing_doc`);
  await guardRef.set({ intact: true });
  const failBatch = subject.batch();
  failBatch.set(guardRef, { intact: false });
  failBatch.delete(missingBatchRef, { exists: true });
  const failingBatchOutcome = await captureGenericOutcome(subject, () => failBatch.commit());
  const guardAfterFailSnap = await guardRef.get();

  const txRefA = subject.doc(`${baseDocPath}/tx/a`);
  const txRefB = subject.doc(`${baseDocPath}/tx/b`);
  const txMissingRef = subject.doc(`${baseDocPath}/tx/missing`);
  await txRefA.set({ n: 10 });
  await txRefB.set({ n: 20 });

  const txGetAllOrder = await subject.runTransaction(async (tx) => {
    const snaps = await tx.getAll(txRefB, txMissingRef, txRefA);
    tx.update(txRefA, { n: 15 }, { exists: true });
    return {
      ids: snaps.map((s) => s.id),
      existsFlags: snaps.map((s) => s.exists),
      datas: snaps.map((s) => s.data() ?? null),
    };
  });
  const txRefAAfter = await txRefA.get();

  const txGetAllAfterWrite = await captureGenericOutcome(subject, () =>
    subject.runTransaction(async (tx) => {
      tx.set(txRefB, { n: 99 });
      await tx.getAll(txRefA);
    }),
  );

  const txPreconditionMismatch = await captureGenericOutcome(subject, () =>
    subject.runTransaction(async (tx) => {
      await tx.get(txMissingRef);
      tx.delete(txMissingRef, { exists: true });
    }),
  );

  return {
    writeResultAndPreconditions: {
      createHasWriteTime: isWriteResultWithTimestamp(createRes),
      setHasWriteTime: isWriteResultWithTimestamp(setRes),
      createEqualsSelf: createRes.isEqual(createRes),
      writeTimeMonotonicCreateToSet: setRes.writeTime.toMillis() >= createRes.writeTime.toMillis(),
      epochZeroNotEqualCreateTime: createRes.writeTime.toMillis() !== subject.epochZeroTimestamp().toMillis(),
      updateExistsTrueOnExisting,
      updateExactLastUpdateTime,
      updateStaleLastUpdateTime,
      deleteExistsFalseOnExisting,
      deleteStaleLastUpdateTime,
      deleteExistsTrueOnExisting,
      deleteExistsTrueOnMissing,
      deleteExistsFalseOnMissing,
      updateExistsTrueOnMissing,
    },
    filterAggregateAndCursors: {
      orIdsSorted: orSnap.docs.map((d) => d.id).sort(),
      andIdsSorted: andSnap.docs.map((d) => d.id).sort(),
      nestedFilterOrderedIds: nestedFilterSnap.docs.map((d) => d.id),
      aggregateHasGetMethod: typeof aggQuery.get === 'function',
      aggregateData: aggSnap.data(),
      startAt20Ids: startAt20.docs.map((d) => d.id),
      startAfter20Ids: startAfter20.docs.map((d) => d.id),
      endAt30Ids: endAt30.docs.map((d) => d.id),
      endBefore30Ids: endBefore30.docs.map((d) => d.id),
      window20To30Ids: window20To30.docs.map((d) => d.id),
      startAtSnapP2Ids: startAtSnapP2.docs.map((d) => d.id),
      startAfterSnapP2Ids: startAfterSnapP2.docs.map((d) => d.id),
      endAtSnapP3Ids: endAtSnapP3.docs.map((d) => d.id),
      endBeforeSnapP3Ids: endBeforeSnapP3.docs.map((d) => d.id),
    },
    batchAndTransaction: {
      batchResultsIsArray: Array.isArray(batchResults),
      batchResultsLength: batchResults.length,
      batchEveryHasWriteTime: batchResults.every((item) => isWriteResultWithTimestamp(item)),
      failingBatchOutcome,
      guardIntactAfterFailedBatch: guardAfterFailSnap.data()?.intact === true,
      txGetAllOrder,
      txRefAUpdatedValue: txRefAAfter.data()?.n ?? null,
      txGetAllAfterWrite,
      txPreconditionMismatch,
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
    'firebase-admin/firestore WriteResult shapes and isEqual, update/delete/batch/transaction Precondition (exists and lastUpdateTime) error categories, composite Filter (where/or/and), AggregateField with Query.aggregate(spec).get(), startAt/startAfter/endAt/endBefore value and snapshot cursors, WriteBatch.commit() WriteResult[], and Transaction.getAll(...refs).',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, fsMod, { loadOracleServiceAccount, oracleAppOptions }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('../../src/oracle-credential.ts'),
    ]);
    const sa = await loadOracleServiceAccount();
    const runId = `fs_admin_wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const app = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-${runId}`);
    const db = fsMod.getFirestore(app);
    const baseDocPath = `pyric_oracle/${runId}`;

    const subject: FirestoreAdminWriteResultFilterGetAllSubject = {
      doc: (path) => db.doc(path) as unknown as AdminDocRefLike,
      collection: (path) => db.collection(path) as unknown as AdminCollectionRefLike,
      batch: () => db.batch() as unknown as AdminWriteBatchParityLike,
      runTransaction: (fn) =>
        db.runTransaction(
          fn as unknown as Parameters<typeof db.runTransaction>[0],
        ) as Promise<never>,
      filterWhere: (fieldPath, opStr, value) =>
        fsMod.Filter.where(fieldPath, opStr as WhereFilterOp, value),
      filterOr: (...filters) => {
        const typedFilters = filters as Filter[];
        return fsMod.Filter.or(...typedFilters);
      },
      filterAnd: (...filters) => {
        const typedFilters = filters as Filter[];
        return fsMod.Filter.and(...typedFilters);
      },
      aggregateCount: () => fsMod.AggregateField.count(),
      aggregateSum: (field) => fsMod.AggregateField.sum(field),
      aggregateAverage: (field) => fsMod.AggregateField.average(field),
      epochZeroTimestamp: () => new fsMod.Timestamp(0, 0),
      classifyError: classifyAdminParityError,
    };

    try {
      return await observeFirestoreAdminWriteResultFilterGetAll(subject, baseDocPath);
    } finally {
      await db.recursiveDelete(db.doc(baseDocPath)).catch(() => undefined);
      await adminAppMod.deleteApp(app).catch(() => undefined);
    }
  },
};
