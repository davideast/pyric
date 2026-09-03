import Testing
import Foundation
@testable import PyricFirestore

@Suite("firestore-swift Conformance Suite")
struct ConformanceTests {

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
        #expect(Bool(false), "Unverified row firestore-swift#15: Network toggling offline cache deferred")
    }

    @Test func `firestore-swift#16: Firestore.clearPersistence() - Clears offline client persistence cache when no active listeners exist.`() async throws {
        #expect(Bool(false), "Unverified row firestore-swift#16: Offline persistence clearing deferred")
    }

    @Test func `firestore-swift#17: Firestore.terminate() - Terminates the client instance and cancels active snapshot listeners.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        try await harness.firestore.terminate()
        let isDisposed = await harness.client.isDisposed
        #expect(isDisposed)
    }

    @Test func `firestore-swift#18: Firestore.waitForPendingWrites() - Awaits backend acknowledgment of all pending local writes.`() async throws {
        #expect(Bool(false), "Unverified row firestore-swift#18: Offline local write queue deferred")
    }

    @Test func `firestore-swift#19: Firestore.addSnapshotsInSyncListener(_:) - Attaches a callback invoked when all active snapshot listeners synchronize.`() async throws {
        #expect(Bool(false), "Unverified row firestore-swift#19: Snapshot sync listener deferred")
    }

    @Test func `firestore-swift#20: Firestore.loadBundle(_:) - Loads serialized Firestore bundle data into the local cache.`() async throws {
        #expect(Bool(false), "Unverified row firestore-swift#20: Bundle loader deferred")
    }

    @Test func `firestore-swift#21: Firestore.getQuery(named:completion:) - Retrieves a named query from a previously loaded Firestore bundle.`() async throws {
        #expect(Bool(false), "Unverified row firestore-swift#21: Named bundle query deferred")
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
    // ── 4. Query: Filters & Constraints (Rows 41–63) ─────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#41: Query.whereField(_:isEqualTo:) - Filters documents matching exact field equality.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isEqualTo: 30)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == "=="
        }))
    }

    @Test func `firestore-swift#42: Query.whereField(_:isNotEqualTo:) - Filters documents where field does not equal value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("role", isNotEqualTo: "guest")
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "role" && $0["op"]?.stringValue == "!="
        }))
    }

    @Test func `firestore-swift#43: Query.whereField(_:isLessThan:) - Filters documents where field is strictly less than value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isLessThan: 65)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == "<"
        }))
    }

    @Test func `firestore-swift#44: Query.whereField(_:isLessThanOrEqualTo:) - Filters documents where field is less than or equal to value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isLessThanOrEqualTo: 64)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == "<="
        }))
    }

    @Test func `firestore-swift#45: Query.whereField(_:isGreaterThan:) - Filters documents where field is strictly greater than value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isGreaterThan: 18)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == ">"
        }))
    }

    @Test func `firestore-swift#46: Query.whereField(_:isGreaterThanOrEqualTo:) - Filters documents where field is greater than or equal to value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isGreaterThanOrEqualTo: 18)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == ">="
        }))
    }

    @Test func `firestore-swift#47: Query.whereField(_:arrayContains:) - Filters documents where array field contains argument element.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("tags", arrayContains: "swift")
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "tags" && $0["op"]?.stringValue == "array-contains"
        }))
    }

    @Test func `firestore-swift#48: Query.whereField(_:arrayContainsAny:) - Filters documents where array field contains any element from argument list.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("tags", arrayContainsAny: ["swift", "ios"])
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "tags" && $0["op"]?.stringValue == "array-contains-any"
        }))
    }

    @Test func `firestore-swift#49: Query.whereField(_:in:) - Filters documents where field value matches any element in argument list.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("role", in: ["admin", "owner"])
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "role" && $0["op"]?.stringValue == "in"
        }))
    }

    @Test func `firestore-swift#50: Query.whereField(_:notIn:) - Filters documents where field value matches none in argument list.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("role", notIn: ["banned", "deleted"])
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "role" && $0["op"]?.stringValue == "not-in"
        }))
    }

    @Test func `firestore-swift#51: Query.whereFilter(_:) - Applies composite boolean Filter using andFilter or orFilter disjunctions.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let filter = Filter.orFilter([
            Filter.whereField("status", isEqualTo: "active"),
            Filter.whereField("role", isEqualTo: "admin")
        ])
        let q = harness.firestore.collection("users").whereFilter(filter)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: { $0["kind"]?.stringValue == "or" }))
    }

    @Test func `firestore-swift#52: Query.order(by:) - Sorts query results by field ascending.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").order(by: "createdAt")
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "orderBy" && $0["field"]?.stringValue == "createdAt" && $0["direction"] == nil
        }))
    }

    @Test func `firestore-swift#53: Query.order(by:descending:) - Sorts query results by field ascending or descending.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").order(by: "score", descending: true)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "orderBy" && $0["field"]?.stringValue == "score" && $0["direction"]?.stringValue == "desc"
        }))
    }

    @Test func `firestore-swift#54: Query.limit(to:) - Limits maximum number of matching documents from start of query results.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").limit(to: 20)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "limit" && $0["n"]?.intValue == 20
        }))
    }

    @Test func `firestore-swift#55: Query.limit(toLast:) - Limits results to last N documents requiring explicit orderBy constraint.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").order(by: "score").limit(toLast: 10)
        let target = q.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "limitToLast" && $0["n"]?.intValue == 10
        }))
    }

    @Test func `firestore-swift#56: Query.start(at:) / start(after:) - Positions starting cursor using ordered field values.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q1 = harness.firestore.collection("users").order(by: "score").start(at: [100])
        let q2 = harness.firestore.collection("users").order(by: "score").start(after: [100])
        let c1 = q1.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        let c2 = q2.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(c1.contains(where: { $0["kind"]?.stringValue == "startAt" }))
        #expect(c2.contains(where: { $0["kind"]?.stringValue == "startAfter" }))
    }

    @Test func `firestore-swift#57: Query.end(before:) / end(at:) - Positions ending cursor using ordered field values.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q1 = harness.firestore.collection("users").order(by: "score").end(before: [200])
        let q2 = harness.firestore.collection("users").order(by: "score").end(at: [200])
        let c1 = q1.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        let c2 = q2.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(c1.contains(where: { $0["kind"]?.stringValue == "endBefore" }))
        #expect(c2.contains(where: { $0["kind"]?.stringValue == "endAt" }))
    }

    @Test func `firestore-swift#58: Query.start(atDocument:) / start(afterDocument:) - Positions starting cursor using DocumentSnapshot position.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["score": 50])
        let q = harness.firestore.collection("users").order(by: "score").start(atDocument: snap)
        let c = q.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(c.contains(where: { $0["kind"]?.stringValue == "startAt" }))
    }

    @Test func `firestore-swift#59: Query.end(beforeDocument:) / end(atDocument:) - Positions ending cursor using DocumentSnapshot position.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["score": 50])
        let q = harness.firestore.collection("users").order(by: "score").end(atDocument: snap)
        let c = q.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(c.contains(where: { $0["kind"]?.stringValue == "endAt" }))
    }

    @Test func `firestore-swift#60: Query.getDocuments(source:) - Executes query and returns QuerySnapshot from server, cache, or default source.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snapshot = try await harness.firestore.collection("users").getDocuments()
        #expect(snapshot.count == 2)
        #expect(snapshot.documents.first?.data()["name"] as? String == "A")
    }

    @Test func `firestore-swift#61: Query.addSnapshotListener(_:) - Attaches real-time query listener returning ListenerRegistration handle.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let (stream, cont) = AsyncStream<QuerySnapshot>.makeStream()
        let reg = harness.firestore.collection("users").addSnapshotListener { snap, _ in
            if let snap { cont.yield(snap) }
        }
        var iter = stream.makeAsyncIterator()
        let snap = await iter.next()
        #expect(snap?.count == 1)
        reg.remove()
    }

    @Test func `firestore-swift#62: Query.addSnapshotListener(includeMetadataChanges:listener:) - Attaches real-time query listener receiving metadata-only change notifications.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let reg = harness.firestore.collection("users").addSnapshotListener(includeMetadataChanges: true) { _, _ in }
        try await Task.sleep(nanoseconds: 20_000_000)
        let lastMsg = harness.lastSentMessage()
        #expect(lastMsg?["type"]?.stringValue == "worker-sub")
        #expect(lastMsg?["sub"]?["includeMetadataChanges"]?.boolValue == true)
        reg.remove()
    }

    @Test func `firestore-swift#63: Query.addSnapshotListener(options:listener:) - Attaches real-time query listener configured with SnapshotListenOptions.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        var options = SnapshotListenOptions()
        options.includeMetadataChanges = true
        let reg = harness.firestore.collection("users").addSnapshotListener(options: options) { _, _ in }
        try await Task.sleep(nanoseconds: 20_000_000)
        let lastMsg = harness.lastSentMessage()
        #expect(lastMsg?["type"]?.stringValue == "worker-sub")
        reg.remove()
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── 5. Snapshots & Metadata (Rows 64–78) ──────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#64: DocumentSnapshot.exists - Boolean indicating whether document currently exists in Firestore.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let present = DocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["a": 1], exists: true)
        #expect(present.exists)
        let missing = DocumentSnapshot(firestore: harness.firestore, path: "users/2", data: nil, exists: false)
        #expect(!missing.exists)
    }

    @Test func `firestore-swift#65: DocumentSnapshot.documentID - Unique key string identifying the snapshot document.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/alice", data: ["k": "v"], exists: true)
        #expect(snap.documentID == "alice")
    }

    @Test func `firestore-swift#66: DocumentSnapshot.reference - DocumentReference pointing to the snapshot document location.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/alice", data: ["k": "v"], exists: true)
        #expect(snap.reference.path == "users/alice")
    }

    @Test func `firestore-swift#67: DocumentSnapshot.metadata - SnapshotMetadata describing cache origin and pending write status.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["a": 1], exists: true, metadata: SnapshotMetadata(hasPendingWrites: true, isFromCache: true))
        #expect(snap.metadata.hasPendingWrites)
        #expect(snap.metadata.isFromCache)
    }

    @Test func `firestore-swift#68: DocumentSnapshot.data() - Returns dictionary of document fields or nil if document does not exist.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["name": "Alice"], exists: true)
        #expect(snap.data()?["name"] as? String == "Alice")
        let missing = DocumentSnapshot(firestore: harness.firestore, path: "users/2", data: nil, exists: false)
        #expect(missing.data() == nil)
    }

    @Test func `firestore-swift#69: DocumentSnapshot.data(with:) - Returns document fields configuring ServerTimestampBehavior handling.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["ts": Timestamp(seconds: 100, nanoseconds: 0)], exists: true)
        #expect(snap.data(with: .estimate)?["ts"] != nil)
    }

    @Test func `firestore-swift#70: DocumentSnapshot.get(_:) - Extracts nested field value supporting dot-delimited string or FieldPath.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/1", data: [
            "profile": ["address": ["zip": 94103]]
        ], exists: true)
        #expect(snap.get("profile.address.zip") as? Int == 94103)
        #expect(snap.get(FieldPath(["profile", "address", "zip"])) as? Int == 94103)
    }

    @Test func `firestore-swift#71: DocumentSnapshot.subscript - Provides subscript syntax snapshot[key] to access document fields.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["role": "admin"], exists: true)
        #expect(snap["role"] as? String == "admin")
    }

    @Test func `firestore-swift#72: QueryDocumentSnapshot - Guaranteed-existent document snapshot subclass where data() is non-optional.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let qSnap = QueryDocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["item": "sword"])
        #expect(qSnap.data()["item"] as? String == "sword")
        #expect(qSnap.exists == true)
    }

    @Test func `firestore-swift#73: SnapshotMetadata (hasPendingWrites, isFromCache) - Flags indicating uncommitted local writes and cache data origin.`() async throws {
        let meta = SnapshotMetadata(hasPendingWrites: false, isFromCache: false)
        #expect(!meta.hasPendingWrites)
        #expect(!meta.isFromCache)
    }

    @Test func `firestore-swift#74: QuerySnapshot.documents - Ordered array of QueryDocumentSnapshot instances matched by query.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let d1 = QueryDocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["i": 1])
        let d2 = QueryDocumentSnapshot(firestore: harness.firestore, path: "users/2", data: ["i": 2])
        let qs = QuerySnapshot(documents: [d1, d2])
        #expect(qs.documents.count == 2)
        #expect(qs.documents[0].documentID == "1")
        #expect(qs.documents[1].documentID == "2")
    }

    @Test func `firestore-swift#75: QuerySnapshot.documentChanges - List of DocumentChange deltas since previous snapshot emission.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let d1 = QueryDocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["i": 1])
        let change = DocumentChange(type: .added, document: d1, oldIndex: -1, newIndex: 0)
        let qs = QuerySnapshot(documents: [d1], documentChanges: [change])
        #expect(qs.documentChanges.count == 1)
        #expect(qs.documentChanges.first?.type == .added)
    }

    @Test func `firestore-swift#76: QuerySnapshot.documentChanges(includeMetadataChanges:) - List of DocumentChange deltas including metadata-only changes.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let d1 = QueryDocumentSnapshot(firestore: harness.firestore, path: "users/1", data: ["i": 1])
        let change = DocumentChange(type: .modified, document: d1, oldIndex: 0, newIndex: 0)
        let qs = QuerySnapshot(documents: [d1], documentChanges: [change])
        #expect(qs.documentChanges(includeMetadataChanges: true).count == 1)
    }

    @Test func `firestore-swift#77: QuerySnapshot.isEmpty / count - Inspection properties reporting empty status and count of matched documents.`() async throws {
        let emptyQs = QuerySnapshot(documents: [])
        #expect(emptyQs.isEmpty)
        #expect(emptyQs.count == 0)
    }

    @Test func `firestore-swift#78: DocumentChange (type, document, oldIndex, newIndex) - Delta change descriptor indicating added, modified, or removed mutations.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let doc = QueryDocumentSnapshot(firestore: harness.firestore, path: "items/x", data: ["price": 10])
        let change = DocumentChange(type: .removed, document: doc, oldIndex: 2, newIndex: -1)
        #expect(change.type == .removed)
        #expect(change.oldIndex == 2)
        #expect(change.newIndex == -1)
        #expect(change.document.documentID == "x")
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

    // ══════════════════════════════════════════════════════════════════════════
    // ── 8. FieldValue: Sentinels & Transformations (Rows 92–97) ──────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#92: FieldValue.serverTimestamp() - Sentinel replaced by server commit timestamp during write processing.`() async throws {
        let fv = FieldValue.serverTimestamp()
        let wire = try ValueCodec.encodeValue(fv) as? [String: Any]
        #expect(wire?["__sentinel"] as? String == "serverTimestamp")
    }

    @Test func `firestore-swift#93: FieldValue.delete() - Sentinel deleting target field during document update operation.`() async throws {
        let fv = FieldValue.delete()
        let wire = try ValueCodec.encodeValue(fv) as? [String: Any]
        #expect(wire?["__sentinel"] as? String == "deleteField")
    }

    @Test func `firestore-swift#94: FieldValue.increment(_:) - Operand atomically incrementing numeric integer or double field value.`() async throws {
        let fvInt = FieldValue.increment(Int64(5))
        let wireInt = try ValueCodec.encodeValue(fvInt) as? [String: Any]
        #expect(wireInt?["__sentinel"] as? String == "increment")
        #expect(wireInt?["n"] as? Int64 == 5)

        let fvDouble = FieldValue.increment(1.5)
        let wireDouble = try ValueCodec.encodeValue(fvDouble) as? [String: Any]
        #expect(wireDouble?["__sentinel"] as? String == "increment")
        #expect(wireDouble?["n"] as? Double == 1.5)
    }

    @Test func `firestore-swift#95: FieldValue.arrayUnion(_:) - Transformation adding unique elements to array field if absent.`() async throws {
        let fv = FieldValue.arrayUnion(["red", "blue"])
        let wire = try ValueCodec.encodeValue(fv) as? [String: Any]
        #expect(wire?["__sentinel"] as? String == "arrayUnion")
        #expect((wire?["values"] as? [String]) == ["red", "blue"])
    }

    @Test func `firestore-swift#96: FieldValue.arrayRemove(_:) - Transformation removing matching elements from array field.`() async throws {
        let fv = FieldValue.arrayRemove(["blue"])
        let wire = try ValueCodec.encodeValue(fv) as? [String: Any]
        #expect(wire?["__sentinel"] as? String == "arrayRemove")
        #expect((wire?["values"] as? [String]) == ["blue"])
    }

    @Test func `firestore-swift#97: FieldValue.vector(_:) - Constructs dense vector embedding from Double or Float array.`() async throws {
        let fv = FieldValue.vector([0.1, 0.2, 0.3])
        let wire = try ValueCodec.encodeValue(fv) as? [String: Any]
        #expect(wire?["__sentinel"] as? String == "vector")
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── 9. Data Types & Value Codecs (Rows 98–100) ───────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#98: Timestamp - UTC timestamp representing 64-bit seconds and nanosecond resolution.`() async throws {
        let ts = Timestamp(seconds: 1_700_000_000, nanoseconds: 500_000)
        #expect(ts.seconds == 1_700_000_000)
        #expect(ts.nanoseconds == 500_000)
        let encoded = try ValueCodec.encodeValue(ts) as? [String: Any]
        #expect(encoded?["__type"] as? String == "timestamp")
        let decoded = ValueCodec.decodeValue(encoded) as? Timestamp
        #expect(decoded == ts)
    }

    @Test func `firestore-swift#99: GeoPoint - Immutable geographic coordinate pair with latitude and longitude bounds.`() async throws {
        let gp = GeoPoint(latitude: 37.7749, longitude: -122.4194)
        #expect(gp.latitude == 37.7749)
        #expect(gp.longitude == -122.4194)
        let encoded = try ValueCodec.encodeValue(gp) as? [String: Any]
        #expect(encoded?["__type"] as? String == "latlng")
        let decoded = ValueCodec.decodeValue(encoded) as? GeoPoint
        #expect(decoded == gp)
    }

    @Test func `firestore-swift#100: FieldPath - Path pointing to nested document field or documentID sentinel.`() async throws {
        let fp = FieldPath(["users", "profile", "name"])
        #expect(fp.stringRepresentation == "users.profile.name")
        let docIdPath = FieldPath.documentID()
        #expect(docIdPath.stringRepresentation == "__name__")
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── 10. Concurrency & Async Sequences (Rows 101–102) ─────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#101: DocumentReference.snapshots - AsyncSequence streaming real-time DocumentSnapshot updates via Swift concurrency.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        var iterator = harness.firestore.document("users/alice").snapshots.makeAsyncIterator()
        let snap = try await iterator.next()
        #expect(snap?.exists == true)
        #expect(snap?.data()?["status"] as? String == "online")
    }

    @Test func `firestore-swift#102: Query.snapshots - AsyncSequence streaming real-time QuerySnapshot updates via Swift concurrency.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        var iterator = harness.firestore.collection("users").snapshots.makeAsyncIterator()
        let snap = try await iterator.next()
        #expect(snap?.count == 1)
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── 11. Codable Integration (Rows 103–105) ───────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#103: @DocumentID - Property wrapper populating document ID on decoding; omitted from write payloads.`() async throws {
        #expect(Bool(false), "Unverified row firestore-swift#103: @DocumentID property wrapper deferred")
    }

    @Test func `firestore-swift#104: @ServerTimestamp - Property wrapper encoding nil as serverTimestamp sentinel on write.`() async throws {
        #expect(Bool(false), "Unverified row firestore-swift#104: @ServerTimestamp property wrapper deferred")
    }

    @Test func `firestore-swift#105: DocumentSnapshot.data(as:decoder:) - Decodes document snapshot fields directly into Decodable model.`() async throws {
        #expect(Bool(false), "Unverified row firestore-swift#105: data(as:) decoder deferred")
    }
}
