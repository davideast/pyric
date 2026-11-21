import { row } from './section.ts';

export default row({
  order: 40,
  api: "maxUploadRetryTimeMillis / maxDownloadRetryTimeMillis / maxOperationRetryTimeMillis / maxChunkUploadRetry",
  behavior: "Exposes upstream default retry budgets (600_000L, 600_000L, 120_000L, 60_000L) and retains caller overrides on the FirebaseStorage instance.",
  featureKeys: ["maxUploadRetryTimeMillis", "maxDownloadRetryTimeMillis", "maxOperationRetryTimeMillis"],
  evidence: "Verified against mock bridge in `packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt` (retryTimeoutsAndUseEmulatorRetainSettingsAndValidateArguments).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt",
  ],
});
