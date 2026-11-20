import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuthPlatform.sendAuthChangesEvent(appName, userPlatform)',
  behavior: 'Dispatches synthetic auth state updates across all stream controllers.',
  featureKeys: ['sendAuthChangesEvent'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
