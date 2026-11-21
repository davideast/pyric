import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: "PyricFirebaseStoragePlatform.useStorageEmulator(host, port)",
  behavior: "Validates host and port arguments and reconnects the Storage platform delegate to a local Pyric bridge host.",
  featureKeys: ["useStorageEmulator"],
  status: "diverged-documented",
  statusNote: "bridge transport",
  evidence: "`useStorageEmulator(host, port)` connects `PyricBridgeClient` to `ws://<host>:<port>/__pyric/sandbox` and the companion HTTP byte route rather than speaking the upstream Firebase Storage REST emulator wire protocol, verified in `packages/flutter-client/test/storage/pyric_storage_platform_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#6).",
  tests: [
    "packages/flutter-client/test/storage/pyric_storage_platform_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
