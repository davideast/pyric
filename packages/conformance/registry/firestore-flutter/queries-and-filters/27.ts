import { row } from './section.ts';

export default row({
  order: 70,
  api: 'QueryPlatform.where(field, whereNotIn: values)',
  behavior: 'Filters documents where field value matches no element in values list (NOT IN query).',
  featureKeys: ['where', 'whereNotIn'],
  flipped: 'unit-backed',
});
