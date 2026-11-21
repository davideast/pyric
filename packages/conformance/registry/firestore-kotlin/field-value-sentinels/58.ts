import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FieldValue.arrayRemove(elements)',
  behavior: 'Encodes transformation removing matching elements from array field.',
  featureKeys: ['arrayRemove'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-crud-merge-sentinels-and-codecs'],
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
