import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DatabaseReference.childByAutoId().key',
  behavior: 'Monotonically orders generated push keys lexicographically by creation timestamp.',
  featureKeys: ['pushKeyOrdering'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-writes-autoid-servervalue-and-transactions',
    'rtdb-swift-navigation-push-priorities-and-snapshots',
  ],
});
