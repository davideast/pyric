import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: 'Timestamp',
  behavior: 'UTC timestamp representing 64-bit seconds and nanosecond resolution.',
  featureKeys: ['timestamp'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-crud-merge-sentinels-and-codecs'],
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
