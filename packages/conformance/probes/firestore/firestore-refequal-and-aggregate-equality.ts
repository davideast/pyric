import type { FirestoreDataConverter } from 'firebase/firestore';
import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#112',
  rowIds: ['firestore#112', 'firestore#114', 'firestore#118', 'firestore#147', 'firestore#155'],
  description:
    'refEqual compares document, collection, converter, and QuerySnapshot.docs[i].ref handles; getDocFromServer and getDocsFromServer return live server snapshots; and aggregateFieldEqual and aggregateQuerySnapshotEqual compare aggregate descriptors and snapshots.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        FieldPath,
        aggregateFieldEqual,
        aggregateQuerySnapshotEqual,
        average,
        collection,
        count,
        doc,
        getAggregateFromServer,
        getDocFromServer,
        getDocs,
        getDocsFromServer,
        orderBy,
        query,
        refEqual,
        setDoc,
        sum,
        where,
      } = firestoreSdk;

      const items = collection(db, collectionPath('refequal-server-agg-eq'));
      const siblingItems = collection(db, collectionPath('refequal-sibling'));

      const converter: FirestoreDataConverter<{ readonly points: number }> = {
        toFirestore: (model) => ({ points: model.points }),
        fromFirestore: (snap) => ({ points: Number(snap.data().points) }),
      };

      const alphaRef = doc(items, 'alpha');
      const alphaViaDb = doc(db, items.path, 'alpha');
      const betaRef = doc(items, 'beta');
      const convertedAlphaRef = alphaRef.withConverter(converter);

      await setDoc(alphaRef, { points: 10 });
      await setDoc(betaRef, { points: 30 });

      const orderedQuery = query(items, orderBy('points', 'asc'));
      const querySnap = await getDocs(orderedQuery);
      const firstQueryDoc = querySnap.docs[0];
      if (firstQueryDoc === undefined) {
        throw new Error('Expected at least one query document');
      }

      const serverDocSnap = await getDocFromServer(alphaRef);
      const serverQuerySnap = await getDocsFromServer(orderedQuery);

      let serverDocPoints: unknown = null;
      const serverDocData = serverDocSnap.data();
      if (serverDocData !== undefined && serverDocData.points !== undefined) {
        serverDocPoints = serverDocData.points;
      }

      const aggSpec = { total: sum('points'), avg: average('points'), n: count() };
      const aggSnap1 = await getAggregateFromServer(items, aggSpec);
      const aggSnap2 = await getAggregateFromServer(items, aggSpec);
      const aggFilteredSnap = await getAggregateFromServer(
        query(items, where('points', '>', 15)),
        aggSpec,
      );

      return {
        refEqualChecks: {
          sameDocPathEqual: refEqual(alphaRef, alphaViaDb),
          sameCollectionPathEqual: refEqual(collection(db, items.path), items),
          differentDocPathEqual: refEqual(alphaRef, betaRef),
          differentCollectionPathEqual: refEqual(items, siblingItems),
          docVsCollectionEqual: refEqual(
            alphaRef as unknown as Parameters<typeof refEqual>[0],
            items as unknown as Parameters<typeof refEqual>[1],
          ),
          convertedVsRawEqual: refEqual(
            convertedAlphaRef as unknown as Parameters<typeof refEqual>[0],
            alphaRef as unknown as Parameters<typeof refEqual>[1],
          ),
          sameConverterEqual: refEqual(
            convertedAlphaRef,
            doc(items, 'alpha').withConverter(converter),
          ),
          querySnapshotDoc0EqualsAlpha: refEqual(firstQueryDoc.ref, alphaRef),
          querySnapshotDoc0EqualsBeta: refEqual(firstQueryDoc.ref, betaRef),
        },
        serverReads: {
          docExists: serverDocSnap.exists(),
          docFromCache: serverDocSnap.metadata.fromCache,
          docPoints: serverDocPoints,
          queryIds: serverQuerySnap.docs.map((d) => d.id),
          queryFromCache: serverQuerySnap.metadata.fromCache,
        },
        aggregateEquality: {
          countEqualsCount: aggregateFieldEqual(count(), count()),
          sumStringEqualsFieldPath: aggregateFieldEqual(
            sum('points'),
            sum(new FieldPath('points')),
          ),
          sumDifferentFieldEquals: aggregateFieldEqual(sum('points'), sum('other')),
          sumVsAverageEquals: aggregateFieldEqual(sum('points'), average('points')),
          sameAggregateSnapshotsEqual: aggregateQuerySnapshotEqual(aggSnap1, aggSnap2),
          differentQueryAggregateSnapshotsEqual: aggregateQuerySnapshotEqual(
            aggSnap1,
            aggFilteredSnap,
          ),
          aggregateData: aggSnap1.data(),
        },
      };
    });
  },
};
