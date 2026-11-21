import Dispatch
import FirebaseCore
import FirebaseDatabase
import Foundation

func onDisconnectSetValueAsync(_ ref: DatabaseReference, value: Any?) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.onDisconnectSetValue(value) { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

func onDisconnectUpdateChildValuesAsync(
  _ ref: DatabaseReference,
  values: [AnyHashable: Any]
) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.onDisconnectUpdateChildValues(values) { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

func onDisconnectRemoveValueAsync(_ ref: DatabaseReference) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.onDisconnectRemoveValue { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

func cancelDisconnectOperationsAsync(_ ref: DatabaseReference) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.cancelDisconnectOperations { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

private final class RtdbListenerRecorder {
  private let lock = NSLock()
  private var connectedTransitions: [Bool] = []
  private var observedOffsetNumber = false
  private var valueCounts: [Int] = []
  private var childTimeline: [String] = []

  func recordConnected(_ state: Bool) {
    lock.lock()
    defer { lock.unlock() }
    if connectedTransitions.last != state {
      connectedTransitions.append(state)
    }
  }

  func recordOffset(_ raw: Any?) {
    lock.lock()
    defer { lock.unlock() }
    if raw is NSNumber {
      observedOffsetNumber = true
    }
  }

  func recordValueCount(_ count: Int) {
    lock.lock()
    defer { lock.unlock() }
    valueCounts.append(count)
  }

  func recordChildEvent(_ entry: String) {
    lock.lock()
    defer { lock.unlock() }
    childTimeline.append(entry)
  }

  func snapshot() -> (
    connected: [Bool],
    sawOffset: Bool,
    counts: [Int],
    timeline: [String]
  ) {
    lock.lock()
    defer { lock.unlock() }
    return (connectedTransitions, observedOffsetNumber, valueCounts, childTimeline)
  }
}

private func awaitRtdbCondition(
  _ label: String,
  timeoutMs: Int = 15_000,
  predicate: () -> Bool
) async throws {
  let attempts = max(1, timeoutMs / 25)
  for _ in 0..<attempts {
    if predicate() {
      return
    }
    try await Task.sleep(nanoseconds: 25_000_000)
  }
  if !predicate() {
    throw RtdbOracleError.listenerTimeout(label)
  }
}

private func verifyTwoAppOnDisconnect(
  config: RtdbOracleConfig,
  observerRunRef: DatabaseReference
) async throws -> [String: Any] {
  let presenceRef = observerRunRef.child("presence")
  let statusRef = presenceRef.child("status")
  let metaRef = presenceRef.child("meta")
  let ephemeralRef = presenceRef.child("ephemeral_session")
  let canceledRef = presenceRef.child("kept_after_cancel")

  try await setValueAsync(statusRef, value: "online")
  try await setValueAsync(metaRef, value: ["state": "active", "keep": 1])
  try await setValueAsync(ephemeralRef, value: "active-ephemeral")
  try await setValueAsync(canceledRef, value: "kept-alive")

  let writerAppName = "pyric-ios-rtdb-writer-\(config.runId)"
  let writerOptions = makeRtdbFirebaseOptions(config: config)

  FirebaseApp.configure(name: writerAppName, options: writerOptions)
  guard let writerApp = FirebaseApp.app(name: writerAppName) else {
    throw RtdbOracleError.appLookupFailed(writerAppName)
  }
  let writerDb = Database.database(app: writerApp, url: config.databaseUrl)
  writerDb.callbackQueue = DispatchQueue(
    label: "dev.pyric.ios.oracle.rtdb.writer.\(config.runId)"
  )
  writerDb.goOnline()

  do {
    let writerPresence = writerDb.reference(withPath: "pyric_oracle/\(config.runId)/presence")
    try await setValueAsync(writerPresence.child("writer_ready"), value: true)

    try await onDisconnectSetValueAsync(
      writerPresence.child("status"),
      value: "offline-by-ondisconnect"
    )
    try await onDisconnectUpdateChildValuesAsync(
      writerPresence.child("meta"),
      values: ["state": "ended"]
    )
    try await onDisconnectRemoveValueAsync(writerPresence.child("ephemeral_session"))
    try await onDisconnectSetValueAsync(
      writerPresence.child("kept_after_cancel"),
      value: "must-not-run"
    )
    try await cancelDisconnectOperationsAsync(writerPresence.child("kept_after_cancel"))

    writerDb.goOffline()
    await deleteAppAsync(writerApp)
  } catch {
    writerDb.goOffline()
    await deleteAppAsync(writerApp)
    throw error
  }

  var observedStatus = (try await getDataAsync(statusRef)).value as? String ?? ""
  let maxPolls = 150
  var pollIndex = 0
  while observedStatus != "offline-by-ondisconnect" && pollIndex < maxPolls {
    try await Task.sleep(nanoseconds: 100_000_000)
    observedStatus = (try await getDataAsync(statusRef)).value as? String ?? ""
    pollIndex += 1
  }

  let metaAfterSnap = try await getDataAsync(metaRef)
  let metaAfterDict = metaAfterSnap.value as? [String: Any]
  let metaStateAfter = (metaAfterDict?["state"] as? String) ?? ""
  let metaKeepPreserved = (metaAfterDict?["keep"] as? NSNumber)?.intValue ?? -1
  let ephemeralAfterSnap = try await getDataAsync(ephemeralRef)
  let canceledAfterSnap = try await getDataAsync(canceledRef)
  let canceledValueAfter = (canceledAfterSnap.value as? String) ?? ""

  return [
    "statusAfterDisconnect": observedStatus,
    "metaStateAfterDisconnect": metaStateAfter,
    "metaKeepPreservedAfterDisconnect": metaKeepPreserved,
    "ephemeralExistsAfterDisconnect": ephemeralAfterSnap.exists(),
    "canceledPathValueAfterDisconnect": canceledValueAfter,
  ]
}

func runListenersTransactionsConnectionAndOnDisconnect(
  db: Database,
  config: RtdbOracleConfig
) async throws -> [String: Any] {
  let runRef = db.reference(withPath: "pyric_oracle/\(config.runId)")
  let connectedRef = db.reference(withPath: ".info/connected")
  let offsetRef = db.reference(withPath: ".info/serverTimeOffset")
  let unknownInfoRef = db.reference(withPath: ".info/nonexistent_key")

  let recorder = RtdbListenerRecorder()
  db.goOnline()

  let connectedHandle = connectedRef.observe(.value) { snapshot in
    if let state = (snapshot.value as? NSNumber)?.boolValue {
      recorder.recordConnected(state)
    }
  }
  let offsetHandle = offsetRef.observe(.value) { snapshot in
    recorder.recordOffset(snapshot.value)
  }

  var valueHandle: DatabaseHandle?
  var addedHandle: DatabaseHandle?
  var changedHandle: DatabaseHandle?
  var movedHandle: DatabaseHandle?
  var removedHandle: DatabaseHandle?
  let watchRef = runRef.child("watched_scores")
  let orderedWatch = watchRef.queryOrderedByValue()

  do {
    try await setValueAsync(runRef.child("handshake_ping"), value: "ready")
    try await awaitRtdbCondition("info-connected-initial-true") {
      let snap = recorder.snapshot()
      return snap.connected.contains(true) && snap.sawOffset
    }

    let unknownInfoSnap = try await observeSingleValueAsync(unknownInfoRef)
    let unknownInfoExists = unknownInfoSnap.exists()
    let unknownInfoValueIsNSNull = unknownInfoSnap.value is NSNull

    db.goOffline()
    try await awaitRtdbCondition("info-connected-offline-false") {
      recorder.snapshot().connected.last == false
    }

    db.goOnline()
    try await awaitRtdbCondition("info-connected-reconnected-true") {
      let connected = recorder.snapshot().connected
      return connected.count >= 3 && connected.last == true
    }

    connectedRef.removeObserver(withHandle: connectedHandle)
    offsetRef.removeObserver(withHandle: offsetHandle)

    try await setValueAsync(watchRef, value: ["a": 1, "b": 2])

    valueHandle = watchRef.observe(.value) { snapshot in
      recorder.recordValueCount(Int(snapshot.childrenCount))
    }
    addedHandle = orderedWatch.observe(.childAdded) { snapshot, prevKey in
      recorder.recordChildEvent("added:\(snapshot.key):prev=\(prevKey ?? "nil")")
    }
    changedHandle = orderedWatch.observe(.childChanged) { snapshot, _ in
      let intVal = (snapshot.value as? NSNumber)?.intValue ?? -1
      recorder.recordChildEvent("changed:\(snapshot.key):\(intVal)")
    }
    movedHandle = orderedWatch.observe(.childMoved) { snapshot, prevKey in
      recorder.recordChildEvent("moved:\(snapshot.key):prev=\(prevKey ?? "nil")")
    }
    removedHandle = orderedWatch.observe(.childRemoved) { snapshot in
      let intVal = (snapshot.value as? NSNumber)?.intValue ?? -1
      recorder.recordChildEvent("removed:\(snapshot.key):\(intVal)")
    }

    try await awaitRtdbCondition("initial-watch-events") {
      let snap = recorder.snapshot()
      return !snap.counts.isEmpty && snap.timeline.count >= 2
    }

    try await setValueAsync(watchRef.child("c"), value: 3)
    try await awaitRtdbCondition("child-added-c") {
      recorder.snapshot().timeline.contains("added:c:prev=b")
    }

    try await setValueAsync(watchRef.child("a"), value: 10)
    try await awaitRtdbCondition("child-changed-and-moved-a") {
      let timeline = recorder.snapshot().timeline
      return timeline.contains("changed:a:10") && timeline.contains("moved:a:prev=c")
    }

    try await removeValueAsync(watchRef.child("b"))
    try await awaitRtdbCondition("child-removed-b") {
      recorder.snapshot().timeline.contains("removed:b:2")
    }

    if let h = valueHandle {
      watchRef.removeObserver(withHandle: h)
      valueHandle = nil
    }
    if let h = addedHandle {
      orderedWatch.removeObserver(withHandle: h)
      addedHandle = nil
    }
    if let h = changedHandle {
      orderedWatch.removeObserver(withHandle: h)
      changedHandle = nil
    }
    if let h = movedHandle {
      orderedWatch.removeObserver(withHandle: h)
      movedHandle = nil
    }
    if let h = removedHandle {
      orderedWatch.removeObserver(withHandle: h)
      removedHandle = nil
    }

    let snapshotAtUnsub = recorder.snapshot()
    try await setValueAsync(watchRef.child("d"), value: 4)
    let fenceSingleSnap = try await observeSingleValueAsync(watchRef)
    let snapshotAfterFence = recorder.snapshot()
    let silentAfterRemoveObserver =
      snapshotAfterFence.counts.count == snapshotAtUnsub.counts.count
      && snapshotAfterFence.timeline.count == snapshotAtUnsub.timeline.count

    let txRef = runRef.child("tx_counter")
    try await setValueAsync(txRef, value: 10)

    let commitOutcome = try await runTransactionAsync(txRef) { currentData in
      let current = (currentData.value as? NSNumber)?.intValue ?? 0
      currentData.value = current + 7
      return TransactionResult.success(withValue: currentData)
    }

    let abortOutcome = try await runTransactionAsync(txRef) { currentData in
      currentData.value = 999
      return TransactionResult.abort()
    }
    let txServerAfterAbortSnap = try await getDataAsync(txRef)

    let onDisconnectResult = try await verifyTwoAppOnDisconnect(
      config: config,
      observerRunRef: runRef
    )

    try await removeValueAsync(runRef)
    let removedRunSnap = try await getDataAsync(runRef)

    let connectedHistory = snapshotAfterFence.connected
    let firstTrueIdx = connectedHistory.firstIndex(of: true) ?? -1
    let sawTrueFalseTrue =
      firstTrueIdx >= 0
      && connectedHistory.dropFirst(firstTrueIdx + 1).contains(false)
      && connectedHistory.last == true

    return [
      "infoConnectedToggleTrueFalseTrue": sawTrueFalseTrue,
      "infoServerTimeOffsetIsNSNumber": snapshotAfterFence.sawOffset,
      "infoUnknownKeyExists": unknownInfoExists,
      "infoUnknownKeyValueIsNSNull": unknownInfoValueIsNSNull,
      "valueListenerInitialCount": snapshotAfterFence.counts.first ?? -1,
      "valueListenerObservedMutations": snapshotAfterFence.counts.count >= 4,
      "childTimeline": snapshotAfterFence.timeline,
      "silentAfterRemoveObserver": silentAfterRemoveObserver,
      "observeSingleCountAfterUnsub": Int(fenceSingleSnap.childrenCount),
      "txCommitCommitted": commitOutcome.committed,
      "txCommitFinalValue": (commitOutcome.snapshot?.value as? NSNumber)?.intValue ?? -1,
      "txAbortCommitted": abortOutcome.committed,
      "txServerValueAfterAbort": (txServerAfterAbortSnap.value as? NSNumber)?.intValue ?? -1,
      "onDisconnect": onDisconnectResult,
      "cleanupRemovedRunNode": !removedRunSnap.exists(),
    ]
  } catch {
    connectedRef.removeObserver(withHandle: connectedHandle)
    offsetRef.removeObserver(withHandle: offsetHandle)
    if let h = valueHandle {
      watchRef.removeObserver(withHandle: h)
    }
    if let h = addedHandle {
      orderedWatch.removeObserver(withHandle: h)
    }
    if let h = changedHandle {
      orderedWatch.removeObserver(withHandle: h)
    }
    if let h = movedHandle {
      orderedWatch.removeObserver(withHandle: h)
    }
    if let h = removedHandle {
      orderedWatch.removeObserver(withHandle: h)
    }
    try? await removeValueAsync(runRef)
    throw error
  }
}
