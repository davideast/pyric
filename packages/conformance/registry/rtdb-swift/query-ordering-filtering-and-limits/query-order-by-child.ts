import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseQuery.queryOrdered(byChild:)',
  behavior: 'Orders query results by the value of the specified nested child key.',
  featureKeys: ['queryOrderedByChild'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-dedicated-crud-and-query-order',
    'rtdb-swift-navigation-push-priorities-and-snapshots',
  ],
});
