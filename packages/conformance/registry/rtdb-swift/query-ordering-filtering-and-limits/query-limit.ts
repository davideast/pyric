import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseQuery.queryLimited(toFirst:) / queryLimited(toLast:)',
  behavior: 'Caps query results to the first N or last N ordered child nodes.',
  featureKeys: ['queryLimitedToFirst', 'queryLimitedToLast'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-dedicated-crud-and-query-order',
    'rtdb-swift-queries-ranges-limits-and-permission-denied',
    'rtdb-swift-navigation-push-priorities-and-snapshots',
  ],
});
