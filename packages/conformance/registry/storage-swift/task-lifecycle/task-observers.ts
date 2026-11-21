import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "observe(_:handler:) / removeObserver(withHandle:) / removeAllObservers",
  behavior: "Dispatches .resume, .progress, .pause, .success, and .failure StorageTaskSnapshot events (including single-shot terminal replay) and isolates removed observer handles.",
  featureKeys: ["observe", "removeObserver", "removeAllObservers"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricStorageTests/StorageObservableTaskTests.swift` (observerRemovalMethodsIsolateCallbacks, lateTerminalSuccessAndFailureObserversReplayOnce) and `packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricStorageTests/StorageObservableTaskTests.swift",
    "packages/swift-client/Tests/PyricStorageTests/StorageTasksLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
