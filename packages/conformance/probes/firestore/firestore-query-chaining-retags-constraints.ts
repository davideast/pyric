import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreIdQuery } from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Nested query(query(coll, where(...)), orderBy(...)) chaining accumulates constraints without mutating intermediate Query handles.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, limit, orderBy, query, setDoc, where } = firestoreSdk;
      const items = collection(db, collectionPath('query-chaining'));
      await setDoc(doc(items, 'd1'), { score: 10 });
      await setDoc(doc(items, 'd2'), { score: 20 });
      await setDoc(doc(items, 'd3'), { score: 30 });
      await setDoc(doc(items, 'd4'), { score: 40 });

      const filtered = query(items, where('score', '>=', 20));
      const ordered = query(filtered, orderBy('score', 'desc'));
      const capped = query(ordered, limit(2));

      return {
        chainedThreeStep: await observeFirestoreIdQuery(() => getDocs(capped)),
        intermediateOrderedUnmutated: await observeFirestoreIdQuery(() => getDocs(ordered)),
        intermediateFilteredUnmutated: await observeFirestoreIdQuery(() => getDocs(filtered)),
      };
    });
  },
};
