import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_SNAPSHOTS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentSnapshot.getData()',
  behavior: 'Returns revived Map<String, Object> containing document field data.',
  featureKeys: ['getData'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-crud-merge-sentinels-and-codecs'],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
