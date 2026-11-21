import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseReference.setValue(_:andPriority:)',
  behavior: 'Atomically writes the node value alongside its ordering priority metadata.',
  featureKeys: ['setValueAndPriority'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: ['rtdb-swift-navigation-push-priorities-and-snapshots'],
});
