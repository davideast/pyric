import type { Probe } from '../../rigs/types.ts';

export interface AdminTimestampLike {
  toMillis(): number;
  isEqual(other: AdminTimestampLike): boolean;
}

export interface AdminWriteResultLike {
  readonly writeTime: AdminTimestampLike;
  isEqual(other: AdminWriteResultLike): boolean;
}

export interface AdminMetaDocSnapLike {
  readonly id: string;
  readonly exists: boolean;
  readonly createTime: AdminTimestampLike | undefined;
  readonly updateTime: AdminTimestampLike | undefined;
  readonly readTime: AdminTimestampLike;
  data(): Record<string, unknown> | undefined;
  isEqual(other: AdminMetaDocSnapLike): boolean;
}

export interface AdminMetaQueryLike {
  readonly firestore: unknown;
  isEqual(other: unknown): boolean;
}

export interface AdminMetaQuerySnapLike {
  readonly size: number;
  readonly readTime: AdminTimestampLike;
  readonly query: AdminMetaQueryLike;
  isEqual(other: AdminMetaQuerySnapLike): boolean;
}

export interface AdminFirestoreErrorLike {
  readonly code: string;
  readonly message: string;
  toJSON(): Record<string, unknown>;
}

export interface AdminSnapshotAndReferenceMetadataSubject {
  readonly dbHandle: unknown;
  isTimestamp(value: unknown): value is AdminTimestampLike;
  isWriteResultInstance(value: unknown): boolean;
  hasFirestoreErrorExport: boolean;
  createFirestoreError(code: string, message: string): AdminFirestoreErrorLike;
  checkReferenceMetadataAndEquality(): {
    readonly rootColParentIsNull: boolean;
    readonly subColParentPathMatchesBase: boolean;
    readonly colFirestoreSameAsDb: boolean;
    readonly docFirestoreSameAsDb: boolean;
    readonly queryFirestoreSameAsDb: boolean;
    readonly colIsEqualSame: boolean;
    readonly colIsEqualDifferent: boolean;
    readonly docIsEqualSame: boolean;
    readonly docIsEqualDifferent: boolean;
    readonly queryIsEqualSame: boolean;
    readonly queryIsEqualDifferent: boolean;
  };
  readDoc(id: string): Promise<AdminMetaDocSnapLike>;
  createDoc(id: string, data: Record<string, unknown>): Promise<AdminWriteResultLike>;
  updateDoc(id: string, data: Record<string, unknown>): Promise<AdminWriteResultLike>;
  buildRankQuery(rank: number): AdminMetaQueryLike;
  runRankQuery(rank: number): Promise<AdminMetaQuerySnapLike>;
}

export async function observeFirestoreAdminSnapshotAndReferenceMetadata(
  subject: AdminSnapshotAndReferenceMetadataSubject,
): Promise<Record<string, unknown>> {
  const references = subject.checkReferenceMetadataAndEquality();

  const missingSnap = await subject.readDoc('missing');
  const wrCreate = await subject.createDoc('d1', { title: 'First', rank: 1 });
  await subject.createDoc('d2', { title: 'Other', rank: 2 });

  const snapBeforeA = await subject.readDoc('d1');
  const snapBeforeB = await subject.readDoc('d1');

  let createEqualsInitialUpdate = false;
  let createMatchesWriteResult = false;
  if (snapBeforeA.createTime !== undefined && snapBeforeA.updateTime !== undefined) {
    createEqualsInitialUpdate = snapBeforeA.createTime.isEqual(snapBeforeA.updateTime);
    createMatchesWriteResult = snapBeforeA.createTime.isEqual(wrCreate.writeTime);
  }

  const wrUpdate = await subject.updateDoc('d1', { title: 'Updated' });
  const snapAfter = await subject.readDoc('d1');

  let createTimeUnchangedAcrossUpdate = false;
  let updateTimeAdvancedOrEqual = false;
  let updateMatchesSecondWriteResult = false;
  if (
    snapBeforeA.createTime !== undefined &&
    snapBeforeA.updateTime !== undefined &&
    snapAfter.createTime !== undefined &&
    snapAfter.updateTime !== undefined
  ) {
    createTimeUnchangedAcrossUpdate = snapAfter.createTime.isEqual(snapBeforeA.createTime);
    updateTimeAdvancedOrEqual =
      snapAfter.updateTime.toMillis() >= snapBeforeA.updateTime.toMillis();
    updateMatchesSecondWriteResult = snapAfter.updateTime.isEqual(wrUpdate.writeTime);
  }

  const q1 = subject.buildRankQuery(1);
  const qs1A = await subject.runRankQuery(1);
  const qs1B = await subject.runRankQuery(1);
  const qs2 = await subject.runRankQuery(2);

  const sampleErr = subject.createFirestoreError('not-found', 'Sample missing document');

  return {
    references,
    writeResultClass: {
      isInstance: subject.isWriteResultInstance(wrCreate),
      hasTimestampWriteTime: subject.isTimestamp(wrCreate.writeTime),
      isEqualSelf: wrCreate.isEqual(wrCreate),
      isEqualDifferentWrite: wrCreate.isEqual(wrUpdate),
    },
    documentSnapshots: {
      missingExists: missingSnap.exists,
      missingCreateTimeUndefined: missingSnap.createTime === undefined,
      missingUpdateTimeUndefined: missingSnap.updateTime === undefined,
      missingReadTimeIsTimestamp: subject.isTimestamp(missingSnap.readTime),
      existingCreateTimeIsTimestamp: subject.isTimestamp(snapBeforeA.createTime),
      existingUpdateTimeIsTimestamp: subject.isTimestamp(snapBeforeA.updateTime),
      existingReadTimeIsTimestamp: subject.isTimestamp(snapBeforeA.readTime),
      createEqualsInitialUpdate,
      createMatchesWriteResult,
      isEqualSameUnchangedDoc: snapBeforeA.isEqual(snapBeforeB),
      isEqualMissingVsExisting: missingSnap.isEqual(snapBeforeA),
      createTimeUnchangedAcrossUpdate,
      updateTimeAdvancedOrEqual,
      updateMatchesSecondWriteResult,
      isEqualAfterMutation: snapBeforeA.isEqual(snapAfter),
    },
    querySnapshots: {
      readTimeIsTimestamp: subject.isTimestamp(qs1A.readTime),
      queryMatchesOrigin: qs1A.query.isEqual(q1),
      isEqualRepeatedSameQuery: qs1A.isEqual(qs1B),
      isEqualDifferentQuery: qs1A.isEqual(qs2),
    },
    firestoreErrorClass: {
      hasExport: subject.hasFirestoreErrorExport,
      isErrorInstance: sampleErr instanceof Error,
      code: sampleErr.code,
      message: sampleErr.message,
      jsonCode: sampleErr.toJSON().code ?? null,
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
    'firebase-admin/firestore DocumentSnapshot.{createTime, updateTime, readTime, isEqual}, QuerySnapshot.{readTime, isEqual, query}, reference .{firestore, parent, isEqual}, WriteResult, and FirebaseFirestoreError.',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, fsMod, { loadOracleServiceAccount, oracleAppOptions }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('../../src/oracle-credential.ts'),
    ]);

    const sa = await loadOracleServiceAccount();
    const runId = `adm_meta_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const basePath = `pyric_oracle/${runId}`;

    const mainApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-meta-${runId}`);
    const mainDb = fsMod.getFirestore(mainApp);
    const FirestoreErrorCtor = fsMod.FirebaseFirestoreError as unknown as new (info: {
      code: string;
      message: string;
    }) => AdminFirestoreErrorLike;

    try {
      const rootCol = mainDb.collection('pyric_oracle');
      const itemsCol = mainDb.collection(`${basePath}/items`);

      const subject: AdminSnapshotAndReferenceMetadataSubject = {
        dbHandle: mainDb,
        isTimestamp: (val): val is AdminTimestampLike => val instanceof fsMod.Timestamp,
        isWriteResultInstance: (val): boolean => val instanceof fsMod.WriteResult,
        hasFirestoreErrorExport: typeof fsMod.FirebaseFirestoreError === 'function',
        createFirestoreError: (code, message) => new FirestoreErrorCtor({ code, message }),
        checkReferenceMetadataAndEquality() {
          const d1 = itemsCol.doc('d1');
          const d2 = itemsCol.doc('d2');
          const q1 = itemsCol.where('rank', '==', 1);
          const q1Same = mainDb.collection(`${basePath}/items`).where('rank', '==', 1);
          const q2 = itemsCol.where('rank', '==', 2);
          let subColParentPath = '';
          if (itemsCol.parent !== null) {
            subColParentPath = itemsCol.parent.path;
          }
          return {
            rootColParentIsNull: rootCol.parent === null,
            subColParentPathMatchesBase: subColParentPath === basePath,
            colFirestoreSameAsDb: itemsCol.firestore === mainDb,
            docFirestoreSameAsDb: d1.firestore === mainDb,
            queryFirestoreSameAsDb: q1.firestore === mainDb,
            colIsEqualSame: itemsCol.isEqual(mainDb.collection(`${basePath}/items`)),
            colIsEqualDifferent: itemsCol.isEqual(rootCol),
            docIsEqualSame: d1.isEqual(mainDb.doc(`${basePath}/items/d1`)),
            docIsEqualDifferent: d1.isEqual(d2),
            queryIsEqualSame: q1.isEqual(q1Same),
            queryIsEqualDifferent: q1.isEqual(q2),
          };
        },
        readDoc: async (id) =>
          (await itemsCol.doc(id).get()) as unknown as AdminMetaDocSnapLike,
        createDoc: async (id, data) =>
          (await itemsCol.doc(id).create(data)) as unknown as AdminWriteResultLike,
        updateDoc: async (id, data) =>
          (await itemsCol.doc(id).update(data)) as unknown as AdminWriteResultLike,
        buildRankQuery: (rank) =>
          itemsCol.where('rank', '==', rank) as unknown as AdminMetaQueryLike,
        runRankQuery: async (rank) =>
          (await itemsCol.where('rank', '==', rank).get()) as unknown as AdminMetaQuerySnapLike,
      };

      return await observeFirestoreAdminSnapshotAndReferenceMetadata(subject);
    } finally {
      await mainDb.recursiveDelete(mainDb.doc(basePath)).catch(() => undefined);
      await mainDb.terminate().catch(() => undefined);
      await adminAppMod.deleteApp(mainApp).catch(() => undefined);
    }
  },
};
