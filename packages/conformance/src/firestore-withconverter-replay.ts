/**
 * Shared dual-plane replay drivers for all 10 `withConverter -- typed refs`
 * production captures (`firestore#46..#53b`).
 *
 * Runs identical operations over `inPageContext()` (`pyric/firestore`) and
 * `servedFirestoreContext()` (served worker client + real host) using the same
 * `createRecordedItemConverter()` recorder that captured the live observations.
 */
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';
import {
  type ConvertedItem,
  createRecordedItemConverter,
  observeInitialQuerySnapshot,
} from './firestore-withconverter-probe-model.ts';

function subcollectionPath(ctx: FirestoreScenarioContext, suffix: string): string {
  return `${ctx.base}/${suffix}`;
}

export async function replayWithConverterDocRoundtrip(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const items = fs.collection(db, subcollectionPath(ctx, 'wc-doc-roundtrip'));
  const rawDoc = fs.doc(items, 'd1') as unknown as {
    type: unknown;
    converter: unknown;
    parent: { converter: unknown };
    withConverter: (c: unknown) => {
      type: unknown;
      converter: unknown;
      parent: { converter: unknown };
    };
  };
  const { converter, toFirestoreCalls, fromFirestoreCalls } = createRecordedItemConverter();
  const typedDoc = rawDoc.withConverter(converter);

  await fs.setDoc(typedDoc as never, { title: 'Alpha', count: 3, tag: 'v1' } as never);

  const rawSnap = await fs.getDoc(rawDoc as never);
  const typedSnap = await fs.getDoc(typedDoc as never);

  return {
    hasTopLevelWithConverterExport: 'withConverter' in fs,
    hasDocWithConverterMethod: typeof rawDoc.withConverter === 'function',
    rawDocType: rawDoc.type,
    typedDocType: typedDoc.type,
    rawConverterIsNull: rawDoc.converter === null,
    typedConverterMatches: typedDoc.converter === converter,
    typedParentConverterMatches: typedDoc.parent.converter === converter,
    rawStoredData: rawSnap.data() ?? null,
    typedReadData: typedSnap.data() ?? null,
    toFirestoreCallCount: toFirestoreCalls.length,
    fromFirestoreCallCount: fromFirestoreCalls.length,
  };
}

export async function replayWithConverterCollectionPropagatesToDoc(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const rawColl = fs.collection(db, subcollectionPath(ctx, 'wc-coll-doc')) as unknown as {
    type: unknown;
    converter: unknown;
    withConverter: (c: unknown) => { type: unknown; converter: unknown };
  };
  const { converter, toFirestoreCalls, fromFirestoreCalls } = createRecordedItemConverter();
  const typedColl = rawColl.withConverter(converter);

  const namedDoc = fs.doc(typedColl as never, 'd1') as unknown as {
    id: string;
    converter: unknown;
  };
  const autoDoc = fs.doc(typedColl as never) as unknown as {
    id: string;
    converter: unknown;
  };

  await fs.setDoc(namedDoc as never, { title: 'Named', count: 2, tag: 'fixed' } as never);
  await fs.setDoc(autoDoc as never, { title: 'Auto', count: 4 } as never);

  const rawNamedSnap = await fs.getDoc(fs.doc(rawColl as never, 'd1'));
  const typedNamedSnap = await fs.getDoc(namedDoc as never);
  const typedAutoSnap = await fs.getDoc(autoDoc as never);

  return {
    rawCollType: rawColl.type,
    typedCollType: typedColl.type,
    rawCollConverterIsNull: rawColl.converter === null,
    typedCollConverterMatches: typedColl.converter === converter,
    namedDocConverterMatches: namedDoc.converter === converter,
    autoDocConverterMatches: autoDoc.converter === converter,
    autoDocIdLength: autoDoc.id.length,
    rawNamedStored: rawNamedSnap.data() ?? null,
    typedNamedRead: typedNamedSnap.data() ?? null,
    typedAutoRead: typedAutoSnap.data() ?? null,
    toFirestoreCallCount: toFirestoreCalls.length,
    fromFirestoreCallCount: fromFirestoreCalls.length,
  };
}

export async function replayWithConverterCollectionPropagatesToQueryGetDocs(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const rawColl = fs.collection(db, subcollectionPath(ctx, 'wc-coll-query')) as unknown as {
    withConverter: (c: unknown) => unknown;
  };
  const { converter, fromFirestoreCalls } = createRecordedItemConverter();
  const typedColl = rawColl.withConverter(converter);

  await fs.setDoc(fs.doc(typedColl as never, 'a'), { title: 'One', count: 1 } as never);
  await fs.setDoc(
    fs.doc(typedColl as never, 'b'),
    { title: 'Two', count: 2, tag: 'match' } as never,
  );
  await fs.setDoc(
    fs.doc(typedColl as never, 'c'),
    { title: 'Three', count: 3, tag: 'match' } as never,
  );

  const filteredQuery = fs.query(
    typedColl as never,
    fs.where('dbCount', '>=', 20),
    fs.orderBy('dbCount', 'asc'),
  ) as unknown as { type: unknown; converter: unknown };
  const snap = await fs.getDocs(filteredQuery as never);
  const docs = snap.docs.map((docSnap) => ({
    id: docSnap.id,
    data: docSnap.data(),
    refConverterMatches:
      (docSnap.ref as unknown as { converter: unknown }).converter === converter,
  }));

  return {
    filteredQueryType: filteredQuery.type,
    filteredQueryConverterMatches: filteredQuery.converter === converter,
    resultIds: snap.docs.map((docSnap) => docSnap.id),
    docs,
    fromFirestoreCallCount: fromFirestoreCalls.length,
  };
}

export async function replayWithConverterNullStripsConverter(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const rawDoc = fs.doc(
    fs.collection(db, subcollectionPath(ctx, 'wc-strip-null')),
    'd1',
  ) as unknown as {
    converter: unknown;
    withConverter: (c: unknown) => {
      converter: unknown;
      withConverter: (n: null) => { converter: unknown };
    };
  };
  const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
    createRecordedItemConverter();
  const typedDoc = rawDoc.withConverter(converter);
  await fs.setDoc(
    typedDoc as never,
    { title: 'TypedFirst', count: 5, tag: 'init' } as never,
  );

  resetCalls();
  const strippedDoc = typedDoc.withConverter(null);
  const strippedSnap = await fs.getDoc(strippedDoc as never);
  const strippedReadData = strippedSnap.data() ?? null;
  const fromCallsDuringStrippedRead = fromFirestoreCalls.length;

  await fs.setDoc(
    strippedDoc as never,
    { rawField: 'untyped-overwrite', rawNum: 9 } as never,
  );
  const toCallsDuringStrippedWrite = toFirestoreCalls.length;
  const afterRawWriteSnap = await fs.getDoc(rawDoc as never);

  return {
    strippedConverterIsNull: strippedDoc.converter === null,
    refEqualRawAndStripped: fs.refEqual(rawDoc as never, strippedDoc as never),
    refEqualTypedAndStripped: fs.refEqual(typedDoc as never, strippedDoc as never),
    strippedReadData,
    fromCallsDuringStrippedRead,
    toCallsDuringStrippedWrite,
    afterRawWriteStored: afterRawWriteSnap.data() ?? null,
  };
}

export async function replayWithConverterPreservesUntypedRefIdentity(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const untypedDoc = fs.doc(
    fs.collection(db, subcollectionPath(ctx, 'wc-untyped-identity')),
    'd1',
  ) as unknown as {
    id: string;
    path: string;
    converter: unknown;
    withConverter: (c: unknown) => { id: string; path: string; converter: unknown };
  };
  const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
    createRecordedItemConverter();
  const typedDoc = untypedDoc.withConverter(converter);

  await fs.setDoc(
    untypedDoc as never,
    { dbTitle: 'RawSeed', dbCount: 60, dbTag: 'raw' } as never,
  );
  const toCallsDuringUntypedWrite = toFirestoreCalls.length;

  resetCalls();
  const typedSnap = await fs.getDoc(typedDoc as never);
  const typedReadData = typedSnap.data() ?? null;
  const fromCallsDuringTypedRead = fromFirestoreCalls.length;

  resetCalls();
  const untypedSnap = await fs.getDoc(untypedDoc as never);
  const untypedReadData = untypedSnap.data() ?? null;
  const fromCallsDuringUntypedRead = fromFirestoreCalls.length;

  return {
    sameObjectIdentity: (untypedDoc as unknown) === (typedDoc as unknown),
    samePath: untypedDoc.path === typedDoc.path,
    sameId: untypedDoc.id === typedDoc.id,
    untypedConverterRemainsNull: untypedDoc.converter === null,
    typedConverterMatches: typedDoc.converter === converter,
    refEqualUntypedAndTyped: fs.refEqual(untypedDoc as never, typedDoc as never),
    toCallsDuringUntypedWrite,
    typedReadData,
    fromCallsDuringTypedRead,
    untypedReadData,
    fromCallsDuringUntypedRead,
  };
}

export async function replayWithConverterSetDocInvokesToFirestore(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const rawDoc = fs.doc(
    fs.collection(db, subcollectionPath(ctx, 'wc-setdoc-tofirestore')),
    'd1',
  ) as unknown as { withConverter: (c: unknown) => unknown };
  const { converter, toFirestoreCalls } = createRecordedItemConverter();
  const typedDoc = rawDoc.withConverter(converter);

  await fs.setDoc(typedDoc as never, { title: 'Initial', count: 1, tag: 'base' } as never);
  const afterFullWrite = (await fs.getDoc(rawDoc as never)).data() ?? null;

  await fs.setDoc(typedDoc as never, { count: 7 } as never, { merge: true });
  const afterMergeTrue = (await fs.getDoc(rawDoc as never)).data() ?? null;

  await fs.setDoc(
    typedDoc as never,
    { title: 'IgnoredByMask', count: 99, tag: 'masked-tag' } as never,
    { mergeFields: ['dbTag'] },
  );
  const afterMergeFields = (await fs.getDoc(rawDoc as never)).data() ?? null;

  return {
    toFirestoreCalls: [...toFirestoreCalls],
    afterFullWrite,
    afterMergeTrue,
    afterMergeFields,
  };
}

export async function replayWithConverterGetDocInvokesFromFirestore(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const items = fs.collection(db, subcollectionPath(ctx, 'wc-getdoc-fromfirestore'));
  const { converter, fromFirestoreCalls, resetCalls } = createRecordedItemConverter();

  const missingTypedDoc = (
    fs.doc(items, 'missing') as unknown as { withConverter: (c: unknown) => unknown }
  ).withConverter(converter);
  const missingSnap = await fs.getDoc(missingTypedDoc as never);
  const callsAfterMissingGetDoc = fromFirestoreCalls.length;
  const missingRawValue = missingSnap.data();
  const missingDataIsUndefined = missingRawValue === undefined;
  const callsAfterMissingData = fromFirestoreCalls.length;

  const existingTypedDoc = (
    fs.doc(items, 'existing') as unknown as { withConverter: (c: unknown) => unknown }
  ).withConverter(converter);
  await fs.setDoc(existingTypedDoc as never, { title: 'Present', count: 8, tag: 'ok' } as never);
  resetCalls();

  const existingSnap = await fs.getDoc(existingTypedDoc as never);
  const callsAfterGetDocBeforeData = fromFirestoreCalls.length;
  const firstData = existingSnap.data() ?? null;
  const callsAfterFirstData = fromFirestoreCalls.length;
  const secondData = existingSnap.data() ?? null;
  const callsAfterSecondData = fromFirestoreCalls.length;

  return {
    missingExists: missingSnap.exists(),
    missingDataIsUndefined,
    callsAfterMissingGetDoc,
    callsAfterMissingData,
    existingExists: existingSnap.exists(),
    snapshotRefConverterMatches:
      (existingSnap.ref as unknown as { converter: unknown }).converter === converter,
    callsAfterGetDocBeforeData,
    callsAfterFirstData,
    callsAfterSecondData,
    firstData,
    secondData,
    recordedCalls: [...fromFirestoreCalls],
  };
}

export async function replayWithConverterUpdateDocBypassesConverter(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const rawDoc = fs.doc(
    fs.collection(db, subcollectionPath(ctx, 'wc-updatedoc-bypass')),
    'd1',
  ) as unknown as { withConverter: (c: unknown) => unknown };
  const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
    createRecordedItemConverter();
  const typedDoc = rawDoc.withConverter(converter);

  await fs.setDoc(typedDoc as never, { title: 'Seed', count: 2, tag: 'initial' } as never);
  resetCalls();

  await fs.updateDoc(typedDoc as never, { dbCount: 90 });
  const updateFieldForm = fs.updateDoc as unknown as (
    ref: unknown,
    field: string,
    value: unknown,
  ) => Promise<void>;
  await updateFieldForm(typedDoc, 'dbTag', 'patched-via-field-arg');
  const toCallsDuringUpdateDoc = toFirestoreCalls.length;
  const fromCallsDuringUpdateDoc = fromFirestoreCalls.length;

  const rawAfterUpdate = (await fs.getDoc(rawDoc as never)).data() ?? null;
  const typedAfterUpdate = (await fs.getDoc(typedDoc as never)).data() ?? null;

  return {
    toCallsDuringUpdateDoc,
    fromCallsDuringUpdateDoc,
    rawAfterUpdate,
    typedAfterUpdate,
  };
}

export async function replayWithConverterCollectionMethodPropagation(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const rawColl = fs.collection(db, subcollectionPath(ctx, 'wc-coll-method')) as unknown as {
    withConverter: (c: unknown) => unknown;
  };
  const rawGroup = fs.collectionGroup(db, 'wc_group_items') as unknown as {
    type: unknown;
    converter: unknown;
    withConverter: (c: unknown) => {
      type: unknown;
      converter: unknown;
      withConverter: (n: null) => { converter: unknown };
    };
  };
  const { converter, toFirestoreCalls } = createRecordedItemConverter();

  const typedColl = rawColl.withConverter(converter);
  const typedGroup = rawGroup.withConverter(converter);
  const typedGroupFiltered = fs.query(
    typedGroup as never,
    fs.where('dbCount', '==', 10),
  ) as unknown as { converter: unknown };

  const fixedDoc = fs.doc(typedColl as never, 'a_fixed') as unknown as { converter: unknown };
  await fs.setDoc(fixedDoc as never, { title: 'Fixed', count: 1, tag: 'doc-id' } as never);

  const autoDoc = fs.doc(typedColl as never) as unknown as {
    id: string;
    converter: unknown;
  };
  await fs.setDoc(autoDoc as never, { title: 'AutoDoc', count: 2, tag: 'doc-auto' } as never);

  const toCallsBeforeAddDoc = toFirestoreCalls.length;
  const addedRef = (await fs.addDoc(
    typedColl as never,
    { title: 'Added', count: 3, tag: 'add-doc' } as never,
  )) as unknown as { id: string; converter: unknown };
  const toCallsDuringAddDoc = toFirestoreCalls.length - toCallsBeforeAddDoc;
  const addedReadSnap = await fs.getDoc(addedRef as never);

  const orderedSnap = await fs.getDocs(fs.query(typedColl as never, fs.orderBy('dbCount', 'asc')));
  const getDocsItems = orderedSnap.docs.map((docSnap) => ({
    data: docSnap.data(),
    refConverterMatches:
      (docSnap.ref as unknown as { converter: unknown }).converter === converter,
  }));

  const snapshotRows = await observeInitialQuerySnapshot<ConvertedItem>(
    (onNext, onError) => fs.onSnapshot(typedColl as never, onNext as never, onError),
    3,
  );
  const onSnapshotItems = snapshotRows
    .map((row) => ({
      data: row.data,
      refHasConverter: row.refHasConverter,
    }))
    .sort((left, right) => left.data.count - right.data.count);

  const maybeQueryEqual = (
    fs as unknown as { queryEqual?: (left: unknown, right: unknown) => boolean }
  ).queryEqual;
  let groupQueryEqualUntypedVsTyped: boolean | null = null;
  let groupQueryEqualUntypedVsStripped: boolean | null = null;
  if (typeof maybeQueryEqual === 'function') {
    groupQueryEqualUntypedVsTyped = maybeQueryEqual(rawGroup, typedGroup);
    groupQueryEqualUntypedVsStripped = maybeQueryEqual(rawGroup, typedGroup.withConverter(null));
  }

  return {
    hasCollectionMethod: typeof rawColl.withConverter === 'function',
    hasCollectionGroupMethod: typeof rawGroup.withConverter === 'function',
    rawGroupType: rawGroup.type,
    typedGroupType: typedGroup.type,
    rawGroupConverterIsNull: rawGroup.converter === null,
    typedGroupConverterMatches: typedGroup.converter === converter,
    typedGroupFilteredConverterMatches: typedGroupFiltered.converter === converter,
    typedGroupNullStripsConverter: typedGroup.withConverter(null).converter === null,
    groupQueryEqualUntypedVsTyped,
    groupQueryEqualUntypedVsStripped,
    fixedDocConverterMatches: fixedDoc.converter === converter,
    autoDocConverterMatches: autoDoc.converter === converter,
    autoDocIdLength: autoDoc.id.length,
    addedRefConverterMatches: addedRef.converter === converter,
    addedRefIdLength: addedRef.id.length,
    toCallsDuringAddDoc,
    addedReadData: addedReadSnap.data() ?? null,
    getDocsItems,
    onSnapshotItems,
  };
}

export async function replayWithConverterQueryMethodAndSubcollectionIsolation(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const rawColl = fs.collection(db, subcollectionPath(ctx, 'wc-query-method')) as unknown as {
    withConverter: (c: unknown) => {
      withConverter: (n: null) => { converter: unknown };
    };
  };
  const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
    createRecordedItemConverter();
  const typedColl = rawColl.withConverter(converter);

  await fs.setDoc(fs.doc(typedColl as never, 'd1'), { title: 'Low', count: 1 } as never);
  await fs.setDoc(
    fs.doc(typedColl as never, 'd2'),
    { title: 'High', count: 4, tag: 'q' } as never,
  );

  const baseQuery = fs.query(
    rawColl as never,
    fs.where('dbCount', '>=', 20),
    fs.orderBy('dbCount', 'asc'),
  ) as unknown as {
    converter: unknown;
    withConverter: (c: unknown) => {
      converter: unknown;
      withConverter: (n: null) => { converter: unknown };
    };
  };
  const typedQuery = baseQuery.withConverter(converter);
  resetCalls();
  const typedQuerySnap = await fs.getDocs(typedQuery as never);
  const typedQueryDocs = typedQuerySnap.docs.map((docSnap) => ({
    id: docSnap.id,
    data: docSnap.data(),
    refConverterMatches:
      (docSnap.ref as unknown as { converter: unknown }).converter === converter,
  }));
  const fromCallsDuringTypedQuery = fromFirestoreCalls.length;

  resetCalls();
  const untypedQuery = typedQuery.withConverter(null);
  const untypedQuerySnap = await fs.getDocs(untypedQuery as never);
  const untypedQueryDocs = untypedQuerySnap.docs.map((docSnap) => ({
    id: docSnap.id,
    data: docSnap.data(),
    refConverterIsNull: (docSnap.ref as unknown as { converter: unknown }).converter === null,
  }));
  const fromCallsDuringUntypedQuery = fromFirestoreCalls.length;

  resetCalls();
  const untypedColl = typedColl.withConverter(null);
  const untypedCollSnap = await fs.getDocs(
    fs.query(untypedColl as never, fs.orderBy('dbCount', 'asc')),
  );
  const untypedCollDocs = untypedCollSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    data: docSnap.data(),
    refConverterIsNull: (docSnap.ref as unknown as { converter: unknown }).converter === null,
  }));
  const fromCallsDuringUntypedColl = fromFirestoreCalls.length;

  resetCalls();
  const typedParentDoc = fs.doc(typedColl as never, 'd1');
  const subColl = fs.collection(typedParentDoc, 'notes') as unknown as {
    type: unknown;
    converter: unknown;
  };
  const subDoc = fs.doc(subColl as never, 'n1') as unknown as { converter: unknown };
  await fs.setDoc(subDoc as never, { noteText: 'raw-subcollection-doc' } as never);
  const subDocSnap = await fs.getDoc(subDoc as never);
  const toCallsDuringSubcollectionWrite = toFirestoreCalls.length;
  const fromCallsDuringSubcollectionRead = fromFirestoreCalls.length;

  const maybeQueryEqual = (
    fs as unknown as { queryEqual?: (left: unknown, right: unknown) => boolean }
  ).queryEqual;
  let queryEqualBaseAndStripped: boolean | null = null;
  let queryEqualBaseAndTyped: boolean | null = null;
  if (typeof maybeQueryEqual === 'function') {
    queryEqualBaseAndStripped = maybeQueryEqual(baseQuery, untypedQuery);
    queryEqualBaseAndTyped = maybeQueryEqual(baseQuery, typedQuery);
  }

  return {
    hasQueryWithConverterMethod: typeof baseQuery.withConverter === 'function',
    baseQueryConverterIsNull: baseQuery.converter === null,
    typedQueryConverterMatches: typedQuery.converter === converter,
    untypedQueryConverterIsNull: untypedQuery.converter === null,
    queryEqualBaseAndStripped,
    queryEqualBaseAndTyped,
    untypedCollConverterIsNull: untypedColl.converter === null,
    refEqualBaseCollAndStripped: fs.refEqual(rawColl as never, untypedColl as never),
    typedQueryDocs,
    fromCallsDuringTypedQuery,
    untypedQueryDocs,
    fromCallsDuringUntypedQuery,
    untypedCollDocs,
    fromCallsDuringUntypedColl,
    subCollType: subColl.type,
    subCollConverterIsNull: subColl.converter === null,
    subDocConverterIsNull: subDoc.converter === null,
    subDocStoredData: subDocSnap.data() ?? null,
    toCallsDuringSubcollectionWrite,
    fromCallsDuringSubcollectionRead,
  };
}
