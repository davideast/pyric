import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 170,
  api: 'Firestore.terminate()',
  behavior: 'Terminates the client instance and cancels active snapshot listeners.',
  featureKeys: ['terminate'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-batches-transactions-offline-and-errors'],
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
