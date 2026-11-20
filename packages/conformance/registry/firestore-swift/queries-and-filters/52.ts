import { row } from './section.ts';

export default row({
  order: 120,
  api: 'Query.order(by:)',
  behavior: 'Sorts query results by field ascending.',
  featureKeys: ['orderBy'],
  flipped: 'unit-backed',
});
