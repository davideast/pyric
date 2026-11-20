import { row } from './section.ts';

export default row({
  order: 20,
  api: 'QueryPlatform.where(field, isNotEqualTo: value)',
  behavior: 'Filters documents where field does not equal specified value.',
  featureKeys: ['where'],
  flipped: 'unit-backed',
});
