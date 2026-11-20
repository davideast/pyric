import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuthPlatform.signInWithEmailAndPassword(email, password)',
  behavior: 'Authenticates user via bridge auth.signInEmail RPC and updates currentUser.',
  featureKeys: ['signInWithEmailAndPassword'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
