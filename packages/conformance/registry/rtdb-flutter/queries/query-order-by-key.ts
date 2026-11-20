import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.orderByKey()',
  behavior: 'Orders query results lexicographically by child key name.',
  featureKeys: ['orderByKey'],
});
