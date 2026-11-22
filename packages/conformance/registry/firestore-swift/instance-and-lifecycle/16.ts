import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_LIFECYCLE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 160,
  api: 'Firestore.clearPersistence()',
  behavior: 'Clears offline client persistence cache when no active listeners exist.',
  featureKeys: ['clearPersistence'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-batches-transactions-offline-and-errors'],
  tests: [LIVE_HOST_LIFECYCLE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
