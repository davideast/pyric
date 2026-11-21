import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "ReferencePlatform.getMetadata()",
  behavior: "Fetches and decodes FullMetadata (bucket, fullPath, name, size, generation, metageneration, md5Hash, timeCreated, updated, content headers, and customMetadata).",
  featureKeys: ["getMetadata", "FullMetadata"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/storage/storage_wire_codec_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#3).",
  tests: [
    "packages/flutter-client/test/storage/storage_wire_codec_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
