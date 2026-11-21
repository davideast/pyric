import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Blob codec',
  behavior: 'Serializes Uint8List byte buffers to base64 bridge wire format and revives them as Blob.',
  featureKeys: ['Blob'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
