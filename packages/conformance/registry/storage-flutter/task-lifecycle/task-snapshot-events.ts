import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "TaskPlatform.snapshotEvents / snapshot / onComplete",
  behavior: "Broadcasts TaskState.running, paused, success, canceled, and error PyricTaskSnapshotPlatform updates carrying bytesTransferred, totalBytes, and terminal FullMetadata.",
  featureKeys: ["snapshotEvents", "onComplete", "TaskState"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_task_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#7).",
  tests: [
    "packages/flutter-client/test/storage/storage_task_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
