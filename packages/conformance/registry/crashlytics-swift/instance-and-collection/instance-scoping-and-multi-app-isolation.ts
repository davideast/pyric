import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Crashlytics.crashlytics() / crashlytics(app:) / evictInstance(for:) / disconnect()",
  behavior: "Caches per-FirebaseApp Crashlytics singletons, omits appId on [DEFAULT], isolates named-app reports and custom keys on CrashlyticsBroker, and tears down sessions on disconnect() and evictInstance(for:).",
  featureKeys: ["Crashlytics.crashlytics", "Crashlytics.evictInstance", "Crashlytics.disconnect"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` and `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
