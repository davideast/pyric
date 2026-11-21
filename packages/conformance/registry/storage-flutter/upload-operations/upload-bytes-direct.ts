import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "PyricFirebaseStoragePlatform.uploadBytes(path, bytes, metadata:)",
  behavior: "Uploads Uint8List payloads (0-byte through multi-part payloads) with SettableMetadata and returns server FullMetadata.",
  featureKeys: ["uploadBytes"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_edge_cases_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#2).",
  tests: [
    "packages/flutter-client/test/storage/storage_edge_cases_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
