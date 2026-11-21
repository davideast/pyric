import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "isCrashlyticsCollectionEnabled() / setCrashlyticsCollectionEnabled(_:)",
  behavior: "Synchronizes per-app Crashlytics collection state with CrashlyticsBroker so errors recorded while disabled queue into unsentReports until explicitly sent or deleted.",
  featureKeys: ["Crashlytics.isCrashlyticsCollectionEnabled", "Crashlytics.setCrashlyticsCollectionEnabled"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` and `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
