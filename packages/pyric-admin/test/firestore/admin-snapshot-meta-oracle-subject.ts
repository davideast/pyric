import type { Sandbox } from 'pyric/sandbox';
import type { RemoteSandbox } from '../../../cli/src/remote/index.js';
import { initializeApp } from '../../src/app/index.js';
import {
  FirebaseFirestoreError,
  getFirestore,
  Timestamp,
  WriteResult,
} from '../../src/firestore/index.js';
import type {
  AdminFirestoreErrorLike,
  AdminMetaDocSnapLike,
  AdminMetaQueryLike,
  AdminMetaQuerySnapLike,
  AdminSnapshotAndReferenceMetadataSubject,
  AdminTimestampLike,
  AdminWriteResultLike,
} from '../../../conformance/probes/firestore-admin/firestore-admin-snapshot-and-reference-metadata.ts';

export function createAdminSnapshotMetaReplaySubject(
  adminSandbox: Sandbox | RemoteSandbox,
  basePath: string,
  armTag: string,
): AdminSnapshotAndReferenceMetadataSubject {
  const mainApp = initializeApp(
    { sandbox: adminSandbox, projectId: 'proj-1' },
    `fs-admin-meta-${armTag}`,
  );
  const mainDb = getFirestore(mainApp);
  const rootCol = mainDb.collection('pyric_oracle') as ReturnType<typeof mainDb.collection> & {
    readonly firestore: unknown;
    readonly parent: { path: string } | null;
    isEqual(other: unknown): boolean;
  };
  const itemsCol = mainDb.collection(`${basePath}/items`) as typeof rootCol;

  return {
    dbHandle: mainDb,
    isTimestamp: (val): val is AdminTimestampLike => val instanceof Timestamp,
    isWriteResultInstance: (val): boolean => val instanceof WriteResult,
    hasFirestoreErrorExport: typeof FirebaseFirestoreError === 'function',
    createFirestoreError: (code, message) =>
      new FirebaseFirestoreError({ code, message }) as AdminFirestoreErrorLike,
    checkReferenceMetadataAndEquality() {
      const d1 = itemsCol.doc('d1') as ReturnType<typeof mainDb.doc> & {
        readonly firestore: unknown;
        isEqual(other: unknown): boolean;
      };
      const d2 = itemsCol.doc('d2');
      const q1 = itemsCol.where('rank', '==', 1) as unknown as AdminMetaQueryLike;
      const q1Same = mainDb.collection(`${basePath}/items`).where('rank', '==', 1);
      const q2 = itemsCol.where('rank', '==', 2);
      let subColParentPath = '';
      if (itemsCol.parent !== null) subColParentPath = itemsCol.parent.path;
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
    readDoc: async (id) => (await itemsCol.doc(id).get()) as unknown as AdminMetaDocSnapLike,
    createDoc: async (id, data) =>
      (await itemsCol.doc(id).create(data)) as unknown as AdminWriteResultLike,
    updateDoc: async (id, data) =>
      (await itemsCol.doc(id).update(data)) as unknown as AdminWriteResultLike,
    buildRankQuery: (rank) => itemsCol.where('rank', '==', rank) as unknown as AdminMetaQueryLike,
    runRankQuery: async (rank) =>
      (await itemsCol.where('rank', '==', rank).get()) as unknown as AdminMetaQuerySnapLike,
  };
}
