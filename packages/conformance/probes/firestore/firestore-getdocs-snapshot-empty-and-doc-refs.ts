import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#22',
  rowIds: ['firestore#22', 'firestore#23', 'firestore#25'],
  description:
    'getDocs(query) returns an empty QuerySnapshot (size: 0, empty: true, docs: []) when no documents match, and returns QueryDocumentSnapshot entries with tagged refs usable in follow-up operations when populated.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        QueryDocumentSnapshot,
        QuerySnapshot,
        collection,
        deleteDoc,
        doc,
        getDoc,
        getDocs,
        orderBy,
        query,
        setDoc,
        updateDoc,
        where,
      } = firestoreSdk;

      const emptyColl = collection(db, collectionPath('getdocs-empty'));
      const emptySnap = await getDocs(emptyColl);
      const emptyCollectionResult = {
        isQuerySnapshot: emptySnap instanceof QuerySnapshot,
        size: emptySnap.size,
        empty: emptySnap.empty,
        docsLength: emptySnap.docs.length,
      };

      const items = collection(db, collectionPath('getdocs-populated'));
      await setDoc(doc(items, 'item-b'), { rank: 2, label: 'B' });
      await setDoc(doc(items, 'item-a'), { rank: 1, label: 'A' });
      await setDoc(doc(items, 'item-c'), { rank: 3, label: 'C' });

      const zeroMatchSnap = await getDocs(query(items, where('rank', '>', 99)));
      const zeroMatchQueryResult = {
        size: zeroMatchSnap.size,
        empty: zeroMatchSnap.empty,
        docsLength: zeroMatchSnap.docs.length,
      };

      const orderedSnap = await getDocs(query(items, orderBy('rank', 'asc')));
      const docEntries = orderedSnap.docs.map((entry) => ({
        id: entry.id,
        exists: entry.exists(),
        data: entry.data(),
        isQueryDocumentSnapshot: entry instanceof QueryDocumentSnapshot,
        refParentMatchesCollection: entry.ref.parent.path === items.path,
      }));

      const firstRef = orderedSnap.docs[0].ref;
      await updateDoc(firstRef, { label: 'A-updated' });
      const rereadFirst = await getDoc(firstRef);
      const rereadFirstData = rereadFirst.data() ?? null;

      await deleteDoc(firstRef);
      const remainingSnap = await getDocs(query(items, orderBy('rank', 'asc')));
      const remainingIds = remainingSnap.docs.map((entry) => entry.id);

      return {
        emptyCollectionResult,
        zeroMatchQueryResult,
        populatedResult: {
          isQuerySnapshot: orderedSnap instanceof QuerySnapshot,
          size: orderedSnap.size,
          empty: orderedSnap.empty,
          docsLength: orderedSnap.docs.length,
          docEntries,
        },
        followUpViaDocsRef: {
          rereadFirstData,
          remainingSizeAfterDelete: remainingSnap.size,
          remainingIds,
        },
      };
    });
  },
};
