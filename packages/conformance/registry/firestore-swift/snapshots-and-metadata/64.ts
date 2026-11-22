import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentSnapshot.exists',
  behavior: 'Boolean indicating whether document currently exists in Firestore.',
  featureKeys: ['exists'],
  status: 'conforms',
  oracleObservations: [
    'firestore-swift-crud-merge-sentinels-and-codecs',
    'firestore-swift-batches-transactions-offline-and-errors',
  ],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
