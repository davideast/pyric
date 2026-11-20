import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuthPlatform.userChanges()',
  behavior: 'Broadcast Stream emitting UserPlatform upon user profile, claims, or auth transitions.',
  featureKeys: ['userChanges'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
