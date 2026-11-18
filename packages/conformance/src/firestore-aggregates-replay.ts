import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';

function queriesMatch(fs: unknown, left: unknown, right: unknown): boolean {
  const maybeQueryEqual = (
    fs as { queryEqual?: (a: unknown, b: unknown) => boolean }
  ).queryEqual;
  if (typeof maybeQueryEqual === 'function') {
    return maybeQueryEqual(left, right);
  }
  return left === right;
}

export async function replayGetCountFromServerDataShape(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
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
    setDoc,
  } = ctx.fs;

  const countField = count();
  const items = collection(ctx.db, `${ctx.base}/count-data-shape`);

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
      type: countField.type ?? null,
      aggregateType: countField.aggregateType ?? null,
    },
    empty: {
      isAggregateQuerySnapshot: emptySnap instanceof AggregateQuerySnapshot,
      type: emptySnap.type,
      dataKeys: Object.keys(emptyData),
      data: emptyData,
      queryMatchesInput: queriesMatch(ctx.fs, emptySnap.query, items),
    },
    populated: {
      dataKeys: Object.keys(fullData),
      data: fullData,
      queryMatchesInput: queriesMatch(ctx.fs, fullSnapA.query, items),
      equalSameQueryAndCount: aggregateQuerySnapshotEqual(fullSnapA, fullSnapB),
      equalDifferentCount: aggregateQuerySnapshotEqual(emptySnap, fullSnapA),
      equalDifferentQuery: aggregateQuerySnapshotEqual(fullSnapA, cappedSnap),
    },
    cappedLimit2: {
      data: cappedData,
      queryMatchesInput: queriesMatch(ctx.fs, cappedSnap.query, cappedQuery),
    },
  };
}

export async function replayGetCountFromServerWhereFilters(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { collection, doc, getCountFromServer, or, query, setDoc, where } = ctx.fs;
  const items = collection(ctx.db, `${ctx.base}/count-where-filters`);

  await setDoc(doc(items, 'item-1'), { status: 'active', priority: 10 });
  await setDoc(doc(items, 'item-2'), { status: 'active', priority: 25 });
  await setDoc(doc(items, 'item-3'), { status: 'queued', priority: 30 });
  await setDoc(doc(items, 'item-4'), { status: 'archived', priority: 5 });
  await setDoc(doc(items, 'item-5'), { status: 'active', priority: 40 });

  const activeSnap = await getCountFromServer(query(items, where('status', '==', 'active')));
  const highPrioritySnap = await getCountFromServer(
    query(items, where('priority', '>=', 25)),
  );
  const inSetSnap = await getCountFromServer(
    query(items, where('status', 'in', ['queued', 'archived'])),
  );
  const compositeOrSnap = await getCountFromServer(
    query(
      items,
      or(where('status', '==', 'queued'), where('status', '==', 'archived')),
    ),
  );
  const zeroMatchSnap = await getCountFromServer(
    query(items, where('status', '==', 'nonexistent')),
  );

  return {
    equalityActiveCount: activeSnap.data().count,
    rangePriorityAtLeast25Count: highPrioritySnap.data().count,
    inQueuedOrArchivedCount: inSetSnap.data().count,
    compositeOrQueuedOrArchivedCount: compositeOrSnap.data().count,
    zeroMatchCount: zeroMatchSnap.data().count,
  };
}

export async function replayAggregateComposeDottedAndFieldPath(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const {
    AggregateField,
    aggregateFieldEqual,
    average,
    collection,
    count,
    doc,
    FieldPath,
    getAggregateFromServer,
    setDoc,
    sum,
  } = ctx.fs;

  const sumDotted = sum('metrics.pages');
  const sumPath = sum(new FieldPath('metrics', 'pages'));
  const sumLiteralDot = sum(new FieldPath('metrics.pages'));
  const avgDotted = average('metrics.pages');
  const avgPath = average(new FieldPath('metrics', 'pages'));

  const items = collection(ctx.db, `${ctx.base}/aggregate-compose-dotted`);
  await setDoc(doc(items, 'book-1'), { metrics: { pages: 100 } });
  await setDoc(doc(items, 'book-2'), { metrics: { pages: 250 } });
  await setDoc(doc(items, 'book-3'), { metrics: { pages: 550 } });

  const dottedSnap = await getAggregateFromServer(items, {
    docCount: count(),
    totalPages: sumDotted,
    meanPages: avgDotted,
  });

  const fieldPathSnap = await getAggregateFromServer(items, {
    docCount: count(),
    totalPages: sumPath,
    meanPages: avgPath,
  });

  const literalDotItems = collection(ctx.db, `${ctx.base}/aggregate-literal-dot`);
  await setDoc(doc(literalDotItems, 'lit-1'), {
    'metrics.pages': 12,
    metrics: { pages: 900 },
  });
  await setDoc(doc(literalDotItems, 'lit-2'), {
    'metrics.pages': 18,
    metrics: { pages: 900 },
  });
  const literalDotSnap = await getAggregateFromServer(literalDotItems, {
    docCount: count(),
    totalLiteral: sumLiteralDot,
    meanLiteral: average(new FieldPath('metrics.pages')),
  });

  return {
    descriptors: {
      sumIsAggregateField: sumDotted instanceof AggregateField,
      sumType: sumDotted.type ?? null,
      sumAggregateType: sumDotted.aggregateType ?? null,
      avgIsAggregateField: avgDotted instanceof AggregateField,
      avgType: avgDotted.type ?? null,
      avgAggregateType: avgDotted.aggregateType ?? null,
      equalCount: aggregateFieldEqual(count(), count()),
      equalSumStringVsFieldPath: aggregateFieldEqual(sumDotted, sumPath),
      equalAvgStringVsFieldPath: aggregateFieldEqual(avgDotted, avgPath),
      equalSumVsAvgSameField: aggregateFieldEqual(sumDotted, avgDotted),
      equalNestedVsLiteralDot: aggregateFieldEqual(sumDotted, sumLiteralDot),
    },
    dottedResult: dottedSnap.data(),
    dottedQueryMatchesInput: queriesMatch(ctx.fs, dottedSnap.query, items),
    fieldPathResult: fieldPathSnap.data(),
    literalDotResult: literalDotSnap.data(),
  };
}

export async function replayAggregateAverageEmptyAndNonNumeric(
  ctx: FirestoreScenarioContext,
): Promise<Behavior> {
  const { average, collection, count, doc, getAggregateFromServer, query, setDoc, sum, where } =
    ctx.fs;

  const emptyColl = collection(ctx.db, `${ctx.base}/avg-empty-coll`);
  const emptySnap = await getAggregateFromServer(emptyColl, {
    docCount: count(),
    totalScore: sum('score'),
    meanScore: average('score'),
  });

  const filteredColl = collection(ctx.db, `${ctx.base}/avg-zero-match`);
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

  const missingFieldColl = collection(ctx.db, `${ctx.base}/avg-missing-field`);
  await setDoc(doc(missingFieldColl, 'm1'), { label: 'alpha' });
  await setDoc(doc(missingFieldColl, 'm2'), { label: 'beta' });
  const missingFieldSnap = await getAggregateFromServer(missingFieldColl, {
    docCount: count(),
    totalScore: sum('score'),
    meanScore: average('score'),
  });

  const nonNumericColl = collection(ctx.db, `${ctx.base}/avg-nonnumeric-field`);
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
}
