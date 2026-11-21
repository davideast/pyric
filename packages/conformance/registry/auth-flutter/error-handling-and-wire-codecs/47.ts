import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Bridge auth operation codecs',
  behavior: 'Encodes and decodes auth.* RPC operations and subscription frames across WebSocket bridge.',
  featureKeys: ['bridgeOps'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
