import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Crashlytics.log(_:) / log(format:_:) / log(format:arguments:)",
  behavior: "Formats plain and C printf-style variadic log messages in FIFO order, appends them to the rolling breadcrumb buffer, and attaches breadcrumbs to recorded error and exception reports.",
  featureKeys: ["Crashlytics.log"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` and `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
