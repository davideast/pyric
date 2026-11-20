import { row } from './section.ts';

export default row({
  order: 110,
  api: 'QueryPlatform.limitToLast(limit)',
  behavior: 'Limits query results to the last N documents relative to query ordering.',
  featureKeys: ['limitToLast'],
  flipped: 'unit-backed',
});
