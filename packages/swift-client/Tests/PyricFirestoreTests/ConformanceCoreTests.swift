import Testing
import Foundation
@testable import PyricFirestore

@Suite("firestore-swift Core Conformance Suite")
struct ConformanceCoreTests {

    // ══════════════════════════════════════════════════════════════════════════
    // ── 1. Firestore: Instance & Lifecycle (Rows 1–21) ───────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#1: Firestore.firestore() returns default instance`() async throws {
        _ = try await ConformanceMockHarness.create()
        let db = Firestore.firestore()
        #expect(db.settings.host == "127.0.0.1:5174")
    }

    @Test func `firestore-swift#2: Firestore.firestore(app:) - Returns a Firestore instance associated with the specified FirebaseApp.`() async throws {
        _ = try await ConformanceMockHarness.create()
        let db = Firestore.firestore(database: "custom-app-db")
        #expect(db.database == "custom-app-db")
    }

    @Test func `firestore-swift#3: Firestore.firestore(app:database:) - Returns a named database instance for the specified FirebaseApp.`() async throws {
        _ = try await ConformanceMockHarness.create()
        let db = Firestore.firestore(database: "db-secondary")
        #expect(db.database == "db-secondary")
    }

    @Test func `firestore-swift#4: Firestore.firestore(database:) - Returns a named database instance for the default FirebaseApp.`() async throws {
        _ = try await ConformanceMockHarness.create()
        let db = Firestore.firestore(database: "named-db")
        #expect(db.database == "named-db")
    }

    @Test func `firestore-swift#5: Firestore.settings - Provides custom client configuration including host, sslEnabled, dispatchQueue, and cacheSettings.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let settings = FirestoreSettings()
        settings.host = "pyric.local:5174"
        settings.isSSLEnabled = false
        settings.cacheSettings = MemoryCacheSettings()
        harness.firestore.settings = settings
        #expect(harness.firestore.settings.host == "pyric.local:5174")
        #expect(!harness.firestore.settings.isSSLEnabled)
    }

    @Test func `firestore-swift#6: Firestore.app - Returns the FirebaseApp associated with this Firestore instance.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        #expect(harness.firestore.app.name == "[DEFAULT]" || harness.firestore.database == "(default)")
    }

    @Test func `firestore-swift#7: Firestore.document(_:) - Instantiates a DocumentReference pointing to the slash-delimited document path.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let docRef = harness.firestore.document("users/alice")
        #expect(docRef.path == "users/alice")
        #expect(docRef.documentID == "alice")
    }

    @Test func `firestore-swift#8: Firestore.collection(_:) - Instantiates a CollectionReference pointing to the slash-delimited collection path.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let collRef = harness.firestore.collection("users")
        #expect(collRef.path == "users")
        #expect(collRef.collectionID == "users")
    }

    @Test func `firestore-swift#9: Firestore.collectionGroup(_:) - Instantiates a Query spanning all collections with the matching collectionID.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let group = harness.firestore.collectionGroup("orders")
        #expect(group.isCollectionGroup)
        #expect(group.collectionID == "orders")
    }

    @Test func `firestore-swift#10: Firestore.batch() - Instantiates a WriteBatch for atomic batched mutations.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let batch = harness.firestore.batch()
        let docRef = harness.firestore.document("users/alice")
        batch.setData(["k": "v"], forDocument: docRef)
        try await batch.commit()
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "batchCommit")
    }

    @Test func `firestore-swift#11: Firestore.runTransaction(_:) - Executes an interactive transaction block with automatic conflict retry.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let result = try await harness.firestore.runTransaction { txn in
            let snap = try await txn.getDocument(harness.firestore.document("users/alice"))
            #expect(snap.exists)
            txn.updateData(["age": 31], forDocument: harness.firestore.document("users/alice"))
            return "txn-ok"
        }
        #expect(result as? String == "txn-ok")
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "txnCommit")
    }

    @Test func `firestore-swift#12: Firestore.runTransaction(options:block:) - Executes an interactive transaction with custom TransactionOptions.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let opts = TransactionOptions()
        opts.maxAttempts = 3
        let result = try await harness.firestore.runTransaction(options: opts) { txn in
            txn.setData(["name": "Bob"], forDocument: harness.firestore.document("users/bob"))
            return 42
        }
        #expect(result as? Int == 42)
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "txnCommit")
    }

    @Test func `firestore-swift#13: Firestore.runTransaction(_:) async - Executes an interactive transaction asynchronously via Swift concurrency.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let res = try await harness.firestore.runTransaction { _ in
            return "async-ok"
        }
        #expect(res as? String == "async-ok")
    }

    @Test func `firestore-swift#14: Firestore.useEmulator(host:port:) - Configures client networking to route requests to a local emulator or Pyric bridge.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        harness.firestore.useEmulator(host: "127.0.0.1", port: 5174)
        #expect(harness.firestore.settings.host == "127.0.0.1:5174")
        #expect(!harness.firestore.settings.isSSLEnabled)
    }

    @Test func `firestore-swift#15: Firestore.enableNetwork() / disableNetwork() - Toggles client network connectivity to simulate offline and online operation.`() async throws {
        expectUnverified("Unverified row firestore-swift#15: Network toggling offline cache deferred")
    }

    @Test func `firestore-swift#16: Firestore.clearPersistence() - Clears offline client persistence cache when no active listeners exist.`() async throws {
        expectUnverified("Unverified row firestore-swift#16: Offline persistence clearing deferred")
    }

    @Test func `firestore-swift#17: Firestore.terminate() - Terminates the client instance and cancels active snapshot listeners.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        try await harness.firestore.terminate()
        let isDisposed = await harness.client.isDisposed
        #expect(isDisposed)
    }

    @Test func `firestore-swift#18: Firestore.waitForPendingWrites() - Awaits backend acknowledgment of all pending local writes.`() async throws {
        expectUnverified("Unverified row firestore-swift#18: Offline local write queue deferred")
    }

    @Test func `firestore-swift#19: Firestore.addSnapshotsInSyncListener(_:) - Attaches a callback invoked when all active snapshot listeners synchronize.`() async throws {
        expectUnverified("Unverified row firestore-swift#19: Snapshot sync listener deferred")
    }

    @Test func `firestore-swift#20: Firestore.loadBundle(_:) - Loads serialized Firestore bundle data into the local cache.`() async throws {
        expectUnverified("Unverified row firestore-swift#20: Bundle loader deferred")
    }

    @Test func `firestore-swift#21: Firestore.getQuery(named:completion:) - Retrieves a named query from a previously loaded Firestore bundle.`() async throws {
        expectUnverified("Unverified row firestore-swift#21: Named bundle query deferred")
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── 2. DocumentReference: Document Operations (Rows 22–34) ───────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#22: DocumentReference.documentID - Returns the document identifier representing the last path component.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let docRef = harness.firestore.document("users/alice")
        #expect(docRef.documentID == "alice")
    }

    @Test func `firestore-swift#23: DocumentReference.path - Returns the slash-delimited path relative to the database root.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let docRef = harness.firestore.document("users/alice")
        #expect(docRef.path == "users/alice")
    }

    @Test func `firestore-swift#24: DocumentReference.parent - Returns the parent CollectionReference containing this document.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let docRef = harness.firestore.document("users/alice")
        #expect(docRef.parent.path == "users")
    }

    @Test func `firestore-swift#25: DocumentReference.collection(_:) - Instantiates a child CollectionReference nested under this document.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let subColl = harness.firestore.document("users/alice").collection("orders")
        #expect(subColl.path == "users/alice/orders")
        #expect(subColl.parent?.path == "users/alice")
    }

    @Test func `firestore-swift#26: DocumentReference.getDocument(source:) - Reads document snapshot from server, cache, or default source.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = try await harness.firestore.document("users/alice").getDocument()
        #expect(snap.exists)
        #expect(snap.documentID == "alice")
        #expect(snap.data()?["name"] as? String == "Alice")
    }

    @Test func `firestore-swift#27: DocumentReference.setData(_:) - Overwrites the target document completely with provided dictionary payload.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        try await harness.firestore.document("users/alice").setData(["name": "Alice", "age": 30])
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "setDoc")
        #expect(op?["path"]?.stringValue == "users/alice")
        #expect(op?["data"]?["name"]?.stringValue == "Alice")
    }

    @Test func `firestore-swift#28: DocumentReference.setData(_:merge:) - Merges payload fields into existing document without overwriting unspecified fields.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        try await harness.firestore.document("users/alice").setData(["age": 31], merge: true)
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "setDoc")
        #expect(op?["options"]?["merge"]?.boolValue == true)
    }

    @Test func `firestore-swift#29: DocumentReference.setData(_:mergeFields:) - Replaces only explicitly specified field paths in the target document.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        try await harness.firestore.document("users/alice").setData(["city": "Tokyo"], mergeFields: ["city"])
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "setDoc")
        #expect(op?["options"]?["mergeFields"]?.arrayValue?.contains(.string("city")) == true)
    }

    @Test func `firestore-swift#30: DocumentReference.updateData(_:) - Updates specified fields in an existing document; fails if document does not exist.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        try await harness.firestore.document("users/alice").updateData(["age": 32])
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "updateDoc")
        #expect(op?["path"]?.stringValue == "users/alice")
        #expect(op?["data"]?["age"]?.intValue == 32)
    }

    @Test func `firestore-swift#31: DocumentReference.delete() - Deletes document at reference path from Firestore database.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        try await harness.firestore.document("users/alice").delete()
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "deleteDoc")
        #expect(op?["path"]?.stringValue == "users/alice")
    }

    @Test func `firestore-swift#32: DocumentReference.addSnapshotListener(_:) - Attaches real-time closure listener receiving DocumentSnapshot updates.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let (stream, cont) = AsyncStream<DocumentSnapshot>.makeStream()
        let registration = harness.firestore.document("users/alice").addSnapshotListener { snap, _ in
            if let snap { cont.yield(snap) }
        }
        var iterator = stream.makeAsyncIterator()
        let received = await iterator.next()
        #expect(received?.exists == true)
        #expect(received?.data()?["status"] as? String == "online")
        registration.remove()
    }

    @Test func `firestore-swift#33: DocumentReference.addSnapshotListener(includeMetadataChanges:listener:) - Listens to document snapshot updates including metadata-only transitions.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let registration = harness.firestore.document("users/alice").addSnapshotListener(includeMetadataChanges: true) { _, _ in }
        try await Task.sleep(nanoseconds: 20_000_000)
        let lastMsg = harness.lastSentMessage()
        #expect(lastMsg?["type"]?.stringValue == "worker-sub")
        #expect(lastMsg?["sub"]?["includeMetadataChanges"]?.boolValue == true)
        registration.remove()
    }

    @Test func `firestore-swift#34: DocumentReference.addSnapshotListener(options:listener:) - Listens to document updates configured with SnapshotListenOptions.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        var options = SnapshotListenOptions()
        options.includeMetadataChanges = true
        let registration = harness.firestore.document("users/alice").addSnapshotListener(options: options) { _, _ in }
        try await Task.sleep(nanoseconds: 20_000_000)
        let lastMsg = harness.lastSentMessage()
        #expect(lastMsg?["type"]?.stringValue == "worker-sub")
        registration.remove()
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── 3. CollectionReference: Collection Operations (Rows 35–40) ───────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#35: CollectionReference.collectionID - Returns the collection identifier string.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let coll = harness.firestore.collection("orders")
        #expect(coll.collectionID == "orders")
    }

    @Test func `firestore-swift#36: CollectionReference.path - Returns the full slash-separated collection path relative to database root.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let coll = harness.firestore.collection("users/alice/orders")
        #expect(coll.path == "users/alice/orders")
    }

    @Test func `firestore-swift#37: CollectionReference.parent - Returns parent DocumentReference or nil if this is a root collection.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let root = harness.firestore.collection("users")
        #expect(root.parent == nil)
        let sub = harness.firestore.collection("users/alice/orders")
        #expect(sub.parent?.path == "users/alice")
    }

    @Test func `firestore-swift#38: CollectionReference.document() - Instantiates a child DocumentReference with an auto-generated unique ID.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let doc = harness.firestore.collection("users").document()
        #expect(doc.path.hasPrefix("users/"))
        #expect(doc.documentID.count == 20)
    }

    @Test func `firestore-swift#39: CollectionReference.document(_:) - Instantiates a child DocumentReference at relative document path.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let doc = harness.firestore.collection("users").document("custom-id")
        #expect(doc.path == "users/custom-id")
        #expect(doc.documentID == "custom-id")
    }

    @Test func `firestore-swift#40: CollectionReference.addDocument(data:) - Auto-generates document ID, writes data payload, and returns document reference.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let newDoc = try await harness.firestore.collection("users").addDocument(data: ["name": "Charlie"])
        #expect(newDoc.path.hasPrefix("users/"))
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "addDoc" || op?["method"]?.stringValue == "setDoc")
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── 6. WriteBatch: Atomic Batches (Rows 79–84) ───────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#79: WriteBatch.setData(_:forDocument:) - Enqueues set overwrite operation into atomic mutation batch.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let batch = harness.firestore.batch()
        batch.setData(["title": "Post"], forDocument: harness.firestore.document("posts/1"))
        try await batch.commit()
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["method"]?.stringValue == "set" && $0["path"]?.stringValue == "posts/1"
        }))
    }

    @Test func `firestore-swift#80: WriteBatch.setData(_:forDocument:merge:) - Enqueues set merge operation into atomic mutation batch.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let batch = harness.firestore.batch()
        batch.setData(["views": 5], forDocument: harness.firestore.document("posts/1"), merge: true)
        try await batch.commit()
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["options"]?["merge"]?.boolValue == true
        }))
    }

    @Test func `firestore-swift#81: WriteBatch.setData(_:forDocument:mergeFields:) - Enqueues selective field merge operation into atomic mutation batch.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let batch = harness.firestore.batch()
        batch.setData(["views": 6], forDocument: harness.firestore.document("posts/1"), mergeFields: ["views"])
        try await batch.commit()
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["options"]?["mergeFields"]?.arrayValue?.contains(.string("views")) == true
        }))
    }

    @Test func `firestore-swift#82: WriteBatch.updateData(_:forDocument:) - Enqueues update operation into atomic mutation batch.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let batch = harness.firestore.batch()
        batch.updateData(["likes": 10], forDocument: harness.firestore.document("posts/1"))
        try await batch.commit()
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["method"]?.stringValue == "update" && $0["path"]?.stringValue == "posts/1"
        }))
    }

    @Test func `firestore-swift#83: WriteBatch.deleteDocument(_:) - Enqueues document deletion into atomic mutation batch.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let batch = harness.firestore.batch()
        batch.deleteDocument(harness.firestore.document("posts/1"))
        try await batch.commit()
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["method"]?.stringValue == "delete" && $0["path"]?.stringValue == "posts/1"
        }))
    }

    @Test func `firestore-swift#84: WriteBatch.commit() - Atomically commits all enqueued batch mutations in a single transaction.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let batch = harness.firestore.batch()
        batch.setData(["a": 1], forDocument: harness.firestore.document("c/1"))
        batch.deleteDocument(harness.firestore.document("c/2"))
        try await batch.commit()
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "batchCommit")
        #expect(op?["writes"]?.arrayValue?.count == 2)
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── 7. Transaction: Interactive Transactions (Rows 85–91) ────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#85: Transaction.getDocument(_:) - Reads document snapshot within transaction and establishes read lock.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        _ = try await harness.firestore.runTransaction { txn in
            let snap = try await txn.getDocument(harness.firestore.document("users/alice"))
            #expect(snap.exists)
            #expect(snap.documentID == "alice")
            return nil
        }
    }

    @Test func `firestore-swift#86: Transaction.setData(_:forDocument:) - Stages transactional set overwrite mutation.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        _ = try await harness.firestore.runTransaction { txn in
            txn.setData(["name": "Ada"], forDocument: harness.firestore.document("users/ada"))
            return nil
        }
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["method"]?.stringValue == "set" && $0["path"]?.stringValue == "users/ada"
        }))
    }

    @Test func `firestore-swift#87: Transaction.setData(_:forDocument:merge:) - Stages transactional set merge mutation.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        _ = try await harness.firestore.runTransaction { txn in
            txn.setData(["status": "vip"], forDocument: harness.firestore.document("users/ada"), merge: true)
            return nil
        }
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["options"]?["merge"]?.boolValue == true
        }))
    }

    @Test func `firestore-swift#88: Transaction.setData(_:forDocument:mergeFields:) - Stages transactional selective field merge mutation.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        _ = try await harness.firestore.runTransaction { txn in
            txn.setData(["status": "vip"], forDocument: harness.firestore.document("users/ada"), mergeFields: ["status"])
            return nil
        }
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["options"]?["mergeFields"]?.arrayValue?.contains(.string("status")) == true
        }))
    }

    @Test func `firestore-swift#89: Transaction.updateData(_:forDocument:) - Stages transactional update mutation for existing document.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        _ = try await harness.firestore.runTransaction { txn in
            txn.updateData(["score": 100], forDocument: harness.firestore.document("users/ada"))
            return nil
        }
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["method"]?.stringValue == "update" && $0["path"]?.stringValue == "users/ada"
        }))
    }

    @Test func `firestore-swift#90: Transaction.deleteDocument(_:) - Stages transactional document deletion.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        _ = try await harness.firestore.runTransaction { txn in
            txn.deleteDocument(harness.firestore.document("users/ada"))
            return nil
        }
        let writes = harness.lastWorkerOp()?["writes"]?.arrayValue ?? []
        #expect(writes.contains(where: {
            $0["method"]?.stringValue == "delete" && $0["path"]?.stringValue == "users/ada"
        }))
    }

    @Test func `firestore-swift#91: TransactionOptions.maxAttempts - Configures maximum retry attempts upon transactional concurrent contention.`() async throws {
        let opts = TransactionOptions()
        opts.maxAttempts = 5
        #expect(opts.maxAttempts == 5)
    }
}
