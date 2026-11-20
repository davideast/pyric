import { row } from './section.ts';

export default row({
  order: 60,
  api: 'Query.whereIn(field, values)',
  behavior: 'Filters documents where field value matches any element in values list (IN query).',
  featureKeys: ['whereIn'],
  flipped: 'unit-backed',
});
