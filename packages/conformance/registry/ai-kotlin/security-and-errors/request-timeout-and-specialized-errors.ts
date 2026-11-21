import { row } from './section.ts';

export default row({
  order: 30,
  api: "RequestOptions(timeoutInMillis) / RequestTimeoutException / UnsupportedUserLocationException / APINotConfiguredException / ServiceDisabledException",
  behavior: "Enforces RequestOptions.timeoutInMillis deadlines with RequestTimeoutException and maps location, unconfigured-API, and disabled-service wire errors to specialized FirebaseAIException subclasses.",
  featureKeys: ["RequestOptions", "RequestTimeoutException", "UnsupportedUserLocationException", "APINotConfiguredException", "ServiceDisabledException"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt` (wireErrorsTimeoutAndCancellationMapToExactFirebaseAiExceptionHierarchy).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/GenerativeModelExceptionsAndAppCheckTest.kt",
  ],
});
