import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 50,
  api: 'DocumentSnapshot.data()',
  behavior: 'Returns dictionary of document fields or nil if document does not exist.',
  featureKeys: ['data'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-crud-merge-sentinels-and-codecs'],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
