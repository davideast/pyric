import Dispatch
import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

@Suite("firestore-swift Document CRUD & Listener Live-Host Conformance (Rows 22-34)", .serialized)
struct FirestoreCrudLiveHostConformanceTests {

    @Test("firestore-swift#22, #23, #24, #25: DocumentReference documentID, path, parent, and collection(_:) over live host")
    func documentIdentityHierarchyAndSubcollectionsLiveHostConformance() async throws {
        try await withLiveCrudSession(prefix: "crud-id") { db, uid in
            let userDoc = db.document("users/\(uid)")
            #expect(userDoc.documentID == uid)
            #expect(userDoc.path == "users/\(uid)")
            #expect(userDoc.parent.path == "users")
            #expect(userDoc.parent.collectionID == "users")
            #expect(userDoc.parent.parent == nil)

            let itemsCol = userDoc.collection("items")
            #expect(itemsCol.path == "users/\(uid)/items")
            #expect(itemsCol.collectionID == "items")
            #expect(itemsCol.parent == userDoc)

            let slashedItemsCol = userDoc.collection("/items/")
            #expect(slashedItemsCol.path == "users/\(uid)/items")

            let entriesCol = userDoc.collection("rooms/r-alpha/entries")
            #expect(entriesCol.path == "users/\(uid)/rooms/r-alpha/entries")
            #expect(entriesCol.collectionID == "entries")
            #expect(entriesCol.parent?.path == "users/\(uid)/rooms/r-alpha")
            #expect(entriesCol.parent?.documentID == "r-alpha")

            let entryRef = entriesCol.document("entry-1")
            #expect(entryRef.documentID == "entry-1")
            #expect(entryRef.path == "users/\(uid)/rooms/r-alpha/entries/entry-1")
            #expect(entryRef.parent.path == "users/\(uid)/rooms/r-alpha/entries")
            #expect(entryRef == db.document("users/\(uid)/rooms/r-alpha/entries/entry-1"))
            #expect(entryRef.hashValue == db.document("users/\(uid)/rooms/r-alpha/entries/entry-1").hashValue)

            try await entryRef.setData(["note": "nested-live", "seq": 1])
            let snap = try await entryRef.getDocument(source: .server)
            #expect(snap.exists == true)
            #expect(snap.documentID == "entry-1")
            #expect(snap.reference == entryRef)
            #expect(snap.data()?["note"] as? String == "nested-live")
        }
    }

    @Test("firestore-swift#26: DocumentReference.getDocument(source:) across default, server, cache, offline, completion, and rules")
    func getDocumentSourcesOfflineAndSecurityRulesLiveHostConformance() async throws {
        try await withLiveCrudSession(prefix: "crud-get") { db, uid in
            let items = db.collection("users/\(uid)/items")
            let missingRef = items.document("missing-doc")

            let missingServer = try await missingRef.getDocument(source: .server)
            #expect(missingServer.exists == false)
            #expect(missingServer.data() == nil)
            #expect(missingServer.documentID == "missing-doc")
            #expect(missingServer.metadata.isFromCache == false)

            // Cold cache for an uncached path throws .unavailable.
            await expectBridgeCode(.unavailable) {
                _ = try await items.document("never-fetched").getDocument(source: .cache)
            }

            let targetRef = items.document("doc-source-1")
            try await targetRef.setData(["title": "Warm", "version": 1])

            let fromDefault = try await targetRef.getDocument()
            #expect(fromDefault.exists == true)
            #expect(fromDefault.metadata.isFromCache == false)
            #expect(fromDefault.data()?["title"] as? String == "Warm")

            let fromCacheOnline = try await targetRef.getDocument(source: .cache)
            #expect(fromCacheOnline.exists == true)
            #expect(fromCacheOnline.metadata.isFromCache == true)
            #expect(fromCacheOnline.data()?["title"] as? String == "Warm")

            try await db.disableNetwork()
            let fromDefaultOffline = try await targetRef.getDocument(source: .default)
            #expect(fromDefaultOffline.exists == true)
            #expect(fromDefaultOffline.metadata.isFromCache == true)
            #expect(fromDefaultOffline.data()?["version"] as? Int64 == 1)

            let fromCacheOffline = try await targetRef.getDocument(source: .cache)
            #expect(fromCacheOffline.exists == true)
            #expect(fromCacheOffline.metadata.isFromCache == true)

            await expectBridgeCode(.unavailable) {
                _ = try await targetRef.getDocument(source: .server)
            }
            try await db.enableNetwork()

            // Completion-handler overloads (default and explicit source).
            let cbDefault = try await awaitSnapshotCompletion { cb in
                targetRef.getDocument(completion: cb)
            }
            #expect(cbDefault.exists == true)
            #expect(cbDefault.data()?["title"] as? String == "Warm")

            let cbCache = try await awaitSnapshotCompletion { cb in
                targetRef.getDocument(source: .cache, completion: cb)
            }
            #expect(cbCache.metadata.isFromCache == true)

            // Security Rules deny reading another user's document.
            await expectBridgeCode(.permissionDenied) {
                _ = try await db.document("users/other-\(uid)/items/secret").getDocument(source: .server)
            }
        }
    }

    @Test("firestore-swift#27, #28, #29: DocumentReference setData overwrite, setData(merge:), and setData(mergeFields:) over live host")
    func setDataOverwriteMergeAndMergeFieldsLiveHostConformance() async throws {
        try await withLiveCrudSession(prefix: "crud-set") { db, uid in
            let docRef = db.document("users/\(uid)/items/set-ops")

            // #27: setData(_:) overwrites existing top-level and nested map fields completely.
            try await docRef.setData([
                "title": "Initial",
                "legacy": "remove-on-overwrite",
                "nested": ["a": 1, "b": 2]
            ])
            try await docRef.setData([
                "title": "Replaced",
                "nested": ["a": 10]
            ])
            let overwritten = try await docRef.getDocument(source: .server)
            #expect(overwritten.data()?["title"] as? String == "Replaced")
            #expect(overwritten.data()?["legacy"] == nil)
            let overwrittenNested = overwritten.data()?["nested"] as? [String: Any]
            #expect(overwrittenNested?["a"] as? Int64 == 10)
            #expect(overwrittenNested?["b"] == nil)

            try await awaitVoidCompletion { cb in
                docRef.setData(["title": "CallbackOverwrite", "nested": ["x": 1, "y": 2]], completion: cb)
            }

            // #28: setData(_:merge: true) deep-merges nested maps without clobbering unspecified keys.
            try await docRef.setData([
                "nested": ["y": 20, "z": 30],
                "badge": "gold"
            ], merge: true)
            let merged = try await docRef.getDocument(source: .server)
            #expect(merged.data()?["title"] as? String == "CallbackOverwrite")
            #expect(merged.data()?["badge"] as? String == "gold")
            let mergedNested = merged.data()?["nested"] as? [String: Any]
            #expect(mergedNested?["x"] as? Int64 == 1)
            #expect(mergedNested?["y"] as? Int64 == 20)
            #expect(mergedNested?["z"] as? Int64 == 30)

            try await awaitVoidCompletion { cb in
                docRef.setData(["nested": ["z": FieldValue.delete()], "extra": true], merge: true, completion: cb)
            }
            let afterMergeCallback = try await docRef.getDocument(source: .server)
            let nestedAfterDelete = afterMergeCallback.data()?["nested"] as? [String: Any]
            #expect(nestedAfterDelete?["x"] as? Int64 == 1)
            #expect(nestedAfterDelete?["z"] == nil)
            #expect(afterMergeCallback.data()?["extra"] as? Bool == true)

            // setData(_:merge: false) acts as full overwrite.
            try await docRef.setData([
                "title": "Reset",
                "stats": ["a": 1, "b": 2],
                "meta": ["v1": "nested-keep"],
                "meta.v1": "old-literal-dot"
            ], merge: false)
            let resetSnap = try await docRef.getDocument(source: .server)
            #expect(resetSnap.data()?["badge"] == nil)
            #expect(resetSnap.data()?["extra"] == nil)

            // #29: setData(_:mergeFields:) writes ONLY masked String, nested, and literal-dot FieldPath entries.
            try await docRef.setData(
                [
                    "title": "MaskedTitle",
                    "unmaskedTop": "must-not-write",
                    "stats": ["a": 99, "unmaskedNested": 777],
                    "meta.v1": "new-literal-dot",
                    "meta": ["v1": "must-not-clobber"]
                ],
                mergeFields: ["title", FieldPath(["stats", "a"]), FieldPath(["meta.v1"])]
            )
            let maskedSnap = try await docRef.getDocument(source: .server)
            #expect(maskedSnap.data()?["title"] as? String == "MaskedTitle")
            #expect(maskedSnap.data()?["unmaskedTop"] == nil)
            let maskedStats = maskedSnap.data()?["stats"] as? [String: Any]
            #expect(maskedStats?["a"] as? Int64 == 99)
            #expect(maskedStats?["b"] as? Int64 == 2)
            #expect(maskedStats?["unmaskedNested"] == nil)
            #expect(maskedSnap.get(FieldPath(["meta.v1"])) as? String == "new-literal-dot")
            #expect(maskedSnap.get(FieldPath(["meta", "v1"])) as? String == "nested-keep")

            // Local cache projection also preserves literal-dot mergeFields without touching sibling nested "meta.v1".
            let maskedCache = try await docRef.getDocument(source: .cache)
            #expect(maskedCache.get(FieldPath(["meta.v1"])) as? String == "new-literal-dot")
            #expect(maskedCache.get(FieldPath(["meta", "v1"])) as? String == "nested-keep")

            try await awaitVoidCompletion { cb in
                docRef.setData(
                    ["stats": ["b": 222, "ignored": 0]],
                    mergeFields: ["stats.b"],
                    completion: cb
                )
            }
            let maskedCbSnap = try await docRef.getDocument(source: .server)
            let maskedCbStats = maskedCbSnap.data()?["stats"] as? [String: Any]
            #expect(maskedCbStats?["a"] as? Int64 == 99)
            #expect(maskedCbStats?["b"] as? Int64 == 222)
            #expect(maskedCbStats?["ignored"] == nil)

            // Specifying a top-level OR nested mergeField absent from data fails closed with PyricFirestoreError.
            await #expect(throws: PyricFirestoreError.self) {
                try await docRef.setData(["title": "Valid"], mergeFields: ["missingField"])
            }
            await #expect(throws: PyricFirestoreError.self) {
                try await docRef.setData(["stats": ["a": 1]], mergeFields: ["stats.missingNested"])
            }

            await expectBridgeCode(.permissionDenied) {
                try await db.document("users/other-\(uid)/items/denied").setData(["title": "Nope"])
            }
        }
    }

    @Test("firestore-swift#30, #31: DocumentReference updateData(_:) and delete() including literal-dot FieldPath and missing-doc semantics")
    func updateDataAndDeleteLiveHostConformance() async throws {
        try await withLiveCrudSession(prefix: "crud-upd-del") { db, uid in
            let items = db.collection("users/\(uid)/items")
            let missingRef = items.document("missing-update-target")

            // #30: updateData on a non-existent document fails with .notFound.
            await expectBridgeCode(.notFound) {
                try await missingRef.updateData(["title": "Ghost"])
            }

            let docRef = items.document("update-target")
            try await docRef.setData([
                "title": "V1",
                "profile": ["rank": 1, "tier": "bronze"],
                "meta.v1": ["flag": "initial", "keep": true]
            ])

            // Update top-level String, dotted nested path, multi-segment FieldPath, and literal-dot FieldPath.
            try await docRef.updateData([
                "title": "V2",
                "profile.rank": 2,
                FieldPath(["profile", "badge"]): "verified",
                FieldPath(["meta.v1", "flag"]): "updated-literal-dot"
            ])

            let serverSnap = try await docRef.getDocument(source: .server)
            #expect(serverSnap.data()?["title"] as? String == "V2")
            let profile = serverSnap.data()?["profile"] as? [String: Any]
            #expect(profile?["rank"] as? Int64 == 2)
            #expect(profile?["tier"] as? String == "bronze")
            #expect(profile?["badge"] as? String == "verified")
            let literalDotMap = serverSnap.data()?["meta.v1"] as? [String: Any]
            #expect(literalDotMap?["flag"] as? String == "updated-literal-dot")
            #expect(literalDotMap?["keep"] as? Bool == true)
            #expect(serverSnap.data()?["meta"] == nil)
            #expect(serverSnap.get(FieldPath(["meta.v1", "flag"])) as? String == "updated-literal-dot")

            // Local cache also reflects the literal-dot segment update accurately.
            let cacheSnap = try await docRef.getDocument(source: .cache)
            #expect(cacheSnap.get(FieldPath(["meta.v1", "flag"])) as? String == "updated-literal-dot")

            try await awaitVoidCompletion { cb in
                docRef.updateData(["profile.rank": 3], completion: cb)
            }
            let afterCb = try await docRef.getDocument(source: .server)
            #expect(afterCb.get("profile.rank") as? Int64 == 3)

            // #31: delete() evicts local cache entry immediately, removes document on server, and is idempotent.
            try await docRef.delete()
            await expectBridgeCode(.unavailable) {
                _ = try await docRef.getDocument(source: .cache)
            }
            let deletedServer = try await docRef.getDocument(source: .server)
            #expect(deletedServer.exists == false)
            let negativeCached = try await docRef.getDocument(source: .cache)
            #expect(negativeCached.exists == false)
            #expect(negativeCached.metadata.isFromCache == true)

            // Deleting an already-absent document succeeds without throwing.
            try await docRef.delete()

            let cbDeleteRef = items.document("delete-via-callback")
            try await cbDeleteRef.setData(["temp": true])
            try await awaitVoidCompletion { cb in
                cbDeleteRef.delete(completion: cb)
            }
            #expect(try await cbDeleteRef.getDocument(source: .server).exists == false)

            await expectBridgeCode(.permissionDenied) {
                try await db.document("users/other-\(uid)/items/protected").delete()
            }
        }
    }

    @Test("firestore-swift#32, #33, #34: DocumentReference addSnapshotListener, includeMetadataChanges, and SnapshotListenOptions over live host")
    func documentSnapshotListenersAndMetadataOptionsLiveHostConformance() async throws {
        try await withLiveCrudSession(prefix: "crud-listen") { db, uid in
            let docRef = db.document("users/\(uid)/items/live-doc")
            let basicCollector = DocEventCollector()

            // #32: Basic addSnapshotListener receives initial missing state, live writes, delete, and stops after remove().
            let basicReg = docRef.addSnapshotListener { snap, err in
                basicCollector.record(snap: snap, err: err)
            }
            let initialMissing = try await basicCollector.waitForCount(1)
            #expect(initialMissing.last?.exists == false)

            try await docRef.setData(["step": "created", "count": 1])
            let afterCreate = try await basicCollector.waitForCount(2)
            #expect(afterCreate.last?.exists == true)
            #expect(afterCreate.last?.step == "created")

            try await docRef.updateData(["step": "updated", "count": 2])
            let afterUpdate = try await basicCollector.waitForCount(3)
            #expect(afterUpdate.last?.step == "updated")

            try await docRef.delete()
            let afterDelete = try await basicCollector.waitForCount(4)
            #expect(afterDelete.last?.exists == false)

            basicReg.remove()
            try await docRef.setData(["step": "post-remove", "count": 3])
            try await Task.sleep(nanoseconds: 80_000_000)
            #expect(basicCollector.snapshotCount == 4)

            // Unauthorized online listener receives permission-denied error asynchronously.
            let deniedCollector = DocEventCollector()
            let deniedReg = db.document("users/other-\(uid)/items/forbidden").addSnapshotListener { snap, err in
                deniedCollector.record(snap: snap, err: err)
            }
            let deniedErr = try await deniedCollector.waitForError()
            let bridgeDenied = try #require(deniedErr as? PyricBridgeError)
            #expect(bridgeDenied.code == .permissionDenied)
            deniedReg.remove()

            // #34 (ListenSource.cache): SnapshotListenOptions(source: .cache) reads local cache only (never subscribes to server)
            // and reacts to local cache mutations while online without firing on unchanged-content redeliveries.
            let unauthedCacheCollector = DocEventCollector()
            let unauthedCacheReg = db.document("users/other-\(uid)/items/forbidden").addSnapshotListener(
                options: SnapshotListenOptions().withSource(.cache)
            ) { snap, err in
                unauthedCacheCollector.record(snap: snap, err: err)
            }
            let unauthedCacheEvents = try await unauthedCacheCollector.waitForCount(1)
            #expect(unauthedCacheEvents.last?.exists == false)
            #expect(unauthedCacheEvents.last?.isFromCache == true)
            unauthedCacheReg.remove()

            let cacheTargetRef = db.document("users/\(uid)/items/cache-source-doc")
            try await cacheTargetRef.setData(["step": "warm-cache"])
            _ = try await cacheTargetRef.getDocument(source: .server)

            let cacheOnlyCollector = DocEventCollector()
            let cacheOnlyReg = cacheTargetRef.addSnapshotListener(
                options: SnapshotListenOptions(includeMetadataChanges: false, source: .cache)
            ) { snap, err in
                cacheOnlyCollector.record(snap: snap, err: err)
            }
            let cacheInit = try await cacheOnlyCollector.waitForCount(1)
            #expect(cacheInit.last?.step == "warm-cache")
            #expect(cacheInit.last?.isFromCache == true)

            // Remote write on another FirebaseApp does NOT trigger ListenSource.cache listener while online.
            let ownerEmail = try #require(Auth.auth(app: db.app).currentUser?.email)
            let (peerApp, peerDb) = try await makePeerApp(prefix: "crud-peer", email: ownerEmail, password: "CorrectHorse!99")
            do {
                try await peerDb.document(cacheTargetRef.path).setData(["step": "remote-only"])
                try await Task.sleep(nanoseconds: 60_000_000)
                #expect(cacheOnlyCollector.snapshotCount == 1)
                await peerApp.disconnectSharedBridge()
            } catch {
                await peerApp.disconnectSharedBridge()
                throw error
            }

            // Local online write updates local cache and triggers ListenSource.cache listener; identical rewrite suppresses duplicate.
            try await cacheTargetRef.setData(["step": "local-cache-hit"])
            let cacheHit = try await cacheOnlyCollector.waitForCount(2)
            #expect(cacheHit.last?.step == "local-cache-hit")
            #expect(cacheHit.last?.isFromCache == true)

            try await cacheTargetRef.setData(["step": "local-cache-hit"])
            try await Task.sleep(nanoseconds: 60_000_000)
            #expect(cacheOnlyCollector.snapshotCount == 2)
            cacheOnlyReg.remove()

            // #33 & #34: includeMetadataChanges: true and SnapshotListenOptions(includeMetadataChanges:).
            let metaDocRef = db.document("users/\(uid)/items/meta-doc")
            try await metaDocRef.setData(["phase": "online-seed"])

            let metaCollector = DocEventCollector()
            let optionsTrueCollector = DocEventCollector()
            let optionsFalseCollector = DocEventCollector()

            let metaReg = metaDocRef.addSnapshotListener(includeMetadataChanges: true) { snap, err in
                metaCollector.record(snap: snap, err: err)
            }
            let optsTrueReg = metaDocRef.addSnapshotListener(
                options: SnapshotListenOptions(includeMetadataChanges: true)
            ) { snap, err in
                optionsTrueCollector.record(snap: snap, err: err)
            }
            let optsFalseReg = metaDocRef.addSnapshotListener(
                options: SnapshotListenOptions(includeMetadataChanges: false)
            ) { snap, err in
                optionsFalseCollector.record(snap: snap, err: err)
            }

            let initMeta = try await metaCollector.waitForCount(1)
            _ = try await optionsTrueCollector.waitForCount(1)
            _ = try await optionsFalseCollector.waitForCount(1)
            #expect(initMeta.last?.hasPendingWrites == false)
            #expect(initMeta.last?.isFromCache == false)

            // Transition offline: metadata-enabled listeners receive cache transition; metadata-false suppresses it.
            try await db.disableNetwork()
            let offlineGapMeta = try await metaCollector.waitForCount(2)
            let offlineGapOpts = try await optionsTrueCollector.waitForCount(2)
            #expect(offlineGapMeta.last?.isFromCache == true)
            #expect(offlineGapOpts.last?.isFromCache == true)

            // Stage an offline update: all three receive the projected value with hasPendingWrites == true.
            let offlineWriteTask = Task {
                try await metaDocRef.updateData(["phase": "offline-staged"])
            }
            let stagedMeta = try await metaCollector.waitForWhere {
                $0.step == "offline-staged" && $0.hasPendingWrites && $0.isFromCache
            }
            let stagedOptsTrue = try await optionsTrueCollector.waitForWhere {
                $0.step == "offline-staged" && $0.hasPendingWrites && $0.isFromCache
            }
            let stagedOptsFalse = try await optionsFalseCollector.waitForWhere {
                $0.step == "offline-staged"
            }
            #expect(stagedMeta.hasPendingWrites == true)
            #expect(stagedOptsTrue.hasPendingWrites == true)
            #expect(stagedOptsFalse.step == "offline-staged")
            let countBeforeFlush = optionsFalseCollector.snapshotCount

            // Re-enable network: pending write flushes and metadata listeners observe settled server state.
            try await db.enableNetwork()
            try await offlineWriteTask.value

            let settledMeta = try await metaCollector.waitForWhere {
                $0.step == "offline-staged" && !$0.hasPendingWrites && !$0.isFromCache
            }
            let settledOptsTrue = try await optionsTrueCollector.waitForWhere {
                $0.step == "offline-staged" && !$0.hasPendingWrites && !$0.isFromCache
            }
            #expect(settledMeta.isFromCache == false)
            #expect(settledOptsTrue.isFromCache == false)

            try await Task.sleep(nanoseconds: 80_000_000)
            // SnapshotListenOptions(includeMetadataChanges: false) suppresses metadata-only sync event.
            #expect(optionsFalseCollector.snapshotCount == countBeforeFlush)

            metaReg.remove()
            optsTrueReg.remove()
            optsFalseReg.remove()
        }
    }
}
