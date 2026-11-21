import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: "Storage.useEmulator(withHost:port:)",
  behavior: "Rebinds the Storage instance before operations start to a local Pyric host endpoint.",
  featureKeys: ["useEmulator"],
  status: "diverged-documented",
  statusNote: "bridge transport",
  evidence: "`useEmulator(withHost:port:)` connects `PyricBridgeClient` to `ws://<host>:<port>/__pyric/sandbox` and the companion HTTP byte route rather than speaking the upstream Firebase Storage REST emulator wire protocol, verified live in `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
