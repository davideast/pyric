import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentReference codec',
  behavior: 'Encodes and decodes DocumentReferencePlatform values stored within document fields.',
  featureKeys: ['DocumentReference'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
