import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#75',
  rowIds: ['firestore#75'],
  description:
    'getCountFromServer(query) honors equality, range, in-membership, composite or(), and zero-match where() filters.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getCountFromServer, or, query, setDoc, where } = firestoreSdk;
      const items = collection(db, collectionPath('count-where-filters'));

      await setDoc(doc(items, 'item-1'), { status: 'active', priority: 10 });
      await setDoc(doc(items, 'item-2'), { status: 'active', priority: 25 });
      await setDoc(doc(items, 'item-3'), { status: 'queued', priority: 30 });
      await setDoc(doc(items, 'item-4'), { status: 'archived', priority: 5 });
      await setDoc(doc(items, 'item-5'), { status: 'active', priority: 40 });

      const activeSnap = await getCountFromServer(query(items, where('status', '==', 'active')));
      const highPrioritySnap = await getCountFromServer(
        query(items, where('priority', '>=', 25)),
      );
      const inSetSnap = await getCountFromServer(
        query(items, where('status', 'in', ['queued', 'archived'])),
      );
      const compositeOrSnap = await getCountFromServer(
        query(
          items,
          or(where('status', '==', 'queued'), where('status', '==', 'archived')),
        ),
      );
      const zeroMatchSnap = await getCountFromServer(
        query(items, where('status', '==', 'nonexistent')),
      );

      return {
        equalityActiveCount: activeSnap.data().count,
        rangePriorityAtLeast25Count: highPrioritySnap.data().count,
        inQueuedOrArchivedCount: inSetSnap.data().count,
        compositeOrQueuedOrArchivedCount: compositeOrSnap.data().count,
        zeroMatchCount: zeroMatchSnap.data().count,
      };
    });
  },
};
