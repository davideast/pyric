import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'getCountFromServer(query) returns an AggregateQuerySnapshot whose data() yields { count: N } across empty, populated, and limit-capped queries, preserving query identity and snapshot equality.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        AggregateField,
        AggregateQuerySnapshot,
        aggregateQuerySnapshotEqual,
        collection,
        count,
        doc,
        getCountFromServer,
        limit,
        query,
        queryEqual,
        setDoc,
      } = firestoreSdk;

      const countField = count();
      const items = collection(db, collectionPath('count-data-shape'));

      const emptySnap = await getCountFromServer(items);
      const emptyData = emptySnap.data();

      await setDoc(doc(items, 'doc-1'), { label: 'one' });
      await setDoc(doc(items, 'doc-2'), { label: 'two' });
      await setDoc(doc(items, 'doc-3'), { label: 'three' });

      const fullSnapA = await getCountFromServer(items);
      const fullSnapB = await getCountFromServer(items);
      const fullData = fullSnapA.data();

      const cappedQuery = query(items, limit(2));
      const cappedSnap = await getCountFromServer(cappedQuery);
      const cappedData = cappedSnap.data();

      return {
        countDescriptor: {
          isAggregateField: countField instanceof AggregateField,
          type: countField.type,
          aggregateType: countField.aggregateType,
        },
        empty: {
          isAggregateQuerySnapshot: emptySnap instanceof AggregateQuerySnapshot,
          type: emptySnap.type,
          dataKeys: Object.keys(emptyData),
          data: emptyData,
          queryMatchesInput: queryEqual(emptySnap.query, items),
        },
        populated: {
          dataKeys: Object.keys(fullData),
          data: fullData,
          queryMatchesInput: queryEqual(fullSnapA.query, items),
          equalSameQueryAndCount: aggregateQuerySnapshotEqual(fullSnapA, fullSnapB),
          equalDifferentCount: aggregateQuerySnapshotEqual(emptySnap, fullSnapA),
          equalDifferentQuery: aggregateQuerySnapshotEqual(fullSnapA, cappedSnap),
        },
        cappedLimit2: {
          data: cappedData,
          queryMatchesInput: queryEqual(cappedSnap.query, cappedQuery),
        },
      };
    });
  },
};
