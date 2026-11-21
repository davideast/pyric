import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "PyricFirebaseStoragePlatform.refFromURL(url)",
  behavior: "Parses gs://, Firebase REST, Google Cloud Storage, and Pyric HTTP byte-route URLs into bucket-scoped ReferencePlatform delegates and rejects data: or malformed percent-encoded URLs.",
  featureKeys: ["refFromURL"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/pyric_storage_platform_test.dart`, `packages/flutter-client/test/storage/storage_wire_codec_test.dart`, and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#4, storage-live#6).",
  tests: [
    "packages/flutter-client/test/storage/pyric_storage_platform_test.dart",
    "packages/flutter-client/test/storage/storage_wire_codec_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
