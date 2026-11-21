import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: "StorageReference.putFile(uri, metadata, existingUploadUri)",
  behavior: "Probes the server byte offset of an existing uploadSessionUri over the HTTP byte route and resumes uploading only the remaining bytes.",
  featureKeys: ["uploadSessionUri", "livePutFileResumesFromExistingUploadSessionUriOffset"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageResumableUploadTasksTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt` (livePutFileResumesFromExistingUploadSessionUriOffset).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageResumableUploadTasksTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageTasksLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
