import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseQuery.queryEqual(toValue:childKey:)',
  behavior: 'Filters query results to nodes matching the exact sort value and optional key.',
  featureKeys: ['queryEqualToValue'],
});
