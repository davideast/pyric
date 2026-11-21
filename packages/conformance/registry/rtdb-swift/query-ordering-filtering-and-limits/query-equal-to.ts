import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseQuery.queryEqual(toValue:childKey:)',
  behavior: 'Filters query results to nodes matching the exact sort value and optional key.',
  featureKeys: ['queryEqualToValue'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-queries-ranges-limits-and-permission-denied',
    'rtdb-swift-navigation-push-priorities-and-snapshots',
  ],
});
