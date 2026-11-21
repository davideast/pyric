import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "ReferencePlatform.putData(data, [metadata])",
  behavior: "Streams Uint8List payloads (0-byte through multi-chunk > 256 KiB) via PyricTaskPlatform with progress snapshots and FullMetadata completion.",
  featureKeys: ["putData"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_task_test.dart`, `packages/flutter-client/test/storage/storage_edge_cases_test.dart`, and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#7, storage-live#8).",
  tests: [
    "packages/flutter-client/test/storage/storage_task_test.dart",
    "packages/flutter-client/test/storage/storage_edge_cases_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
