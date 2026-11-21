import { row } from './section.ts';

export default row({
  order: 20,
  api: "Circular Throwable.cause guard & NaN/Infinity float normalization",
  behavior: "Terminates cyclic Throwable cause graphs cleanly with [CIRCULAR REFERENCE: ...] markers and normalizes non-finite Float and Double custom keys to string literals.",
  featureKeys: ["FirebaseCrashlytics.formatCauseChain"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt` (`FIFO ordering custom keys KTX DSL breadcrumbs and cause chain serialization`).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/crashlytics/FirebaseCrashlyticsTest.kt",
  ],
});
