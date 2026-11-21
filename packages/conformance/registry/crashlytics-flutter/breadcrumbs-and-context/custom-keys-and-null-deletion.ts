import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "setCustomKey(key, value) / setCustomKeysAndValues(keysAndValues)",
  behavior: "Persists String, int, double, and bool custom keys on CrashlyticsBroker and deletes existing keys when null values are supplied via setCustomKeysAndValues.",
  featureKeys: ["FirebaseCrashlytics.setCustomKey", "FirebaseCrashlytics.setCustomKeysAndValues"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` and `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
