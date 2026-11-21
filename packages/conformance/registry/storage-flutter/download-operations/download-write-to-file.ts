import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "ReferencePlatform.writeToFile(file)",
  behavior: "Streams downloaded object chunks to a local File via PyricTaskPlatform, truncating existing target files cleanly on 0-byte objects.",
  featureKeys: ["writeToFile"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_file_and_blob_test.dart`, `packages/flutter-client/test/storage/storage_edge_cases_test.dart`, and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#7, storage-live#8).",
  tests: [
    "packages/flutter-client/test/storage/storage_file_and_blob_test.dart",
    "packages/flutter-client/test/storage/storage_edge_cases_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
