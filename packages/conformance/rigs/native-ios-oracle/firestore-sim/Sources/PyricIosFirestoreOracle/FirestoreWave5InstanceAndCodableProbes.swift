import FirebaseCore
import FirebaseFirestore
import Foundation

private struct Wave5CodableRecord: Codable, Equatable {
  @DocumentID var id: String?
  var label: String
  var points: Int
  var active: Bool
  @ServerTimestamp var stampedAt: Timestamp?
}

private final class Wave5ListenerBox: @unchecked Sendable {
  private let lock = NSLock()
  private var inSyncCount = 0
  private var docEventCount = 0
  private var docLabels: [String] = []
  private var optionsMetadataFlags: [Bool] = []
  private var queryChangeEntries: [String] = []

  func recordInSync() {
    lock.lock()
    defer { lock.unlock() }
    inSyncCount += 1
  }

  func recordDocLabel(_ label: String) {
    lock.lock()
    defer { lock.unlock() }
    docEventCount += 1
    if docLabels.last != label {
      docLabels.append(label)
    }
  }

  func recordOptionsMetadata(_ flag: Bool) {
    lock.lock()
    defer { lock.unlock() }
    optionsMetadataFlags.append(flag)
  }

  func recordQueryChanges(_ entries: [String]) {
    lock.lock()
    defer { lock.unlock() }
    queryChangeEntries.append(contentsOf: entries)
  }

  func snapshot() -> (
    inSync: Int,
    docEvents: Int,
    labels: [String],
    pendingFlags: [Bool],
    queryChanges: [String]
  ) {
    lock.lock()
    defer { lock.unlock() }
    return (inSyncCount, docEventCount, docLabels, optionsMetadataFlags, queryChangeEntries)
  }
}

private func setCodableDataAsync<T: Encodable>(
  _ ref: DocumentReference,
  from value: T,
  merge: Bool? = nil
) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    do {
      if let mergeVal = merge {
        try ref.setData(from: value, merge: mergeVal) { error in
          if let error = error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: ())
          }
        }
      } else {
        try ref.setData(from: value) { error in
          if let error = error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: ())
          }
        }
      }
    } catch {
      continuation.resume(throwing: error)
    }
  }
}

extension FirestoreOracleProbeRunner {
  private static func awaitWave5Condition(
    _ label: String,
    timeoutMs: Int = 10_000,
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
      throw FirestoreOracleError.listenerTimeout(label)
    }
  }

  static func runInstanceSnapshotsInSyncAndCodable(
    db: Firestore,
    app: FirebaseApp,
    options: FirebaseOptions,
    runId: String
  ) async throws -> [String: Any] {
    let createdDefaultApp = FirebaseApp.app() == nil
    if createdDefaultApp {
      FirebaseApp.configure(options: options)
    }
    let defaultApp = FirebaseApp.app()

    let settingsAppName = "pyric-ios-fs-settings-\(runId)"
    FirebaseApp.configure(name: settingsAppName, options: options)
    guard let settingsApp = FirebaseApp.app(name: settingsAppName) else {
      if createdDefaultApp, let createdDefault = defaultApp {
        try? await Firestore.firestore(app: createdDefault).terminate()
        await deleteAppAsync(createdDefault)
      }
      throw FirestoreOracleError.appLookupFailed(settingsAppName)
    }

    let col = db.collection("pyric_oracle/\(runId)/wave5_items")
    let docAlpha = db.document("pyric_oracle/\(runId)/wave5_items/doc_alpha")
    let docBeta = col.document("doc_beta")
    let codableRef = col.document("codable_doc")
    let createdRefs = [docAlpha, docBeta, codableRef]

    let box = Wave5ListenerBox()
    var inSyncReg: ListenerRegistration?
    var docReg: ListenerRegistration?
    var docMetaReg: ListenerRegistration?
    var docOptionsReg: ListenerRegistration?
    var queryOptionsReg: ListenerRegistration?

    do {
      let defaultFirestoreIdentical = Firestore.firestore() === Firestore.firestore()
      let defaultFirestoreAppIsDefault = Firestore.firestore().app.name == "__FIRAPP_DEFAULT"
      let namedFirestoreIdentical = Firestore.firestore(app: app) === db
      let namedFirestoreAppMatches = db.app === app && db.app.name == app.name

      let settingsDb = Firestore.firestore(app: settingsApp)
      let defaultSettingsHost = settingsDb.settings.host
      let customSettings = FirestoreSettings()
      customSettings.cacheSettings = MemoryCacheSettings()
      settingsDb.settings = customSettings
      let appliedMemoryCacheSettings = settingsDb.settings.cacheSettings is MemoryCacheSettings
      settingsDb.useEmulator(withHost: "127.0.0.1", port: 8080)
      let emulatorHostApplied = settingsDb.settings.host == "127.0.0.1:8080"
      try? await settingsDb.terminate()
      await deleteAppAsync(settingsApp)

      let autoRef = col.document()
      let generatedDocIdLength = autoRef.documentID.count
      let docPathSuffixMatches = docAlpha.path.hasSuffix("/wave5_items/doc_alpha")
      let docParentCollectionId = docAlpha.parent.collectionID
      let subCol = docAlpha.collection("nested_sub")
      let subColParentMatchesDoc = subCol.parent?.path == docAlpha.path
      let topColParentMatchesRunDoc = col.parent?.documentID == runId

      let emptyBundleJson =
        "{\"metadata\":{\"id\":\"pyric-wave5\",\"createTime\":{\"seconds\":0,\"nanos\":0},\"version\":1,\"totalDocuments\":0,\"totalBytes\":0}}"
      let framedBundle = Data("\(emptyBundleJson.utf8.count)\(emptyBundleJson)".utf8)
      let bundleProgress = try await db.loadBundle(framedBundle)
      let emptyBundleSucceeded =
        bundleProgress.state == .success && bundleProgress.totalDocuments == 0

      var malformedBundleRejected = false
      do {
        _ = try await db.loadBundle(Data())
      } catch {
        malformedBundleRejected = (error as NSError).domain == FirestoreErrorDomain
      }
      let missingNamedQueryIsNil = await db.getQuery(named: "nonexistent-wave5-query") == nil

      try await docAlpha.setData([
        "label": "alpha-v1",
        "rank": 1,
        "nested": ["tag": "core"],
        "stamped": FieldValue.serverTimestamp(),
        "vec": FieldValue.vector([1.0, 2.5, 3.75]),
      ])
      try await docBeta.setData([
        "label": "beta-v1",
        "rank": 2,
      ])

      let alphaSnap = try await docAlpha.getDocument(source: .server)
      let snapshotRefMatchesPath = alphaSnap.reference.path == docAlpha.path
      let getByStringLabel = (alphaSnap.get("label") as? String) ?? ""
      let getByFieldPathTag = (alphaSnap.get(FieldPath(["nested", "tag"])) as? String) ?? ""
      let subscriptLabel = (alphaSnap["label"] as? String) ?? ""
      let dataWithEstimateHasStamped = alphaSnap.data(with: .estimate)?["stamped"] is Timestamp
      let vectorRoundTrip = (alphaSnap.get("vec") as? VectorValue)?.array ?? []

      try await docAlpha.updateData(["label": "alpha-v2"])
      var updateMissingCode = -1
      do {
        try await col.document("missing_doc_wave5").updateData(["label": "nope"])
      } catch {
        updateMissingCode = extractFirestoreError(error).code
      }
      if updateMissingCode != FirestoreErrorCode.notFound.rawValue {
        throw FirestoreOracleError.expectedFirestoreRejection("update-missing-wave5")
      }

      var asyncDocSnapshotId = ""
      var asyncQuerySnapshotIds: [String] = []
      if #available(iOS 18.0, macOS 15.0, *) {
        for try await snap in docAlpha.snapshots {
          asyncDocSnapshotId = snap.documentID
          break
        }
        for try await qSnap in col.order(by: "rank").snapshots {
          asyncQuerySnapshotIds = qSnap.documents.map(\.documentID)
          break
        }
      }

      inSyncReg = db.addSnapshotsInSyncListener {
        box.recordInSync()
      }
      docReg = docAlpha.addSnapshotListener { snap, _ in
        if let label = snap?.data()?["label"] as? String {
          box.recordDocLabel(label)
        }
      }
      docMetaReg = docAlpha.addSnapshotListener(includeMetadataChanges: true) { snap, _ in
        if let snap = snap {
          box.recordOptionsMetadata(snap.metadata.isFromCache)
        }
      }
      let listenOpts = SnapshotListenOptions()
        .withIncludeMetadataChanges(true)
        .withSource(.default)
      docOptionsReg = docAlpha.addSnapshotListener(options: listenOpts) { snap, _ in
        if let snap = snap {
          box.recordOptionsMetadata(snap.metadata.hasPendingWrites)
        }
      }
      queryOptionsReg = col
        .order(by: "rank")
        .addSnapshotListener(options: listenOpts) { qSnap, _ in
          guard let qSnap = qSnap else { return }
          let changes = qSnap.documentChanges(includeMetadataChanges: true).map { change in
            "\(change.type.rawValue):\(change.document.documentID):\(change.oldIndex)->\(change.newIndex)"
          }
          box.recordQueryChanges(changes)
        }

      try await awaitWave5Condition("initial-listeners-and-insync") {
        let snap = box.snapshot()
        return snap.inSync >= 1 && !snap.labels.isEmpty && !snap.queryChanges.isEmpty
      }

      try await docAlpha.updateData(["label": "alpha-v3"])
      try await awaitWave5Condition("updated-doc-listener") {
        box.snapshot().labels.contains("alpha-v3")
      }

      inSyncReg?.remove()
      inSyncReg = nil
      docReg?.remove()
      docReg = nil
      docMetaReg?.remove()
      docMetaReg = nil
      docOptionsReg?.remove()
      docOptionsReg = nil
      queryOptionsReg?.remove()
      queryOptionsReg = nil

      let snapAtUnsub = box.snapshot()
      try await docAlpha.updateData(["label": "alpha-v4"])
      _ = try await docAlpha.getDocument(source: .server)
      let snapAfterUnsub = box.snapshot()
      let silentAfterListenerRemove =
        snapAfterUnsub.docEvents == snapAtUnsub.docEvents
        && snapAfterUnsub.inSync == snapAtUnsub.inSync

      let nonEmptyQuerySnap = try await col.order(by: "rank").getDocuments(source: .server)
      let emptyQuerySnap = try await col
        .whereField("rank", isEqualTo: 999)
        .getDocuments(source: .server)

      try await setCodableDataAsync(
        codableRef,
        from: Wave5CodableRecord(
          id: "client-id-ignored-on-write",
          label: "codable-v1",
          points: 42,
          active: true,
          stampedAt: nil
        )
      )
      let rawCodableSnap = try await codableRef.getDocument(source: .server)
      let rawCodableData = rawCodableSnap.data() ?? [:]
      let codableOmittedDocumentIdField = rawCodableData["id"] == nil
      let codableServerTimestampResolved = rawCodableData["stampedAt"] is Timestamp
      let decodedInitial = try rawCodableSnap.data(
        as: Wave5CodableRecord.self,
        decoder: Firestore.Decoder()
      )

      try await setCodableDataAsync(
        codableRef,
        from: Wave5CodableRecord(
          id: nil,
          label: "codable-v2",
          points: 99,
          active: false,
          stampedAt: decodedInitial.stampedAt
        ),
        merge: true
      )
      let decodedMerged = try await codableRef
        .getDocument(source: .server)
        .data(as: Wave5CodableRecord.self)

      await deleteDocsBestEffort(createdRefs)
      if createdDefaultApp, let createdDefault = defaultApp {
        try? await Firestore.firestore(app: createdDefault).terminate()
        await deleteAppAsync(createdDefault)
      }

      return [
        "defaultFirestoreIdentical": defaultFirestoreIdentical,
        "defaultFirestoreAppIsDefault": defaultFirestoreAppIsDefault,
        "namedFirestoreIdentical": namedFirestoreIdentical,
        "namedFirestoreAppMatches": namedFirestoreAppMatches,
        "defaultSettingsHost": defaultSettingsHost,
        "appliedMemoryCacheSettings": appliedMemoryCacheSettings,
        "emulatorHostApplied": emulatorHostApplied,
        "generatedDocIdLength": generatedDocIdLength,
        "docPathSuffixMatches": docPathSuffixMatches,
        "docParentCollectionId": docParentCollectionId,
        "subColParentMatchesDoc": subColParentMatchesDoc,
        "topColParentMatchesRunDoc": topColParentMatchesRunDoc,
        "emptyBundleSucceeded": emptyBundleSucceeded,
        "malformedBundleRejected": malformedBundleRejected,
        "missingNamedQueryIsNil": missingNamedQueryIsNil,
        "snapshotRefMatchesPath": snapshotRefMatchesPath,
        "getByStringLabel": getByStringLabel,
        "getByFieldPathTag": getByFieldPathTag,
        "subscriptLabel": subscriptLabel,
        "dataWithEstimateHasStamped": dataWithEstimateHasStamped,
        "vectorRoundTrip": vectorRoundTrip,
        "updateMissingMatchesNotFound":
          updateMissingCode == FirestoreErrorCode.notFound.rawValue,
        "asyncDocSnapshotId": asyncDocSnapshotId,
        "asyncQuerySnapshotIds": asyncQuerySnapshotIds,
        "inSyncFired": snapAtUnsub.inSync >= 1,
        "docListenerObservedLabels": snapAtUnsub.labels,
        "optionsListenerObservedMetadata": !snapAtUnsub.pendingFlags.isEmpty,
        "queryOptionsObservedChanges": !snapAtUnsub.queryChanges.isEmpty,
        "silentAfterListenerRemove": silentAfterListenerRemove,
        "nonEmptyQueryIsEmpty": nonEmptyQuerySnap.isEmpty,
        "nonEmptyQueryCount": nonEmptyQuerySnap.count,
        "emptyQueryIsEmpty": emptyQuerySnap.isEmpty,
        "emptyQueryCount": emptyQuerySnap.count,
        "codableOmittedDocumentIdField": codableOmittedDocumentIdField,
        "codableServerTimestampResolved": codableServerTimestampResolved,
        "codableDecodedDocumentId": decodedInitial.id ?? "",
        "codableDecodedLabel": decodedInitial.label,
        "codableDecodedPoints": decodedInitial.points,
        "codableDecodedHasTimestamp": decodedInitial.stampedAt != nil,
        "codableMergedLabel": decodedMerged.label,
        "codableMergedPoints": decodedMerged.points,
        "codableMergedActive": decodedMerged.active,
      ]
    } catch {
      inSyncReg?.remove()
      docReg?.remove()
      docMetaReg?.remove()
      docOptionsReg?.remove()
      queryOptionsReg?.remove()
      await deleteDocsBestEffort(createdRefs)
      if let remainingSettings = FirebaseApp.app(name: settingsAppName) {
        try? await Firestore.firestore(app: remainingSettings).terminate()
        await deleteAppAsync(remainingSettings)
      }
      if createdDefaultApp, let createdDefault = defaultApp {
        try? await Firestore.firestore(app: createdDefault).terminate()
        await deleteAppAsync(createdDefault)
      }
      throw error
    }
  }
}
