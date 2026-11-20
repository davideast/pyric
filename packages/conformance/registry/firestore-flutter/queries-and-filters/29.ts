import { row } from './section.ts';

export default row({
  order: 90,
  api: 'QueryPlatform.orderBy(field, descending: bool)',
  behavior: 'Orders query results by field ascending or descending.',
  featureKeys: ['orderBy'],
  flipped: 'unit-backed',
});
