import { row } from './section.ts';

export default row({
  order: 30,
  api: "Completion-handler overloads & setCrashlyticsCollectionEnabled(nil) reset",
  behavior: "Supports Objective-C style completion callbacks on checkForUnsentReports, checkAndUpdateUnsentReports, and flush, and resets collection overrides when passed nil.",
  featureKeys: ["CrashlyticsValueNormalizer"],
  evidence: "Verified in `packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift` (`Manages disabled collection unsent queue, checkAndUpdateUnsentReports, completion handlers, and fatal crash flag`).",
  tests: [
    "packages/swift-client/Tests/PyricCrashlyticsTests/PyricCrashlyticsUnitTests.swift",
  ],
});
