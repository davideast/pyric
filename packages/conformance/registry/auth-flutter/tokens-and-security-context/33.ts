import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'UserPlatform forced token refresh event dispatch',
  behavior: 'Dispatches auth change events across platform streams when token claims change upon forced refresh.',
  featureKeys: ['idTokenRefresh'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
