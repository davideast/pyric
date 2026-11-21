import Dispatch
import FirebaseAuth
import FirebaseCore
import FirebaseFirestore
import Foundation

private func runTransactionCompletionAsync(
  _ db: Firestore,
  block: @escaping (Transaction, NSErrorPointer) -> Any?
) async throws -> Any? {
  try await withCheckedThrowingContinuation {
    (continuation: CheckedContinuation<Any?, Error>) in
    db.runTransaction(block) { result, error in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: result)
      }
    }
  }
}

private func runTransactionWithOptionsAsync(
  _ db: Firestore,
  options: TransactionOptions,
  block: @escaping (Transaction, NSErrorPointer) -> Any?
) async throws -> Any? {
  try await withCheckedThrowingContinuation {
    (continuation: CheckedContinuation<Any?, Error>) in
    db.runTransaction(with: options, block: block) { result, error in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: result)
      }
    }
  }
}

private func awaitCollectionGroupQueryReady(
  _ db: Firestore,
  cgId: String,
  timeoutMs: Int = 20_000
) async throws -> QuerySnapshot {
  let maxRetries = max(1, timeoutMs / 500)
  var lastError: Error?
  for attempt in 0..<maxRetries {
    do {
      return try await db.collectionGroup(cgId).getDocuments(source: .server)
    } catch {
      lastError = error
      let nsErr = error as NSError
      let isPermDenied =
        nsErr.domain == FirestoreErrorDomain
        && nsErr.code == FirestoreErrorCode.permissionDenied.rawValue
      if !isPermDenied || attempt + 1 == maxRetries {
        throw error
      }
      try await Task.sleep(nanoseconds: 500_000_000)
    }
  }
  throw lastError ?? FirestoreOracleError.listenerTimeout("collection-group-rules-ready")
}

private func writeOutOfBandSync(
  _ ref: DocumentReference,
  data: [String: Any]
) -> Bool {
  let sem = DispatchSemaphore(value: 0)
  var succeeded = false
  ref.setData(data) { error in
    succeeded = (error == nil)
    sem.signal()
  }
  let waitResult = sem.wait(timeout: .now() + .seconds(10))
  return waitResult == .success && succeeded
}

extension FirestoreOracleProbeRunner {
  static func runInequalityCursorsCollectionGroupAndTxRetry(
    db: Firestore,
    options: FirebaseOptions,
    customToken: String,
    runId: String
  ) async throws -> [String: Any] {
    let contenderAppName = "pyric-ios-fs-contender-\(runId)"
    FirebaseApp.configure(name: contenderAppName, options: options)
    guard let contenderApp = FirebaseApp.app(name: contenderAppName) else {
      throw FirestoreOracleError.appLookupFailed(contenderAppName)
    }
    let contenderAuth = Auth.auth(app: contenderApp)
    let contenderDb = Firestore.firestore(app: contenderApp)
    let contenderSettings = FirestoreSettings()
    contenderSettings.cacheSettings = MemoryCacheSettings()
    contenderSettings.dispatchQueue = DispatchQueue(label: "pyric.ios.oracle.contender")
    contenderDb.settings = contenderSettings

    let col = db.collection("pyric_oracle/\(runId)/wave5_queries")
    let d1 = col.document("d1")
    let d2 = col.document("d2")
    let d3 = col.document("d3")
    let d4 = col.document("d4")

    let cgId = "cg_\(runId)"
    let cgDocA = db.document("pyric_oracle/\(runId)/cg_parents/p1/\(cgId)/item_a")
    let cgDocB = db.document("pyric_oracle/\(runId)/cg_parents/p2/\(cgId)/item_b")

    let wbMergeDoc = col.document("wb_merge_doc")
    let txWriteDoc = col.document("tx_write_doc")
    let txDeleteTarget = col.document("tx_delete_target")
    let txRetryDoc = col.document("tx_retry_doc")
    let txAbortDoc = col.document("tx_abort_doc")

    let createdRefs = [
      d1,
      d2,
      d3,
      d4,
      cgDocA,
      cgDocB,
      wbMergeDoc,
      txWriteDoc,
      txDeleteTarget,
      txRetryDoc,
      txAbortDoc,
    ]

    do {
      _ = try await contenderAuth.signIn(withCustomToken: customToken)

      try await d1.setData(["score": 10, "tier": "free", "tags": ["a"]])
      try await d2.setData(["score": 20, "tier": "pro", "tags": ["b"]])
      try await d3.setData(["score": 30, "tier": "pro", "tags": ["c"]])
      try await d4.setData(["score": 40, "tier": "enterprise", "tags": ["a", "d"]])

      let notEqualIds = try await col
        .whereField("tier", isNotEqualTo: "pro")
        .getDocuments(source: .server)
        .documents.map(\.documentID)
        .sorted()

      let lessThanIds = try await col
        .whereField("score", isLessThan: 25)
        .order(by: "score")
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let lessThanOrEqualIds = try await col
        .whereField("score", isLessThanOrEqualTo: 20)
        .order(by: "score")
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let greaterThanIds = try await col
        .whereField("score", isGreaterThan: 20)
        .order(by: "score")
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let greaterThanOrEqualIds = try await col
        .whereField("score", isGreaterThanOrEqualTo: 30)
        .order(by: "score")
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let arrayContainsAnyIds = try await col
        .whereField("tags", arrayContainsAny: ["b", "d"])
        .getDocuments(source: .server)
        .documents.map(\.documentID)
        .sorted()

      let notInIds = try await col
        .whereField("tier", notIn: ["pro", "enterprise"])
        .getDocuments(source: .server)
        .documents.map(\.documentID)
        .sorted()

      let startAtEndBeforeIds = try await col
        .order(by: "score")
        .start(at: [20])
        .end(before: [40])
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let startAfterEndAtIds = try await col
        .order(by: "score")
        .start(after: [10])
        .end(at: [30])
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let d1Snap = try await d1.getDocument(source: .server)
      let d2Snap = try await d2.getDocument(source: .server)
      let d3Snap = try await d3.getDocument(source: .server)
      let d4Snap = try await d4.getDocument(source: .server)

      let startAtDocEndAtDocIds = try await col
        .order(by: "score")
        .start(atDocument: d2Snap)
        .end(atDocument: d3Snap)
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let startAfterDocEndBeforeDocIds = try await col
        .order(by: "score")
        .start(afterDocument: d1Snap)
        .end(beforeDocument: d4Snap)
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      try await cgDocA.setData(["slot": "first"])
      try await cgDocB.setData(["slot": "second"])
      let cgSnap = try await awaitCollectionGroupQueryReady(db, cgId: cgId)
      let cgDocIds = cgSnap.documents.map(\.documentID).sorted()
      let cgParentIds = cgSnap.documents.compactMap { $0.reference.parent.parent?.documentID }.sorted()

      var unscopedCgCode = -1
      do {
        _ = try await db.collectionGroup("cg_unscoped_\(runId)").getDocuments(source: .server)
      } catch {
        unscopedCgCode = extractFirestoreError(error).code
      }
      let unscopedCollectionGroupDenied =
        unscopedCgCode == FirestoreErrorCode.permissionDenied.rawValue

      try await wbMergeDoc.setData(["base": "kept", "replaceMe": "old"])
      let batch = db.batch()
      batch.setData(["mergedFlag": true], forDocument: wbMergeDoc, merge: true)
      batch.setData(
        ["replaceMe": "selected", "ignoredField": "dropped"],
        forDocument: wbMergeDoc,
        mergeFields: ["replaceMe"]
      )
      try await batch.commit()
      let wbData = try await wbMergeDoc.getDocument(source: .server).data() ?? [:]
      let batchMergePreservedBase = (wbData["base"] as? String) == "kept"
      let batchMergeAddedFlag = (wbData["mergedFlag"] as? Bool) == true
      let batchMergeFieldsUpdatedSelected = (wbData["replaceMe"] as? String) == "selected"
      let batchMergeFieldsOmittedUnlisted = wbData["ignoredField"] == nil

      try await txDeleteTarget.setData(["ephemeral": true])
      _ = try await runTransactionCompletionAsync(db) { transaction, _ in
        transaction.setData(["step": 1, "keep": "yes"], forDocument: txWriteDoc)
        transaction.setData(["merged": true], forDocument: txWriteDoc, merge: true)
        transaction.setData(
          ["selected": "ok", "skipped": "no"],
          forDocument: txWriteDoc,
          mergeFields: ["selected"]
        )
        transaction.deleteDocument(txDeleteTarget)
        return true
      }
      let txWriteData = try await txWriteDoc.getDocument(source: .server).data() ?? [:]
      let txSetAndMergeSucceeded =
        (txWriteData["keep"] as? String) == "yes"
        && (txWriteData["merged"] as? Bool) == true
        && (txWriteData["selected"] as? String) == "ok"
        && txWriteData["skipped"] == nil
      let txDeleteRemovedTarget = !(try await txDeleteTarget.getDocument(source: .server).exists)

      let defaultMaxAttempts = TransactionOptions().maxAttempts

      try await txRetryDoc.setData(["counter": 1])
      let contenderRetryRef = contenderDb.document(txRetryDoc.path)
      let retryOpts = TransactionOptions()
      retryOpts.maxAttempts = 3
      let retryLock = NSLock()
      var retryAttempts = 0
      _ = try await runTransactionWithOptionsAsync(db, options: retryOpts) {
        transaction,
        errorPointer in
        let snap: DocumentSnapshot
        do {
          snap = try transaction.getDocument(txRetryDoc)
        } catch let nsError as NSError {
          errorPointer?.pointee = nsError
          return nil
        }
        retryLock.lock()
        retryAttempts += 1
        let currentAttempt = retryAttempts
        retryLock.unlock()

        if currentAttempt == 1 {
          _ = writeOutOfBandSync(contenderRetryRef, data: ["counter": 2])
        }
        let currentVal = (snap.data()?["counter"] as? NSNumber)?.intValue ?? 0
        transaction.updateData(["counter": currentVal + 10], forDocument: txRetryDoc)
        return currentVal + 10
      }
      let retryFinalCounter =
        (try await txRetryDoc.getDocument(source: .server).data()?["counter"] as? NSNumber)?
        .intValue ?? -1

      try await txAbortDoc.setData(["counter": 1])
      let contenderAbortRef = contenderDb.document(txAbortDoc.path)
      let singleAttemptOpts = TransactionOptions()
      singleAttemptOpts.maxAttempts = 1
      let abortLock = NSLock()
      var singleAttemptRuns = 0
      var maxAttemptsExhaustedRejected = false
      var maxAttemptsExhaustedDomain = ""
      var maxAttemptsExhaustedCode = -1
      do {
        _ = try await runTransactionWithOptionsAsync(db, options: singleAttemptOpts) {
          transaction,
          errorPointer in
          do {
            _ = try transaction.getDocument(txAbortDoc)
          } catch let nsError as NSError {
            errorPointer?.pointee = nsError
            return nil
          }
          abortLock.lock()
          singleAttemptRuns += 1
          let runNumber = singleAttemptRuns
          abortLock.unlock()

          if runNumber == 1 {
            _ = writeOutOfBandSync(contenderAbortRef, data: ["counter": 50])
          }
          transaction.updateData(["counter": 999], forDocument: txAbortDoc)
          return nil
        }
      } catch {
        maxAttemptsExhaustedRejected = true
        let captured = extractFirestoreError(error)
        maxAttemptsExhaustedDomain = captured.domain
        maxAttemptsExhaustedCode = captured.code
      }
      if !maxAttemptsExhaustedRejected {
        throw FirestoreOracleError.expectedFirestoreRejection("max-attempts-1-contention")
      }
      let abortDocPersistedContenderValue =
        (try await txAbortDoc.getDocument(source: .server).data()?["counter"] as? NSNumber)?
        .intValue ?? -1

      await deleteDocsBestEffort(createdRefs)
      try? await contenderDb.terminate()
      try? contenderAuth.signOut()
      await deleteAppAsync(contenderApp)

      return [
        "notEqualIds": notEqualIds,
        "lessThanIds": lessThanIds,
        "lessThanOrEqualIds": lessThanOrEqualIds,
        "greaterThanIds": greaterThanIds,
        "greaterThanOrEqualIds": greaterThanOrEqualIds,
        "arrayContainsAnyIds": arrayContainsAnyIds,
        "notInIds": notInIds,
        "startAtEndBeforeIds": startAtEndBeforeIds,
        "startAfterEndAtIds": startAfterEndAtIds,
        "startAtDocEndAtDocIds": startAtDocEndAtDocIds,
        "startAfterDocEndBeforeDocIds": startAfterDocEndBeforeDocIds,
        "collectionGroupDocIds": cgDocIds,
        "collectionGroupParentIds": cgParentIds,
        "unscopedCollectionGroupDenied": unscopedCollectionGroupDenied,
        "batchMergePreservedBase": batchMergePreservedBase,
        "batchMergeAddedFlag": batchMergeAddedFlag,
        "batchMergeFieldsUpdatedSelected": batchMergeFieldsUpdatedSelected,
        "batchMergeFieldsOmittedUnlisted": batchMergeFieldsOmittedUnlisted,
        "txSetAndMergeSucceeded": txSetAndMergeSucceeded,
        "txDeleteRemovedTarget": txDeleteRemovedTarget,
        "defaultMaxAttempts": defaultMaxAttempts,
        "retryAttemptsOnSingleConflict": retryAttempts,
        "retryFinalCounter": retryFinalCounter,
        "singleAttemptRunsBeforeFailure": singleAttemptRuns,
        "maxAttemptsExhaustedRejected": maxAttemptsExhaustedRejected,
        "maxAttemptsExhaustedDomain": maxAttemptsExhaustedDomain,
        "maxAttemptsExhaustedCode": maxAttemptsExhaustedCode,
        "abortDocPersistedContenderValue": abortDocPersistedContenderValue,
      ]
    } catch {
      await deleteDocsBestEffort(createdRefs)
      try? await contenderDb.terminate()
      try? contenderAuth.signOut()
      await deleteAppAsync(contenderApp)
      throw error
    }
  }
}
