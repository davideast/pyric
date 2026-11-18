import type { DocumentData, DocumentSnapshot, QuerySnapshot } from 'firebase/firestore';
import type { Probe } from '../../rigs/types.ts';
import { waitForCondition } from '../../src/oracle-run-stable-shapes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'onSnapshot honors where, orderBy, and limit constraints across initial and live write emissions, translates Timestamp fields identically to getDoc, and exposes usable tagged DocumentReference handles on snapshots.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        Timestamp,
        collection,
        doc,
        getDoc,
        getDocs,
        limit,
        onSnapshot,
        orderBy,
        query,
        refEqual,
        setDoc,
        updateDoc,
        where,
      } = firestoreSdk;

      const items = collection(db, collectionPath('onsnapshot-filtered-ts-refs'));
      const explicitTs = new Timestamp(1_700_000_000, 123_000_000);

      await setDoc(doc(items, 'doc-a'), { score: 10, createdAt: explicitTs });
      await setDoc(doc(items, 'doc-b'), { score: 30, createdAt: explicitTs });
      await setDoc(doc(items, 'doc-c'), { score: 50, createdAt: explicitTs });

      const directDocBSnap = await getDoc(doc(items, 'doc-b'));
      const directCreatedAt = directDocBSnap.data()?.createdAt as InstanceType<typeof Timestamp>;

      const filteredQuery = query(
        items,
        where('score', '>=', 20),
        orderBy('score', 'desc'),
        limit(2),
      );

      const state: {
        docSnap: DocumentSnapshot<DocumentData> | null;
        querySnap: QuerySnapshot<DocumentData> | null;
      } = {
        docSnap: null,
        querySnap: null,
      };
      const queryEmissions: string[][] = [];

      const unsubDoc = onSnapshot(doc(items, 'doc-b'), (snap) => {
        state.docSnap = snap;
      });
      const unsubQuery = onSnapshot(filteredQuery, (snap) => {
        state.querySnap = snap;
        queryEmissions.push(snap.docs.map((d) => d.id));
      });

      try {
        await waitForCondition(
          () => state.docSnap !== null && state.querySnap !== null && queryEmissions.length >= 1,
          5000,
        );

        const firstDocSnap = state.docSnap;
        const firstQuerySnap = state.querySnap;
        if (!firstDocSnap || !firstQuerySnap) {
          throw new Error('Expected initial doc and query snapshots');
        }

        const initialFilteredIds = [...(queryEmissions[0] ?? [])];
        const initialGetDocsIds = (await getDocs(filteredQuery)).docs.map((d) => d.id);

        const docTs = firstDocSnap.data()?.createdAt;
        const firstQueryDoc = firstQuerySnap.docs[0];
        if (!firstQueryDoc) {
          throw new Error('Expected first query document');
        }
        const queryTs = firstQueryDoc.data().createdAt;

        const docRefUsableSnap = await getDoc(firstDocSnap.ref);
        await updateDoc(firstQueryDoc.ref, { score: 60 });
        const updatedDocCSnap = await getDoc(doc(items, 'doc-c'));

        await setDoc(doc(items, 'doc-d'), { score: 45, createdAt: explicitTs });
        await waitForCondition(() => {
          const tail = queryEmissions[queryEmissions.length - 1] ?? [];
          return tail.length === 2 && tail[0] === 'doc-c' && tail[1] === 'doc-d';
        }, 5000);
        const afterMatchingInsertIds = [...(queryEmissions[queryEmissions.length - 1] ?? [])];

        await setDoc(doc(items, 'doc-low'), { score: 5, createdAt: explicitTs });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
        const finalGetDocsIds = (await getDocs(filteredQuery)).docs.map((d) => d.id);
        const afterNonMatchingInsertIds = [...(queryEmissions[queryEmissions.length - 1] ?? [])];

        return {
          filteredListener: {
            initialFilteredIds,
            initialMatchesGetDocs:
              JSON.stringify(initialFilteredIds) === JSON.stringify(initialGetDocsIds),
            afterMatchingInsertIds,
            afterNonMatchingInsertIds,
            finalMatchesGetDocs:
              JSON.stringify(afterNonMatchingInsertIds) === JSON.stringify(finalGetDocsIds),
          },
          timestampTranslation: {
            docIsTimestamp: docTs instanceof Timestamp,
            docSeconds: (docTs as InstanceType<typeof Timestamp>).seconds,
            docNanoseconds: (docTs as InstanceType<typeof Timestamp>).nanoseconds,
            docEqualsGetDoc: (docTs as InstanceType<typeof Timestamp>).isEqual(directCreatedAt),
            queryIsTimestamp: queryTs instanceof Timestamp,
            querySeconds: (queryTs as InstanceType<typeof Timestamp>).seconds,
            queryNanoseconds: (queryTs as InstanceType<typeof Timestamp>).nanoseconds,
            queryEqualsGetDoc: (queryTs as InstanceType<typeof Timestamp>).isEqual(directCreatedAt),
          },
          snapshotRefs: {
            docRefType: firstDocSnap.ref.type,
            docRefEqualsOriginal: refEqual(firstDocSnap.ref, doc(items, 'doc-b')),
            docRefFollowupScore: docRefUsableSnap.data()?.score ?? null,
            queryDocRefType: firstQueryDoc.ref.type,
            queryDocRefEqualsDocC: refEqual(firstQueryDoc.ref, doc(items, 'doc-c')),
            updatedScoreViaQueryDocRef: updatedDocCSnap.data()?.score ?? null,
          },
        };
      } finally {
        unsubDoc();
        unsubQuery();
      }
    });
  },
};
