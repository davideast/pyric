import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "ReferencePlatform.putString(data, format, [metadata])",
  behavior: "Encodes and uploads PutStringFormat.raw, base64, base64Url, and dataUrl strings with MIME inference and validation on malformed inputs.",
  featureKeys: ["putString", "PutStringFormat"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_string_and_pagination_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#7).",
  tests: [
    "packages/flutter-client/test/storage/storage_string_and_pagination_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
