import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "FirebaseCrashlytics App Check bridge token attachment",
  behavior: "Automatically mints and attaches a valid RS256 appCheckToken from FirebaseAppCheckPlatform onto every crashlytics.* worker-op envelope.",
  featureKeys: ["FirebaseCrashlytics.appCheckTokenAttachment"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart` and `packages/cli/test/serve/native-flutter-crashlytics-conformance.test.ts`.",
  tests: [
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
