import Testing
import Foundation
@testable import PyricFirestore

@Suite("firestore-swift Query & Codable Conformance Suite")
struct ConformanceQueryAndCodableTests {

    // ══════════════════════════════════════════════════════════════════════════
    // ── 4. Query: Filters & Constraints (Rows 41–63) ─────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    @Test func `firestore-swift#41: Query.whereField(_:isEqualTo:) - Filters documents matching exact field equality.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isEqualTo: 30)
        let constraints = q.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: { $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == "==" }))
    }

    @Test func `firestore-swift#42: Query.whereField(_:isNotEqualTo:) - Filters documents where field does not equal value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("role", isNotEqualTo: "guest")
        let constraints = q.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: { $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "role" && $0["op"]?.stringValue == "!=" }))
    }

    @Test func `firestore-swift#43: Query.whereField(_:isLessThan:) - Filters documents where field is strictly less than value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isLessThan: 65)
        let constraints = q.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: { $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == "<" }))
    }

    @Test func `firestore-swift#44: Query.whereField(_:isLessThanOrEqualTo:) - Filters documents where field is less than or equal to value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isLessThanOrEqualTo: 64)
        let constraints = q.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: { $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == "<=" }))
    }

    @Test func `firestore-swift#45: Query.whereField(_:isGreaterThan:) - Filters documents where field is strictly greater than value.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let q = harness.firestore.collection("users").whereField("age", isGreaterThan: 18)
        let constraints = q.compileTarget().toAnySendable()["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: { $0["kind"]?.stringValue == "where" && $0["field"]?.stringValue == "age" && $0["op"]?.stringValue == ">" }))
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

    struct CodableItemModel: Codable, Equatable {
        @DocumentID var id: String?
        var name: String
        var score: Int
    }

    struct CodableTimestampModel: Codable, Equatable {
        var title: String
        @ServerTimestamp var createdAt: Timestamp?
    }

    @Test func `firestore-swift#103: @DocumentID - Property wrapper populating document ID on decoding; omitted from write payloads.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "items/item-42", data: ["name": "Shield", "score": 100], exists: true)
        let decoded = try snap.data(as: CodableItemModel.self)
        #expect(decoded.id == "item-42")
        #expect(decoded.name == "Shield")
        #expect(decoded.score == 100)
        let encoded = try Firestore.Encoder().encode(decoded)
        #expect(encoded["id"] == nil)
        #expect(encoded["name"] as? String == "Shield")
        #expect(encoded["score"] as? Int == 100)
    }

    @Test func `firestore-swift#104: @ServerTimestamp - Property wrapper encoding nil as serverTimestamp sentinel on write.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let model = CodableTimestampModel(title: "Release Note")
        let encoded = try Firestore.Encoder().encode(model)
        #expect(encoded["title"] as? String == "Release Note")
        let fv = encoded["createdAt"] as? FieldValue
        #expect(fv != nil)
        if let fv {
            let wire = try ValueCodec.encodeValue(fv) as? [String: Any]
            #expect(wire?["__sentinel"] as? String == "serverTimestamp")
        }
        try await harness.firestore.document("notes/1").setData(from: model)
        let op = harness.lastWorkerOp()
        #expect(op?["method"]?.stringValue == "setDoc")
        #expect(op?["data"]?["createdAt"]?["__sentinel"]?.stringValue == "serverTimestamp")
    }

    @Test func `firestore-swift#105: DocumentSnapshot.data(as:decoder:) - Decodes document snapshot fields directly into Decodable model.`() async throws {
        let harness = try await ConformanceMockHarness.create()
        let snap = DocumentSnapshot(firestore: harness.firestore, path: "items/item-99", data: ["name": "Sword", "score": 250], exists: true)
        let item = try snap.data(as: CodableItemModel.self)
        #expect(item == CodableItemModel(id: "item-99", name: "Sword", score: 250))
    }
}
