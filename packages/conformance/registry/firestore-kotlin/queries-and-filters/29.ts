import { row } from './section.ts';

export default row({
  order: 90,
  api: 'Query.orderBy(field, direction)',
  behavior: 'Orders query results by field ascending or descending.',
  featureKeys: ['orderBy'],
  flipped: 'unit-backed',
});
