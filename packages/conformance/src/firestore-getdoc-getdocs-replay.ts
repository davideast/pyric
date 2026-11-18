import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';

export async function replayGetDocSnapshotShapeMissingAndRef(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { DocumentSnapshot, collection, deleteDoc, doc, getDoc, setDoc, updateDoc } = ctx.fs;

  const items = collection(ctx.db, `${ctx.base}/getdoc-shape`);
  const missingRef = doc(items, 'missing-doc');
  const missingSnap = await getDoc(missingRef);
  const missingDoc = {
    isDocumentSnapshot: missingSnap instanceof DocumentSnapshot,
    id: missingSnap.id,
    existsIsFunction: typeof missingSnap.exists === 'function',
    exists: missingSnap.exists(),
    dataIsUndefined: missingSnap.data() === undefined,
    refPathMatchesInput: missingSnap.ref.path === missingRef.path,
    refParentMatchesCollection: missingSnap.ref.parent.path === items.path,
  };

  const targetRef = doc(items, 'alpha-doc');
  await setDoc(targetRef, { title: 'Alpha', count: 3 });
  const hitSnap = await getDoc(targetRef);
  const hitData = hitSnap.data();
  const seededDoc = {
    isDocumentSnapshot: hitSnap instanceof DocumentSnapshot,
    id: hitSnap.id,
    existsIsFunction: typeof hitSnap.exists === 'function',
    exists: hitSnap.exists(),
    data: hitData ?? null,
    refPathMatchesInput: hitSnap.ref.path === targetRef.path,
    refParentMatchesCollection: hitSnap.ref.parent.path === items.path,
  };

  await updateDoc(hitSnap.ref, { count: 10 });
  const afterUpdateSnap = await getDoc(hitSnap.ref);
  const afterUpdateRaw = afterUpdateSnap.data();
  const afterUpdateData = afterUpdateRaw ?? null;

  await deleteDoc(hitSnap.ref);
  const afterDeleteSnap = await getDoc(hitSnap.ref);

  return {
    missingDoc,
    seededDoc,
    followUpViaSnapRef: {
      afterUpdateExists: afterUpdateSnap.exists(),
      afterUpdateData,
      afterDeleteExists: afterDeleteSnap.exists(),
      afterDeleteDataIsUndefined: afterDeleteSnap.data() === undefined,
    },
  };
}

export async function replayGetDocsSnapshotEmptyAndDocRefs(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const {
    QueryDocumentSnapshot,
    QuerySnapshot,
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    orderBy,
    query,
    setDoc,
    updateDoc,
    where,
  } = ctx.fs;

  const emptyColl = collection(ctx.db, `${ctx.base}/getdocs-empty`);
  const emptySnap = await getDocs(emptyColl);
  const emptyCollectionResult = {
    isQuerySnapshot: emptySnap instanceof QuerySnapshot,
    size: emptySnap.size,
    empty: emptySnap.empty,
    docsLength: emptySnap.docs.length,
  };

  const items = collection(ctx.db, `${ctx.base}/getdocs-populated`);
  await setDoc(doc(items, 'item-b'), { rank: 2, label: 'B' });
  await setDoc(doc(items, 'item-a'), { rank: 1, label: 'A' });
  await setDoc(doc(items, 'item-c'), { rank: 3, label: 'C' });

  const zeroMatchSnap = await getDocs(query(items, where('rank', '>', 99)));
  const zeroMatchQueryResult = {
    size: zeroMatchSnap.size,
    empty: zeroMatchSnap.empty,
    docsLength: zeroMatchSnap.docs.length,
  };

  const orderedSnap = await getDocs(query(items, orderBy('rank', 'asc')));
  const docEntries = orderedSnap.docs.map((entry) => ({
    id: entry.id,
    exists: entry.exists(),
    data: entry.data(),
    isQueryDocumentSnapshot: entry instanceof QueryDocumentSnapshot,
    refParentMatchesCollection: entry.ref.parent.path === items.path,
  }));

  const firstEntry = orderedSnap.docs[0];
  if (firstEntry === undefined) {
    throw new Error('Expected orderedSnap.docs[0] to be defined');
  }
  const firstRef = firstEntry.ref;
  await updateDoc(firstRef, { label: 'A-updated' });
  const rereadFirst = await getDoc(firstRef);
  const rereadRaw = rereadFirst.data();
  const rereadFirstData = rereadRaw ?? null;

  await deleteDoc(firstRef);
  const remainingSnap = await getDocs(query(items, orderBy('rank', 'asc')));
  const remainingIds = remainingSnap.docs.map((entry) => entry.id);

  return {
    emptyCollectionResult,
    zeroMatchQueryResult,
    populatedResult: {
      isQuerySnapshot: orderedSnap instanceof QuerySnapshot,
      size: orderedSnap.size,
      empty: orderedSnap.empty,
      docsLength: orderedSnap.docs.length,
      docEntries,
    },
    followUpViaDocsRef: {
      rereadFirstData,
      remainingSizeAfterDelete: remainingSnap.size,
      remainingIds,
    },
  };
}

export async function replayGetDocsForEachThisArgAndArity(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { collection, doc, getDocs, orderBy, query, setDoc } = ctx.fs;

  const emptyColl = collection(ctx.db, `${ctx.base}/foreach-empty`);
  const emptySnap = await getDocs(emptyColl);
  let emptyCallCount = 0;
  emptySnap.forEach(() => {
    emptyCallCount += 1;
  });

  const items = collection(ctx.db, `${ctx.base}/foreach-items`);
  await setDoc(doc(items, 'step-2'), { seq: 2, code: 'two' });
  await setDoc(doc(items, 'step-1'), { seq: 1, code: 'one' });
  await setDoc(doc(items, 'step-3'), { seq: 3, code: 'three' });

  const orderedQuery = query(items, orderBy('seq', 'asc'));
  const snap = await getDocs(orderedQuery);
  const receiver = { marker: 'bound-receiver' };
  const rawVisits: Array<{
    id: string;
    code: unknown;
    argCount: number;
    thisBoundToReceiver: boolean;
    exists: boolean;
  }> = [];

  snap.forEach(function (this: unknown, docSnap) {
    rawVisits.push({
      id: docSnap.id,
      code: docSnap.data().code,
      argCount: arguments.length,
      thisBoundToReceiver: this === receiver,
      exists: docSnap.exists(),
    });
  }, receiver);

  const converter = {
    toFirestore(model: { seq: number; upperCode: string }) {
      return { seq: model.seq, code: model.upperCode.toLowerCase() };
    },
    fromFirestore(snapshot: { data(): Record<string, unknown> }) {
      const raw = snapshot.data();
      return {
        seq: Number(raw.seq),
        upperCode: String(raw.code).toUpperCase(),
      };
    },
  };

  const typedQuery = query(items.withConverter(converter), orderBy('seq', 'desc'));
  const typedSnap = await getDocs(typedQuery);
  const converterVisits: Array<{
    id: string;
    data: { seq: number; upperCode: string };
    argCount: number;
    thisBoundToReceiver: boolean;
  }> = [];

  typedSnap.forEach(function (this: unknown, docSnap) {
    converterVisits.push({
      id: docSnap.id,
      data: docSnap.data(),
      argCount: arguments.length,
      thisBoundToReceiver: this === receiver,
    });
  }, receiver);

  return {
    emptyCallCount,
    rawVisits,
    converterVisits,
  };
}

export async function replaySnapshotGetDottedAndFieldPath(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { FieldPath, collection, doc, getDoc, getDocs, setDoc } = ctx.fs;

  const items = collection(ctx.db, `${ctx.base}/snapshot-get`);
  const missingSnap = await getDoc(doc(items, 'absent-doc'));
  const missingDocReads = {
    dottedIsUndefined: missingSnap.get('profile.handle') === undefined,
    fieldPathIsUndefined: missingSnap.get(new FieldPath('profile', 'handle')) === undefined,
  };

  const targetRef = doc(items, 'rich-doc');
  await setDoc(targetRef, {
    profile: {
      handle: 'ada',
      stats: { wins: 7 },
    },
    'a.b': 'literal-dot-value',
    a: { b: 'nested-b-value' },
    zeroVal: 0,
    falseVal: false,
    nullVal: null,
  });

  const docSnap = await getDoc(targetRef);
  const readFromSnapshot = (snap: typeof docSnap) => ({
    dottedNestedHandle: snap.get('profile.handle'),
    dottedDeepWins: snap.get('profile.stats.wins'),
    fieldPathDeepWins: snap.get(new FieldPath('profile', 'stats', 'wins')),
    dottedAB: snap.get('a.b'),
    fieldPathLiteralDotAB: snap.get(new FieldPath('a.b')),
    fieldPathTwoSegmentAB: snap.get(new FieldPath('a', 'b')),
    zeroVal: snap.get('zeroVal'),
    falseVal: snap.get('falseVal'),
    nullVal: snap.get('nullVal'),
    absentDottedIsUndefined: snap.get('profile.nonexistent') === undefined,
    absentFieldPathIsUndefined:
      snap.get(new FieldPath('profile', 'nonexistent')) === undefined,
  });

  const docSnapValues = readFromSnapshot(docSnap);
  const querySnap = await getDocs(items);
  const firstQueryDoc = querySnap.docs[0];
  if (firstQueryDoc === undefined) {
    throw new Error('Expected querySnap.docs[0] to be defined');
  }
  const queryDocValues = readFromSnapshot(firstQueryDoc);

  const converter = {
    toFirestore(value: Record<string, unknown>) {
      return value;
    },
    fromFirestore(snapshot: { data(): Record<string, unknown> }) {
      return { wrapped: true, rawKeysCount: Object.keys(snapshot.data()).length };
    },
  };
  const typedSnap = await getDoc(targetRef.withConverter(converter));
  const typedData = typedSnap.data();

  return {
    missingDocReads,
    docSnapValues,
    queryDocMatchesDocSnap:
      JSON.stringify(queryDocValues) === JSON.stringify(docSnapValues),
    withConverterSnapshot: {
      convertedDataWrapped: typedData !== undefined && typedData.wrapped === true,
      getStillReadsStoredField: typedSnap.get('profile.handle'),
      getAbsentStillUndefined: typedSnap.get('profile.missing') === undefined,
    },
  };
}
