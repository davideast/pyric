import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'PyricFirebaseAppCheckPlatform.setTokenAutoRefreshEnabled(enabled) / isTokenAutoRefreshEnabled',
  behavior: 'Enables or cancels the proactive refresh timer and exposes current state via isTokenAutoRefreshEnabled.',
  featureKeys: ['setTokenAutoRefreshEnabled', 'isTokenAutoRefreshEnabled'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` and `packages/flutter-client/test/live_host/app_check_live_host_test.dart`.',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
    'packages/flutter-client/test/live_host/app_check_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
