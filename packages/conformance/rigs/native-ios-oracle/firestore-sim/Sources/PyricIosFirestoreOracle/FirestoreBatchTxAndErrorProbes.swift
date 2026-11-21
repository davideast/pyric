import FirebaseFirestore
import Foundation

extension FirestoreOracleProbeRunner {
  static func runBatchesTransactionsOfflineAndErrors(
    db: Firestore,
    runId: String
  ) async throws -> (behavior: [String: Any], didTerminate: Bool) {
    let col = db.collection("pyric_oracle/\(runId)/tx_items")
    let b1 = col.document("b1")
    let b2 = col.document("b2")
    let bStale = col.document("b_stale")
    let offlineDoc = col.document("offline_doc")
    let createdRefs = [b1, b2, bStale, offlineDoc]
    var didTerminate = false

    do {
      try await bStale.setData(["obsolete": true])

      let batch = db.batch()
      batch.setData(["points": 10, "label": "one"], forDocument: b1)
      batch.setData(["points": 5, "label": "two"], forDocument: b2)
      batch.updateData(["points": FieldValue.increment(Int64(7))], forDocument: b1)
      batch.deleteDocument(bStale)
      try await batch.commit()

      let b1AfterBatch = (try await b1.getDocument(source: .server).data()?["points"] as? NSNumber)?.intValue ?? -1
      let b2AfterBatch = (try await b2.getDocument(source: .server).data()?["points"] as? NSNumber)?.intValue ?? -1
      let bStaleExistsAfterBatch = try await bStale.getDocument(source: .server).exists

      // Atomic read-modify-write transaction commit.
      let txResult = try await db.runTransaction { transaction, errorPointer in
        let snap1: DocumentSnapshot
        let snap2: DocumentSnapshot
        do {
          snap1 = try transaction.getDocument(b1)
          snap2 = try transaction.getDocument(b2)
        } catch let nsError as NSError {
          errorPointer?.pointee = nsError
          return nil
        }
        let p1 = (snap1.data()?["points"] as? NSNumber)?.intValue ?? 0
        let p2 = (snap2.data()?["points"] as? NSNumber)?.intValue ?? 0
        transaction.updateData(["points": p1 + p2], forDocument: b1)
        transaction.updateData(["points": 0], forDocument: b2)
        return "committed-\(p1 + p2)"
      }
      let txReturnString = txResult as? String ?? ""
      let b1AfterTxCommit = (try await b1.getDocument(source: .server).data()?["points"] as? NSNumber)?.intValue ?? -1
      let b2AfterTxCommit = (try await b2.getDocument(source: .server).data()?["points"] as? NSNumber)?.intValue ?? -1

      // Explicit transaction abort via NSErrorPointer leaves server state untouched.
      var abortedDomain = ""
      var abortedCode = -1
      do {
        _ = try await db.runTransaction { transaction, errorPointer in
          do {
            _ = try transaction.getDocument(b1)
          } catch let nsError as NSError {
            errorPointer?.pointee = nsError
            return nil
          }
          transaction.updateData(["points": 999], forDocument: b1)
          errorPointer?.pointee = NSError(
            domain: "PyricIosOracleTxAbort",
            code: 77,
            userInfo: [NSLocalizedDescriptionKey: "Intentional rollback"]
          )
          return nil
        }
      } catch {
        let nsError = error as NSError
        abortedDomain = nsError.domain
        abortedCode = nsError.code
      }
      if abortedCode != 77 {
        throw FirestoreOracleError.expectedFirestoreRejection("transaction-abort")
      }
      let b1AfterTxAbort = (try await b1.getDocument(source: .server).data()?["points"] as? NSNumber)?.intValue ?? -1

      // updateData on a non-existent document throws FirestoreErrorCode.notFound (5).
      var missingUpdateDomain = ""
      var missingUpdateCode = -1
      do {
        try await col.document("missing_target").updateData(["points": 1])
      } catch {
        let captured = extractFirestoreError(error)
        missingUpdateDomain = captured.domain
        missingUpdateCode = captured.code
      }
      if missingUpdateCode != FirestoreErrorCode.notFound.rawValue {
        throw FirestoreOracleError.expectedFirestoreRejection("update-missing-not-found")
      }

      // Offline cache projection, Source.server unavailable, enableNetwork, and waitForPendingWrites.
      try await db.disableNetwork()
      offlineDoc.setData(["status": "queued-offline"]) { _ in }
      let cacheWhileOffline = try await offlineDoc.getDocument(source: .cache)
      let offlineCacheExists = cacheWhileOffline.exists
      let offlineHasPendingWrites = cacheWhileOffline.metadata.hasPendingWrites
      let offlineStatus = cacheWhileOffline.data()?["status"] as? String ?? ""

      var offlineServerReadCode = -1
      do {
        _ = try await col.document("uncached_while_offline").getDocument(source: .server)
      } catch {
        offlineServerReadCode = extractFirestoreError(error).code
      }

      try await db.enableNetwork()
      try await db.waitForPendingWrites()
      let flushedServerSnap = try await offlineDoc.getDocument(source: .server)
      let flushedHasPendingWrites = flushedServerSnap.metadata.hasPendingWrites
      let flushedFromCache = flushedServerSnap.metadata.isFromCache

      // Read-only getDocument outside pyric_oracle/<runId> rejects with permissionDenied (7).
      var deniedDomain = ""
      var deniedCode = -1
      do {
        _ = try await db
          .document("pyric_oracle_denied_\(runId)/forbidden")
          .getDocument(source: .server)
      } catch {
        let captured = extractFirestoreError(error)
        deniedDomain = captured.domain
        deniedCode = captured.code
      }
      if deniedCode != FirestoreErrorCode.permissionDenied.rawValue {
        throw FirestoreOracleError.expectedFirestoreRejection("rules-permission-denied")
      }

      await deleteDocsBestEffort(createdRefs)

      // Lifecycle: terminate() followed by clearPersistence() succeeds cleanly.
      try await db.terminate()
      didTerminate = true
      try await db.clearPersistence()

      let behavior: [String: Any] = [
        "b1AfterBatch": b1AfterBatch,
        "b2AfterBatch": b2AfterBatch,
        "bStaleExistsAfterBatch": bStaleExistsAfterBatch,
        "txReturnString": txReturnString,
        "b1AfterTxCommit": b1AfterTxCommit,
        "b2AfterTxCommit": b2AfterTxCommit,
        "txAbortDomain": abortedDomain,
        "txAbortCode": abortedCode,
        "b1AfterTxAbort": b1AfterTxAbort,
        "missingUpdateDomain": missingUpdateDomain,
        "missingUpdateMatchesNotFound":
          missingUpdateDomain == FirestoreErrorDomain
          && missingUpdateCode == FirestoreErrorCode.notFound.rawValue,
        "missingUpdateCode": missingUpdateCode,
        "offlineCacheExists": offlineCacheExists,
        "offlineHasPendingWrites": offlineHasPendingWrites,
        "offlineStatus": offlineStatus,
        "offlineServerReadMatchesUnavailable":
          offlineServerReadCode == FirestoreErrorCode.unavailable.rawValue,
        "offlineServerReadCode": offlineServerReadCode,
        "flushedHasPendingWrites": flushedHasPendingWrites,
        "flushedFromCache": flushedFromCache,
        "deniedDomain": deniedDomain,
        "deniedMatchesPermissionDenied":
          deniedDomain == FirestoreErrorDomain
          && deniedCode == FirestoreErrorCode.permissionDenied.rawValue,
        "deniedCode": deniedCode,
        "terminatedAndClearedPersistence": true,
      ]
      return (behavior, didTerminate)
    } catch {
      try? await db.enableNetwork()
      if !didTerminate {
        await deleteDocsBestEffort(createdRefs)
      }
      throw error
    }
  }
}
