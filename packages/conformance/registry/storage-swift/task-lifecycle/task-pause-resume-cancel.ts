import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "StorageUploadTask / StorageDownloadTask pause() / resume() / cancel()",
  behavior: "Pauses, resumes, and cancels in-flight transfers, aborting or rolling back staged server uploads and surfacing StorageErrorCode.cancelled.",
  featureKeys: ["pause", "resume", "cancel", "observableUploadTaskPauseResumeAndCancelOverHostedRuntime"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageObservableTaskTests.swift` (pauseResumeAndCancelUploadTask, cancelRacingFinishUploadRollsBackCommittedObject), `packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift` (observableUploadTaskPauseResumeAndCancelOverHostedRuntime), and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageObservableTaskTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
