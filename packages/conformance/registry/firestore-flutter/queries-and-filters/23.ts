import { row } from './section.ts';

export default row({
  order: 30,
  api: 'QueryPlatform.where(field, isLessThan / isLessThanOrEqualTo / isGreaterThan / isGreaterThanOrEqualTo)',
  behavior: 'Applies relational range comparison filters on field value.',
  featureKeys: ['where'],
  flipped: 'unit-backed',
});
