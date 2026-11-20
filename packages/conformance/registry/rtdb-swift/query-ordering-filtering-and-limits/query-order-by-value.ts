import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DatabaseQuery.queryOrderedByValue()',
  behavior: 'Orders query results by direct scalar node values.',
  featureKeys: ['queryOrderedByValue'],
});
