import { row } from './section.ts';

export default row({
  order: 30,
  api: "SendException (ERROR_INVALID_PARAMETERS, ERROR_MISSING_TO, ERROR_TTL_EXCEEDED, ERROR_TOO_MANY_MESSAGES, ERROR_UNKNOWN) / onDeletedMessages",
  behavior: "Maps missing destination, invalid parameter, TTL exceeded, quota/rate-limit, and unknown upstream send failures to canonical SendException integer error codes and dispatches FirebaseMessagingService.onDeletedMessages.",
  featureKeys: ["SendException", "SendException.ERROR_INVALID_PARAMETERS", "SendException.ERROR_MISSING_TO", "SendException.ERROR_TTL_EXCEEDED", "SendException.ERROR_TOO_MANY_MESSAGES", "FirebaseMessagingService.onDeletedMessages"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` (`RemoteMessage builder KTX DSL send callbacks and SendException error codes`).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
  ],
});
