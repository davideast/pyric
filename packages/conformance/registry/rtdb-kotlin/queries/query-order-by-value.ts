import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.orderByValue()',
  behavior: 'Orders query results by direct scalar node values.',
  featureKeys: ['orderByValue'],
});
