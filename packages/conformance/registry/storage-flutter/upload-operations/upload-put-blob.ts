import { row } from './section.ts';

export default row({
  order: 50,
  api: "ReferencePlatform.putBlob(data, [metadata])",
  behavior: "Uploads Uint8List, List<int>, ByteBuffer, String, Stream<List<int>>, and File blob sources via PyricTaskPlatform.",
  featureKeys: ["putBlob"],
  evidence: "Verified against mock bridge in `packages/flutter-client/test/storage/storage_file_and_blob_test.dart`.",
  tests: [
    "packages/flutter-client/test/storage/storage_file_and_blob_test.dart",
  ],
});
