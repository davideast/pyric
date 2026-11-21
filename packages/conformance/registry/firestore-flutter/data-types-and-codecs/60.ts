import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'GeoPoint codec',
  behavior: 'Serializes and revives GeoPoint coordinates (latitude, longitude) over WebSocket bridge.',
  featureKeys: ['GeoPoint'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/firestore_queries_tx_codecs_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
