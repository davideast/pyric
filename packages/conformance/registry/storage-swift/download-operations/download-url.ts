import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: "StorageReference.downloadURL() / downloadURL(completion:)",
  behavior: "Mints a persistent token-gated download URL serving stored bytes over HTTP without SDK headers and round-tripping through storage.reference(for:).",
  featureKeys: ["downloadURL"],
  status: "diverged-documented",
  statusNote: "local byte-route URL",
  evidence: "On the Pyric host, `downloadURL()` returns `http://<host>:<port>/__pyric/storage/v0/b/<bucket>/o/<path>?alt=media&token=<token>` on the local host origin rather than `https://firebasestorage.googleapis.com/...`. Tokenized HTTP fetch and `reference(for:)` round-tripping are verified in `packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift` and `packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageCompletionAndBucketTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
