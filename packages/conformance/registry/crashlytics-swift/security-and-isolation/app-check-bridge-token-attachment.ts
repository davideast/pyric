import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "Crashlytics App Check bridge token attachment",
  behavior: "Automatically mints and attaches a valid RS256 appCheckToken from a configured AppCheck provider onto every crashlytics.* worker-op frame.",
  featureKeys: ["Crashlytics.appCheckTokenAttachment"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift` and `packages/cli/test/serve/native-swift-crashlytics-conformance.test.ts`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
