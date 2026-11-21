import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "setUserID(_:) / setCustomValue(_:forKey:) / setCustomKeysAndValues(_:)",
  behavior: "Updates per-app userID and Bool, Int, Int64, Float, Double, String, and URL custom values, removing existing keys on CrashlyticsBroker when nil is passed to setCustomValue(_:forKey:).",
  featureKeys: ["Crashlytics.setUserID", "Crashlytics.setCustomValue", "Crashlytics.setCustomKeysAndValues"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` and `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
