import { row } from './section.ts';

export default row({
  order: 30,
  api: "StorageMetadata(dictionary:) & dictionaryRepresentation()",
  behavior: "Round-trips StorageMetadata dictionary representations, NSCopying clones, and null patch tombstones for cleared fields and removed customMetadata keys.",
  featureKeys: ["dictionaryRepresentation", "metadataPatchClearsRemovedKeysAndFields"],
  evidence: "Verified in unit suites `packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift` (metadataFieldsAndDictionaryRepresentation) and `packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift` (metadataPatchClearsRemovedKeysAndFields).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageUnitTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift",
  ],
});
