import type { DocumentData, DocumentSnapshot, QuerySnapshot } from 'firebase/firestore';
import type { Probe } from '../../rigs/types.ts';
import { FirestoreQueryTimeoutError } from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

const WATCH_TIMEOUT_MS = 15_000;

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#81a',
  rowIds: ['firestore#81a', 'firestore#81b', 'firestore#86'],
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
        lowDocExists: boolean;
        streamError: unknown;
      } = {
        docSnap: null,
        querySnap: null,
        lowDocExists: false,
        streamError: null,
      };
      const queryEmissions: string[][] = [];
      const waiters = new Set<() => void>();

      const notifyWaiters = (): void => {
        for (const check of [...waiters]) {
          check();
        }
      };

      const recordStreamError = (err: unknown): void => {
        if (state.streamError === null) {
          state.streamError = err;
        }
        notifyWaiters();
      };

      const awaitWatch = (label: string, predicate: () => boolean): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;

          const finish = (outcome: () => void): void => {
            if (settled) return;
            settled = true;
            waiters.delete(evaluate);
            if (timer !== undefined) {
              clearTimeout(timer);
            }
            outcome();
          };

          const evaluate = (): void => {
            if (state.streamError !== null) {
              const err = state.streamError;
              finish(() => reject(err));
              return;
            }
            if (predicate()) {
              finish(() => resolve());
            }
          };

          timer = setTimeout(() => {
            finish(() => reject(new FirestoreQueryTimeoutError(WATCH_TIMEOUT_MS, label)));
          }, WATCH_TIMEOUT_MS);

          waiters.add(evaluate);
          evaluate();
        });

      const unsubDoc = onSnapshot(
        doc(items, 'doc-b'),
        (snap) => {
          state.docSnap = snap;
          notifyWaiters();
        },
        recordStreamError,
      );
      const unsubQuery = onSnapshot(
        filteredQuery,
        (snap) => {
          state.querySnap = snap;
          queryEmissions.push(snap.docs.map((d) => d.id));
          notifyWaiters();
        },
        recordStreamError,
      );
      const unsubLowDoc = onSnapshot(
        doc(items, 'doc-low'),
        (snap) => {
          state.lowDocExists = snap.exists();
          notifyWaiters();
        },
        recordStreamError,
      );

      try {
        await awaitWatch(
          'onSnapshot(initial doc-b and filteredQuery)',
          () =>
            state.docSnap !== null && state.querySnap !== null && queryEmissions.length >= 1,
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
        await awaitWatch('onSnapshot(filteredQuery after doc-d insert)', () => {
          const tail = queryEmissions[queryEmissions.length - 1] ?? [];
          return tail.length === 2 && tail[0] === 'doc-c' && tail[1] === 'doc-d';
        });
        const afterMatchingInsertIds = [...(queryEmissions[queryEmissions.length - 1] ?? [])];

        await setDoc(doc(items, 'doc-low'), { score: 5, createdAt: explicitTs });
        await awaitWatch('onSnapshot(doc-low fence)', () => state.lowDocExists);
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
        unsubLowDoc();
      }
    });
  },
};
