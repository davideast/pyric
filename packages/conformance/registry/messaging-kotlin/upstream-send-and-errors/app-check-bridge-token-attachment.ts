import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseMessaging App Check bridge token attachment",
  behavior: "Automatically mints and attaches a valid RS256 appCheckToken from a registered FirebaseAppCheck provider onto every messaging.* worker-op envelope so strict App Check enforcement accepts token, topic, visibility, and send operations.",
  featureKeys: ["FirebaseMessaging.appCheckTokenAttachment"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt` and `packages/cli/test/serve/native-kotlin-messaging-conformance.test.ts` (asserts all 6 `messaging.*` ops carry RS256 `appCheckToken`).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
