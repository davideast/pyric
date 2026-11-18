import { describe, it } from 'bun:test';
import {
  replayAggregateAverageEmptyAndNonNumeric,
  replayAggregateComposeDottedAndFieldPath,
  replayGetCountFromServerDataShape,
  replayGetCountFromServerWhereFilters,
} from '../../../../../conformance/src/firestore-aggregates-replay.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

describe('Firestore Aggregates oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('firestore-getcountfromserver-data-shape (firestore#74)', async () => {
    const production = load('firestore-getcountfromserver-data-shape');
    const pyric = await replayGetCountFromServerDataShape(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-getcountfromserver-where-filters (firestore#75)', async () => {
    const production = load('firestore-getcountfromserver-where-filters');
    const pyric = await replayGetCountFromServerWhereFilters(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-aggregate-compose-dotted-and-fieldpath (firestore#77)', async () => {
    const production = load('firestore-aggregate-compose-dotted-and-fieldpath');
    const pyric = await replayAggregateComposeDottedAndFieldPath(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-aggregate-average-empty-and-nonnumeric (firestore#78)', async () => {
    const production = load('firestore-aggregate-average-empty-and-nonnumeric');
    const pyric = await replayAggregateAverageEmptyAndNonNumeric(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });
});
