import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Messaging condition fanout ('topicA' in topics && 'topicB' in topics)",
  behavior: "Delivers condition-targeted messages to subscribed Kotlin clients matching boolean &&, ||, and ! topic expressions and halts delivery immediately after unsubscribeFromTopic breaks the predicate.",
  featureKeys: ["FirebaseMessaging.conditionFanout"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt` and `packages/cli/test/serve/native-kotlin-messaging-conformance.test.ts`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/MessagingLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
