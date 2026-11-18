import type { Probe } from '../../rigs/types.ts';
import {
  observeFirestoreCall,
  observeFirestoreIdQuery,
  type FirestoreSyncCallOutcome,
} from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export async function probeClientLimitBounds(): Promise<{
  limitZero: FirestoreSyncCallOutcome;
  limitNegativeOne: FirestoreSyncCallOutcome;
  limitPositiveTwo: FirestoreSyncCallOutcome;
}> {
  const [{ deleteApp, initializeApp }, { collection, getFirestore, limit, query }] =
    await Promise.all([import('firebase/app'), import('firebase/firestore')]);
  const app = initializeApp(
    { projectId: 'limit-bounds-check', apiKey: 'local-validation-only' },
    `limit-bounds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    const coll = collection(getFirestore(app), 'items');
    return {
      limitZero: observeFirestoreCall(() => query(coll, limit(0))),
      limitNegativeOne: observeFirestoreCall(() => query(coll, limit(-1))),
      limitPositiveTwo: observeFirestoreCall(() => query(coll, limit(2))),
    };
  } finally {
    await deleteApp(app);
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#60',
  rowIds: ['firestore#60'],
  description:
    'limit(n) caps returned document count across ascending, descending, and over-collection bounds, and rejects non-positive limits on construction.',
  async observe() {
    const clientBounds = await probeClientLimitBounds();
    const live = await withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, limit, orderBy, query, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('limit-caps'));
      await setDoc(doc(items, 'd1'), { n: 1 });
      await setDoc(doc(items, 'd2'), { n: 2 });
      await setDoc(doc(items, 'd3'), { n: 3 });
      await setDoc(doc(items, 'd4'), { n: 4 });

      return {
        ascLimitTwo: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('n', 'asc'), limit(2))),
        ),
        descLimitThree: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('n', 'desc'), limit(3))),
        ),
        ascLimitExceedsCount: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('n', 'asc'), limit(10))),
        ),
      };
    });
    return {
      clientBounds,
      live,
    };
  },
};
