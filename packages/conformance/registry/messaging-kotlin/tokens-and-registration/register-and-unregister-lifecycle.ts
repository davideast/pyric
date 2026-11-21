import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseMessaging.register() / unregister() / onRegistered / onUnregistered",
  behavior: "Coordinates explicit broker registration and unregistration cycles and emits registration state transitions on onRegistered and onUnregistered flows.",
  featureKeys: ["FirebaseMessaging.register", "FirebaseMessaging.unregister", "FirebaseMessaging.onRegistered", "FirebaseMessaging.onUnregistered"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` (`singleton KTX token deduplication caching deleteToken and settings match upstream`).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
  ],
});
