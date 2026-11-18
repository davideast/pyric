import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';

interface AdminDocRefLike {
  readonly id: string;
  readonly path: string;
  set(data: Record<string, unknown>): Promise<unknown>;
  get(): Promise<{ readonly exists: boolean; readonly data: () => Record<string, unknown> | undefined }>;
  collection(subPath: string): AdminCollectionRefLike;
}

interface AdminCollectionRefLike {
  readonly id: string;
  readonly path: string;
  doc(docPath?: string): AdminDocRefLike;
  add(data: Record<string, unknown>): Promise<AdminDocRefLike>;
}

export interface FirestoreAdminPathsSubject {
  collection(collectionPath: string): AdminCollectionRefLike;
  doc(documentPath: string): AdminDocRefLike;
}

const AUTO_ID_RE = /^[A-Za-z0-9]{20}$/;

function threwSynchronously(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

export async function observeFirestoreAdminPathsAndAutoIds(
  subject: FirestoreAdminPathsSubject,
  baseDocPath: string,
): Promise<Record<string, unknown>> {
  const itemsPath = `${baseDocPath}/items`;

  const emptyCollectionThrows = threwSynchronously(() => subject.collection(''));
  const evenSegmentCollectionThrows = threwSynchronously(() =>
    subject.collection(`${itemsPath}/doc-even`),
  );
  const doubleSlashCollectionThrows = threwSynchronously(() =>
    subject.collection(`${baseDocPath}//items`),
  );
  const emptyDocThrows = threwSynchronously(() => subject.doc(''));
  const oddSegmentDocThrows = threwSynchronously(() => subject.doc(itemsPath));
  const evenSegmentChildDocThrows = threwSynchronously(() =>
    subject.collection(itemsPath).doc('sub/doc-even'),
  );

  const itemsCol = subject.collection(itemsPath);
  const generatedIds: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    generatedIds.push(itemsCol.doc().id);
  }
  const allDocAutoIdsTwentyAlnum = generatedIds.every((id) => AUTO_ID_RE.test(id));
  const allDocAutoIdsUnique = new Set(generatedIds).size === generatedIds.length;

  const explicitRef = itemsCol.doc('explicit-1');
  await explicitRef.set({ label: 'explicit', order: 1 });
  const explicitSnap = await subject.doc(`${itemsPath}/explicit-1`).get();

  const addedRef = await itemsCol.add({ label: 'added', order: 2 });
  const addedSnap = await subject.doc(`${itemsPath}/${addedRef.id}`).get();

  const nestedRef = explicitRef.collection('events').doc('event-1');
  await nestedRef.set({ stage: 'nested', ok: true });
  const nestedViaRootSnap = await subject
    .doc(`${itemsPath}/explicit-1/events/event-1`)
    .get();

  return {
    invalidPaths: {
      emptyCollectionThrows,
      evenSegmentCollectionThrows,
      doubleSlashCollectionThrows,
      emptyDocThrows,
      oddSegmentDocThrows,
      evenSegmentChildDocThrows,
    },
    autoIds: {
      sampleCount: generatedIds.length,
      allDocAutoIdsTwentyAlnum,
      allDocAutoIdsUnique,
      addedDocAutoIdTwentyAlnum: AUTO_ID_RE.test(addedRef.id),
    },
    explicitDoc: {
      idMatches: explicitRef.id === 'explicit-1',
      endsWithExpectedSuffix: explicitRef.path.endsWith('items/explicit-1'),
      exists: explicitSnap.exists,
      data: explicitSnap.data(),
    },
    addedDoc: {
      pathMatchesCollectionPrefix: addedRef.path === `${itemsPath}/${addedRef.id}`,
      exists: addedSnap.exists,
      data: addedSnap.data(),
    },
    nestedSubcollection: {
      endsWithExpectedSuffix: nestedRef.path.endsWith('items/explicit-1/events/event-1'),
      exists: nestedViaRootSnap.exists,
      data: nestedViaRootSnap.data(),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['admin-firestore'],
  matrixRow: 'firestore-admin#3',
  rowIds: ['firestore-admin#3'],
  description:
    'firebase-admin/firestore db.collection(path), db.doc(path), col.doc(id?), col.add(data), and docRef.collection(name) validate odd/even slash-delimited paths synchronously, mint 20-character alphanumeric auto-IDs, and address nested subcollections.',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, { getFirestore }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);
    const sa = await loadOracleServiceAccount();
    const runId = `fs_admin_paths_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const app = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-${runId}`);
    const db = getFirestore(app);
    const baseDocPath = `pyric_oracle/${runId}`;

    try {
      return await observeFirestoreAdminPathsAndAutoIds(db, baseDocPath);
    } finally {
      await db.recursiveDelete(db.doc(baseDocPath)).catch(() => undefined);
      await adminAppMod.deleteApp(app).catch(() => undefined);
    }
  },
};
