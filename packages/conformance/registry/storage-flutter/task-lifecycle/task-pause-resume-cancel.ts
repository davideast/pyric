import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "TaskPlatform.pause() / resume() / cancel()",
  behavior: "Pauses, resumes, and cancels in-flight upload and file-download tasks, aborting or rolling back staged server uploads and rejecting onComplete with FirebaseException(code: \"canceled\").",
  featureKeys: ["pause", "resume", "cancel"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_task_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#7).",
  tests: [
    "packages/flutter-client/test/storage/storage_task_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
