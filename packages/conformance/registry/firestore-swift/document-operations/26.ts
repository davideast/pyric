import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 50,
  api: 'DocumentReference.getDocument(source:)',
  behavior: 'Reads document snapshot from server, cache, or default source.',
  featureKeys: ['getDocument'],
  status: 'conforms',
  oracleObservations: [
    'firestore-swift-crud-merge-sentinels-and-codecs',
    'firestore-swift-batches-transactions-offline-and-errors',
  ],
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
