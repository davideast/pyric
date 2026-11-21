import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'PyricFirebaseAppCheckPlatform.getToken(false) / getTokenResult(false)',
  behavior: 'Mints a ~1-hour RS256 App Check JWT bound to appId and projectId on cache miss or inside the 5-minute expiry buffer, and returns the cached token and AppCheckTokenResult while fresh.',
  featureKeys: ['PyricFirebaseAppCheckPlatform.getToken', 'getTokenResult', 'AppCheckTokenResult'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` and `packages/flutter-client/test/live_host/app_check_live_host_test.dart`, with `pyric-admin/app-check` `verifyToken()` validation in `packages/cli/test/serve/native-flutter-appcheck-conformance.test.ts`.',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
    'packages/flutter-client/test/live_host/app_check_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
