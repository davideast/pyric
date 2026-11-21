import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

@Suite("firestore-swift WriteBatch, Transactions & AsyncSequences Live-Host Conformance (Rows 79-91, 101-102)", .serialized)
struct FirestoreTransactionsLiveHostConformanceTests {

    @Test("firestore-swift#79..#84: WriteBatch setData, merge, mergeFields, updateData, deleteDocument, offline staging, and atomic commit over live host")
    func writeBatchFullSurfaceLiveHostConformance() async throws {
        guard let (host, port) = try liveTransactionsEndpoint() else {
            return
        }

        let app = makeTransactionsLiveApp(prefix: "fs-wb", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let tag = UUID().uuidString.lowercased()
        let created = try await Auth.auth(app: app).createUser(
            withEmail: "fs-wb-\(tag)@example.test",
            password: "CorrectHorse!79"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)
        let items = db.collection("users/\(uid)/items")

        // Empty batch commit succeeds cleanly.
        try await db.batch().commit()

        let overwriteRef = items.document("wb-overwrite")
        let mergeRef = items.document("wb-merge")
        let maskRef = items.document("wb-mask")
        let updateRef = items.document("wb-update")
        let deleteRef = items.document("wb-delete")
        let codableRef = items.document("wb-codable")

        try await overwriteRef.setData(["legacy": "remove-me", "v": 1])
        try await mergeRef.setData(["keep": "untouched", "nested": ["a": 1, "b": 2]])
        try await maskRef.setData([
            "keep": "preserved",
            "profile": ["city": "Austin", "zip": 78701],
            "meta.v1": ["tier": "free", "quota": 10]
        ])
        try await updateRef.setData([
            "score": 10,
            "tags": ["alpha", "stale"],
            "obsolete": "gone",
            "meta.v1": ["quota": 50, "keepFlag": true]
        ])
        try await deleteRef.setData(["temp": true])

        // Rows 79, 80, 81, 82, 83, 84 in a single atomic batch.
        let batch = db.batch()
        batch
            .setData(["title": "Fresh", "v": 2], forDocument: overwriteRef)
            .setData(["nested": ["b": 20, "c": 30]], forDocument: mergeRef, merge: true)
            .setData(
                [
                    "keep": "ignored-by-mask",
                    "profile": ["city": "Seattle", "ignored": true],
                    "meta.v1": ["tier": "pro", "quota": 999]
                ],
                forDocument: maskRef,
                mergeFields: ["profile.city", FieldPath(["meta.v1", "tier"])]
            )
            .updateData(
                [
                    "score": FieldValue.increment(Int64(15)),
                    "tags": FieldValue.arrayUnion(["beta"]),
                    "obsolete": FieldValue.delete(),
                    FieldPath(["meta.v1", "quota"]): 250
                ],
                forDocument: updateRef
            )
            .deleteDocument(deleteRef)
            .deleteDocument(items.document("wb-already-missing"))
        _ = try batch.setData(from: TxnItemRecord(title: "CodableBatch", qty: 7), forDocument: codableRef)
        try await batch.commit()

        // Re-committing an already committed WriteBatch fails.
        do {
            try await batch.commit()
            Issue.record("Expected second commit() on committed WriteBatch to throw")
        } catch {}

        let overSnap = try await overwriteRef.getDocument(source: .server)
        #expect(overSnap.data()?["legacy"] == nil)
        #expect(overSnap.data()?["title"] as? String == "Fresh")
        #expect(overSnap.data()?["v"] as? Int64 == 2)

        let mergeSnap = try await mergeRef.getDocument(source: .server)
        #expect(mergeSnap.data()?["keep"] as? String == "untouched")
        #expect(mergeSnap.get("nested.a") as? Int64 == 1)
        #expect(mergeSnap.get("nested.b") as? Int64 == 20)
        #expect(mergeSnap.get("nested.c") as? Int64 == 30)

        let maskSnap = try await maskRef.getDocument(source: .server)
        #expect(maskSnap.data()?["keep"] as? String == "preserved")
        #expect(maskSnap.get("profile.city") as? String == "Seattle")
        #expect(maskSnap.get("profile.zip") as? Int64 == 78701)
        #expect(maskSnap.get("profile.ignored") == nil)
        #expect(maskSnap.get(FieldPath(["meta.v1", "tier"])) as? String == "pro")
        #expect(maskSnap.get(FieldPath(["meta.v1", "quota"])) as? Int64 == 10)

        let updSnap = try await updateRef.getDocument(source: .server)
        #expect(updSnap.data()?["score"] as? Int64 == 25)
        #expect((updSnap.data()?["tags"] as? [String])?.contains("beta") == true)
        #expect(updSnap.data()?["obsolete"] == nil)
        #expect(updSnap.get(FieldPath(["meta.v1", "quota"])) as? Int64 == 250)
        #expect(updSnap.get(FieldPath(["meta.v1", "keepFlag"])) as? Bool == true)

        #expect(try await deleteRef.getDocument(source: .server).exists == false)
        let decodedCodable = try await codableRef.getDocument(source: .server).data(as: TxnItemRecord.self)
        #expect(decodedCodable == TxnItemRecord(title: "CodableBatch", qty: 7))

        // Row 82 & 84: updateData on missing document fails with .notFound and rolls back sibling setData.
        let rollbackCanary = items.document("wb-rollback-canary")
        let missingUpdateBatch = db.batch()
        missingUpdateBatch
            .setData(["canary": true], forDocument: rollbackCanary)
            .updateData(["x": 1], forDocument: items.document("wb-does-not-exist"))
        await expectTxnBridgeCode(.notFound) {
            try await missingUpdateBatch.commit()
        }
        #expect(try await rollbackCanary.getDocument(source: .server).exists == false)

        // Row 84: Offline WriteBatch staging (including literal-dot FieldPath update), immediate local cache visibility, and online flush settlement.
        try await db.disableNetwork()
        let offlineBatchRef = items.document("wb-offline")
        let offlineBatch = db.batch()
        offlineBatch
            .setData(["staged": "offline-batch", "meta.v1": ["quota": 1]], forDocument: offlineBatchRef)
            .updateData([FieldPath(["meta.v1", "quota"]): 42], forDocument: offlineBatchRef)
        let commitTask = Task { try await offlineBatch.commit() }
        try await Task.sleep(nanoseconds: 40_000_000)

        let cachedOffline = try await offlineBatchRef.getDocument(source: .cache)
        #expect(cachedOffline.exists == true)
        #expect(cachedOffline.metadata.isFromCache == true)
        #expect(cachedOffline.metadata.hasPendingWrites == true)
        #expect(cachedOffline.data()?["staged"] as? String == "offline-batch")
        #expect(cachedOffline.get(FieldPath(["meta.v1", "quota"])) as? Int64 == 42)

        try await db.enableNetwork()
        try await commitTask.value
        try await db.waitForPendingWrites()
        let settledOffline = try await offlineBatchRef.getDocument(source: .server)
        #expect(settledOffline.metadata.hasPendingWrites == false)
        #expect(settledOffline.data()?["staged"] as? String == "offline-batch")
        #expect(settledOffline.get(FieldPath(["meta.v1", "quota"])) as? Int64 == 42)

        await app.disconnectSharedBridge()
    }

    @Test("firestore-swift#85..#91: Transaction getDocument, snapshot isolation, setData/merge/mergeFields, updateData, deleteDocument, and TransactionOptions.maxAttempts over live host")
    func interactiveTransactionsLiveHostConformance() async throws {
        guard let (host, port) = try liveTransactionsEndpoint() else {
            return
        }

        let app1 = makeTransactionsLiveApp(prefix: "fs-tx1", host: host, port: port)
        let app2 = makeTransactionsLiveApp(prefix: "fs-tx2", host: host, port: port)
        defer {
            Task {
                await app1.disconnectSharedBridge()
                await app2.disconnectSharedBridge()
            }
        }

        let tag = UUID().uuidString.lowercased()
        let email = "fs-tx-\(tag)@example.test"
        let password = "CorrectHorse!85"
        let created = try await Auth.auth(app: app1).createUser(withEmail: email, password: password)
        _ = try await Auth.auth(app: app2).signIn(withEmail: email, password: password)
        let uid = created.user.uid

        let db1 = Firestore.firestore(app: app1)
        let db2 = Firestore.firestore(app: app2)
        let items1 = db1.collection("users/\(uid)/items")
        let items2 = db2.collection("users/\(uid)/items")

        let overRef = items1.document("tx-overwrite")
        let mergeRef = items1.document("tx-merge")
        let maskRef = items1.document("tx-mask")
        let updRef = items1.document("tx-update")
        let delRef = items1.document("tx-delete")
        let missingReadRef = items1.document("tx-missing-read")

        try await overRef.setData(["old": "gone", "n": 1])
        try await mergeRef.setData(["keep": "yes", "nested": ["x": 1, "y": 2]])
        try await maskRef.setData([
            "untouched": "stay",
            "meta.v1": ["tier": "basic", "quota": 5],
            "profile": ["role": "member", "dept": "eng"]
        ])
        try await updRef.setData([
            "balance": 100,
            "dropMe": "bye",
            "meta.v1": ["limit": 10, "active": true]
        ])
        try await delRef.setData(["bye": true])

        // Rows 85..90 in one transaction: read existing + missing docs, then stage set/merge/mergeFields/update/delete.
        let summary = try await db1.runTransaction { txn -> Any? in
            let overSnap = try await txn.getDocument(overRef)
            let missingSnap = try await txn.getDocument(missingReadRef)
            #expect(overSnap.exists == true)
            #expect(missingSnap.exists == false)

            txn
                .setData(["fresh": true, "n": 2], forDocument: overRef)
                .setData(["nested": ["y": 22, "z": 33]], forDocument: mergeRef, merge: true)
                .setData(
                    [
                        "untouched": "ignored",
                        "meta.v1": ["tier": "enterprise", "quota": 999],
                        "profile": ["role": "owner", "dept": "ignored"]
                    ],
                    forDocument: maskRef,
                    mergeFields: ["profile.role", FieldPath(["meta.v1", "tier"])]
                )
                .updateData(
                    [
                        "balance": FieldValue.increment(Int64(50)),
                        "dropMe": FieldValue.delete(),
                        FieldPath(["meta.v1", "limit"]): 99
                    ],
                    forDocument: updRef
                )
                .deleteDocument(delRef)
            _ = try txn.setData(from: TxnItemRecord(title: "CreatedFromMissingRead", qty: 3), forDocument: missingReadRef)
            return "committed"
        }
        #expect(summary as? String == "committed")

        let overAfter = try await overRef.getDocument(source: .server)
        #expect(overAfter.data()?["old"] == nil)
        #expect(overAfter.data()?["fresh"] as? Bool == true)

        let mergeAfter = try await mergeRef.getDocument(source: .server)
        #expect(mergeAfter.data()?["keep"] as? String == "yes")
        #expect(mergeAfter.get("nested.x") as? Int64 == 1)
        #expect(mergeAfter.get("nested.y") as? Int64 == 22)
        #expect(mergeAfter.get("nested.z") as? Int64 == 33)

        let maskAfter = try await maskRef.getDocument(source: .server)
        #expect(maskAfter.data()?["untouched"] as? String == "stay")
        #expect(maskAfter.get("profile.role") as? String == "owner")
        #expect(maskAfter.get("profile.dept") as? String == "eng")
        #expect(maskAfter.get(FieldPath(["meta.v1", "tier"])) as? String == "enterprise")
        #expect(maskAfter.get(FieldPath(["meta.v1", "quota"])) as? Int64 == 5)

        let updAfter = try await updRef.getDocument(source: .server)
        #expect(updAfter.data()?["balance"] as? Int64 == 150)
        #expect(updAfter.data()?["dropMe"] == nil)
        #expect(updAfter.get(FieldPath(["meta.v1", "limit"])) as? Int64 == 99)
        #expect(updAfter.get(FieldPath(["meta.v1", "active"])) as? Bool == true)

        #expect(try await delRef.getDocument(source: .server).exists == false)
        let createdModel = try await missingReadRef.getDocument(source: .server).data(as: TxnItemRecord.self)
        #expect(createdModel == TxnItemRecord(title: "CreatedFromMissingRead", qty: 3))

        // Row 85: Read-after-write inside transaction is rejected with .invalidArgument and rolls back.
        await expectTxnBridgeCode(.invalidArgument) {
            _ = try await db1.runTransaction { txn in
                txn.setData(["invalidOrder": true], forDocument: overRef)
                _ = try await txn.getDocument(mergeRef)
                return nil
            }
        }
        #expect(try await overRef.getDocument(source: .server).data()?["invalidOrder"] == nil)

        // Row 89: Transaction.updateData on non-existent document fails immediately with .notFound (no retry loop).
        let missingUpdAttempts = TxnAttemptCounter()
        await expectTxnBridgeCode(.notFound) {
            _ = try await db1.runTransaction { txn in
                missingUpdAttempts.increment()
                txn.updateData(["v": 1], forDocument: items1.document("tx-never-existed"))
                return nil
            }
        }
        #expect(missingUpdAttempts.value == 1)

        // Row 85 & 91: Intra-attempt pinned snapshot isolation across two reads + TransactionOptions.maxAttempts.
        let acctA1 = items1.document("acct-a")
        let acctB1 = items1.document("acct-b")
        let acctB2 = items2.document("acct-b")
        try await acctA1.setData(["amount": 100])
        try await acctB1.setData(["amount": 200])

        let isoAttempts = TxnAttemptCounter()
        let totalTransferred = try await db1.runTransaction(options: TransactionOptions(maxAttempts: 3)) { txn -> Any? in
            let attempt = isoAttempts.increment()
            let snapA = try await txn.getDocument(acctA1)
            if attempt <= 2 {
                // Mutate acct-b via peer app2 AFTER attempt pinned its snapshot on acct-a read!
                // Intra-attempt txnId snapshot isolation still sees the pre-mutation acct-b value,
                // and txnCommit detects the read-set conflict on acct-b and retries cleanly.
                try await acctB2.setData(["amount": Int64(200 + attempt * 10)])
            }
            let snapB = try await txn.getDocument(acctB1)
            let aVal = (snapA.data()?["amount"] as? Int64) ?? 0
            let bVal = (snapB.data()?["amount"] as? Int64) ?? 0
            if attempt == 1 {
                #expect(bVal == 200)
            }
            txn.updateData(["amount": aVal - 25], forDocument: acctA1)
            txn.updateData(["amount": bVal + 25], forDocument: acctB1)
            return (aVal - 25) + (bVal + 25)
        }
        #expect(isoAttempts.value == 3)
        #expect(totalTransferred as? Int64 == 320)
        #expect(try await acctA1.getDocument(source: .server).data()?["amount"] as? Int64 == 75)
        #expect(try await acctB1.getDocument(source: .server).data()?["amount"] as? Int64 == 245)

        // Row 91: Exhausting maxAttempts: 2 throws .aborted after exactly 2 attempts; maxAttempts < 1 throws .invalidArgument.
        let exhaustedAttempts = TxnAttemptCounter()
        let opts = TransactionOptions(maxAttempts: 2)
        #expect(opts.maxAttempts == 2)
        await expectTxnBridgeCode(.aborted) {
            _ = try await db1.runTransaction(options: opts) { txn in
                let n = exhaustedAttempts.increment()
                _ = try await txn.getDocument(acctA1)
                try await items2.document("acct-a").setData(["amount": Int64(500 + n)])
                txn.updateData(["amount": 0], forDocument: acctA1)
                return nil
            }
        }
        #expect(exhaustedAttempts.value == 2)

        await expectTxnBridgeCode(.invalidArgument) {
            _ = try await db1.runTransaction(options: TransactionOptions(maxAttempts: 0)) { _ in nil }
        }

        await app1.disconnectSharedBridge()
        await app2.disconnectSharedBridge()
    }

    @Test("firestore-swift#101..#102: DocumentReference.snapshots and Query.snapshots AsyncSequences stream updates, metadata transitions, cancellation, and rule errors over live host")
    func asyncSequencesSnapshotsLiveHostConformance() async throws {
        guard let (host, port) = try liveTransactionsEndpoint() else {
            return
        }

        let app1 = makeTransactionsLiveApp(prefix: "fs-seq1", host: host, port: port)
        let app2 = makeTransactionsLiveApp(prefix: "fs-seq2", host: host, port: port)
        defer {
            Task {
                await app1.disconnectSharedBridge()
                await app2.disconnectSharedBridge()
            }
        }

        let tag = UUID().uuidString.lowercased()
        let email = "fs-seq-\(tag)@example.test"
        let password = "CorrectHorse!101"
        let created = try await Auth.auth(app: app1).createUser(withEmail: email, password: password)
        _ = try await Auth.auth(app: app2).signIn(withEmail: email, password: password)
        let uid = created.user.uid

        let db1 = Firestore.firestore(app: app1)
        let db2 = Firestore.firestore(app: app2)

        // 1. Row 101: DocumentReference.snapshots & snapshots(includeMetadataChanges: true).
        let doc1 = db1.document("users/\(uid)/items/stream-doc")
        let doc2 = db2.document("users/\(uid)/items/stream-doc")
        let docSignal = StreamStepSignal()

        let docConsumer = Task<[String], Error> {
            var states: [String] = []
            for try await snap in doc1.snapshots(includeMetadataChanges: true) {
                if !snap.exists {
                    states.append("missing")
                    docSignal.mark(1)
                } else if let phase = snap.data()?["phase"] as? String {
                    let badge = "\(phase):pending=\(snap.metadata.hasPendingWrites)"
                    states.append(badge)
                    if phase == "v1" && !snap.metadata.hasPendingWrites {
                        docSignal.mark(2)
                    }
                    if phase == "v2" && !snap.metadata.hasPendingWrites {
                        break
                    }
                }
            }
            return states
        }

        await docSignal.wait(for: 1)
        try await doc1.setData(["phase": "v1"])
        await docSignal.wait(for: 2)
        try await doc2.updateData(["phase": "v2"])

        let docStates = try await docConsumer.value
        #expect(docStates.first == "missing")
        #expect(docStates.contains("v1:pending=true"))
        #expect(docStates.contains("v1:pending=false"))
        #expect(docStates.last == "v2:pending=false")

        // Unauthorized DocumentReference.snapshots throws .permissionDenied.
        await expectTxnBridgeCode(.permissionDenied) {
            for try await _ in db1.document("users/other-\(tag)/items/forbidden").snapshots {
                Issue.record("Expected permissionDenied before yielding unauthorized DocumentSnapshot")
            }
        }

        // 2. Row 102: Query.snapshots & snapshots(includeMetadataChanges: true) + Task cancellation cleanup.
        let coll1 = db1.collection("users/\(uid)/rooms/stream-room/entries")
        let coll2 = db2.collection("users/\(uid)/rooms/stream-room/entries")
        try await coll1.document("e1").setData(["ownerUid": uid, "rank": 10])

        let querySignal = StreamStepSignal()
        let queryConsumer = Task<[[String]], Error> {
            var idFrames: [[String]] = []
            for try await qSnap in coll1.order(by: "rank").snapshots {
                idFrames.append(qSnap.documents.map(\.documentID))
                querySignal.mark(idFrames.count)
                if idFrames.count == 3 {
                    break
                }
            }
            return idFrames
        }

        await querySignal.wait(for: 1)
        try await coll2.document("e2").setData(["ownerUid": uid, "rank": 5])
        await querySignal.wait(for: 2)
        try await coll2.document("e1").delete()

        let frames = try await queryConsumer.value
        #expect(frames == [["e1"], ["e2", "e1"], ["e2"]])

        // Explicit Task.cancel() terminates active Query.snapshots stream without hanging.
        let cancelSignal = StreamStepSignal()
        let cancellableTask = Task<Int, Error> {
            var count = 0
            for try await _ in coll1.snapshots(includeMetadataChanges: true) {
                count += 1
                cancelSignal.mark(1)
            }
            return count
        }
        await cancelSignal.wait(for: 1)
        cancellableTask.cancel()
        _ = try? await cancellableTask.value

        // Unauthorized Query.snapshots throws .permissionDenied.
        await expectTxnBridgeCode(.permissionDenied) {
            for try await _ in db1.collection("users/other-\(tag)/items").snapshots {
                Issue.record("Expected permissionDenied before yielding unauthorized QuerySnapshot")
            }
        }

        await app1.disconnectSharedBridge()
        await app2.disconnectSharedBridge()
    }
}
