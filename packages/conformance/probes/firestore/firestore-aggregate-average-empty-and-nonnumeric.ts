import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'average(field) returns null on empty collections, zero-match filtered queries, missing-field collections, and non-numeric field collections while sum(field) returns 0.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { average, collection, count, doc, getAggregateFromServer, query, setDoc, sum, where } =
        firestoreSdk;

      const emptyColl = collection(db, collectionPath('avg-empty-coll'));
      const emptySnap = await getAggregateFromServer(emptyColl, {
        docCount: count(),
        totalScore: sum('score'),
        meanScore: average('score'),
      });

      const filteredColl = collection(db, collectionPath('avg-zero-match'));
      await setDoc(doc(filteredColl, 'd1'), { score: 10 });
      await setDoc(doc(filteredColl, 'd2'), { score: 20 });
      const zeroMatchSnap = await getAggregateFromServer(
        query(filteredColl, where('score', '>', 1000)),
        {
          docCount: count(),
          totalScore: sum('score'),
          meanScore: average('score'),
        },
      );

      const missingFieldColl = collection(db, collectionPath('avg-missing-field'));
      await setDoc(doc(missingFieldColl, 'm1'), { label: 'alpha' });
      await setDoc(doc(missingFieldColl, 'm2'), { label: 'beta' });
      const missingFieldSnap = await getAggregateFromServer(missingFieldColl, {
        docCount: count(),
        totalScore: sum('score'),
        meanScore: average('score'),
      });

      const nonNumericColl = collection(db, collectionPath('avg-nonnumeric-field'));
      await setDoc(doc(nonNumericColl, 'n1'), { score: 'ten' });
      await setDoc(doc(nonNumericColl, 'n2'), { score: null });
      await setDoc(doc(nonNumericColl, 'n3'), { score: true });
      const nonNumericSnap = await getAggregateFromServer(nonNumericColl, {
        docCount: count(),
        totalScore: sum('score'),
        meanScore: average('score'),
      });

      return {
        emptyCollection: emptySnap.data(),
        zeroMatchFiltered: zeroMatchSnap.data(),
        missingFieldDocs: missingFieldSnap.data(),
        nonNumericFieldDocs: nonNumericSnap.data(),
      };
    });
  },
};
