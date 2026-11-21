import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Crashlytics local Pyric WebSocket bridge transport",
  behavior: "Routes logs, custom values, NSError and ExceptionModel reports, and unsent-report operations over the local Pyric WebSocket bridge via app.useEmulator(withHost:port:) instead of Mach exception handlers and cloud Crashlytics ingestion.",
  featureKeys: ["Crashlytics.bridgeTransport"],
  status: "diverged-documented",
  statusNote: "local WebSocket bridge routing",
  evidence: "Instead of installing Mach/POSIX signal traps or uploading dSYM crash payloads to Google servers, `PyricCrashlytics` dispatches `crashlytics.*` `worker-op` frames over `/__pyric/sandbox` to `CrashlyticsBroker`. Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
