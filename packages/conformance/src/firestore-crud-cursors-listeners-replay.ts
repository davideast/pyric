import type { DocumentData, DocumentSnapshot, FirestoreDataConverter, QuerySnapshot } from 'firebase/firestore';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';
import { FirestoreQueryTimeoutError } from './firestore-probe-outcomes.ts';

interface CounterModel {
  readonly label: string;
  readonly count: number;
}

const AUTO_ID_RE = /^[A-Za-z0-9]{20}$/;
const WATCH_TIMEOUT_MS = 15_000;

export async function replayCrudConverterDeleteAndAddDoc(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { addDoc, collection, deleteDoc, doc, getDoc, updateDoc } = ctx.fs;

  let toFirestoreCalls = 0;
  let fromFirestoreCalls = 0;

  const converter: FirestoreDataConverter<CounterModel> = {
    toFirestore(model: CounterModel) {
      toFirestoreCalls += 1;
      return { rawLabel: model.label, count: model.count };
    },
    fromFirestore(snapshot) {
      fromFirestoreCalls += 1;
      const raw = snapshot.data();
      return {
        label: String(raw.rawLabel).toUpperCase(),
        count: Number(raw.count),
      };
    },
  };

  const rawColl = collection(ctx.db, `${ctx.base}/crud-converter-add-delete`);
  const typedColl = rawColl.withConverter(converter);

  const addedRef = await addDoc(typedColl, { label: 'alpha', count: 1 });
  const toCallsAfterAddDoc = toFirestoreCalls;

  const addedTypedSnap = await getDoc(addedRef);
  const fromCallsAfterInitialRead = fromFirestoreCalls;
  const rawStoredSnap = await getDoc(doc(rawColl, addedRef.id));

  await updateDoc(addedRef, { count: 7 });
  const toCallsAfterUpdateDoc = toFirestoreCalls;
  const fromCallsAfterUpdateDoc = fromFirestoreCalls;

  const updatedTypedSnap = await getDoc(addedRef);
  const fromCallsAfterUpdatedRead = fromFirestoreCalls;

  await deleteDoc(addedRef);
  const deletedSnap = await getDoc(addedRef);
  const fromCallsAfterDeletedRead = fromFirestoreCalls;

  const initialData = addedTypedSnap.data();
  let initialTypedData: CounterModel | null = null;
  if (initialData !== undefined) {
    initialTypedData = initialData;
  }

  const rawData = rawStoredSnap.data();
  let rawStoredData: DocumentData | null = null;
  if (rawData !== undefined) {
    rawStoredData = rawData;
  }

  const updatedData = updatedTypedSnap.data();
  let updatedTypedData: CounterModel | null = null;
  if (updatedData !== undefined) {
    updatedTypedData = updatedData;
  }

  return {
    addDocShape: {
      refType: addedRef.type,
      autoIdLength: addedRef.id.length,
      autoIdAlphanumeric: AUTO_ID_RE.test(addedRef.id),
      parentPathMatches: addedRef.parent.path === typedColl.path,
      converterPropagated: addedRef.converter === converter,
      toCallsAfterAddDoc,
      fromCallsAfterInitialRead,
      initialTypedData,
      rawStoredData,
    },
    updateDocBypass: {
      toCallsUnchanged: toCallsAfterUpdateDoc === toCallsAfterAddDoc,
      fromCallsUnchangedDuringWrite: fromCallsAfterUpdateDoc === fromCallsAfterInitialRead,
      updatedTypedData,
      fromCallsAfterUpdatedRead,
    },
    deleteDocRemoval: {
      existsAfterDelete: deletedSnap.exists(),
      dataUndefinedAfterDelete: deletedSnap.data() === undefined,
      fromCallsUnchangedOnMissingRead:
        fromCallsAfterDeletedRead === fromCallsAfterUpdatedRead,
    },
  };
}

export async function replayQueryCursorsEndAtSnapAndPagination(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { collection, doc, endAt, getDoc, getDocs, limit, orderBy, query, setDoc, startAfter } =
    ctx.fs;

  const items = collection(ctx.db, `${ctx.base}/cursors-endat-pagination`);
  await setDoc(doc(items, 'item-1'), { rank: 10 });
  await setDoc(doc(items, 'item-2'), { rank: 20 });
  await setDoc(doc(items, 'item-3'), { rank: 30 });
  await setDoc(doc(items, 'item-4'), { rank: 40 });
  await setDoc(doc(items, 'item-5'), { rank: 50 });

  const midSnap = await getDoc(doc(items, 'item-3'));

  const endAtAscSnap = await getDocs(query(items, orderBy('rank', 'asc'), endAt(midSnap)));
  const endAtDescSnap = await getDocs(query(items, orderBy('rank', 'desc'), endAt(midSnap)));

  const page1Snap = await getDocs(query(items, orderBy('rank', 'asc'), limit(2)));
  const page1Cursor = page1Snap.docs[page1Snap.docs.length - 1];
  if (page1Cursor === undefined) {
    throw new Error('Expected page1 to contain 2 documents');
  }

  const page2Snap = await getDocs(
    query(items, orderBy('rank', 'asc'), startAfter(page1Cursor), limit(2)),
  );
  const page2Cursor = page2Snap.docs[page2Snap.docs.length - 1];
  if (page2Cursor === undefined) {
    throw new Error('Expected page2 to contain 2 documents');
  }

  const page3Snap = await getDocs(
    query(items, orderBy('rank', 'asc'), startAfter(page2Cursor), limit(2)),
  );
  const page3Cursor = page3Snap.docs[page3Snap.docs.length - 1];
  if (page3Cursor === undefined) {
    throw new Error('Expected page3 to contain 1 document');
  }

  const page4Snap = await getDocs(
    query(items, orderBy('rank', 'asc'), startAfter(page3Cursor), limit(2)),
  );

  const valueCursorPageSnap = await getDocs(
    query(items, orderBy('rank', 'asc'), startAfter(20), limit(2)),
  );

  return {
    endAtSnapshot: {
      ascIds: endAtAscSnap.docs.map((d) => d.id),
      descIds: endAtDescSnap.docs.map((d) => d.id),
    },
    pagination: {
      page1Ids: page1Snap.docs.map((d) => d.id),
      page2Ids: page2Snap.docs.map((d) => d.id),
      page3Ids: page3Snap.docs.map((d) => d.id),
      page4Ids: page4Snap.docs.map((d) => d.id),
      page4Empty: page4Snap.empty,
      valueCursorPageIds: valueCursorPageSnap.docs.map((d) => d.id),
    },
  };
}

export async function replayOnSnapshotFilteredTimestampAndRefs(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
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
  } = ctx.fs;

  const items = collection(ctx.db, `${ctx.base}/onsnapshot-filtered-ts-refs`);
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
        if (settled) {
          return;
        }
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
      () => state.docSnap !== null && state.querySnap !== null && queryEmissions.length >= 1,
    );

    const firstDocSnap = state.docSnap;
    const firstQuerySnap = state.querySnap;
    if (firstDocSnap === null || firstQuerySnap === null) {
      throw new Error('Expected initial doc and query snapshots');
    }

    const firstEmission = queryEmissions[0] ?? [];
    const initialFilteredIds = [...firstEmission];
    const initialGetDocsIds = (await getDocs(filteredQuery)).docs.map((d) => d.id);

    const docTs = firstDocSnap.data()?.createdAt;
    const firstQueryDoc = firstQuerySnap.docs[0];
    if (firstQueryDoc === undefined) {
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
    const matchingTail = queryEmissions[queryEmissions.length - 1] ?? [];
    const afterMatchingInsertIds = [...matchingTail];

    await setDoc(doc(items, 'doc-low'), { score: 5, createdAt: explicitTs });
    await awaitWatch('onSnapshot(doc-low fence)', () => state.lowDocExists);
    const finalGetDocsIds = (await getDocs(filteredQuery)).docs.map((d) => d.id);
    const nonMatchingTail = queryEmissions[queryEmissions.length - 1] ?? [];
    const afterNonMatchingInsertIds = [...nonMatchingTail];

    let docRefFollowupScore: unknown = null;
    const docRefFollowupData = docRefUsableSnap.data();
    if (docRefFollowupData !== undefined && docRefFollowupData.score !== undefined) {
      docRefFollowupScore = docRefFollowupData.score;
    }

    let updatedScoreViaQueryDocRef: unknown = null;
    const updatedDocCData = updatedDocCSnap.data();
    if (updatedDocCData !== undefined && updatedDocCData.score !== undefined) {
      updatedScoreViaQueryDocRef = updatedDocCData.score;
    }

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
        docRefFollowupScore,
        queryDocRefType: firstQueryDoc.ref.type,
        queryDocRefEqualsDocC: refEqual(firstQueryDoc.ref, doc(items, 'doc-c')),
        updatedScoreViaQueryDocRef,
      },
    };
  } finally {
    unsubDoc();
    unsubQuery();
    unsubLowDoc();
  }
}
