import { row } from './section.ts';

export default row({
  order: 30,
  api: "didCrashOnPreviousExecution() / simulatePreviousCrashForTest(didCrash)",
  behavior: "Reports whether the previous app execution terminated with a fatal crash and updates local state from broker getState() or simulatePreviousCrashForTest.",
  featureKeys: ["FirebaseCrashlytics.didCrashOnPreviousExecution", "FirebaseCrashlytics.simulatePreviousCrashForTest"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt` (`disabled collection defers into unsent reports and supports check send delete and nullable reset`).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
  ],
});
