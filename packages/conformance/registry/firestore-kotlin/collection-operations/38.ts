import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'CollectionReference.add(data)',
  behavior: 'Generates auto-ID, writes document data, and returns DocumentReference.',
  featureKeys: ['add'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-crud-merge-sentinels-and-codecs'],
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
