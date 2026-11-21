import { row } from './section.ts';

export default row({
  order: 40,
  api: "StorageReference root-level preconditions",
  behavior: "Rejects object-only operations (putData, putFile, data, write(toFile:), getMetadata, updateMetadata, downloadURL, delete) at the bucket root while allowing listAll() and list(maxResults:).",
  featureKeys: ["fileIOValidatesInvalidFileURLsAndRootReference"],
  evidence: "Verified against mock bridge in `packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift` (fileIOValidatesInvalidFileURLsAndRootReference).",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageFileAndPaginationTests.swift",
  ],
});
