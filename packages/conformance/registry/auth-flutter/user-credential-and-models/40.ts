import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'UserCredentialPlatform.additionalUserInfo',
  behavior: 'Provides AdditionalUserInfo indicating whether authenticated user is a new user.',
  featureKeys: ['additionalUserInfo'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
