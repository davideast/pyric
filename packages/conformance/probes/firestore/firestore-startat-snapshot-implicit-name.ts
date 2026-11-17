import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore #71',
  rowIds: ['firestore#71'],
  description:
    'startAt(snapshot) disambiguates equal-valued docs via the implicit __name__ tiebreak.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, getDocs, orderBy, query, setDoc, startAt } = firestoreSdk;
      const items = collection(db, collectionPath('startat-snapshot'));
      for (const id of ['a', 'b', 'c']) {
        await setDoc(doc(items, id), { pos: 1 });
      }
      const anchor = await getDoc(doc(items, 'b'));
      const snap = await getDocs(query(items, orderBy('pos'), startAt(anchor)));
      const idsFromB = snap.docs.map((item) => item.id);
      return {
        idsFromB,
        excludedEqualValuedPredecessor: !idsFromB.includes('a'),
      };
    });
  },
};
