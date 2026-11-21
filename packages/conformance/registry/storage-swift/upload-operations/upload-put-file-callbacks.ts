import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: "StorageReference.putFile(from:metadata:completion:)",
  behavior: "Enqueues an observable StorageUploadTask for local file uploads with (StorageMetadata?, Error?) and Result<StorageMetadata, Error> completion overloads.",
  featureKeys: ["putFile"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift` and `packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
