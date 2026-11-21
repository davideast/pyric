import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Crashlytics.record(error:) / record(error:userInfo:)",
  behavior: "Extracts NSError domain, code, localizedDescription, nested NSUnderlyingErrorKey cause chains, and call-site userInfo attributes into sdkPlatform == 'ios' CrashlyticsBroker reports.",
  featureKeys: ["Crashlytics.record(error:)", "CrashlyticsError"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` and `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
