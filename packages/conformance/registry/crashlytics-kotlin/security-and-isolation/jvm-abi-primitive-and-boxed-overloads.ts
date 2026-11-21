import { row } from './section.ts';

export default row({
  order: 20,
  api: "FirebaseCrashlyticsKt & JVM bytecode primitive/boxed setCrashlyticsCollectionEnabled overloads",
  behavior: "Emits both primitive boolean and boxed java.lang.Boolean JVM method signatures for setCrashlyticsCollectionEnabled alongside the com.google.firebase.crashlytics.FirebaseCrashlyticsKt facade.",
  featureKeys: ["FirebaseCrashlyticsKt"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt` (`singleton KTX JVM ABI overloads and per-app isolation match firebase-crashlytics`).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
  ],
});
