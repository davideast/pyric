import { row } from './section.ts';

export default row({
  order: 140,
  api: 'Query.limit(to:)',
  behavior: 'Limits maximum number of matching documents from start of query results.',
  featureKeys: ['limitTo'],
  flipped: 'unit-backed',
});
