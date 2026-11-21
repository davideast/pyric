import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseException(plugin: \"firebase_storage\") error mapping",
  behavior: "Strips storage/ wire prefixes and maps bridge and HTTP byte-route failures (401/403/404/412/429) to FlutterFire codes (object-not-found, unauthorized, unauthenticated, quota-exceeded, canceled, download-size-exceeded, invalid-argument).",
  featureKeys: ["normalizeStorageErrorCode", "object-not-found"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_wire_codec_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#1, storage-live#2, storage-live#6).",
  tests: [
    "packages/flutter-client/test/storage/storage_wire_codec_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
