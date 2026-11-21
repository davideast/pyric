import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageTask.taskState: Flow<TaskState<T>>",
  behavior: "Emits TaskState.InProgress and TaskState.Paused snapshots until completion, unregisters listeners when cancelled early, and propagates StorageException to Flow collectors on failure or cancellation.",
  featureKeys: ["taskState", "InProgress"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageDownloadAndFlowTasksTest.kt` (taskStateFlowEmitsInProgressAndPausedAndPropagatesErrorsToCatch), `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageConcurrencyLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageDownloadAndFlowTasksTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageConcurrencyLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
