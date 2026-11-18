import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#72',
  rowIds: ['firestore#72', 'firestore#73'],
  description:
    'endAt(snapshot) bounds ordered queries inclusively at the anchor snapshot in both directions, and startAfter + limit paginates deterministically through ordered result sets until exhausted.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, endAt, getDoc, getDocs, limit, orderBy, query, setDoc, startAfter } =
        firestoreSdk;

      const items = collection(db, collectionPath('cursors-endat-pagination'));
      await setDoc(doc(items, 'item-1'), { rank: 10 });
      await setDoc(doc(items, 'item-2'), { rank: 20 });
      await setDoc(doc(items, 'item-3'), { rank: 30 });
      await setDoc(doc(items, 'item-4'), { rank: 40 });
      await setDoc(doc(items, 'item-5'), { rank: 50 });

      const midSnap = await getDoc(doc(items, 'item-3'));

      const endAtAscSnap = await getDocs(query(items, orderBy('rank', 'asc'), endAt(midSnap)));
      const endAtDescSnap = await getDocs(query(items, orderBy('rank', 'desc'), endAt(midSnap)));

      const page1Snap = await getDocs(query(items, orderBy('rank', 'asc'), limit(2)));
      const page1Cursor = page1Snap.docs[page1Snap.docs.length - 1];
      if (!page1Cursor) {
        throw new Error('Expected page1 to contain 2 documents');
      }

      const page2Snap = await getDocs(
        query(items, orderBy('rank', 'asc'), startAfter(page1Cursor), limit(2)),
      );
      const page2Cursor = page2Snap.docs[page2Snap.docs.length - 1];
      if (!page2Cursor) {
        throw new Error('Expected page2 to contain 2 documents');
      }

      const page3Snap = await getDocs(
        query(items, orderBy('rank', 'asc'), startAfter(page2Cursor), limit(2)),
      );
      const page3Cursor = page3Snap.docs[page3Snap.docs.length - 1];
      if (!page3Cursor) {
        throw new Error('Expected page3 to contain 1 document');
      }

      const page4Snap = await getDocs(
        query(items, orderBy('rank', 'asc'), startAfter(page3Cursor), limit(2)),
      );

      const valueCursorPageSnap = await getDocs(
        query(items, orderBy('rank', 'asc'), startAfter(20), limit(2)),
      );

      return {
        endAtSnapshot: {
          ascIds: endAtAscSnap.docs.map((d) => d.id),
          descIds: endAtDescSnap.docs.map((d) => d.id),
        },
        pagination: {
          page1Ids: page1Snap.docs.map((d) => d.id),
          page2Ids: page2Snap.docs.map((d) => d.id),
          page3Ids: page3Snap.docs.map((d) => d.id),
          page4Ids: page4Snap.docs.map((d) => d.id),
          page4Empty: page4Snap.empty,
          valueCursorPageIds: valueCursorPageSnap.docs.map((d) => d.id),
        },
      };
    });
  },
};
