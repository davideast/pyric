import { row } from './section.ts';

export default row({
  order: 150,
  api: 'Query.limit(toLast:)',
  behavior: 'Limits results to last N documents requiring explicit orderBy constraint.',
  featureKeys: ['limitToLast'],
  flipped: 'unit-backed',
});
