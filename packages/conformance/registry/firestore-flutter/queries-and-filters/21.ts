import { row } from './section.ts';

export default row({
  order: 10,
  api: 'QueryPlatform.where(field, isEqualTo: value)',
  behavior: 'Filters documents matching exact field equality.',
  featureKeys: ['where'],
  flipped: 'unit-backed',
});
