import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseReference.childByAutoId()',
  behavior: 'Generates a new child DatabaseReference with a chronologically ordered unique push ID.',
  featureKeys: ['childByAutoId'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: [
    'rtdb-swift-writes-autoid-servervalue-and-transactions',
    'rtdb-swift-navigation-push-priorities-and-snapshots',
  ],
});
