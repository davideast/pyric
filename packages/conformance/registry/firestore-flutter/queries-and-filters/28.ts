import { row } from './section.ts';

export default row({
  order: 80,
  api: 'QueryPlatform.where(field, isNull: true/false)',
  behavior: 'Filters documents based on null equality or field existence.',
  featureKeys: ['where', 'isNull'],
  flipped: 'unit-backed',
});
