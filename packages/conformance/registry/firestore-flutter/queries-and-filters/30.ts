import { row } from './section.ts';

export default row({
  order: 100,
  api: 'QueryPlatform.limit(limit)',
  behavior: 'Limits maximum number of matched documents returned.',
  featureKeys: ['limit'],
  flipped: 'unit-backed',
});
