import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 50,
  api: 'FieldValue.arrayRemove(_:)',
  behavior: 'Transformation removing matching elements from array field.',
  featureKeys: ['arrayRemove'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-crud-merge-sentinels-and-codecs'],
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
