import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'UserPlatform.customClaims',
  behavior: 'Exposes decoded custom claims map attached to user token identity.',
  featureKeys: ['customClaims'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
