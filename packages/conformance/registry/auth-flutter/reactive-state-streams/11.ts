import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuthPlatform.authStateChanges()',
  behavior: 'Broadcast Stream emitting UserPlatform upon sign-in/sign-out with immediate replay of current state.',
  featureKeys: ['authStateChanges'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
