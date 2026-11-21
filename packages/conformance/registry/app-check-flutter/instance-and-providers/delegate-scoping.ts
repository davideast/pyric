import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'PyricFirebaseAppCheckPlatform.registerWith() / delegateFor(app:) / dispose()',
  behavior: 'Registers PyricFirebaseAppCheckPlatform on FirebaseAppCheckPlatform.instance, caches isolated per-FirebaseApp delegates, and closes streams, timers, and owned bridge connections on dispose().',
  featureKeys: ['PyricFirebaseAppCheckPlatform', 'registerWith', 'delegateFor'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/app_check/app_check_test.dart` and `packages/flutter-client/test/live_host/app_check_live_host_test.dart` (mints standard, forced-refresh, and limited-use RS256 App Check JWTs across isolated FirebaseApps over live WebSocket bridge).',
  tests: [
    'packages/flutter-client/test/app_check/app_check_test.dart',
    'packages/flutter-client/test/live_host/app_check_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
