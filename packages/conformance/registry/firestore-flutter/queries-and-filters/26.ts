import { row } from './section.ts';

export default row({
  order: 60,
  api: 'QueryPlatform.where(field, whereIn: values)',
  behavior: 'Filters documents where field value matches any element in values list (IN query).',
  featureKeys: ['where', 'whereIn'],
  flipped: 'unit-backed',
});
