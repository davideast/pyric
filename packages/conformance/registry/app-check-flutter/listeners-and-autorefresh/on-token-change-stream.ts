import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'PyricFirebaseAppCheckPlatform.onTokenChange',
  behavior: 'Broadcasts distinct standard App Check JWT strings on onTokenChange whenever getToken, getTokenResult, or auto-refresh mints a new token, while suppressing cached hits and limited-use tokens.',
  featureKeys: ['onTokenChange'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` and `packages/flutter-client/test/live_host/app_check_live_host_test.dart`.',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
    'packages/flutter-client/test/live_host/app_check_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
