import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DatabaseReference.updateChildValues(_:)',
  behavior: 'Performs a multi-path atomic update of specified child keys without overwriting omitted siblings.',
  featureKeys: ['updateChildValues'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-dedicated-crud-and-query-order',
    'rtdb-swift-writes-autoid-servervalue-and-transactions',
  ],
});
