import { row } from './section.ts';

export default row({
  order: 30,
  api: "ExceptionModel.isFatal / didCrashDuringPreviousExecution()",
  behavior: "Marks reports with ExceptionModel.isFatal == true as fatal crashes and flips didCrashDuringPreviousExecution() to true.",
  featureKeys: ["Crashlytics.didCrashDuringPreviousExecution"],
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` (`Manages disabled collection unsent queue, checkAndUpdateUnsentReports, completion handlers, and fatal crash flag`).",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
  ],
});
