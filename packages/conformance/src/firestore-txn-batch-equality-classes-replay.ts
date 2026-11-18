import type { FirestoreDataConverter } from 'firebase/firestore';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';

export async function replayTransactionAndBatchQueuedMutations(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { collection, doc, getDoc, runTransaction, setDoc, writeBatch } = ctx.fs;

  const txnItems = collection(ctx.db, `${ctx.base}/txn-atomic-read-write`);
  const refA = doc(txnItems, 'acct-a');
  const refB = doc(txnItems, 'acct-b');
  const refNew = doc(txnItems, 'acct-new');
  const refStale = doc(txnItems, 'acct-stale');

  await setDoc(refA, { balance: 100 });
  await setDoc(refB, { balance: 40 });
  await setDoc(refStale, { flag: 'drop' });

  let readConsistentBalances: number[] = [];
  let missingExistsInTxn = true;

  const returnValue = await runTransaction(ctx.db, async (txn) => {
    const snapA = await txn.get(refA);
    const snapB = await txn.get(refB);
    const snapMissing = await txn.get(refNew);
    readConsistentBalances = [
      Number(snapA.data()?.balance),
      Number(snapB.data()?.balance),
    ];
    missingExistsInTxn = snapMissing.exists();

    txn.update(refA, { balance: 75 });
    txn.update(refB, { balance: 65 });
    txn.set(refNew, { transferred: 25 });
    txn.delete(refStale);
    return 'committed-25';
  });

  const postA = await getDoc(refA);
  const postB = await getDoc(refB);
  const postNew = await getDoc(refNew);
  const postStale = await getDoc(refStale);

  let newDocData: unknown = null;
  const rawNew = postNew.data();
  if (rawNew !== undefined) {
    newDocData = rawNew;
  }

  const batchItems = collection(ctx.db, `${ctx.base}/batch-queued-mutations`);
  const batchSetRef = doc(batchItems, 'b-set');
  const batchUpdateRef = doc(batchItems, 'b-update');
  const batchDeleteRef = doc(batchItems, 'b-delete');

  await setDoc(batchUpdateRef, { count: 1 });
  await setDoc(batchDeleteRef, { keep: false });

  const batch = writeBatch(ctx.db);
  batch.set(batchSetRef, { count: 10 });
  batch.update(batchUpdateRef, { count: 9 });
  batch.delete(batchDeleteRef);

  const preCommitSetSnap = await getDoc(batchSetRef);
  const preCommitUpdateSnap = await getDoc(batchUpdateRef);
  const preCommitDeleteSnap = await getDoc(batchDeleteRef);

  await batch.commit();

  const postCommitSetSnap = await getDoc(batchSetRef);
  const postCommitUpdateSnap = await getDoc(batchUpdateRef);
  const postCommitDeleteSnap = await getDoc(batchDeleteRef);

  let preCommitUpdateCount: unknown = null;
  const preUpdateData = preCommitUpdateSnap.data();
  if (preUpdateData !== undefined && preUpdateData.count !== undefined) {
    preCommitUpdateCount = preUpdateData.count;
  }

  let postCommitSetCount: unknown = null;
  const postSetData = postCommitSetSnap.data();
  if (postSetData !== undefined && postSetData.count !== undefined) {
    postCommitSetCount = postSetData.count;
  }

  let postCommitUpdateCount: unknown = null;
  const postUpdateData = postCommitUpdateSnap.data();
  if (postUpdateData !== undefined && postUpdateData.count !== undefined) {
    postCommitUpdateCount = postUpdateData.count;
  }

  return {
    transaction: {
      returnValue,
      readConsistentBalances,
      missingExistsInTxn,
      postCommitBalances: [
        Number(postA.data()?.balance),
        Number(postB.data()?.balance),
      ],
      newDocData,
      deletedDocExists: postStale.exists(),
    },
    writeBatchQueueing: {
      preCommitSetExists: preCommitSetSnap.exists(),
      preCommitUpdateCount,
      preCommitDeleteExists: preCommitDeleteSnap.exists(),
      postCommitSetCount,
      postCommitUpdateCount,
      postCommitDeleteExists: postCommitDeleteSnap.exists(),
    },
  };
}

export async function replayRefEqualAndAggregateEquality(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
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
  } = ctx.fs;

  const items = collection(ctx.db, `${ctx.base}/refequal-server-agg-eq`);
  const siblingItems = collection(ctx.db, `${ctx.base}/refequal-sibling`);

  const converter: FirestoreDataConverter<{ readonly points: number }> = {
    toFirestore: (model) => ({ points: model.points }),
    fromFirestore: (snap) => ({ points: Number(snap.data().points) }),
  };

  const alphaRef = doc(items, 'alpha');
  const alphaViaDb = doc(ctx.db, items.path, 'alpha');
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
      sameCollectionPathEqual: refEqual(collection(ctx.db, items.path), items),
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
}

export async function replayRuntimeClassesAndInstanceOf(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const {
    AggregateField,
    AggregateQuerySnapshot,
    CACHE_SIZE_UNLIMITED,
    CollectionReference,
    DocumentReference,
    DocumentSnapshot,
    Firestore,
    FirestoreError,
    Query,
    QueryCompositeFilterConstraint,
    QueryConstraint,
    QueryDocumentSnapshot,
    QueryEndAtConstraint,
    QueryFieldFilterConstraint,
    QueryLimitConstraint,
    QueryOrderByConstraint,
    QuerySnapshot,
    QueryStartAtConstraint,
    SnapshotMetadata,
    Transaction,
    WriteBatch,
    collection,
    count,
    doc,
    endAt,
    getCountFromServer,
    getDoc,
    getDocs,
    limit,
    or,
    orderBy,
    query,
    runTransaction,
    setDoc,
    startAt,
    where,
    writeBatch,
  } = ctx.fs;

  const items = collection(ctx.db, `${ctx.base}/runtime-classes-instanceof`);
  const itemRef = doc(items, 'doc-1');
  await setDoc(itemRef, { rank: 1 });

  const docSnap = await getDoc(itemRef);
  const builtQuery = query(items, where('rank', '==', 1));
  const querySnap = await getDocs(builtQuery);
  const firstQueryDoc = querySnap.docs[0];
  if (firstQueryDoc === undefined) {
    throw new Error('Expected query document');
  }

  const countField = count();
  const aggSnap = await getCountFromServer(items);
  const batch = writeBatch(ctx.db);

  let txnIsTransaction = false;
  await runTransaction(ctx.db, async (txn) => {
    txnIsTransaction = txn instanceof Transaction;
    await txn.get(itemRef);
  });

  let caughtInvalidPathError: unknown = null;
  try {
    doc(ctx.db, 'invalid/even');
  } catch (err) {
    caughtInvalidPathError = err;
  }

  const fieldFilter = where('rank', '==', 1);
  const compositeFilter = or(where('rank', '==', 1), where('rank', '==', 2));
  const orderConstraint = orderBy('rank');
  const limitConstraint = limit(5);
  const startConstraint = startAt(1);
  const endConstraint = endAt(1);

  return {
    constantsAndExports: {
      cacheSizeUnlimited: CACHE_SIZE_UNLIMITED,
      hasAbstractUserDataWriter: 'AbstractUserDataWriter' in ctx.fs,
    },
    handleInstanceOf: {
      dbIsFirestore: ctx.db instanceof Firestore,
      collIsCollectionReference: items instanceof CollectionReference,
      collIsQuery: items instanceof Query,
      builtQueryIsQuery: builtQuery instanceof Query,
      docRefIsDocumentReference: itemRef instanceof DocumentReference,
      docSnapIsDocumentSnapshot: docSnap instanceof DocumentSnapshot,
      docSnapMetadataIsSnapshotMetadata: docSnap.metadata instanceof SnapshotMetadata,
      querySnapIsQuerySnapshot: querySnap instanceof QuerySnapshot,
      queryDocIsQueryDocumentSnapshot: firstQueryDoc instanceof QueryDocumentSnapshot,
      queryDocIsDocumentSnapshot: firstQueryDoc instanceof DocumentSnapshot,
      batchIsWriteBatch: batch instanceof WriteBatch,
      txnIsTransaction,
      countIsAggregateField: countField instanceof AggregateField,
      aggSnapIsAggregateQuerySnapshot: aggSnap instanceof AggregateQuerySnapshot,
      invalidPathIsFirestoreError: caughtInvalidPathError instanceof FirestoreError,
      invalidPathIsError: caughtInvalidPathError instanceof Error,
    },
    constraintInstanceOf: {
      fieldFilterIsFieldFilter: fieldFilter instanceof QueryFieldFilterConstraint,
      fieldFilterIsQueryConstraint: fieldFilter instanceof QueryConstraint,
      compositeIsCompositeFilter: compositeFilter instanceof QueryCompositeFilterConstraint,
      compositeIsQueryConstraint: compositeFilter instanceof QueryConstraint,
      orderIsOrderByConstraint: orderConstraint instanceof QueryOrderByConstraint,
      orderIsQueryConstraint: orderConstraint instanceof QueryConstraint,
      limitIsLimitConstraint: limitConstraint instanceof QueryLimitConstraint,
      limitIsQueryConstraint: limitConstraint instanceof QueryConstraint,
      startIsStartAtConstraint: startConstraint instanceof QueryStartAtConstraint,
      startIsQueryConstraint: startConstraint instanceof QueryConstraint,
      endIsEndAtConstraint: endConstraint instanceof QueryEndAtConstraint,
      endIsQueryConstraint: endConstraint instanceof QueryConstraint,
    },
  };
}
