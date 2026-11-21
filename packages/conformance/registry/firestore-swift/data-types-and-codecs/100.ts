import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 30,
  api: 'FieldPath',
  behavior: 'Path pointing to nested document field or documentID sentinel.',
  featureKeys: ['fieldPath'],
  status: 'conforms',
  oracleObservations: [
    'firestore-swift-crud-merge-sentinels-and-codecs',
    'firestore-swift-instance-snapshots-inSync-and-codable',
  ],
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
