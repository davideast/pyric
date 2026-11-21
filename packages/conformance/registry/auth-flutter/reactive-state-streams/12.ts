import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuthPlatform.idTokenChanges()',
  behavior: 'Broadcast Stream emitting UserPlatform upon sign-in, sign-out, or token refresh with immediate replay.',
  featureKeys: ['idTokenChanges'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
