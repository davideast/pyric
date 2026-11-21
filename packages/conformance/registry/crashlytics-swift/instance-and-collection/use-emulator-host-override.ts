import { row } from './section.ts';

export default row({
  order: 40,
  api: "Crashlytics.useEmulator(withHost:port:sslEnabled:) / Crashlytics.reset()",
  behavior: "Reconfigures an instance's PyricBridgeClient endpoint (normalizing Android 10.0.2.2 and wildcard hosts to 127.0.0.1) and clears cached instances via Crashlytics.reset().",
  featureKeys: ["Crashlytics.useEmulator", "Crashlytics.reset"],
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` (`Caches per-app instances, omits appId on [DEFAULT], attaches AppCheck tokens, and reconfigures emulator host`).",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
  ],
});
