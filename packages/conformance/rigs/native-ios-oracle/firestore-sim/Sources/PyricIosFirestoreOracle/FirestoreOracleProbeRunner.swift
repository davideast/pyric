import Darwin
import FirebaseAuth
import FirebaseCore
import FirebaseFirestore
import Foundation

public struct FirestoreOracleInputConfig: Decodable {
  public let mode: String?
  public let probeId: String?
  public let runId: String?
  public let projectId: String?
  public let googleAppId: String?
  public let gcmSenderId: String?
  public let apiKey: String?
  public let customToken: String?
  public let expectedCustomUid: String?
}

public enum FirestoreOracleError: LocalizedError {
  case missingField(String)
  case unknownProbe(String)
  case appLookupFailed(String)
  case customUidMismatch(expected: String, actual: String)
  case expectedFirestoreRejection(String)
  case listenerTimeout(String)
  case invalidJsonObject

  public var errorDescription: String? {
    switch self {
    case .missingField(let name):
      return "Missing required Firestore oracle input field '\(name)'"
    case .unknownProbe(let probeId):
      return "Unknown iOS Firestore oracle probe '\(probeId)'"
    case .appLookupFailed(let appName):
      return "Failed to resolve configured FirebaseApp '\(appName)'"
    case .customUidMismatch(let expected, let actual):
      return "Signed-in custom UID '\(actual)' did not match expected '\(expected)'"
    case .expectedFirestoreRejection(let step):
      return "Expected FirebaseFirestore rejection during step '\(step)'"
    case .listenerTimeout(let step):
      return "Timed out waiting for FirebaseFirestore listener condition '\(step)'"
    case .invalidJsonObject:
      return "Firestore oracle behavior payload is not a valid JSON object"
    }
  }
}

struct CapturedIosFirestoreError {
  let domain: String
  let code: Int
}

public enum FirestoreOracleProbeRunner {
  static func emitCleanupUid(_ uid: String, into cleanupUids: inout [String]) {
    if !uid.isEmpty {
      if !cleanupUids.contains(uid) {
        cleanupUids.append(uid)
      }
      print("PYRIC_IOS_ORACLE_CLEANUP_UID:\(uid)")
      fflush(stdout)
    }
  }

  static func extractFirestoreError(_ error: Error) -> CapturedIosFirestoreError {
    let nsError = error as NSError
    return CapturedIosFirestoreError(domain: nsError.domain, code: nsError.code)
  }

  static func deleteDocsBestEffort(_ refs: [DocumentReference]) async {
    for ref in refs {
      try? await ref.delete()
    }
  }

  private static func requireNonEmpty(_ value: String?, field: String) throws -> String {
    guard let unwrapped = value, !unwrapped.isEmpty else {
      throw FirestoreOracleError.missingField(field)
    }
    return unwrapped
  }

  static func deleteAppAsync(_ app: FirebaseApp) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      app.delete { _ in
        continuation.resume(returning: ())
      }
    }
  }

  public static func run(inputData: Data) async throws -> Data {
    let input = try JSONDecoder().decode(FirestoreOracleInputConfig.self, from: inputData)
    if input.mode == "template" {
      let noopPayload: [String: Any] = ["mode": "template", "ok": true]
      return try JSONSerialization.data(withJSONObject: noopPayload, options: [.sortedKeys])
    }

    let probeId = try requireNonEmpty(input.probeId, field: "probeId")
    let runId = try requireNonEmpty(input.runId, field: "runId")
    let projectId = try requireNonEmpty(input.projectId, field: "projectId")
    let googleAppId = try requireNonEmpty(input.googleAppId, field: "googleAppId")
    let gcmSenderId = try requireNonEmpty(input.gcmSenderId, field: "gcmSenderId")
    let apiKey = try requireNonEmpty(input.apiKey, field: "apiKey")
    let customToken = try requireNonEmpty(input.customToken, field: "customToken")
    let expectedUid = try requireNonEmpty(input.expectedCustomUid, field: "expectedCustomUid")

    let appName = "pyric-ios-firestore-\(runId)"
    let options = FirebaseOptions(googleAppID: googleAppId, gcmSenderID: gcmSenderId)
    options.apiKey = apiKey
    options.projectID = projectId

    FirebaseApp.configure(name: appName, options: options)
    guard let app = FirebaseApp.app(name: appName) else {
      throw FirestoreOracleError.appLookupFailed(appName)
    }

    let auth = Auth.auth(app: app)
    let db = Firestore.firestore(app: app)
    var cleanupUids: [String] = []
    var alreadyTerminated = false

    do {
      if auth.currentUser != nil {
        try? auth.signOut()
      }
      let authResult = try await auth.signIn(withCustomToken: customToken)
      let signedInUid = authResult.user.uid
      emitCleanupUid(signedInUid, into: &cleanupUids)
      guard signedInUid == expectedUid else {
        throw FirestoreOracleError.customUidMismatch(expected: expectedUid, actual: signedInUid)
      }

      var behavior: [String: Any]
      switch probeId {
      case "firestore-swift-crud-merge-sentinels-and-codecs":
        behavior = try await runCrudMergeSentinelsAndCodecs(db: db, runId: runId)
      case "firestore-swift-queries-cursors-filters-and-aggregations":
        behavior = try await runQueriesCursorsFiltersAndAggregations(db: db, runId: runId)
      case "firestore-swift-batches-transactions-offline-and-errors":
        let outcome = try await runBatchesTransactionsOfflineAndErrors(db: db, runId: runId)
        behavior = outcome.behavior
        alreadyTerminated = outcome.didTerminate
      case "firestore-swift-instance-snapshots-inSync-and-codable":
        behavior = try await runInstanceSnapshotsInSyncAndCodable(
          db: db,
          app: app,
          options: options,
          runId: runId
        )
      case "firestore-swift-inequality-cursors-collectionGroup-and-txRetry":
        behavior = try await runInequalityCursorsCollectionGroupAndTxRetry(
          db: db,
          options: options,
          customToken: customToken,
          runId: runId
        )
      default:
        throw FirestoreOracleError.unknownProbe(probeId)
      }

      behavior["_cleanupUids"] = cleanupUids
      if !alreadyTerminated {
        try? await db.terminate()
      }
      try? auth.signOut()
      await deleteAppAsync(app)

      guard JSONSerialization.isValidJSONObject(behavior) else {
        throw FirestoreOracleError.invalidJsonObject
      }
      return try JSONSerialization.data(
        withJSONObject: behavior,
        options: [.sortedKeys, .prettyPrinted]
      )
    } catch {
      if !alreadyTerminated {
        try? await db.terminate()
      }
      try? auth.signOut()
      await deleteAppAsync(app)
      throw error
    }
  }
}
