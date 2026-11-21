import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseCrashlytics local Pyric WebSocket bridge transport",
  behavior: "Routes all 10 crashlytics.* operations over /__pyric/sandbox to CrashlyticsBroker (with an offline local store fallback) instead of Flutter MethodChannel bindings and native OS crash reporters.",
  featureKeys: ["FirebaseCrashlytics.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of invoking platform MethodChannels or uploading crash sessions to Google servers, `pyric_crashlytics` dispatches `crashlytics.*` `worker-op` frames over `/__pyric/sandbox` to `CrashlyticsBroker`. Verified in `packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
    "packages/flutter-client/test/crashlytics/crashlytics_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
