import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "checkForUnsentReports() / checkAndUpdateUnsentReports() / CrashlyticsReport / sendUnsentReports() / deleteUnsentReports()",
  behavior: "Inspects queued unsent reports, annotates pending CrashlyticsReport handles with post-crash logs, custom values, and userID updates, and promotes or deletes queued reports.",
  featureKeys: ["Crashlytics.checkForUnsentReports", "Crashlytics.checkAndUpdateUnsentReports", "CrashlyticsReport", "Crashlytics.sendUnsentReports", "Crashlytics.deleteUnsentReports"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` and `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
