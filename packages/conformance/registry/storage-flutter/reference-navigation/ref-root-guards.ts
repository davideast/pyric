import { row } from './section.ts';

export default row({
  order: 40,
  api: "ReferencePlatform root-level preconditions",
  behavior: "Rejects object-only operations (getData, getDownloadURL, getMetadata, updateMetadata, delete, putData, putBlob, putFile, putString, writeToFile) on the root reference with FirebaseException(code: \"invalid-root-operation\").",
  featureKeys: ["invalid-root-operation"],
  evidence: "Verified against mock bridge in `packages/flutter-client/test/storage/pyric_reference_platform_test.dart` and `packages/flutter-client/test/storage/storage_file_and_blob_test.dart`.",
  tests: [
    "packages/flutter-client/test/storage/pyric_reference_platform_test.dart",
    "packages/flutter-client/test/storage/storage_file_and_blob_test.dart",
  ],
});
