import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageReference.getData(maxSize:completion:) / data(maxSize:completion:)",
  behavior: "Enqueues an observable StorageDownloadTask delivering in-memory Data or NSError / Result<Data, Error> on callbackQueue.",
  featureKeys: ["getData", "StorageDownloadTask"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift` (completionAndResultOverloadsDeliverValuesAndErrors) and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift` (concurrentTransfersAndCancellationIsolationOverHostedRuntime).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
