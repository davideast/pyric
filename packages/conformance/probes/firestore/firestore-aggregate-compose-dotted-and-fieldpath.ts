import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#77',
  rowIds: ['firestore#77'],
  description:
    'count(), sum(field), and average(field) compose under one getAggregateFromServer spec across dotted nested string paths and FieldPath instances, and expose AggregateField descriptor metadata.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        AggregateField,
        aggregateFieldEqual,
        average,
        collection,
        count,
        doc,
        FieldPath,
        getAggregateFromServer,
        queryEqual,
        setDoc,
        sum,
      } = firestoreSdk;

      const sumDotted = sum('metrics.pages');
      const sumPath = sum(new FieldPath('metrics', 'pages'));
      const sumLiteralDot = sum(new FieldPath('metrics.pages'));
      const avgDotted = average('metrics.pages');
      const avgPath = average(new FieldPath('metrics', 'pages'));

      const items = collection(db, collectionPath('aggregate-compose-dotted'));
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

      const literalDotItems = collection(db, collectionPath('aggregate-literal-dot'));
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
          sumType: sumDotted.type,
          sumAggregateType: sumDotted.aggregateType,
          avgIsAggregateField: avgDotted instanceof AggregateField,
          avgType: avgDotted.type,
          avgAggregateType: avgDotted.aggregateType,
          equalCount: aggregateFieldEqual(count(), count()),
          equalSumStringVsFieldPath: aggregateFieldEqual(sumDotted, sumPath),
          equalAvgStringVsFieldPath: aggregateFieldEqual(avgDotted, avgPath),
          equalSumVsAvgSameField: aggregateFieldEqual(sumDotted, avgDotted),
          equalNestedVsLiteralDot: aggregateFieldEqual(sumDotted, sumLiteralDot),
        },
        dottedResult: dottedSnap.data(),
        dottedQueryMatchesInput: queryEqual(dottedSnap.query, items),
        fieldPathResult: fieldPathSnap.data(),
        literalDotResult: literalDotSnap.data(),
      };
    });
  },
};
