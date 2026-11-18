import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreIdQuery } from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#54',
  rowIds: ['firestore#54'],
  description:
    'query(coll, where(...), orderBy(...), limit(...)) composes single-field filter, direction, and result cap in order.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, limit, orderBy, query, setDoc, where } = firestoreSdk;
      const items = collection(db, collectionPath('compose-where-orderby-limit'));
      await setDoc(doc(items, 'd1'), { score: 10 });
      await setDoc(doc(items, 'd2'), { score: 20 });
      await setDoc(doc(items, 'd3'), { score: 30 });
      await setDoc(doc(items, 'd4'), { score: 40 });

      const gteTwentyAscTopTwo = await observeFirestoreIdQuery(() =>
        getDocs(query(items, where('score', '>=', 20), orderBy('score', 'asc'), limit(2))),
      );
      const gteTwentyDescTopTwo = await observeFirestoreIdQuery(() =>
        getDocs(query(items, where('score', '>=', 20), orderBy('score', 'desc'), limit(2))),
      );
      const ltFortyDescTopOne = await observeFirestoreIdQuery(() =>
        getDocs(query(items, where('score', '<', 40), orderBy('score', 'desc'), limit(1))),
      );

      return {
        gteTwentyAscTopTwo,
        gteTwentyDescTopTwo,
        ltFortyDescTopOne,
      };
    });
  },
};
