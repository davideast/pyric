import { describe, it } from 'bun:test';
import {
  replayAggregateAverageEmptyAndNonNumeric,
  replayAggregateComposeDottedAndFieldPath,
  replayGetCountFromServerDataShape,
  replayGetCountFromServerWhereFilters,
} from '../../../../conformance/src/firestore-aggregates-replay.ts';
import { expectReplay, inPageContext, load } from './support.ts';

describe('Firestore Aggregates oracle captures (in-page pyric/firestore)', () => {
  it('firestore-getcountfromserver-data-shape (firestore#74)', async () => {
    const production = load('firestore-getcountfromserver-data-shape');
    const pyric = await replayGetCountFromServerDataShape(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-getcountfromserver-where-filters (firestore#75)', async () => {
    const production = load('firestore-getcountfromserver-where-filters');
    const pyric = await replayGetCountFromServerWhereFilters(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-aggregate-compose-dotted-and-fieldpath (firestore#77)', async () => {
    const production = load('firestore-aggregate-compose-dotted-and-fieldpath');
    const pyric = await replayAggregateComposeDottedAndFieldPath(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-aggregate-average-empty-and-nonnumeric (firestore#78)', async () => {
    const production = load('firestore-aggregate-average-empty-and-nonnumeric');
    const pyric = await replayAggregateAverageEmptyAndNonNumeric(inPageContext());
    expectReplay({ production, pyric });
  });
});
