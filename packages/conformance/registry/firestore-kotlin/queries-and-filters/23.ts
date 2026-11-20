import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.whereLessThan / whereLessThanOrEqualTo / whereGreaterThan / whereGreaterThanOrEqualTo',
  behavior: 'Applies relational range comparison filters on field value.',
  featureKeys: ['whereLessThan', 'whereGreaterThan'],
  flipped: 'unit-backed',
});
