import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "Swift structured concurrency Task.cancel() propagation",
  behavior: "Propagates Swift structured Task cancellation via withTaskCancellationHandler into StorageTaskManagement.cancel() across putDataAsync, putFileAsync, data(maxSize:), and writeAsync(toFile:).",
  featureKeys: ["withCancellableStorageTask", "concurrentUploadsDownloadsAndCancellationIsolation"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift` (concurrentUploadsDownloadsAndCancellationIsolation) and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift` (concurrentTransfersAndCancellationIsolationOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseHardeningTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
