import type { Probe } from '../../rigs/types.ts';
import { createRecordedItemConverter } from '../../src/firestore-withconverter-probe-model.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'CollectionReference.withConverter(converter) propagates through query(typedColl, ...) + getDocs().',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, orderBy, query, setDoc, where } = firestoreSdk;
      const rawColl = collection(db, collectionPath('wc-coll-query'));
      const { converter, fromFirestoreCalls } = createRecordedItemConverter();
      const typedColl = rawColl.withConverter(converter);

      await setDoc(doc(typedColl, 'a'), { title: 'One', count: 1 });
      await setDoc(doc(typedColl, 'b'), { title: 'Two', count: 2, tag: 'match' });
      await setDoc(doc(typedColl, 'c'), { title: 'Three', count: 3, tag: 'match' });

      const filteredQuery = query(
        typedColl,
        where('dbCount', '>=', 20),
        orderBy('dbCount', 'asc'),
      );
      const snap = await getDocs(filteredQuery);
      const docs = snap.docs.map((docSnap) => ({
        id: docSnap.id,
        data: docSnap.data(),
        refConverterMatches: docSnap.ref.converter === converter,
      }));

      return {
        filteredQueryType: filteredQuery.type,
        filteredQueryConverterMatches: filteredQuery.converter === converter,
        resultIds: snap.docs.map((docSnap) => docSnap.id),
        docs,
        fromFirestoreCallCount: fromFirestoreCalls.length,
      };
    });
  },
};
