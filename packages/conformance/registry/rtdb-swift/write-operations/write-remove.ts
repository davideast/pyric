import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseReference.removeValue()',
  behavior: 'Removes the node and all descendant data at the reference path.',
  featureKeys: ['removeValue'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-dedicated-crud-and-query-order',
    'rtdb-swift-writes-autoid-servervalue-and-transactions',
  ],
});
