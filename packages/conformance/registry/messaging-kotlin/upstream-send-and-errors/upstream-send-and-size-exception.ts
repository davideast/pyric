import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "send(RemoteMessage) / remoteMessage(to) { ... } / onMessageSent / onSendError / SendException.ERROR_SIZE",
  behavior: "Builds outbound messages via RemoteMessage.Builder or the remoteMessage(to) KTX DSL, dispatches messaging.send to MessagingBroker, invokes FirebaseMessagingService.onMessageSent on acceptance, and surfaces >4 KB payload rejections via onSendError with SendException(ERROR_SIZE).",
  featureKeys: ["FirebaseMessaging.send", "RemoteMessage.Builder", "FirebaseMessagingService.onMessageSent", "FirebaseMessagingService.onSendError", "SendException.ERROR_SIZE"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
