import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'MultiFactorPlatform interface contract',
  behavior: 'Exposes stub MultiFactorPlatform for enrolled multi-factor inspection.',
  featureKeys: ['multiFactor'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
