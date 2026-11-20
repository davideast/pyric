import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

@Suite("firestore-swift Sentinels, Data Types & Codable Live-Host Conformance (Rows 92-100, 103-105)", .serialized)
struct FirestoreTypesLiveHostConformanceTests {

    @Test("firestore-swift#92, #93, #94: FieldValue.serverTimestamp(), delete(), and increment(_:) over live host")
    func serverTimestampDeleteAndIncrementSentinelsLiveHostConformance() async throws {
        try await withLiveTypesSession(prefix: "types-sentinels") { db, uid in
            let docRef = db.document("users/\(uid)/items/sentinels-1")
            let floorSeconds = Int64(Date().timeIntervalSince1970) - 60

            // #92: serverTimestamp in both top-level and nested map fields.
            try await docRef.setData([
                "title": "Metrics",
                "createdAt": FieldValue.serverTimestamp(),
                "obsoleteTop": "drop-me",
                "nested": [
                    "touchedAt": FieldValue.serverTimestamp(),
                    "obsoleteNested": "drop-nested",
                    "keep": "intact"
                ],
                "views": 10,
                "score": 2.5
            ])

            let initial = try await docRef.getDocument(source: .server)
            let createdTs = try #require(initial.get("createdAt") as? Timestamp)
            let nestedTs = try #require(initial.get("nested.touchedAt") as? Timestamp)
            #expect(createdTs.seconds >= floorSeconds)
            #expect(nestedTs.seconds >= floorSeconds)

            // #93 & #94: delete() removes top-level & nested keys; increment(_:) handles Int64 and Double.
            try await docRef.updateData([
                "obsoleteTop": FieldValue.delete(),
                "nested.obsoleteNested": FieldValue.delete(),
                "views": FieldValue.increment(Int64(5)),
                "score": FieldValue.increment(1.25),
                "freshCounter": FieldValue.increment(Int64(3))
            ])

            let updated = try await docRef.getDocument(source: .server)
            #expect(updated.data()?["obsoleteTop"] == nil)
            let nestedMap = updated.data()?["nested"] as? [String: Any]
            #expect(nestedMap?["obsoleteNested"] == nil)
            #expect(nestedMap?["keep"] as? String == "intact")
            #expect(updated.get("views") as? Int64 == 15)
            #expect(updated.get("score") as? Double == 3.75)
            #expect(updated.get("freshCounter") as? Int64 == 3)

            // Negative Int64 increment decrements atomically.
            try await docRef.updateData(["views": FieldValue.increment(Int64(-4))])
            let afterDecrement = try await docRef.getDocument(source: .server)
            #expect(afterDecrement.get("views") as? Int64 == 11)
        }
    }

    @Test("firestore-swift#95, #96, #97: FieldValue.arrayUnion(_:), arrayRemove(_:), and vector(_:) over live host")
    func arrayTransformationsAndVectorEmbeddingsLiveHostConformance() async throws {
        try await withLiveTypesSession(prefix: "types-arr-vec") { db, uid in
            let docRef = db.document("users/\(uid)/items/arrays-vectors")

            // #95: arrayUnion initializes missing array and appends only unique elements.
            try await docRef.setData([
                "tags": ["swift", "ios"],
                "embeddingDouble": FieldValue.vector([0.125, -0.5, 0.875]),
                "embeddingFloat": FieldValue.vector([Float(0.25), Float(-0.75)])
            ])
            try await docRef.updateData([
                "tags": FieldValue.arrayUnion(["ios", "firestore", "live"]),
                "createdUnion": FieldValue.arrayUnion([1, 2, 1])
            ])

            let afterUnion = try await docRef.getDocument(source: .server)
            let tagsAfterUnion = try #require(afterUnion.get("tags") as? [Any]).compactMap { $0 as? String }
            #expect(tagsAfterUnion == ["swift", "ios", "firestore", "live"])
            let createdUnion = try #require(afterUnion.get("createdUnion") as? [Any]).compactMap { $0 as? Int64 }
            #expect(createdUnion == [1, 2])

            // #96: arrayRemove removes all matching occurrences while ignoring absent elements.
            try await docRef.setData(["dups": ["a", "b", "a", "c"]], merge: true)
            try await docRef.updateData([
                "tags": FieldValue.arrayRemove(["swift", "nonexistent"]),
                "dups": FieldValue.arrayRemove(["a"])
            ])
            let afterRemove = try await docRef.getDocument(source: .server)
            let tagsAfterRemove = try #require(afterRemove.get("tags") as? [Any]).compactMap { $0 as? String }
            #expect(tagsAfterRemove == ["ios", "firestore", "live"])
            let dupsAfterRemove = try #require(afterRemove.get("dups") as? [Any]).compactMap { $0 as? String }
            #expect(dupsAfterRemove == ["b", "c"])

            // #97: VectorValue constructed from [Double] and [Float] round-trips faithfully over live host.
            let vecDouble = try #require(afterRemove.get("embeddingDouble") as? VectorValue)
            #expect(vecDouble == VectorValue([0.125, -0.5, 0.875]))
            #expect(vecDouble.arrayValue == [0.125, -0.5, 0.875])

            let vecFloat = try #require(afterRemove.get("embeddingFloat") as? VectorValue)
            #expect(vecFloat == VectorValue([0.25, -0.75]))

            // Non-finite vector elements fail serialization closed before hitting wire.
            do {
                try await docRef.updateData(["badVec": FieldValue.vector([Double.nan])])
                Issue.record("Expected non-finite vector serialization error")
            } catch is PyricFirestoreError {
                // Expected serializationError.
            }
        }
    }

    @Test("firestore-swift#98, #99, #100: Timestamp, GeoPoint, and FieldPath round-trips, bounds, and documentID queries over live host")
    func timestampGeoPointAndFieldPathLiveHostConformance() async throws {
        try await withLiveTypesSession(prefix: "types-codecs") { db, uid in
            let items = db.collection("users/\(uid)/items")

            // #98: Timestamp nanosecond precision in memory, microsecond server persistence, pre-1970 negative epoch, and Comparable.
            let preEpoch = Timestamp(seconds: -86_400, nanoseconds: 123_456_789)
            let modern = Timestamp(seconds: 1_725_000_000, nanoseconds: 987_654_321)
            let exactMicros = Timestamp(seconds: 1_725_000_001, nanoseconds: 654_321_000)
            #expect(preEpoch.nanoseconds == 123_456_789)
            #expect(modern.nanoseconds == 987_654_321)
            #expect(preEpoch < modern)
            #expect(preEpoch.compare(modern) == .orderedAscending)
            #expect(modern.compare(modern) == .orderedSame)
            let bridgedDate = Timestamp(seconds: 1_700_000_000, nanoseconds: 250_000_000).dateValue()
            #expect(Timestamp(date: bridgedDate).seconds == 1_700_000_000)

            // #99: GeoPoint boundary coordinates and Comparable ordering.
            let southWestPole = GeoPoint(latitude: -90.0, longitude: -180.0)
            let northEastPole = GeoPoint(latitude: 90.0, longitude: 180.0)
            let sf = GeoPoint(latitude: 37.7749, longitude: -122.4194)
            #expect(southWestPole < sf)
            #expect(sf < northEastPole)

            // #100: FieldPath nested access, literal-dot segment preservation, and FieldPath.documentID().
            let docA = items.document("codec-alpha")
            let docB = items.document("codec-beta")
            try await docA.setData([
                "recordedAt": modern,
                "historicAt": preEpoch,
                "exactMicrosAt": exactMicros,
                "origin": sf,
                "boundsMin": southWestPole,
                "boundsMax": northEastPole,
                "profile": ["settings": ["theme": "solarized"]],
                "config.v2": ["enabled": true, "label": "dot-key"]
            ])
            try await docB.setData([
                "recordedAt": preEpoch,
                "origin": northEastPole,
                "profile": ["settings": ["theme": "monokai"]]
            ])

            let snapA = try await docA.getDocument(source: .server)
            #expect(snapA.get("recordedAt") as? Timestamp == Timestamp(seconds: 1_725_000_000, nanoseconds: 987_654_000))
            #expect(snapA.get("historicAt") as? Timestamp == Timestamp(seconds: -86_400, nanoseconds: 123_456_000))
            #expect(snapA.get("exactMicrosAt") as? Timestamp == exactMicros)
            #expect(snapA.get("origin") as? GeoPoint == sf)
            #expect(snapA.get("boundsMin") as? GeoPoint == southWestPole)
            #expect(snapA.get("boundsMax") as? GeoPoint == northEastPole)

            let themePath = FieldPath(["profile", "settings", "theme"])
            let literalDotPath = FieldPath(["config.v2", "label"])
            #expect(snapA.get(themePath) as? String == "solarized")
            #expect(snapA.get(literalDotPath) as? String == "dot-key")
            #expect(snapA.get(FieldPath.documentID()) as? String == "codec-alpha")

            // Query using FieldPath.documentID() and nested FieldPath over live host.
            let byIdSnap = try await items
                .whereField(FieldPath.documentID(), in: ["codec-alpha", "codec-missing"])
                .getDocuments(source: .server)
            #expect(byIdSnap.documents.map(\.documentID) == ["codec-alpha"])

            let byThemeSnap = try await items
                .whereField(themePath, isEqualTo: "monokai")
                .getDocuments(source: .server)
            #expect(byThemeSnap.documents.map(\.documentID) == ["codec-beta"])
        }
    }

    // MARK: - Codable Models (Rows 103-105)

    private struct RichItemRecord: Codable, Equatable, Sendable {
        @DocumentID var id: String?
        var title: String
        var tags: [String]
        var location: GeoPoint
        var milestone: Timestamp
        var dueDate: Date
        var payload: Data
        var embedding: VectorValue
        var parentUserRef: DocumentReference
        @ServerTimestamp var createdAt: Timestamp?
        @ServerTimestamp var syncedAt: Date?
    }

    private struct RefIdentifiedNote: Codable, Equatable, Sendable {
        @DocumentID var ref: DocumentReference?
        var body: String
        var priority: Int
    }

    @Test("firestore-swift#103, #104, #105: @DocumentID, @ServerTimestamp, and DocumentSnapshot.data(as:decoder:) over live host")
    func codableWrappersAndSnapshotDecodingLiveHostConformance() async throws {
        try await withLiveTypesSession(prefix: "types-codable") { db, uid in
            let items = db.collection("users/\(uid)/items")
            let userRef = db.document("users/\(uid)")
            let fixedMilestone = Timestamp(seconds: 1_720_000_100, nanoseconds: 500_000_000)
            let fixedDueDate = Date(timeIntervalSince1970: 1_721_000_000.25)
            let binaryPayload = Data([0x00, 0x41, 0x7F, 0xFF, 0x10])
            let floorSeconds = Int64(Date().timeIntervalSince1970) - 60

            // Write Codable struct with non-nil @DocumentID (must be omitted on wire) and nil @ServerTimestamp fields.
            let docRef = items.document("codable-rich-1")
            let outgoing = RichItemRecord(
                id: "client-local-ignored-id",
                title: "Sensor Pack",
                tags: ["telemetry", "v2"],
                location: GeoPoint(latitude: 47.6062, longitude: -122.3321),
                milestone: fixedMilestone,
                dueDate: fixedDueDate,
                payload: binaryPayload,
                embedding: VectorValue([0.5, -0.25, 0.75]),
                parentUserRef: userRef,
                createdAt: nil,
                syncedAt: nil
            )
            try await docRef.setData(from: outgoing)

            let serverSnap = try await docRef.getDocument(source: .server)
            // #103: @DocumentID was NOT persisted as a stored document field on the server.
            #expect(serverSnap.data()?["id"] == nil)
            // Native types stored as real Firestore types, not plain JSON strings/dicts.
            #expect(serverSnap.get("payload") as? Data == binaryPayload)
            #expect(serverSnap.get("embedding") as? VectorValue == VectorValue([0.5, -0.25, 0.75]))
            #expect(serverSnap.get("parentUserRef") as? DocumentReference == userRef)

            // #105 & #104: Decode directly via DocumentSnapshot.data(as:decoder:).
            let customDecoder = Firestore.Decoder()
            let decoded = try serverSnap.data(as: RichItemRecord.self, decoder: customDecoder)
            #expect(decoded.id == "codable-rich-1")
            #expect(decoded.title == "Sensor Pack")
            #expect(decoded.tags == ["telemetry", "v2"])
            #expect(decoded.location == GeoPoint(latitude: 47.6062, longitude: -122.3321))
            #expect(decoded.milestone == fixedMilestone)
            #expect(abs(decoded.dueDate.timeIntervalSince(fixedDueDate)) < 0.001)
            #expect(decoded.payload == binaryPayload)
            #expect(decoded.embedding == VectorValue([0.5, -0.25, 0.75]))
            #expect(decoded.parentUserRef == userRef)

            let resolvedCreated = try #require(decoded.createdAt)
            let resolvedSynced = try #require(decoded.syncedAt)
            #expect(resolvedCreated.seconds >= floorSeconds)
            #expect(Int64(resolvedSynced.timeIntervalSince1970) >= floorSeconds)

            // Explicit non-nil @ServerTimestamp value is preserved rather than overwritten with sentinel.
            let explicitTs = Timestamp(seconds: 1_700_123_456, nanoseconds: 0)
            var updatedModel = decoded
            updatedModel.title = "Sensor Pack Updated"
            updatedModel.createdAt = explicitTs
            try await docRef.setData(from: updatedModel, mergeFields: ["title", "createdAt"])

            let afterExplicit = try await docRef.getDocument(source: .server).data(as: RichItemRecord.self)
            #expect(afterExplicit.title == "Sensor Pack Updated")
            #expect(afterExplicit.createdAt == explicitTs)
            #expect(afterExplicit.tags == ["telemetry", "v2"])

            // #103: @DocumentID typed as DocumentReference? via CollectionReference.addDocument(from:).
            let addedRef = try await items.addDocument(
                from: RefIdentifiedNote(ref: nil, body: "Auto-ID Codable note", priority: 2)
            )
            let querySnap = try await items
                .whereField("body", isEqualTo: "Auto-ID Codable note")
                .getDocuments(source: .server)
            let queryDoc = try #require(querySnap.documents.first)
            #expect(queryDoc.data()["ref"] == nil)
            let decodedNote = try queryDoc.data(as: RefIdentifiedNote.self)
            #expect(decodedNote.ref == addedRef)
            #expect(decodedNote.body == "Auto-ID Codable note")
            #expect(decodedNote.priority == 2)

            // #103 conflict check: stored field colliding with @DocumentID key throws DecodingError.
            let conflictRef = items.document("codable-conflict")
            try await conflictRef.setData(["id": "stored-colliding-id", "title": "Bad"])
            let conflictSnap = try await conflictRef.getDocument(source: .server)
            struct SimpleIDModel: Codable {
                @DocumentID var id: String?
                var title: String
            }
            #expect(throws: DecodingError.self) {
                _ = try conflictSnap.data(as: SimpleIDModel.self)
            }

            // #105: Non-existent DocumentSnapshot throws PyricFirestoreError on data(as:).
            let missingSnap = try await items.document("does-not-exist").getDocument(source: .server)
            #expect(missingSnap.exists == false)
            #expect(throws: PyricFirestoreError.self) {
                _ = try missingSnap.data(as: SimpleIDModel.self)
            }
        }
    }

    // MARK: - Live-Host Session Helper

    private func withLiveTypesSession(
        prefix: String,
        body: (Firestore, String) async throws -> Void
    ) async throws {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)

        let app = FirebaseApp(
            name: "swift-\(prefix)-\(UUID().uuidString)",
            options: FirebaseOptions(
                projectID: "demo-swift-live",
                databaseURL: "https://demo-swift-live-default-rtdb.firebaseio.com",
                apiKey: "swift-live-key",
                googleAppID: "1:500:ios:live"
            )
        )
        app.useEmulator(withHost: host, port: port)
        let db = Firestore.firestore(app: app)
        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()

        do {
            let session = try await auth.createUser(withEmail: "types-\(tag)@example.test", password: "CorrectHorse!99")
            try await body(db, session.user.uid)
            await app.disconnectSharedBridge()
        } catch {
            await app.disconnectSharedBridge()
            throw error
        }
    }
}
