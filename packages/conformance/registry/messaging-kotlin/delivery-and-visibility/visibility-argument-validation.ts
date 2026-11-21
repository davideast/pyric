import { row } from './section.ts';

export default row({
  order: 30,
  api: "FirebaseMessaging.setVisibility(state: String) validation",
  behavior: "Rejects visibility strings outside 'visible' and 'hidden' locally with IllegalArgumentException before dispatching a messaging.setVisibility bridge operation.",
  featureKeys: ["FirebaseMessaging.setVisibilityValidation"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt` (`foregroundMessages backgroundMessages service delivery and visibility validation`).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt",
  ],
});
