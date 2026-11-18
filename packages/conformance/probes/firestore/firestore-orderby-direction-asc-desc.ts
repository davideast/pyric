import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreIdQuery } from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#59',
  rowIds: ['firestore#59'],
  description:
    'orderBy(field) default direction versus explicit asc and desc direction arguments.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, orderBy, query, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('orderby-direction'));
      await setDoc(doc(items, 'd1'), { rank: 30 });
      await setDoc(doc(items, 'd2'), { rank: 10 });
      await setDoc(doc(items, 'd3'), { rank: 20 });

      return {
        defaultDirection: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('rank'))),
        ),
        explicitAsc: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('rank', 'asc'))),
        ),
        explicitDesc: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('rank', 'desc'))),
        ),
      };
    });
  },
};
