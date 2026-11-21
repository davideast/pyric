import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Crashlytics.flush() / getState() / CrashlyticsStateSnapshot",
  behavior: "Drains all queued FIFO operations via flush() and decodes typed CrashlyticsStateSnapshot records (logs, reports, unsentReports, customKeys, userID, collectionEnabled).",
  featureKeys: ["Crashlytics.flush", "Crashlytics.getState", "CrashlyticsStateSnapshot"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` and `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
