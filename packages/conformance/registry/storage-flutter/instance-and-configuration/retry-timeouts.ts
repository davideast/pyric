import { row } from './section.ts';

export default row({
  order: 40,
  api: "maxOperationRetryTime / maxUploadRetryTime / maxDownloadRetryTime",
  behavior: "Exposes FlutterFire default retry budgets (120_000ms, 600_000ms, 600_000ms), applies updates via setMax*RetryTime, and rejects negative values with FirebaseException(code: \"invalid-argument\").",
  featureKeys: ["maxOperationRetryTime", "setMaxUploadRetryTime", "setMaxDownloadRetryTime"],
  evidence: "Verified against mock bridge in `packages/flutter-client/test/storage/pyric_storage_platform_test.dart`.",
  tests: [
    "packages/flutter-client/test/storage/pyric_storage_platform_test.dart",
  ],
});
