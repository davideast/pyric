import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "ReferencePlatform.list([options])",
  behavior: "Paginates combined prefixes and items (1..1000) via ListOptions(maxResults, pageToken) and rejects invalid maxResults or malformed cursors with FirebaseException(code: \"invalid-argument\").",
  featureKeys: ["ListOptions", "nextPageToken"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_string_and_pagination_test.dart`, `packages/flutter-client/test/storage/storage_wire_codec_test.dart`, and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#5).",
  tests: [
    "packages/flutter-client/test/storage/storage_string_and_pagination_test.dart",
    "packages/flutter-client/test/storage/storage_wire_codec_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
