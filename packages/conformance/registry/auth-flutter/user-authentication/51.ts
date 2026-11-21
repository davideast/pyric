import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 80,
  api: 'FirebaseAuthPlatform.signInWithCredential(credential)',
  behavior: 'Authenticates user with an OAuthCredential via bridge auth.signInWithCredential RPC, updating currentUser and providerData.',
  featureKeys: ['signInWithCredential'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
