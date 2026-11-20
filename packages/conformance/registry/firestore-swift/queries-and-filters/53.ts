import { row } from './section.ts';

export default row({
  order: 130,
  api: 'Query.order(by:descending:)',
  behavior: 'Sorts query results by field ascending or descending.',
  featureKeys: ['orderByDescending'],
  flipped: 'unit-backed',
});
