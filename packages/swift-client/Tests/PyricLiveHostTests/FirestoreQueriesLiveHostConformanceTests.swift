import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

@Suite("firestore-swift Queries & Filters Live-Host Conformance (Rows 41-63)", .serialized)
struct FirestoreQueriesLiveHostConformanceTests {

    @Test("firestore-swift#41..#51: equality, inequality, array, membership, FieldPath, and composite Filter queries over live host")
    func filterPredicatesAndCompositeFiltersLiveHostConformance() async throws {
        guard let (host, port) = try liveQueriesEndpoint() else {
            return
        }

        let app = makeQueriesLiveApp(prefix: "fs-query-filters", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-filters-\(tag)@example.test",
            password: "CorrectHorse!41"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)
        let items = db.collection("users/\(uid)/items")

        let t1 = Timestamp(seconds: 1_760_000_100, nanoseconds: 0)
        let t2 = Timestamp(seconds: 1_760_000_200, nanoseconds: 0)

        try await items.document("item-a").setData([
            "category": "tools",
            "rank": 10,
            "active": true,
            "tags": ["featured", "metal"],
            "note": "hammer",
            "profile": ["region": "west"],
            "meta.v1": ["tier": "pro"],
            "createdAt": t1
        ])
        try await items.document("item-b").setData([
            "category": "tools",
            "rank": 20,
            "active": false,
            "tags": ["wood"],
            "note": NSNull(),
            "profile": ["region": "east"],
            "meta.v1": ["tier": "free"],
            "createdAt": t1
        ])
        try await items.document("item-c").setData([
            "category": "books",
            "rank": 30,
            "active": true,
            "tags": ["featured", "paper"],
            "note": "manual",
            "profile": ["region": "west"],
            "meta.v1": ["tier": "pro"],
            "createdAt": t2
        ])
        try await items.document("item-d").setData([
            "category": "lighting",
            "rank": 40,
            "active": true,
            "tags": ["clearance"],
            "note": "lamp",
            "profile": ["region": "north"],
            "meta.v1": ["tier": "team"],
            "createdAt": t2
        ])
        try await items.document("item-e").setData([
            "category": "archived",
            "rank": 50,
            "active": false,
            "tags": ["legacy"],
            "note": "old",
            "profile": ["region": "south"],
            "meta.v1": ["tier": "free"],
            "createdAt": t2
        ])

        // Row 41: whereField(_:isEqualTo:) including String, nested dot path, null, Timestamp, and literal-dot FieldPath.
        let eqTools = try await items.whereField("category", isEqualTo: "tools").getDocuments()
        #expect(eqTools.documents.map(\.documentID) == ["item-a", "item-b"])

        let eqNull = try await items.whereField("note", isEqualTo: NSNull()).getDocuments()
        #expect(eqNull.documents.map(\.documentID) == ["item-b"])

        let eqNested = try await items.whereField("profile.region", isEqualTo: "west").getDocuments()
        #expect(eqNested.documents.map(\.documentID) == ["item-a", "item-c"])

        let eqLiteralDotFieldPath = try await items
            .whereField(FieldPath(["meta.v1", "tier"]), isEqualTo: "pro")
            .getDocuments()
        #expect(eqLiteralDotFieldPath.documents.map(\.documentID) == ["item-a", "item-c"])

        let eqTimestamp = try await items.whereField("createdAt", isEqualTo: t2).getDocuments()
        #expect(eqTimestamp.documents.map(\.documentID) == ["item-c", "item-d", "item-e"])

        // Row 42: whereField(_:isNotEqualTo:)
        let notTools = try await items
            .whereField("category", isNotEqualTo: "tools")
            .order(by: "category")
            .getDocuments()
        #expect(notTools.documents.map(\.documentID) == ["item-e", "item-c", "item-d"])

        // Row 43: whereField(_:isLessThan:)
        let lt30 = try await items.whereField("rank", isLessThan: 30).order(by: "rank").getDocuments()
        #expect(lt30.documents.map(\.documentID) == ["item-a", "item-b"])

        // Row 44: whereField(_:isLessThanOrEqualTo:)
        let lte30 = try await items.whereField("rank", isLessThanOrEqualTo: 30).order(by: "rank").getDocuments()
        #expect(lte30.documents.map(\.documentID) == ["item-a", "item-b", "item-c"])

        // Row 45: whereField(_:isGreaterThan:)
        let gt30 = try await items.whereField("rank", isGreaterThan: 30).order(by: "rank").getDocuments()
        #expect(gt30.documents.map(\.documentID) == ["item-d", "item-e"])

        // Row 46: whereField(_:isGreaterThanOrEqualTo:)
        let gte30 = try await items.whereField("rank", isGreaterThanOrEqualTo: 30).order(by: "rank").getDocuments()
        #expect(gte30.documents.map(\.documentID) == ["item-c", "item-d", "item-e"])

        // Row 47: whereField(_:arrayContains:)
        let arrayContainsFeatured = try await items
            .whereField("tags", arrayContains: "featured")
            .getDocuments()
        #expect(arrayContainsFeatured.documents.map(\.documentID) == ["item-a", "item-c"])

        // Row 48: whereField(_:arrayContainsAny:)
        let arrayContainsAny = try await items
            .whereField("tags", arrayContainsAny: ["featured", "clearance"])
            .getDocuments()
        #expect(arrayContainsAny.documents.map(\.documentID) == ["item-a", "item-c", "item-d"])

        // Row 49: whereField(_:in:)
        let inCategories = try await items
            .whereField("category", in: ["books", "lighting"])
            .getDocuments()
        #expect(inCategories.documents.map(\.documentID) == ["item-c", "item-d"])

        // Row 50: whereField(_:notIn:)
        let notInCategories = try await items
            .whereField("category", notIn: ["tools", "archived"])
            .order(by: "category")
            .getDocuments()
        #expect(notInCategories.documents.map(\.documentID) == ["item-c", "item-d"])

        // Row 51: whereFilter(_:) with Filter.orFilter, Filter.andFilter, nested boolean composition, and literal-dot FieldPath.
        let orQuery = try await items.whereFilter(
            Filter.orFilter([
                Filter.whereField("category", isEqualTo: "books"),
                Filter.whereField("rank", isEqualTo: 50)
            ])
        ).order(by: "rank").getDocuments()
        #expect(orQuery.documents.map(\.documentID) == ["item-c", "item-e"])

        let nestedComposite = try await items.whereFilter(
            Filter.andFilter([
                Filter.whereField("active", isEqualTo: true),
                Filter.orFilter([
                    Filter.whereField(FieldPath(["meta.v1", "tier"]), isEqualTo: "pro"),
                    Filter.whereField("rank", isGreaterThanOrEqualTo: 40)
                ])
            ])
        ).order(by: "rank").getDocuments()
        #expect(nestedComposite.documents.map(\.documentID) == ["item-a", "item-c", "item-d"])

        // Empty composite filter acts as identity constraint.
        let emptyComposite = try await items.whereFilter(Filter.andFilter([])).order(by: "rank").getDocuments()
        #expect(emptyComposite.documents.count == 5)

        // Security rules deny querying another user's collection.
        await expectQueryBridgeCode(.permissionDenied) {
            _ = try await db.collection("users/other-\(tag)/items")
                .whereField("active", isEqualTo: true)
                .getDocuments()
        }

        await app.disconnectSharedBridge()
    }

    @Test("firestore-swift#52..#59: order, limit, limitToLast, value cursors, and DocumentSnapshot cursors with tie-breaking over live host")
    func orderingLimitsAndCursorsLiveHostConformance() async throws {
        guard let (host, port) = try liveQueriesEndpoint() else {
            return
        }

        let app = makeQueriesLiveApp(prefix: "fs-query-cursors", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-cursors-\(tag)@example.test",
            password: "CorrectHorse!52"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)
        let items = db.collection("users/\(uid)/items")

        // Seed 5 ordered documents (p2 and p3 intentionally tie on score == 20) plus 1 doc missing 'score'.
        try await items.document("p1").setData(["score": 10, "sub": 1, "meta.v1": ["priority": 5]])
        try await items.document("p2").setData(["score": 20, "sub": 2, "meta.v1": ["priority": 4]])
        try await items.document("p3").setData(["score": 20, "sub": 1, "meta.v1": ["priority": 3]])
        try await items.document("p4").setData(["score": 30, "sub": 1, "meta.v1": ["priority": 2]])
        try await items.document("p5").setData(["score": 40, "sub": 1, "meta.v1": ["priority": 1]])
        try await items.document("p-unscored").setData(["label": "no-score-field"])

        // Row 52: order(by:) ascending excludes documents missing the ordered field and tie-breaks by documentID.
        let ascByScore = try await items.order(by: "score").getDocuments()
        #expect(ascByScore.documents.map(\.documentID) == ["p1", "p2", "p3", "p4", "p5"])

        let ascByFieldPath = try await items.order(by: FieldPath(["meta.v1", "priority"])).getDocuments()
        #expect(ascByFieldPath.documents.map(\.documentID) == ["p5", "p4", "p3", "p2", "p1"])

        // Row 53: order(by:descending:) including multi-field sort.
        let descByScore = try await items.order(by: "score", descending: true).getDocuments()
        #expect(descByScore.documents.map(\.documentID) == ["p5", "p4", "p3", "p2", "p1"])

        let multiSort = try await items
            .order(by: "score", descending: false)
            .order(by: "sub", descending: true)
            .getDocuments()
        #expect(multiSort.documents.map(\.documentID) == ["p1", "p2", "p3", "p4", "p5"])

        // Row 54: limit(to:) and replacement when chained.
        let firstThree = try await items.order(by: "score").limit(to: 3).getDocuments()
        #expect(firstThree.documents.map(\.documentID) == ["p1", "p2", "p3"])

        let replacedLimit = try await items.order(by: "score").limit(to: 4).limit(to: 2).getDocuments()
        #expect(replacedLimit.documents.map(\.documentID) == ["p1", "p2"])

        // Row 55: limit(toLast:) returns tail slice in query sort order and rejects missing order(by:).
        let lastTwo = try await items.order(by: "score").limit(toLast: 2).getDocuments()
        #expect(lastTwo.documents.map(\.documentID) == ["p4", "p5"])

        await #expect(throws: PyricFirestoreError.self) {
            _ = try await items.limit(toLast: 2).getDocuments()
        }

        // Row 56: start(at:) and start(after:) with ordered values.
        let startAt20 = try await items.order(by: "score").start(at: [20]).getDocuments()
        #expect(startAt20.documents.map(\.documentID) == ["p2", "p3", "p4", "p5"])

        let startAfter20 = try await items.order(by: "score").start(after: [20]).getDocuments()
        #expect(startAfter20.documents.map(\.documentID) == ["p4", "p5"])

        let startAfterComposite = try await items
            .order(by: "score")
            .order(by: FieldPath.documentID())
            .start(after: [20, "p2"])
            .getDocuments()
        #expect(startAfterComposite.documents.map(\.documentID) == ["p3", "p4", "p5"])

        // Row 57: end(before:) and end(at:) with ordered values.
        let endBefore30 = try await items.order(by: "score").end(before: [30]).getDocuments()
        #expect(endBefore30.documents.map(\.documentID) == ["p1", "p2", "p3"])

        let endAt30 = try await items.order(by: "score").end(at: [30]).getDocuments()
        #expect(endAt30.documents.map(\.documentID) == ["p1", "p2", "p3", "p4"])

        let boundedValues = try await items
            .order(by: "score")
            .start(at: [20])
            .end(before: [40])
            .getDocuments()
        #expect(boundedValues.documents.map(\.documentID) == ["p2", "p3", "p4"])

        // Row 58 & #59: DocumentSnapshot cursors including tie-breaking on equal score (p2 vs p3),
        // implicit key ordering when no explicit order(by:) is present, and pre-orderBy chaining.
        let p2Snap = try await items.document("p2").getDocument()
        let p3Snap = try await items.document("p3").getDocument()
        let p4Snap = try await items.document("p4").getDocument()

        let startAtP2 = try await items.order(by: "score").start(atDocument: p2Snap).getDocuments()
        #expect(startAtP2.documents.map(\.documentID) == ["p2", "p3", "p4", "p5"])

        let startAfterP2 = try await items.order(by: "score").start(afterDocument: p2Snap).getDocuments()
        #expect(startAfterP2.documents.map(\.documentID) == ["p3", "p4", "p5"])

        // Chaining start(afterDocument:) before order(by:) resolves against the final query orders.
        let preChainedStartAfter = try await items.start(afterDocument: p2Snap).order(by: "score").getDocuments()
        #expect(preChainedStartAfter.documents.map(\.documentID) == ["p3", "p4", "p5"])

        // Snapshot cursor without explicit order(by:) positions by implicit document key.
        let keyOrderedAfterP2 = try await items.start(afterDocument: p2Snap).getDocuments()
        #expect(keyOrderedAfterP2.documents.map(\.documentID) == ["p3", "p4", "p5"])

        let endBeforeP3 = try await items.order(by: "score").end(beforeDocument: p3Snap).getDocuments()
        #expect(endBeforeP3.documents.map(\.documentID) == ["p1", "p2"])

        let endAtP3 = try await items.order(by: "score").end(atDocument: p3Snap).getDocuments()
        #expect(endAtP3.documents.map(\.documentID) == ["p1", "p2", "p3"])

        let boundedDocs = try await items
            .order(by: "score")
            .start(atDocument: p2Snap)
            .end(atDocument: p4Snap)
            .getDocuments()
        #expect(boundedDocs.documents.map(\.documentID) == ["p2", "p3", "p4"])

        // Offline cache query evaluates snapshot cursors with identical tie-breaking.
        let cachedAfterP2 = try await items
            .order(by: "score")
            .start(afterDocument: p2Snap)
            .getDocuments(source: .cache)
        #expect(cachedAfterP2.metadata.isFromCache == true)
        #expect(cachedAfterP2.documents.map(\.documentID) == ["p3", "p4", "p5"])

        // Non-existent DocumentSnapshot and missing-ordered-field DocumentSnapshot fail validation.
        let missingSnap = try await items.document("does-not-exist").getDocument()
        #expect(missingSnap.exists == false)
        await #expect(throws: PyricFirestoreError.self) {
            _ = try await items.order(by: "score").start(atDocument: missingSnap).getDocuments()
        }

        let unscoredSnap = try await items.document("p-unscored").getDocument()
        await #expect(throws: PyricFirestoreError.self) {
            _ = try await items.order(by: "score").end(atDocument: unscoredSnap).getDocuments()
        }

        await app.disconnectSharedBridge()
    }

    @Test("firestore-swift#60..#63: getDocuments(source:) and Query.addSnapshotListener overloads with metadata and ListenSource options over live host")
    func getDocumentsSourceAndQueryListenersLiveHostConformance() async throws {
        guard let (host, port) = try liveQueriesEndpoint() else {
            return
        }

        let writerApp = makeQueriesLiveApp(prefix: "fs-qlisten-writer", host: host, port: port)
        let peerApp = makeQueriesLiveApp(prefix: "fs-qlisten-peer", host: host, port: port)
        defer {
            Task {
                await writerApp.disconnectSharedBridge()
                await peerApp.disconnectSharedBridge()
            }
        }

        let tag = UUID().uuidString.lowercased()
        let email = "fs-qlisten-\(tag)@example.test"
        let password = "CorrectHorse!60"
        let created = try await Auth.auth(app: writerApp).createUser(withEmail: email, password: password)
        let uid = created.user.uid
        _ = try await Auth.auth(app: peerApp).signIn(withEmail: email, password: password)

        let db = Firestore.firestore(app: writerApp)
        let peerDb = Firestore.firestore(app: peerApp)
        let items = db.collection("users/\(uid)/items")
        let peerItems = peerDb.collection("users/\(uid)/items")

        try await items.document("q1").setData(["active": true, "rank": 1, "title": "First"])
        try await items.document("q2").setData(["active": false, "rank": 2, "title": "Second"])

        let activeQuery = items.whereField("active", isEqualTo: true).order(by: "rank")

        // Row 60: getDocuments(source:) across .default, .server, .cache, completion overload, and offline mode.
        let defaultSnap = try await activeQuery.getDocuments(source: .default)
        #expect(defaultSnap.metadata.isFromCache == false)
        #expect(defaultSnap.documents.map(\.documentID) == ["q1"])

        let serverViaCompletion = try await awaitQueryCompletion { done in
            activeQuery.getDocuments(source: .server, completion: done)
        }
        #expect(serverViaCompletion.metadata.isFromCache == false)
        #expect(serverViaCompletion.documents.map(\.documentID) == ["q1"])

        let cacheWarmSnap = try await activeQuery.getDocuments(source: .cache)
        #expect(cacheWarmSnap.metadata.isFromCache == true)
        #expect(cacheWarmSnap.documents.map(\.documentID) == ["q1"])

        // Row 61: Query.addSnapshotListener(_:) receives initial + live mutations and stops after remove().
        let plainCollector = QuerySnapshotCollector()
        let plainReg = activeQuery.addSnapshotListener { snap, err in
            plainCollector.record(snapshot: snap, error: err)
        }
        await plainCollector.waitForSnapshotCount(1)
        #expect(plainCollector.snapshots[0].documents.map(\.documentID) == ["q1"])
        #expect(plainCollector.snapshots[0].documentChanges.map(\.type) == [.added])

        try await peerItems.document("q3").setData(["active": true, "rank": 3, "title": "Third"])
        await plainCollector.waitForSnapshotCount(2)
        #expect(plainCollector.snapshots[1].documents.map(\.documentID) == ["q1", "q3"])
        #expect(plainCollector.snapshots[1].documentChanges.map(\.type) == [.added])
        #expect(plainCollector.snapshots[1].documentChanges.first?.document.documentID == "q3")

        plainReg.remove()
        try await peerItems.document("q4").setData(["active": true, "rank": 4, "title": "Fourth"])
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(plainCollector.snapshots.count == 2)

        // Invalid query passed to addSnapshotListener delivers error callback rather than unfiltered collection.
        let invalidCollector = QuerySnapshotCollector()
        let invalidReg = items.limit(toLast: 1).addSnapshotListener { snap, err in
            invalidCollector.record(snapshot: snap, error: err)
        }
        let listenErr = await invalidCollector.waitForFirstError()
        #expect(listenErr is PyricFirestoreError)
        invalidReg.remove()

        // Row 62 & #63: addSnapshotListener(includeMetadataChanges:listener:) and addSnapshotListener(options:listener:).
        let metaCollector = QuerySnapshotCollector()
        let metaOptions = SnapshotListenOptions().withIncludeMetadataChanges(true)
        let metaReg = activeQuery.addSnapshotListener(options: metaOptions) { snap, err in
            metaCollector.record(snapshot: snap, error: err)
        }
        let boolMetaCollector = QuerySnapshotCollector()
        let boolMetaReg = activeQuery.addSnapshotListener(includeMetadataChanges: true) { snap, err in
            boolMetaCollector.record(snapshot: snap, error: err)
        }
        await metaCollector.waitForSnapshotCount(1)
        await boolMetaCollector.waitForSnapshotCount(1)
        #expect(metaCollector.snapshots[0].metadata.isFromCache == false)
        #expect(metaCollector.snapshots[0].metadata.hasPendingWrites == false)
        #expect(metaCollector.snapshots[0].documents.map(\.documentID) == ["q1", "q3", "q4"])

        // Toggle offline: metadata listeners receive cache transition, then pending-write snapshot, then settled online snapshot.
        try await db.disableNetwork()
        await metaCollector.waitForSnapshotCount(2)
        await boolMetaCollector.waitForSnapshotCount(2)
        #expect(metaCollector.snapshots[1].metadata.isFromCache == true)
        #expect(metaCollector.snapshots[1].metadata.hasPendingWrites == false)

        await expectQueryBridgeCode(.unavailable) {
            _ = try await activeQuery.getDocuments(source: .server)
        }
        let offlineDefaultSnap = try await activeQuery.getDocuments()
        #expect(offlineDefaultSnap.metadata.isFromCache == true)

        let offlineWriteTask = Task {
            try await items.document("q5").setData(["active": true, "rank": 5, "title": "Offline Fifth"])
        }
        await metaCollector.waitForSnapshotCount(3)
        await boolMetaCollector.waitForSnapshotCount(3)
        #expect(metaCollector.snapshots[2].metadata.isFromCache == true)
        #expect(metaCollector.snapshots[2].metadata.hasPendingWrites == true)
        #expect(metaCollector.snapshots[2].documents.map(\.documentID) == ["q1", "q3", "q4", "q5"])
        #expect(boolMetaCollector.snapshots[2].metadata.hasPendingWrites == true)

        try await db.enableNetwork()
        try await offlineWriteTask.value
        await metaCollector.waitForSnapshotCount(4)
        await boolMetaCollector.waitForSnapshotCount(4)
        let settledSnap = try #require(metaCollector.snapshots.last)
        #expect(settledSnap.metadata.isFromCache == false)
        #expect(settledSnap.metadata.hasPendingWrites == false)
        #expect(settledSnap.documents.map(\.documentID) == ["q1", "q3", "q4", "q5"])

        metaReg.remove()
        boolMetaReg.remove()

        // Row 63: SnapshotListenOptions().withSource(.cache) listens strictly to local cache without opening remote stream.
        let cacheOnlyCollector = QuerySnapshotCollector()
        let cacheOptions = SnapshotListenOptions().withSource(.cache)
        let cacheReg = activeQuery.addSnapshotListener(options: cacheOptions) { snap, err in
            cacheOnlyCollector.record(snapshot: snap, error: err)
        }
        await cacheOnlyCollector.waitForSnapshotCount(1)
        #expect(cacheOnlyCollector.snapshots[0].metadata.isFromCache == true)
        #expect(cacheOnlyCollector.snapshots[0].documents.map(\.documentID) == ["q1", "q3", "q4", "q5"])

        // Remote write on peerDb does not push to a ListenSource.cache listener.
        try await peerItems.document("q6").setData(["active": true, "rank": 6, "title": "Remote Only"])
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(cacheOnlyCollector.snapshots.count == 1)

        // Local online write on the same Firestore instance updates local cache and notifies ListenSource.cache listener.
        try await items.document("q7").setData(["active": true, "rank": 7, "title": "Local Cache Hit"])
        await cacheOnlyCollector.waitForSnapshotCount(2)
        #expect(cacheOnlyCollector.snapshots[1].metadata.isFromCache == true)
        #expect(cacheOnlyCollector.snapshots[1].documents.map(\.documentID) == ["q1", "q3", "q4", "q5", "q7"])

        // FieldPath.documentID() with DocumentReference matches identically on .cache and .server.
        let byDocRefCache = try await items
            .whereField(FieldPath.documentID(), isEqualTo: items.document("q7"))
            .getDocuments(source: .cache)
        #expect(byDocRefCache.documents.map(\.documentID) == ["q7"])
        let byDocRefServer = try await items
            .whereField(FieldPath.documentID(), isEqualTo: items.document("q7"))
            .getDocuments(source: .server)
        #expect(byDocRefServer.documents.map(\.documentID) == ["q7"])

        cacheReg.remove()

        await writerApp.disconnectSharedBridge()
        await peerApp.disconnectSharedBridge()
    }
}
