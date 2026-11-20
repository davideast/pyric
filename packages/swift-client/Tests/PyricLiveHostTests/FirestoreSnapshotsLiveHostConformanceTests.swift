import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

@Suite("firestore-swift Snapshots & Metadata Live-Host Conformance (Rows 64-78)", .serialized)
struct FirestoreSnapshotsLiveHostConformanceTests {

    @Test("firestore-swift#64..#68, #70..#71: DocumentSnapshot exists, documentID, reference, metadata, data(), get(_:), and subscript over live host")
    func documentSnapshotInspectionAndFieldAccessLiveHostConformance() async throws {
        guard let (host, port) = try liveSnapshotsEndpoint() else {
            return
        }

        let app = makeSnapshotsLiveApp(prefix: "fs-doc-snap", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-docsnap-\(tag)@example.test",
            password: "CorrectHorse!64"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)
        let items = db.collection("users/\(uid)/items")

        // 1. Missing document snapshot invariants (Rows 64, 65, 66, 67, 68, 70, 71).
        let missingRef = items.document("missing-doc")
        let missingSnap = try await missingRef.getDocument(source: .server)
        #expect(missingSnap.exists == false)
        #expect(missingSnap.documentID == "missing-doc")
        #expect(missingSnap.reference.path == "users/\(uid)/items/missing-doc")
        #expect(missingSnap.reference.firestore === db)
        #expect(missingSnap.metadata.isFromCache == false)
        #expect(missingSnap.metadata.hasPendingWrites == false)
        #expect(missingSnap.data() == nil)
        #expect(missingSnap.data(with: .estimate) == nil)
        #expect(missingSnap.get("title") == nil)
        #expect(missingSnap.get(FieldPath.documentID()) == nil)
        #expect(missingSnap["title"] == nil)

        // 2. Existing document with nested maps, literal-dot keys, explicit null, Timestamp, GeoPoint, Data, and DocumentReference.
        let targetRef = items.document("linked-target")
        try await targetRef.setData(["label": "Target"])

        let fixedTs = Timestamp(seconds: 1_765_000_000, nanoseconds: 250_000_000)
        let fixedGeo = GeoPoint(latitude: 37.7749, longitude: -122.4194)
        let fixedBytes = Data([0xDE, 0xAD, 0xBE, 0xEF])

        let docRef = items.document("rich-doc")
        try await docRef.setData([
            "title": "Snapshot Spec",
            "note": NSNull(),
            "profile": [
                "address": [
                    "city": "San Francisco",
                    "zip": 94107
                ]
            ],
            "meta.v1": [
                "tier": "enterprise",
                "quota": 500
            ],
            "publishedAt": fixedTs,
            "coords": fixedGeo,
            "blob": fixedBytes,
            "target": targetRef
        ])

        let snap = try await docRef.getDocument(source: .server)
        #expect(snap.exists == true)
        #expect(snap.documentID == "rich-doc")
        #expect(snap.reference.path == "users/\(uid)/items/rich-doc")
        #expect(snap.reference.documentID == "rich-doc")
        #expect(snap.metadata == SnapshotMetadata(hasPendingWrites: false, isFromCache: false))

        // Row 68: data() returns a defensive copy so caller mutation never mutates subsequent reads.
        var firstData = try #require(snap.data())
        #expect(firstData["title"] as? String == "Snapshot Spec")
        #expect(firstData["note"] is NSNull)
        #expect(firstData["publishedAt"] as? Timestamp == fixedTs)
        #expect(firstData["coords"] as? GeoPoint == fixedGeo)
        #expect(firstData["blob"] as? Data == fixedBytes)
        let decodedTarget = try #require(firstData["target"] as? DocumentReference)
        #expect(decodedTarget.path == targetRef.path)
        firstData["title"] = "Mutated Locally"
        #expect(snap.data()?["title"] as? String == "Snapshot Spec")

        // Row 70: get(_:) with dot-delimited String, multi-segment FieldPath, literal-dot FieldPath, and FieldPath.documentID().
        #expect(snap.get("profile.address.city") as? String == "San Francisco")
        #expect(snap.get("profile.address.zip") as? Int64 == 94107)
        #expect(snap.get(FieldPath(["profile", "address", "city"])) as? String == "San Francisco")
        #expect(snap.get(FieldPath(["meta.v1", "tier"])) as? String == "enterprise")
        #expect(snap.get(FieldPath(["meta.v1", "quota"])) as? Int64 == 500)
        #expect(snap.get(FieldPath.documentID()) as? String == "rich-doc")
        #expect(snap.get("note") is NSNull)
        #expect(snap.get("profile.missing.key") == nil)

        // Row 71: subscript[String] and subscript[FieldPath].
        #expect(snap["title"] as? String == "Snapshot Spec")
        #expect(snap["profile.address.city"] as? String == "San Francisco")
        #expect(snap[FieldPath(["meta.v1", "tier"])] as? String == "enterprise")
        #expect(snap["doesNotExist"] == nil)

        // Row 66: snapshot.reference is live and usable for follow-up mutations.
        try await snap.reference.delete()
        let afterDelete = try await docRef.getDocument(source: .server)
        #expect(afterDelete.exists == false)
        #expect(afterDelete.data() == nil)

        await app.disconnectSharedBridge()
    }

    @Test("firestore-swift#69 & #73: DocumentSnapshot.data(with: ServerTimestampBehavior) and SnapshotMetadata transitions over live host")
    func serverTimestampBehaviorAndMetadataLiveHostConformance() async throws {
        guard let (host, port) = try liveSnapshotsEndpoint() else {
            return
        }

        let app = makeSnapshotsLiveApp(prefix: "fs-sts", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-sts-\(tag)@example.test",
            password: "CorrectHorse!69"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)
        let items = db.collection("users/\(uid)/items")

        let initialTs = Timestamp(seconds: 1_760_000_000, nanoseconds: 123_000_000)
        let existingRef = items.document("existing-ts")
        try await existingRef.setData([
            "version": 1,
            "updatedAt": initialTs
        ])

        let onlineSnap = try await existingRef.getDocument(source: .server)
        #expect(onlineSnap.metadata.isFromCache == false)
        #expect(onlineSnap.metadata.hasPendingWrites == false)
        #expect(onlineSnap.data(with: .none)?["updatedAt"] as? Timestamp == initialTs)

        let cachedCleanSnap = try await existingRef.getDocument(source: .cache)
        #expect(cachedCleanSnap.metadata.isFromCache == true)
        #expect(cachedCleanSnap.metadata.hasPendingWrites == false)

        // Go offline and stage both a new document and an update containing FieldValue.serverTimestamp().
        try await db.disableNetwork()

        let createdOfflineRef = items.document("created-offline-ts")
        let createTask = Task {
            try await createdOfflineRef.setData([
                "label": "new-doc",
                "createdAt": FieldValue.serverTimestamp()
            ])
        }
        let updateTask = Task {
            try await existingRef.updateData([
                "version": 2,
                "updatedAt": FieldValue.serverTimestamp()
            ])
        }
        try await Task.sleep(nanoseconds: 40_000_000)

        // New pending document: .none -> NSNull, .previous -> NSNull (no prior value), .estimate -> local Timestamp.
        let pendingNewSnap = try await createdOfflineRef.getDocument(source: .cache)
        #expect(pendingNewSnap.metadata.isFromCache == true)
        #expect(pendingNewSnap.metadata.hasPendingWrites == true)
        #expect(pendingNewSnap.data()?["createdAt"] is NSNull)
        #expect(pendingNewSnap.data(with: .none)?["createdAt"] is NSNull)
        #expect(pendingNewSnap.data(with: .previous)?["createdAt"] is NSNull)
        let newEstimate = pendingNewSnap.data(with: .estimate)?["createdAt"] as? Timestamp
        #expect(newEstimate != nil)
        #expect(pendingNewSnap.get("createdAt", serverTimestampBehavior: .none) is NSNull)
        #expect(pendingNewSnap.get("createdAt", serverTimestampBehavior: .estimate) is Timestamp)

        // Updated pending document: .none -> NSNull, .previous -> initialTs, .estimate -> local Timestamp != initialTs.
        let pendingUpdatedSnap = try await existingRef.getDocument(source: .cache)
        #expect(pendingUpdatedSnap.metadata.isFromCache == true)
        #expect(pendingUpdatedSnap.metadata.hasPendingWrites == true)
        #expect(pendingUpdatedSnap.data()?["version"] as? Int64 == 2)
        #expect(pendingUpdatedSnap.data()?["updatedAt"] is NSNull)
        #expect(pendingUpdatedSnap.data(with: .none)?["updatedAt"] is NSNull)
        #expect(pendingUpdatedSnap.data(with: .previous)?["updatedAt"] as? Timestamp == initialTs)
        let updatedEstimate = try #require(pendingUpdatedSnap.data(with: .estimate)?["updatedAt"] as? Timestamp)
        #expect(updatedEstimate != initialTs)
        #expect(pendingUpdatedSnap.get("updatedAt", serverTimestampBehavior: .previous) as? Timestamp == initialTs)

        // QuerySnapshot.documents (QueryDocumentSnapshot) preserves ServerTimestampBehavior variants while pending.
        let pendingQuerySnap = try await items.getDocuments(source: .cache)
        #expect(pendingQuerySnap.metadata.isFromCache == true)
        #expect(pendingQuerySnap.metadata.hasPendingWrites == true)
        let pendingQueryExisting = try #require(
            pendingQuerySnap.documents.first { $0.documentID == "existing-ts" }
        )
        #expect(pendingQueryExisting.data(with: .none)["updatedAt"] is NSNull)
        #expect(pendingQueryExisting.data(with: .previous)["updatedAt"] as? Timestamp == initialTs)
        #expect(pendingQueryExisting.data(with: .estimate)["updatedAt"] is Timestamp)

        // Re-enable network and settle writes on live host: committed server Timestamp replaces all variants.
        try await db.enableNetwork()
        try await createTask.value
        try await updateTask.value

        let settledExisting = try await existingRef.getDocument(source: .server)
        #expect(settledExisting.metadata.isFromCache == false)
        #expect(settledExisting.metadata.hasPendingWrites == false)
        let committedTs = try #require(settledExisting.data()?["updatedAt"] as? Timestamp)
        #expect(committedTs != initialTs)
        #expect(settledExisting.data(with: .none)?["updatedAt"] as? Timestamp == committedTs)
        #expect(settledExisting.data(with: .previous)?["updatedAt"] as? Timestamp == committedTs)
        #expect(settledExisting.data(with: .estimate)?["updatedAt"] as? Timestamp == committedTs)

        await app.disconnectSharedBridge()
    }

    @Test("firestore-swift#72, #74..#78: QueryDocumentSnapshot, QuerySnapshot documents/isEmpty/count, documentChanges, documentChanges(includeMetadataChanges:), and DocumentChange indices over live host")
    func querySnapshotAndDocumentChangesLiveHostConformance() async throws {
        guard let (host, port) = try liveSnapshotsEndpoint() else {
            return
        }

        let app = makeSnapshotsLiveApp(prefix: "fs-qsnap", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-qsnap-\(tag)@example.test",
            password: "CorrectHorse!72"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)
        let items = db.collection("users/\(uid)/items")
        let ordered = items.order(by: "rank")

        // Row 77: Empty QuerySnapshot reports isEmpty == true and count == 0.
        let emptySnap = try await ordered.getDocuments(source: .server)
        #expect(emptySnap.isEmpty == true)
        #expect(emptySnap.count == 0)
        #expect(emptySnap.documents.isEmpty == true)
        #expect(emptySnap.documentChanges.isEmpty == true)

        // Seed 3 ordered documents before attaching listeners.
        try await items.document("s1").setData(["rank": 10, "name": "Alpha"])
        try await items.document("s2").setData(["rank": 20, "name": "Beta"])
        try await items.document("s3").setData(["rank": 30, "name": "Gamma"])

        let metaCollector = SnapshotsQueryCollector()
        let metaReg = ordered.addSnapshotListener(includeMetadataChanges: true) { snap, _ in
            metaCollector.append(snap)
        }
        defer { metaReg.remove() }

        // 1. Initial emission: 3 QueryDocumentSnapshots in order, all .added with oldIndex == -1, newIndex == 0..2.
        await metaCollector.waitForCount(1)
        let snap1 = metaCollector.snapshots[0]
        #expect(snap1.isEmpty == false)
        #expect(snap1.count == 3)
        #expect(snap1.documents.map(\.documentID) == ["s1", "s2", "s3"])
        #expect(snap1[0].exists == true)
        #expect(snap1[0].data()["name"] as? String == "Alpha")
        #expect(snap1.documentChanges.count == 3)
        for (idx, change) in snap1.documentChanges.enumerated() {
            #expect(change.type == .added)
            #expect(change.oldIndex == DocumentChange.indexNotFound)
            #expect(change.newIndex == idx)
            #expect(change.document.documentID == snap1.documents[idx].documentID)
        }

        // 2. Modify s1 rank 10 -> 25 so order shifts [s1, s2, s3] -> [s2, s1, s3].
        // With includeMetadataChanges: true, the live host emits both the pending echo (hasPendingWrites == true)
        // and the settled confirmation (hasPendingWrites == false, metadata-only delta on s1).
        try await items.document("s1").updateData(["rank": 25, "name": "Alpha Moved"])
        await metaCollector.waitUntil { snaps in
            snaps.count >= 3 && snaps.last?.metadata.hasPendingWrites == false
        }
        let pendingMoveSnap = metaCollector.snapshots[1]
        #expect(pendingMoveSnap.metadata.hasPendingWrites == true)
        #expect(pendingMoveSnap.documents.map(\.documentID) == ["s2", "s1", "s3"])
        #expect(pendingMoveSnap.documents[0].metadata.hasPendingWrites == false)
        #expect(pendingMoveSnap.documents[1].metadata.hasPendingWrites == true)
        #expect(pendingMoveSnap.documentChanges.count == 1)
        let movedChange = try #require(pendingMoveSnap.documentChanges.first)
        #expect(movedChange.type == .modified)
        #expect(movedChange.document.documentID == "s1")
        #expect(movedChange.oldIndex == 0)
        #expect(movedChange.newIndex == 1)

        let settledMoveSnap = try #require(metaCollector.snapshots.last)
        #expect(settledMoveSnap.metadata.hasPendingWrites == false)
        #expect(settledMoveSnap.documents.map(\.documentID) == ["s2", "s1", "s3"])
        #expect(settledMoveSnap.documentChanges.isEmpty == true)
        let settledMoveMetaChanges = settledMoveSnap.documentChanges(includeMetadataChanges: true)
        #expect(settledMoveMetaChanges.count == 1)
        #expect(settledMoveMetaChanges[0].type == .modified)
        #expect(settledMoveMetaChanges[0].document.documentID == "s1")
        #expect(settledMoveMetaChanges[0].oldIndex == 1)
        #expect(settledMoveMetaChanges[0].newIndex == 1)

        // 3. Delete s2 ([s2, s1, s3] -> [s1, s3]); s2 emits .removed (oldIndex: 0, newIndex: -1).
        let beforeDeleteCount = metaCollector.snapshots.count
        try await items.document("s2").delete()
        await metaCollector.waitUntil { snaps in
            snaps.count > beforeDeleteCount
                && snaps.last?.documents.map(\.documentID) == ["s1", "s3"]
                && snaps.last?.metadata.hasPendingWrites == false
        }
        let deleteSnap = try #require(
            metaCollector.snapshots.dropFirst(beforeDeleteCount).first { !$0.documentChanges.isEmpty }
        )
        #expect(deleteSnap.count == 2)
        #expect(deleteSnap.documents.map(\.documentID) == ["s1", "s3"])
        #expect(deleteSnap.documentChanges.count == 1)
        let removedChange = try #require(deleteSnap.documentChanges.first)
        #expect(removedChange.type == .removed)
        #expect(removedChange.document.documentID == "s2")
        #expect(removedChange.oldIndex == 0)
        #expect(removedChange.newIndex == DocumentChange.indexNotFound)

        // 4. Row 76: Metadata-only transition (disableNetwork: isFromCache false -> true).
        // documentChanges (includeMetadataChanges: false) is empty, while documentChanges(includeMetadataChanges: true) reports .modified.
        let beforeOfflineCount = metaCollector.snapshots.count
        try await db.disableNetwork()
        await metaCollector.waitUntil { $0.count > beforeOfflineCount }
        let cacheTransitionSnap = try #require(metaCollector.snapshots.last)
        #expect(cacheTransitionSnap.metadata.isFromCache == true)
        #expect(cacheTransitionSnap.metadata.hasPendingWrites == false)
        #expect(cacheTransitionSnap.documentChanges.isEmpty == true)
        #expect(cacheTransitionSnap.documentChanges(includeMetadataChanges: false).isEmpty == true)
        let metaOnlyChanges = cacheTransitionSnap.documentChanges(includeMetadataChanges: true)
        #expect(metaOnlyChanges.count == 2)
        #expect(metaOnlyChanges.map(\.type) == [.modified, .modified])
        #expect(metaOnlyChanges.map(\.document.documentID) == ["s1", "s3"])
        #expect(metaOnlyChanges[0].oldIndex == 0 && metaOnlyChanges[0].newIndex == 0)
        #expect(metaOnlyChanges[1].oldIndex == 1 && metaOnlyChanges[1].newIndex == 1)

        // 5. Stage an offline write on s3, then re-enable network; settlement metadata transition is surfaced only when includeMetadataChanges: true.
        let beforeStageCount = metaCollector.snapshots.count
        let offlineTask = Task {
            try await items.document("s3").updateData(["name": "Gamma Offline"])
        }
        await metaCollector.waitUntil { $0.count > beforeStageCount }
        let pendingSnap = try #require(metaCollector.snapshots.last)
        #expect(pendingSnap.metadata.hasPendingWrites == true)
        #expect(pendingSnap.documentChanges.map(\.document.documentID) == ["s3"])
        #expect(pendingSnap.documentChanges.map(\.type) == [.modified])

        let beforeEnableCount = metaCollector.snapshots.count
        try await db.enableNetwork()
        try await offlineTask.value
        await metaCollector.waitUntil { snaps in
            snaps.count > beforeEnableCount
                && snaps.last?.metadata.isFromCache == false
                && snaps.last?.metadata.hasPendingWrites == false
        }
        let settledSnap = try #require(metaCollector.snapshots.last)
        #expect(settledSnap.metadata.isFromCache == false)
        #expect(settledSnap.metadata.hasPendingWrites == false)
        #expect(settledSnap.documentChanges.isEmpty == true)
        let settledMetaChanges = settledSnap.documentChanges(includeMetadataChanges: true)
        #expect(!settledMetaChanges.isEmpty)
        #expect(settledMetaChanges.allSatisfy { $0.type == .modified })

        // 6. Rows 75, 76, 78: Double.nan + VectorValue equality stability AND sequential working-set indices
        // across multi-document batch insert + modify + multi-delete.
        let applySequentialChanges: ([String], [DocumentChange]) -> [String] = { priorIDs, deltas in
            var working = priorIDs
            for delta in deltas {
                switch delta.type {
                case .removed:
                    working.remove(at: delta.oldIndex)
                case .added:
                    working.insert(delta.document.documentID, at: delta.newIndex)
                case .modified:
                    working.remove(at: delta.oldIndex)
                    working.insert(delta.document.documentID, at: delta.newIndex)
                }
            }
            return working
        }

        // Give s3 Double.nan + VectorValue; mutating s1 afterwards must NOT emit a spurious .modified on s3.
        let beforeNanSeedCount = metaCollector.snapshots.count
        try await items.document("s3").updateData([
            "nanMetric": Double.nan,
            "embedding": FieldValue.vector([1.0, 2.5])
        ])
        await metaCollector.waitUntil { snaps in
            snaps.count > beforeNanSeedCount && snaps.last?.metadata.hasPendingWrites == false
        }

        let beforeSiblingEditCount = metaCollector.snapshots.count
        try await items.document("s1").updateData(["name": "Alpha Only"])
        await metaCollector.waitUntil { snaps in
            snaps.count > beforeSiblingEditCount && snaps.last?.metadata.hasPendingWrites == false
        }
        let siblingDataSnap = try #require(
            metaCollector.snapshots.dropFirst(beforeSiblingEditCount).first { !$0.documentChanges.isEmpty }
        )
        #expect(siblingDataSnap.documentChanges.map(\.document.documentID) == ["s1"])

        // Compound batch: insert s0 at rank 5 (index 0) + modify s1 ([s1, s3] -> [s0, s1', s3]).
        // Sequential indices must emit (added s0, newIndex: 0) then (modified s1, oldIndex: 1, newIndex: 1).
        let beforeCompoundCount = metaCollector.snapshots.count
        let compoundBatch = db.batch()
        compoundBatch
            .setData(["rank": 5, "name": "Zero"], forDocument: items.document("s0"))
            .updateData(["name": "Alpha Shifted"], forDocument: items.document("s1"))
        try await compoundBatch.commit()
        await metaCollector.waitUntil { snaps in
            snaps.count > beforeCompoundCount
                && snaps.last?.documents.map(\.documentID) == ["s0", "s1", "s3"]
                && snaps.last?.metadata.hasPendingWrites == false
        }
        let compoundSnap = try #require(
            metaCollector.snapshots.dropFirst(beforeCompoundCount).first { !$0.documentChanges.isEmpty }
        )
        #expect(compoundSnap.documentChanges.count == 2)
        #expect(compoundSnap.documentChanges[0].type == .added)
        #expect(compoundSnap.documentChanges[0].document.documentID == "s0")
        #expect(compoundSnap.documentChanges[0].oldIndex == DocumentChange.indexNotFound)
        #expect(compoundSnap.documentChanges[0].newIndex == 0)
        #expect(compoundSnap.documentChanges[1].type == .modified)
        #expect(compoundSnap.documentChanges[1].document.documentID == "s1")
        #expect(compoundSnap.documentChanges[1].oldIndex == 1)
        #expect(compoundSnap.documentChanges[1].newIndex == 1)
        #expect(applySequentialChanges(["s1", "s3"], compoundSnap.documentChanges) == ["s0", "s1", "s3"])

        // Multi-document batch delete ([s0, s1, s3] -> []): sequential oldIndices must be [0, 0, 0].
        let beforeClearCount = metaCollector.snapshots.count
        let clearBatch = db.batch()
        clearBatch
            .deleteDocument(items.document("s0"))
            .deleteDocument(items.document("s1"))
            .deleteDocument(items.document("s3"))
        try await clearBatch.commit()
        await metaCollector.waitUntil { snaps in
            snaps.count > beforeClearCount && snaps.last?.isEmpty == true
        }
        let clearSnap = try #require(
            metaCollector.snapshots.dropFirst(beforeClearCount).first { !$0.documentChanges.isEmpty }
        )
        #expect(clearSnap.documentChanges.map(\.type) == [.removed, .removed, .removed])
        #expect(clearSnap.documentChanges.map(\.oldIndex) == [0, 0, 0])
        #expect(applySequentialChanges(["s0", "s1", "s3"], clearSnap.documentChanges) == [])

        await app.disconnectSharedBridge()
    }
}
