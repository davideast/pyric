import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 60,
  api: 'DocumentReference.setData(_:)',
  behavior: 'Overwrites the target document completely with provided dictionary payload.',
  featureKeys: ['setData'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-crud-merge-sentinels-and-codecs'],
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
