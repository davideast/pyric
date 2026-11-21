import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  api: 'OAuthProvider(providerId).credential({idToken, accessToken, rawNonce})',
  behavior: 'Constructs a generic OAuthCredential with custom providerId, idToken, accessToken, and rawNonce.',
  featureKeys: ['OAuthProvider', 'credential'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
