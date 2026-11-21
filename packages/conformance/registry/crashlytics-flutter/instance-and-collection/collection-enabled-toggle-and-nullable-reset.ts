import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "isCrashlyticsCollectionEnabled / setCrashlyticsCollectionEnabled(enabled) / pluginConstants",
  behavior: "Synchronizes Crashlytics collection overrides (true, false, and null reset to FirebaseApp automatic data collection) with CrashlyticsBroker and exposes pluginConstants.",
  featureKeys: ["FirebaseCrashlytics.isCrashlyticsCollectionEnabled", "FirebaseCrashlytics.setCrashlyticsCollectionEnabled"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` and `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
