import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseQuery.queryOrdered(byChild:)',
  behavior: 'Orders query results by the value of the specified nested child key.',
  featureKeys: ['queryOrderedByChild'],
});
