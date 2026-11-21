import { row } from './section.ts';

export default row({
  order: 40,
  api: "maxUploadRetryTime / maxDownloadRetryTime / maxOperationRetryTime",
  behavior: "Exposes upstream default retry intervals (600s, 600s, 120s), clamps non-negative updates, and preserves settings across NSCopying copy().",
  featureKeys: ["maxUploadRetryTime", "maxDownloadRetryTime", "maxOperationRetryTime"],
  evidence: "Verified against mock bridge in `packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift` (instanceCachingPerAppAndPerBucket).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift",
  ],
});
