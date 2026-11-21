import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: "ReferencePlatform.putFile(file, [metadata])",
  behavior: "Streams local dart:io File chunks via PyricTaskPlatform and surfaces missing-file errors as FirebaseException.",
  featureKeys: ["putFile"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_file_and_blob_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#7).",
  tests: [
    "packages/flutter-client/test/storage/storage_file_and_blob_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
