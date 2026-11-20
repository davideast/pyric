import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'GoogleAuthProvider.credential({idToken, accessToken})',
  behavior: 'Constructs an OAuthCredential for google.com with idToken and accessToken.',
  featureKeys: ['GoogleAuthProvider', 'credential'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
