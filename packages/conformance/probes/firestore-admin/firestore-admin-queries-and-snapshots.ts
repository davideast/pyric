import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';

interface QueryDocSnapLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface QuerySnapLike {
  readonly size: number;
  readonly empty: boolean;
  readonly docs: readonly QueryDocSnapLike[];
}

export interface AdminQueryLike {
  where(fieldPath: string, opStr: '==' | '>=' | '<=', value: unknown): AdminQueryLike;
  orderBy(fieldPath: string, directionStr?: 'asc' | 'desc'): AdminQueryLike;
  limit(limit: number): AdminQueryLike;
  limitToLast(limit: number): AdminQueryLike;
  get(): Promise<QuerySnapLike>;
  onSnapshot(
    onNext: (snapshot: QuerySnapLike) => void,
    onError?: (error: Error) => void,
  ): () => void;
}

export interface AdminQueryDocRefLike {
  set(data: Record<string, unknown>): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
  onSnapshot(
    onNext: (snapshot: QueryDocSnapLike) => void,
    onError?: (error: Error) => void,
  ): () => void;
}

export interface AdminQueryCollectionRefLike extends AdminQueryLike {
  doc(docPath: string): AdminQueryDocRefLike;
}

export interface FirestoreAdminQueriesSubject {
  collection(collectionPath: string): AdminQueryCollectionRefLike;
  doc(docPath: string): AdminQueryDocRefLike;
  collectionGroup(collectionId: string): AdminQueryLike;
}

async function didGetReject(query: AdminQueryLike): Promise<boolean> {
  try {
    await query.get();
    return false;
  } catch {
    return true;
  }
}

export async function observeFirestoreAdminQueriesAndSnapshots(
  subject: FirestoreAdminQueriesSubject,
  baseDocPath: string,
  uniqueGroupId: string,
): Promise<Record<string, unknown>> {
  const col = subject.collection(`${baseDocPath}/scores`);
  await col.doc('p1').set({ tier: 'gold', score: 10 });
  await col.doc('p2').set({ tier: 'silver', score: 20 });
  await col.doc('p3').set({ tier: 'gold', score: 30 });
  await col.doc('p4').set({ tier: 'gold', score: 40 });

  const eqSnap = await col.where('tier', '==', 'gold').get();
  const rangeAscSnap = await col.where('score', '>=', 20).orderBy('score', 'asc').get();
  const descLimitSnap = await col.orderBy('score', 'desc').limit(2).get();
  const ascLimitLastSnap = await col.orderBy('score', 'asc').limitToLast(2).get();
  const emptySnap = await col.where('tier', '==', 'platinum').get();
  const limitToLastWithoutOrderByRejects = await didGetReject(col.limitToLast(2));

  const siblingGroupId = `${uniqueGroupId}_other`;
  await subject.doc(`${baseDocPath}/orgs/org-a/${uniqueGroupId}/cg-1`).set({ origin: 'org-a' });
  await subject.doc(`${baseDocPath}/orgs/org-b/${uniqueGroupId}/cg-2`).set({ origin: 'org-b' });
  await subject.doc(`${baseDocPath}/orgs/org-a/${siblingGroupId}/cg-ignored`).set({ origin: 'other' });

  const cgSnap = await subject.collectionGroup(uniqueGroupId).get();

  const watchedDoc = col.doc('watched-doc');
  await watchedDoc.set({ stage: 'initial', rev: 1 });

  const docEvents: Array<Record<string, unknown>> = [];
  let resolveDocInitial: (() => void) | undefined;
  let resolveDocUpdated: (() => void) | undefined;
  const docInitialReady = new Promise<void>((resolve) => {
    resolveDocInitial = resolve;
  });
  const docUpdatedReady = new Promise<void>((resolve) => {
    resolveDocUpdated = resolve;
  });

  const unsubDoc = watchedDoc.onSnapshot((snap) => {
    docEvents.push({
      exists: snap.exists,
      data: snap.data(),
    });
    if (docEvents.length === 1 && resolveDocInitial !== undefined) {
      resolveDocInitial();
    }
    if (docEvents.length === 2 && resolveDocUpdated !== undefined) {
      resolveDocUpdated();
    }
  });

  try {
    await docInitialReady;
    await watchedDoc.update({ stage: 'updated', rev: 2 });
    await docUpdatedReady;
  } finally {
    unsubDoc();
  }

  const liveCol = subject.collection(`${baseDocPath}/live_items`);
  await liveCol.doc('a').set({ rank: 2 });

  const queryEvents: string[][] = [];
  let resolveQueryInitial: (() => void) | undefined;
  let resolveQuerySecond: (() => void) | undefined;
  const queryInitialReady = new Promise<void>((resolve) => {
    resolveQueryInitial = resolve;
  });
  const querySecondReady = new Promise<void>((resolve) => {
    resolveQuerySecond = resolve;
  });

  const unsubQuery = liveCol.orderBy('rank', 'asc').onSnapshot((snap) => {
    queryEvents.push(snap.docs.map((d) => d.id));
    if (queryEvents.length === 1 && resolveQueryInitial !== undefined) {
      resolveQueryInitial();
    }
    if (queryEvents.length === 2 && resolveQuerySecond !== undefined) {
      resolveQuerySecond();
    }
  });

  try {
    await queryInitialReady;
    await liveCol.doc('b').set({ rank: 1 });
    await querySecondReady;
  } finally {
    unsubQuery();
  }

  return {
    equalityFilterIdsSorted: eqSnap.docs.map((d) => d.id).sort(),
    rangeOrderedIds: rangeAscSnap.docs.map((d) => d.id),
    descLimitTwoIds: descLimitSnap.docs.map((d) => d.id),
    ascLimitToLastTwoIds: ascLimitLastSnap.docs.map((d) => d.id),
    emptyQuery: {
      empty: emptySnap.empty,
      size: emptySnap.size,
    },
    limitToLastWithoutOrderByRejects,
    collectionGroupIdsSorted: cgSnap.docs.map((d) => d.id).sort(),
    docOnSnapshotEvents: docEvents,
    queryOnSnapshotOrderedIds: queryEvents,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['admin-firestore'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/firestore Query.where, orderBy, limit, limitToLast (including missing-orderBy rejection), collectionGroup discovery across nested subcollections, and DocumentReference/Query onSnapshot initial and live update deliveries.',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, fsMod] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);
    const sa = await loadOracleServiceAccount();
    const runId = `fs_admin_q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const app = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-${runId}`);
    const db = fsMod.getFirestore(app);
    const baseDocPath = `pyric_oracle/${runId}`;
    const uniqueGroupId = `cg_${runId}`;

    const subject: FirestoreAdminQueriesSubject = {
      collection: (path) => db.collection(path) as unknown as AdminQueryCollectionRefLike,
      doc: (path) => db.doc(path) as unknown as AdminQueryDocRefLike,
      collectionGroup: (id) => db.collectionGroup(id) as unknown as AdminQueryLike,
    };

    try {
      return await observeFirestoreAdminQueriesAndSnapshots(subject, baseDocPath, uniqueGroupId);
    } finally {
      await db.recursiveDelete(db.doc(baseDocPath)).catch(() => undefined);
      await adminAppMod.deleteApp(app).catch(() => undefined);
    }
  },
};
