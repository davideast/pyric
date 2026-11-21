import FirebaseDatabase
import Foundation

func observeSingleValueAsync(_ query: DatabaseQuery) async throws -> DataSnapshot {
  try await withCheckedThrowingContinuation {
    (continuation: CheckedContinuation<DataSnapshot, Error>) in
    query.observeSingleEvent(of: .value) { snapshot in
      continuation.resume(returning: snapshot)
    } withCancel: { error in
      continuation.resume(throwing: error)
    }
  }
}

func runTransactionAsync(
  _ ref: DatabaseReference,
  block: @escaping (MutableData) -> TransactionResult
) async throws -> (committed: Bool, snapshot: DataSnapshot?) {
  try await withCheckedThrowingContinuation {
    (continuation: CheckedContinuation<(committed: Bool, snapshot: DataSnapshot?), Error>) in
    ref.runTransactionBlock(block) { error, committed, snapshot in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: (committed, snapshot))
      }
    }
  }
}

func runWritesAutoIdServerValueAndTransactions(
  db: Database,
  runId: String
) async throws -> [String: Any] {
  let runRef = db.reference(withPath: "pyric_oracle/\(runId)")

  do {
    let profileRef = runRef.child("profile")
    try await setValueAsync(
      profileRef,
      value: ["name": "Grace", "role": "viewer", "legacy": "drop-me"]
    )
    try await updateChildValuesAsync(
      profileRef,
      values: ["role": "maintainer", "team": "core"]
    )
    try await removeValueAsync(profileRef.child("legacy"))

    let profileSnap = try await getDataAsync(profileRef)
    let profileDict = profileSnap.value as? [String: Any]
    let updatedNamePreserved = (profileDict?["name"] as? String) ?? ""
    let updatedRole = (profileDict?["role"] as? String) ?? ""
    let updatedTeamAdded = (profileDict?["team"] as? String) ?? ""
    let removedChildExists = profileSnap.childSnapshot(forPath: "legacy").exists()

    let feedRef = runRef.child("feed")
    let auto1 = feedRef.childByAutoId()
    let auto2 = feedRef.childByAutoId()
    let auto3 = feedRef.childByAutoId()
    let k1 = auto1.key ?? ""
    let k2 = auto2.key ?? ""
    let k3 = auto3.key ?? ""

    try await setValueAsync(auto1, value: ["seq": 1])
    try await setValueAsync(auto2, value: ["seq": 2])
    try await setValueAsync(auto3, value: ["seq": 3])

    let orderedAutoSnap = try await getDataAsync(feedRef.queryOrderedByKey())
    var autoIdOrderedSeqs: [Int] = []
    for case let child as DataSnapshot in orderedAutoSnap.children {
      let childDict = child.value as? [String: Any]
      if let seqNumber = childDict?["seq"] as? NSNumber {
        autoIdOrderedSeqs.append(seqNumber.intValue)
      }
    }

    let metricsRef = runRef.child("metrics")
    try await setValueAsync(
      metricsRef,
      value: ["hits": 10, "updatedAt": ServerValue.timestamp()]
    )
    try await updateChildValuesAsync(
      metricsRef,
      values: ["hits": ServerValue.increment(NSNumber(value: 7))]
    )
    try await updateChildValuesAsync(
      metricsRef,
      values: ["hits": ServerValue.increment(NSNumber(value: -2))]
    )

    let metricsSnap = try await getDataAsync(metricsRef)
    let metricsDict = metricsSnap.value as? [String: Any]
    let serverIncrementFinalHits = (metricsDict?["hits"] as? NSNumber)?.intValue ?? -1
    let tsNumber = metricsDict?["updatedAt"] as? NSNumber
    let tsInt64 = tsNumber?.int64Value ?? 0
    let serverTimestampPlausibleEpochMs =
      tsInt64 >= 1_700_000_000_000 && tsInt64 < 4_102_444_800_000

    let counterRef = runRef.child("tx_counter")
    try await setValueAsync(counterRef, value: 10)

    let commitOutcome = try await runTransactionAsync(counterRef) { currentData in
      let current = (currentData.value as? NSNumber)?.intValue ?? 0
      currentData.value = current + 15
      return TransactionResult.success(withValue: currentData)
    }
    let afterCommitSnap = try await getDataAsync(counterRef)

    let abortOutcome = try await runTransactionAsync(counterRef) { currentData in
      guard let number = currentData.value as? NSNumber else {
        return TransactionResult.success(withValue: currentData)
      }
      if number.intValue >= 25 {
        return TransactionResult.abort()
      }
      currentData.value = number.intValue + 100
      return TransactionResult.success(withValue: currentData)
    }
    let afterAbortSnap = try await getDataAsync(counterRef)

    try await removeValueAsync(runRef)
    let removedRunSnap = try await getDataAsync(runRef)

    return [
      "updatedNamePreserved": updatedNamePreserved,
      "updatedRole": updatedRole,
      "updatedTeamAdded": updatedTeamAdded,
      "removedChildExists": removedChildExists,
      "autoIdCount": Int(orderedAutoSnap.childrenCount),
      "autoIdAllLength20": k1.count == 20 && k2.count == 20 && k3.count == 20,
      "autoIdUnique": Set([k1, k2, k3]).count == 3,
      "autoIdStrictlyMonotonic": k1 < k2 && k2 < k3,
      "autoIdOrderedSeqs": autoIdOrderedSeqs,
      "serverIncrementFinalHits": serverIncrementFinalHits,
      "serverTimestampIsNumber": tsNumber != nil,
      "serverTimestampPlausibleEpochMs": serverTimestampPlausibleEpochMs,
      "txCommitCommitted": commitOutcome.committed,
      "txCommitSnapshotValue": (commitOutcome.snapshot?.value as? NSNumber)?.intValue ?? -1,
      "txPersistedAfterCommit": (afterCommitSnap.value as? NSNumber)?.intValue ?? -1,
      "txAbortCommitted": abortOutcome.committed,
      "txAbortSnapshotValue": (abortOutcome.snapshot?.value as? NSNumber)?.intValue ?? -1,
      "txPersistedAfterAbort": (afterAbortSnap.value as? NSNumber)?.intValue ?? -1,
      "cleanupRemovedRunNode": !removedRunSnap.exists(),
    ]
  } catch {
    try? await removeValueAsync(runRef)
    throw error
  }
}

func runQueriesRangesLimitsAndPermissionDenied(
  db: Database,
  runId: String
) async throws -> [String: Any] {
  let runRef = db.reference(withPath: "pyric_oracle/\(runId)")
  let workspaceRef = runRef.child("workspace")
  let deniedRef = runRef.child("denied_leaf")

  do {
    let byKeyRef = workspaceRef.child("by_key")
    try await setValueAsync(
      byKeyRef,
      value: ["k1": "one", "k2": "two", "k3": "three", "k4": "four"]
    )

    let keyRangeQuery = byKeyRef
      .queryOrderedByKey()
      .queryStarting(atValue: "k2")
      .queryEnding(atValue: "k3")
    let keyRangeSnap = try await getDataAsync(keyRangeQuery)
    var keyRangeKeys: [String] = []
    var keyRangeValues: [String] = []
    for case let child as DataSnapshot in keyRangeSnap.children {
      keyRangeKeys.append(child.key)
      if let strVal = child.value as? String {
        keyRangeValues.append(strVal)
      }
    }

    let scoresRef = workspaceRef.child("scores")
    try await setValueAsync(
      scoresRef,
      value: ["p1": 10, "p2": 20, "p3": 20, "p4": 35, "p5": 50]
    )

    let valueEqualSnap = try await getDataAsync(
      scoresRef.queryOrderedByValue().queryEqual(toValue: 20)
    )
    var valueEqualKeys: [String] = []
    var valueEqualScores: [Int] = []
    for case let child as DataSnapshot in valueEqualSnap.children {
      valueEqualKeys.append(child.key)
      if let num = child.value as? NSNumber {
        valueEqualScores.append(num.intValue)
      }
    }

    let valueRangeSnap = try await getDataAsync(
      scoresRef
        .queryOrderedByValue()
        .queryStarting(atValue: 20)
        .queryEnding(atValue: 35)
    )
    var valueRangeKeys: [String] = []
    var valueRangeScores: [Int] = []
    for case let child as DataSnapshot in valueRangeSnap.children {
      valueRangeKeys.append(child.key)
      if let num = child.value as? NSNumber {
        valueRangeScores.append(num.intValue)
      }
    }

    let valueLimitLastSnap = try await getDataAsync(
      scoresRef.queryOrderedByValue().queryLimited(toLast: 2)
    )
    var valueLimitToLastKeys: [String] = []
    var valueLimitToLastScores: [Int] = []
    for case let child as DataSnapshot in valueLimitLastSnap.children {
      valueLimitToLastKeys.append(child.key)
      if let num = child.value as? NSNumber {
        valueLimitToLastScores.append(num.intValue)
      }
    }

    var writeDeniedRejected = false
    var writeDeniedDomain = ""
    var writeDeniedCode = -1
    var writeDeniedHasPermissionText = false
    do {
      try await setValueAsync(deniedRef.child("write_attempt"), value: ["blocked": true])
    } catch {
      writeDeniedRejected = true
      let nsError = error as NSError
      writeDeniedDomain = nsError.domain
      writeDeniedCode = nsError.code
      writeDeniedHasPermissionText =
        nsError.localizedDescription.lowercased().contains("permission")
    }
    if !writeDeniedRejected {
      throw RtdbOracleError.expectedPermissionDenied("setValue")
    }

    var observeDeniedRejected = false
    var observeDeniedDomain = ""
    var observeDeniedCode = -1
    var observeDeniedHasPermissionText = false
    do {
      _ = try await observeSingleValueAsync(deniedRef.child("listen_attempt"))
    } catch {
      observeDeniedRejected = true
      let nsError = error as NSError
      observeDeniedDomain = nsError.domain
      observeDeniedCode = nsError.code
      observeDeniedHasPermissionText =
        nsError.localizedDescription.lowercased().contains("permission")
    }
    if !observeDeniedRejected {
      throw RtdbOracleError.expectedPermissionDenied("observeSingleEvent")
    }

    var getDataDeniedRejected = false
    var getDataDeniedDomain = ""
    var getDataDeniedCode = -1
    var getDataDeniedHasPermissionText = false
    do {
      _ = try await getDataAsync(deniedRef.child("getdata_attempt"))
    } catch {
      getDataDeniedRejected = true
      let nsError = error as NSError
      getDataDeniedDomain = nsError.domain
      getDataDeniedCode = nsError.code
      getDataDeniedHasPermissionText =
        nsError.localizedDescription.lowercased().contains("permission")
    }
    if !getDataDeniedRejected {
      throw RtdbOracleError.expectedPermissionDenied("getData")
    }

    try await removeValueAsync(workspaceRef)
    let cleanedWorkspaceSnap = try await getDataAsync(workspaceRef)

    return [
      "keyRangeKeys": keyRangeKeys,
      "keyRangeValues": keyRangeValues,
      "valueEqualKeys": valueEqualKeys,
      "valueEqualScores": valueEqualScores,
      "valueRangeKeys": valueRangeKeys,
      "valueRangeScores": valueRangeScores,
      "valueLimitToLastKeys": valueLimitToLastKeys,
      "valueLimitToLastScores": valueLimitToLastScores,
      "writeDeniedRejected": writeDeniedRejected,
      "writeDeniedDomain": writeDeniedDomain,
      "writeDeniedCode": writeDeniedCode,
      "writeDeniedHasPermissionText": writeDeniedHasPermissionText,
      "observeDeniedRejected": observeDeniedRejected,
      "observeDeniedDomain": observeDeniedDomain,
      "observeDeniedCode": observeDeniedCode,
      "observeDeniedHasPermissionText": observeDeniedHasPermissionText,
      "getDataDeniedRejected": getDataDeniedRejected,
      "getDataDeniedDomain": getDataDeniedDomain,
      "getDataDeniedCode": getDataDeniedCode,
      "getDataDeniedHasPermissionText": getDataDeniedHasPermissionText,
      "cleanupRemovedWorkspaceNode": !cleanedWorkspaceSnap.exists(),
    ]
  } catch {
    try? await removeValueAsync(workspaceRef)
    throw error
  }
}
