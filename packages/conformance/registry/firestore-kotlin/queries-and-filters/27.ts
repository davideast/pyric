import { row } from './section.ts';

export default row({
  order: 70,
  api: 'Query.whereNotIn(field, values)',
  behavior: 'Filters documents where field value matches no element in values list (NOT IN query).',
  featureKeys: ['whereNotIn'],
  flipped: 'unit-backed',
});
