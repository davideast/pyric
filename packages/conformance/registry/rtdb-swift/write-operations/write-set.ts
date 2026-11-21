import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.setValue(_:)',
  behavior: 'Overwrites data at the reference path with the provided JSON-serializable value.',
  featureKeys: ['setValue'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-dedicated-crud-and-query-order',
    'rtdb-swift-queries-ranges-limits-and-permission-denied',
  ],
});
