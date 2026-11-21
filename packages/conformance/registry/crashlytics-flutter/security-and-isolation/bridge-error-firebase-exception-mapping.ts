import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseException (plugin: 'firebase_crashlytics') bridge error mapping & dispose()",
  behavior: "Normalizes rejected crashlytics.* bridge operations into FirebaseException(plugin: 'firebase_crashlytics') with stripped error code prefixes and cleans up state on dispose().",
  featureKeys: ["FirebaseCrashlytics.dispose"],
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` (`maps bridge errors into FirebaseException under firebase_crashlytics`).",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
  ],
});
