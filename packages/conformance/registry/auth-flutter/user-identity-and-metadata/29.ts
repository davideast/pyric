import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 100,
  api: 'UserPlatform.metadata',
  behavior: 'Provides creationTimestamp and lastSignInTimestamp wrapped in UserMetadata.',
  featureKeys: ['metadata'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
