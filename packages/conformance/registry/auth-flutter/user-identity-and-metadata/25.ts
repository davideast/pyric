import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'UserPlatform.isAnonymous',
  behavior: 'Reports true if user signed in anonymously, false otherwise.',
  featureKeys: ['isAnonymous'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
