import Darwin
import Dispatch
import FirebaseCore
import FirebaseDatabase
import Foundation

struct RtdbOracleConfig: Decodable {
  let probeId: String
  let runId: String
  let projectId: String
  let googleAppId: String
  let gcmSenderId: String
  let apiKey: String
  let databaseUrl: String
}

enum RtdbOracleError: LocalizedError {
  case missingArg(String)
  case unknownProbe(String)
  case appLookupFailed(String)
  case expectedPermissionDenied(String)
  case listenerTimeout(String)
  case invalidJsonPayload

  var errorDescription: String? {
    switch self {
    case .missingArg(let flag):
      return "Missing required CLI argument \(flag)"
    case .unknownProbe(let probeId):
      return "Unknown iOS RTDB oracle probe '\(probeId)'"
    case .appLookupFailed(let appName):
      return "Failed to resolve configured FirebaseApp '\(appName)'"
    case .expectedPermissionDenied(let operation):
      return "Expected RTDB permission-denied rejection for '\(operation)'"
    case .listenerTimeout(let step):
      return "Timed out waiting for RTDB condition '\(step)'"
    case .invalidJsonPayload:
      return "Probe behavior payload is not valid JSON object data"
    }
  }
}

func parseCliArgs(_ args: [String]) throws -> (inputPath: String, outputPath: String) {
  var inputPath: String?
  var outputPath: String?
  var index = 1
  while index < args.count {
    let arg = args[index]
    if arg == "--input", index + 1 < args.count {
      inputPath = args[index + 1]
      index += 2
      continue
    }
    if arg == "--output", index + 1 < args.count {
      outputPath = args[index + 1]
      index += 2
      continue
    }
    index += 1
  }
  guard let resolvedInput = inputPath, !resolvedInput.isEmpty else {
    throw RtdbOracleError.missingArg("--input")
  }
  guard let resolvedOutput = outputPath, !resolvedOutput.isEmpty else {
    throw RtdbOracleError.missingArg("--output")
  }
  return (resolvedInput, resolvedOutput)
}

func setValueAsync(_ ref: DatabaseReference, value: Any?) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.setValue(value) { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

func updateChildValuesAsync(_ ref: DatabaseReference, values: [AnyHashable: Any]) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.updateChildValues(values) { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

func removeValueAsync(_ ref: DatabaseReference) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.removeValue { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

func getDataAsync(_ query: DatabaseQuery) async throws -> DataSnapshot {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<DataSnapshot, Error>) in
    query.getData { error, snapshot in
      if let error = error {
        continuation.resume(throwing: error)
      } else if let snapshot = snapshot {
        continuation.resume(returning: snapshot)
      } else {
        continuation.resume(
          throwing: NSError(
            domain: "PyricIosRtdbOracle",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "getData returned nil snapshot without error"]
          )
        )
      }
    }
  }
}

func deleteAppAsync(_ app: FirebaseApp) async {
  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    app.delete { _ in
      continuation.resume(returning: ())
    }
  }
}

func runDedicatedCrudAndQueryOrder(
  db: Database,
  runId: String
) async throws -> [String: Any] {
  let runRef = db.reference(withPath: "pyric_oracle/\(runId)")
  let itemsRef = runRef.child("items")

  do {
    try await setValueAsync(
      itemsRef.child("alpha"),
      value: ["label": "Alpha", "score": 20]
    )
    try await setValueAsync(
      itemsRef.child("beta"),
      value: ["label": "Beta", "score": 5]
    )
    try await setValueAsync(
      itemsRef.child("gamma"),
      value: ["label": "Gamma", "score": 12]
    )

    try await updateChildValuesAsync(
      itemsRef.child("beta"),
      values: ["score": ServerValue.increment(NSNumber(value: 5))]
    )

    let betaSnap = try await getDataAsync(itemsRef.child("beta"))
    let betaDict = betaSnap.value as? [String: Any]
    let betaScore = (betaDict?["score"] as? NSNumber)?.intValue ?? -1
    let betaLabel = betaDict?["label"] as? String ?? ""

    let orderedQuery = itemsRef.queryOrdered(byChild: "score").queryLimited(toFirst: 2)
    let orderedSnap = try await getDataAsync(orderedQuery)

    var orderedKeys: [String] = []
    var orderedScores: [Int] = []
    for case let child as DataSnapshot in orderedSnap.children {
      orderedKeys.append(child.key)
      let childDict = child.value as? [String: Any]
      if let scoreNumber = childDict?["score"] as? NSNumber {
        orderedScores.append(scoreNumber.intValue)
      }
    }

    try await removeValueAsync(runRef)
    let removedSnap = try await getDataAsync(runRef)

    return [
      "sdkVersionPresent": !Database.sdkVersion().isEmpty,
      "betaExists": betaSnap.exists(),
      "betaKey": betaSnap.key,
      "betaLabel": betaLabel,
      "betaIncrementedScore": betaScore,
      "orderedLimitedCount": Int(orderedSnap.childrenCount),
      "orderedKeys": orderedKeys,
      "orderedScores": orderedScores,
      "removedExistsAfterCleanup": removedSnap.exists(),
    ]
  } catch {
    try? await removeValueAsync(runRef)
    throw error
  }
}

func executeRtdbProbe(config: RtdbOracleConfig) async throws -> [String: Any] {
  let appName = "pyric-ios-rtdb-\(config.runId)"
  let options = FirebaseOptions(
    googleAppID: config.googleAppId,
    gcmSenderID: config.gcmSenderId
  )
  options.apiKey = config.apiKey
  options.projectID = config.projectId
  options.databaseURL = config.databaseUrl

  FirebaseApp.configure(name: appName, options: options)
  guard let app = FirebaseApp.app(name: appName) else {
    throw RtdbOracleError.appLookupFailed(appName)
  }

  let db = Database.database(app: app, url: config.databaseUrl)
  db.callbackQueue = DispatchQueue(label: "dev.pyric.ios.oracle.rtdb.\(config.runId)")

  do {
    let behavior: [String: Any]
    switch config.probeId {
    case "rtdb-swift-dedicated-crud-and-query-order":
      behavior = try await runDedicatedCrudAndQueryOrder(db: db, runId: config.runId)
    case "rtdb-swift-writes-autoid-servervalue-and-transactions":
      behavior = try await runWritesAutoIdServerValueAndTransactions(db: db, runId: config.runId)
    case "rtdb-swift-queries-ranges-limits-and-permission-denied":
      behavior = try await runQueriesRangesLimitsAndPermissionDenied(db: db, runId: config.runId)
    case "rtdb-swift-navigation-push-priorities-and-snapshots":
      behavior = try await runNavigationPushPrioritiesAndSnapshots(db: db, config: config)
    case "rtdb-swift-listeners-transactions-connection-and-ondisconnect":
      behavior = try await runListenersTransactionsConnectionAndOnDisconnect(
        db: db,
        config: config
      )
    default:
      throw RtdbOracleError.unknownProbe(config.probeId)
    }
    db.goOffline()
    await deleteAppAsync(app)
    return behavior
  } catch {
    db.goOffline()
    await deleteAppAsync(app)
    throw error
  }
}

Task {
  do {
    let (inputPath, outputPath) = try parseCliArgs(CommandLine.arguments)
    let inputData = try Data(contentsOf: URL(fileURLWithPath: inputPath))
    let config = try JSONDecoder().decode(RtdbOracleConfig.self, from: inputData)
    let behavior = try await executeRtdbProbe(config: config)

    guard JSONSerialization.isValidJSONObject(behavior) else {
      throw RtdbOracleError.invalidJsonPayload
    }
    let outputData = try JSONSerialization.data(
      withJSONObject: behavior,
      options: [.sortedKeys, .prettyPrinted]
    )
    try outputData.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    print("PYRIC_IOS_ORACLE_RESULT_B64:\(outputData.base64EncodedString())")
    fflush(stdout)
    Darwin.exit(0)
  } catch {
    let message = String(describing: error)
    fputs("[rtdb-oracle-cli] error: \(message)\n", stderr)
    fflush(stderr)
    Darwin.exit(1)
  }
}

RunLoop.main.run()
