import Dispatch
import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

@Suite("firestore-swift Instance & Collection Live-Host Conformance (Rows 1, 2, 5-14, 17, 21, 35-40)", .serialized)
struct FirestoreInstanceLiveHostConformanceTests {

    @Test("firestore-swift#1, #2, #6, #14: default & named-app Firestore singletons, .app binding, and useEmulator over live host")
    func instanceSingletonsAppBindingAndUseEmulatorLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
        FirebaseApp.configure(
            options: FirebaseOptions(
                projectID: "demo-swift-live",
                databaseURL: "https://demo-swift-live-default-rtdb.firebaseio.com",
                apiKey: "swift-default-key",
                googleAppID: "1:500:ios:default"
            )
        )
        Firestore.reset()
        let defaultApp = FirebaseApp.app()
        let defaultDb = Firestore.firestore()
        #expect(defaultDb === Firestore.firestore())
        #expect(defaultDb.app === defaultApp)
        #expect(defaultDb.app.name == "[DEFAULT]")
        defaultDb.useEmulator(host: host, port: port)
        #expect(defaultDb.settings.host == "\(host):\(port)")
        #expect(defaultDb.settings.isSSLEnabled == false)

        let appA = FirebaseApp(
            name: "swift-app-a-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "demo-swift-live", apiKey: "swift-a-key", googleAppID: "1:500:ios:appa")
        )
        let appB = FirebaseApp(
            name: "swift-app-b-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "demo-swift-live", apiKey: "swift-b-key", googleAppID: "1:500:ios:appb")
        )
        do {
            let dbA = Firestore.firestore(app: appA)
            let dbB = Firestore.firestore(app: appB)
            #expect(dbA !== defaultDb)
            #expect(dbA !== dbB)
            #expect(Firestore.firestore(app: appA) === dbA)
            #expect(dbA.app === appA)
            #expect(dbB.app === appB)

            dbA.useEmulator(host: host, port: port)
            dbB.useEmulator(host: host, port: port)

            let tag = UUID().uuidString.lowercased()
            let userDefault = try await Auth.auth(app: defaultApp).createUser(withEmail: "fs-def-\(tag)@example.test", password: "CorrectHorse!01")
            let userA = try await Auth.auth(app: appA).createUser(withEmail: "fs-appa-\(tag)@example.test", password: "CorrectHorse!02")
            let userB = try await Auth.auth(app: appB).createUser(withEmail: "fs-appb-\(tag)@example.test", password: "CorrectHorse!03")

            try await defaultDb.document("users/\(userDefault.user.uid)/items/d1").setData(["owner": "default"])
            let defaultSnap = try await defaultDb.document("users/\(userDefault.user.uid)/items/d1").getDocument(source: .server)
            #expect(defaultSnap.data()?["owner"] as? String == "default")

            try await dbA.document("users/\(userA.user.uid)/items/a1").setData(["owner": "appA"])
            try await dbB.document("users/\(userB.user.uid)/items/b1").setData(["owner": "appB"])

            // Cross-app auth isolation over live host: dbB cannot read userA's protected document.
            await expectBridgeCode(.permissionDenied) {
                _ = try await dbB.document("users/\(userA.user.uid)/items/a1").getDocument(source: .server)
            }
            let readB = try await dbB.document("users/\(userB.user.uid)/items/b1").getDocument(source: .server)
            #expect(readB.data()?["owner"] as? String == "appB")

            await defaultApp.disconnectSharedBridge()
            await appA.disconnectSharedBridge()
            await appB.disconnectSharedBridge()
            Firestore.reset()
            Auth.reset()
            FirebaseApp.resetAppsForTesting()
        } catch {
            await defaultApp.disconnectSharedBridge()
            await appA.disconnectSharedBridge()
            await appB.disconnectSharedBridge()
            Firestore.reset()
            Auth.reset()
            FirebaseApp.resetAppsForTesting()
            throw error
        }
        }
    }

    @Test("firestore-swift#5: Firestore.settings host, sslEnabled, dispatchQueue, cacheSettings, and NSCopying over live host")
    func settingsConfigurationAndDispatchQueueLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "fs-settings", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-settings-\(tag)@example.test",
            password: "CorrectHorse!05"
        )
        let uid = created.user.uid

        let db = Firestore.firestore(app: app)
        #expect(db.settings.host == "\(host):\(port)")
        #expect(db.settings.isSSLEnabled == false)

        let queueKey = DispatchSpecificKey<String>()
        let customQueue = DispatchQueue(label: "dev.pyric.tests.settings-queue")
        customQueue.setSpecific(key: queueKey, value: "custom-settings-queue")

        let configured = try #require(db.settings.copy(with: nil) as? FirestoreSettings)
        #expect(configured == db.settings)
        configured.dispatchQueue = customQueue
        configured.cacheSettings = PersistentCacheSettings(sizeBytes: 32 * 1024 * 1024)
        #expect(configured != db.settings)
        db.settings = configured

        #expect(db.settings.host == "\(host):\(port)")
        #expect(db.settings.sslEnabled == false)
        #expect(db.settings.dispatchQueue === customQueue)
        let persistentCache = try #require(db.settings.cacheSettings as? PersistentCacheSettings)
        #expect(persistentCache.sizeBytes == Int64(32 * 1024 * 1024))

        let docRef = db.document("users/\(uid)/items/settings-doc")
        let writeQueueLabel = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String?, Error>) in
            docRef.setData(["configured": true]) { error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: DispatchQueue.getSpecific(key: queueKey))
                }
            }
        }
        #expect(writeQueueLabel == "custom-settings-queue")

        let (readTitle, readQueueLabel) = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Bool?, String?), Error>) in
            docRef.getDocument(source: .server) { snap, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: (snap?.data()?["configured"] as? Bool, DispatchQueue.getSpecific(key: queueKey)))
                }
            }
        }
        #expect(readTitle == true)
        #expect(readQueueLabel == "custom-settings-queue")
    }

    @Test("firestore-swift#7, #8, #35..40: Firestore.document/collection and CollectionReference operations over live host")
    func documentCollectionAccessorsAndCollectionOperationsLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "fs-coll", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-coll-\(tag)@example.test",
            password: "CorrectHorse!35"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)

        // Rows 7, 8, 35, 36, 37: path canonicalization, collectionID, path, parent (root vs nested).
        let rootUsers = db.collection("/users/")
        #expect(rootUsers.collectionID == "users")
        #expect(rootUsers.path == "users")
        #expect(rootUsers.parent == nil)

        let itemsColl = db.collection("/users/\(uid)/items/")
        #expect(itemsColl.collectionID == "items")
        #expect(itemsColl.path == "users/\(uid)/items")
        #expect(itemsColl.parent?.path == "users/\(uid)")
        #expect(itemsColl.parent?.documentID == uid)

        let slashedDoc = db.document("/users/\(uid)/items/slashed-1/")
        #expect(slashedDoc.path == "users/\(uid)/items/slashed-1")
        #expect(slashedDoc.documentID == "slashed-1")
        try await slashedDoc.setData(["kind": "slashed"])

        // Row 38: CollectionReference.document() auto-ID generation and live write/read.
        let autoDoc1 = itemsColl.document()
        let autoDoc2 = itemsColl.document()
        #expect(autoDoc1.documentID.count == 20)
        #expect(autoDoc2.documentID.count == 20)
        #expect(autoDoc1.documentID != autoDoc2.documentID)
        #expect(autoDoc1.parent.path == "users/\(uid)/items")
        #expect(autoDoc1.documentID.allSatisfy { $0.isLetter || $0.isNumber })
        try await autoDoc1.setData(["kind": "auto-doc"])
        let autoSnap = try await autoDoc1.getDocument(source: .server)
        #expect(autoSnap.exists == true)
        #expect(autoSnap.data()?["kind"] as? String == "auto-doc")

        // Row 39: CollectionReference.document(_:) single-segment and odd multi-segment relative paths.
        let explicitChild = itemsColl.document("explicit-1")
        #expect(explicitChild.path == "users/\(uid)/items/explicit-1")
        try await explicitChild.setData(["kind": "explicit"])

        let nestedRelative = rootUsers.document("\(uid)/items/relative-nested-1")
        #expect(nestedRelative.path == "users/\(uid)/items/relative-nested-1")
        #expect(nestedRelative.documentID == "relative-nested-1")
        try await nestedRelative.setData(["kind": "relative-nested"])
        let nestedSnap = try await itemsColl.document("relative-nested-1").getDocument(source: .server)
        #expect(nestedSnap.data()?["kind"] as? String == "relative-nested")

        // Row 40: CollectionReference.addDocument(data:) async and completion, plus rules denial.
        let addedAsync = try await itemsColl.addDocument(data: ["kind": "added-async", "n": 1])
        #expect(addedAsync.documentID.count == 20)
        #expect(addedAsync.parent.path == itemsColl.path)
        let addedAsyncServer = try await addedAsync.getDocument(source: .server)
        #expect(addedAsyncServer.data()?["kind"] as? String == "added-async")
        let addedAsyncCache = try await addedAsync.getDocument(source: .cache)
        #expect(addedAsyncCache.data()?["kind"] as? String == "added-async")

        var addedViaCallbackRef: DocumentReference?
        try await awaitVoidCompletion { done in
            addedViaCallbackRef = itemsColl.addDocument(data: ["kind": "added-callback", "n": 2], completion: done)
        }
        let callbackRef = try #require(addedViaCallbackRef)
        #expect(callbackRef.documentID.count == 20)
        #expect(callbackRef.documentID != addedAsync.documentID)
        let callbackServer = try await callbackRef.getDocument(source: .server)
        #expect(callbackServer.data()?["kind"] as? String == "added-callback")

        await expectBridgeCode(.permissionDenied) {
            _ = try await db.collection("users/other-\(tag)/items").addDocument(data: ["spoof": true])
        }
    }

    @Test("firestore-swift#9: Firestore.collectionGroup(_:) queries across nested parents and enforces rules over live host")
    func collectionGroupLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app1 = makeLiveApp(prefix: "fs-cg-1", host: host, port: port)
        let app2 = makeLiveApp(prefix: "fs-cg-2", host: host, port: port)
        defer {
            Task {
                await app1.disconnectSharedBridge()
                await app2.disconnectSharedBridge()
            }
        }

        let tag = UUID().uuidString.lowercased()
        let user1 = try await Auth.auth(app: app1).createUser(withEmail: "fs-cg1-\(tag)@example.test", password: "CorrectHorse!09")
        let user2 = try await Auth.auth(app: app2).createUser(withEmail: "fs-cg2-\(tag)@example.test", password: "CorrectHorse!09")
        let uid1 = user1.user.uid
        let uid2 = user2.user.uid
        let db1 = Firestore.firestore(app: app1)
        let db2 = Firestore.firestore(app: app2)

        try await db1.document("users/\(uid1)/rooms/room-a/entries/e-1").setData(["ownerUid": uid1, "tag": tag, "seq": 1])
        try await db1.document("users/\(uid1)/rooms/room-b/entries/e-2").setData(["ownerUid": uid1, "tag": tag, "seq": 2])
        try await db2.document("users/\(uid2)/rooms/room-c/entries/e-3").setData(["ownerUid": uid2, "tag": tag, "seq": 3])

        let groupQuery = db1.collectionGroup("entries")
        #expect(groupQuery.isCollectionGroup == true)
        #expect(groupQuery.collectionID == "entries")

        let matching = try await groupQuery
            .whereField("ownerUid", isEqualTo: uid1)
            .order(by: "seq")
            .getDocuments(source: .server)
        #expect(matching.documents.map(\.documentID) == ["e-1", "e-2"])
        #expect(matching.documents.map(\.reference.path) == [
            "users/\(uid1)/rooms/room-a/entries/e-1",
            "users/\(uid1)/rooms/room-b/entries/e-2"
        ])

        // Unconstrained collectionGroup query cannot prove resource.data.ownerUid == request.auth.uid.
        await expectBridgeCode(.permissionDenied) {
            _ = try await groupQuery.getDocuments(source: .server)
        }
    }

    @Test("firestore-swift#10: Firestore.batch() atomic mutations and all-or-nothing rule denial rollback over live host")
    func writeBatchAtomicityLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "fs-batch", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let tag = UUID().uuidString.lowercased()
        let created = try await Auth.auth(app: app).createUser(
            withEmail: "fs-batch-\(tag)@example.test",
            password: "CorrectHorse!10"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)

        let keepUpdateRef = db.document("users/\(uid)/items/b-update")
        let mergeRef = db.document("users/\(uid)/items/b-merge")
        let deleteRef = db.document("users/\(uid)/items/b-delete")
        let createRef = db.document("users/\(uid)/items/b-create")

        try await keepUpdateRef.setData(["count": 1, "label": "initial"])
        try await mergeRef.setData(["preserved": "yes", "v": 1])
        try await deleteRef.setData(["ephemeral": true])

        let batch1 = db.batch()
        batch1
            .setData(["created": true], forDocument: createRef)
            .setData(["v": 2], forDocument: mergeRef, merge: true)
            .updateData(["count": 5], forDocument: keepUpdateRef)
            .deleteDocument(deleteRef)
        try await batch1.commit()

        #expect(try await createRef.getDocument(source: .server).data()?["created"] as? Bool == true)
        let mergedData = try await mergeRef.getDocument(source: .server).data()
        #expect(mergedData?["preserved"] as? String == "yes")
        #expect(mergedData?["v"] as? Int64 == 2)
        #expect(try await keepUpdateRef.getDocument(source: .server).data()?["count"] as? Int64 == 5)
        #expect(try await deleteRef.getDocument(source: .server).exists == false)

        // Completion overload + atomic rollback when any single write is denied by Security Rules.
        let batch2 = db.batch()
        let cbRef = db.document("users/\(uid)/items/b-callback")
        batch2.setData(["ok": true], forDocument: cbRef)
        try await awaitVoidCompletion { done in
            batch2.commit(completion: done)
        }
        #expect(try await cbRef.getDocument(source: .server).exists == true)

        let shouldRollbackRef = db.document("users/\(uid)/items/b-rolled-back")
        let deniedBatch = db.batch()
        deniedBatch
            .setData(["shouldNotPersist": true], forDocument: shouldRollbackRef)
            .setData(["forbidden": true], forDocument: db.document("users/other-\(tag)/items/nope"))
        await expectBridgeCode(.permissionDenied) {
            try await deniedBatch.commit()
        }
        #expect(try await shouldRollbackRef.getDocument(source: .server).exists == false)
    }

    @Test("firestore-swift#11, #12, #13: runTransaction async, callback, TransactionOptions, and live read-set conflict retry")
    func transactionsAndConflictRetryLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app1 = makeLiveApp(prefix: "fs-txn-1", host: host, port: port)
        let app2 = makeLiveApp(prefix: "fs-txn-2", host: host, port: port)
        defer {
            Task {
                await app1.disconnectSharedBridge()
                await app2.disconnectSharedBridge()
            }
        }

        let tag = UUID().uuidString.lowercased()
        let email = "fs-txn-\(tag)@example.test"
        let password = "CorrectHorse!11"
        let created = try await Auth.auth(app: app1).createUser(withEmail: email, password: password)
        _ = try await Auth.auth(app: app2).signIn(withEmail: email, password: password)
        let uid = created.user.uid

        let db1 = Firestore.firestore(app: app1)
        let db2 = Firestore.firestore(app: app2)

        let counterRef1 = db1.document("users/\(uid)/items/txn-counter")
        let counterRef2 = db2.document("users/\(uid)/items/txn-counter")
        try await counterRef1.setData(["count": 10])

        // Row 13: async runTransaction with real optimistic concurrency conflict on attempt 1 -> retries and commits!
        let asyncAttempts = IntBox()
        let nextCount = try await db1.runTransaction { txn -> Any? in
            let attempt = asyncAttempts.increment()
            let snap = try await txn.getDocument(counterRef1)
            let current = (snap.data()?["count"] as? Int64) ?? 0
            if attempt == 1 {
                // Concurrent external write invalidates attempt 1's read-set before txnCommit.
                try await counterRef2.setData(["count": 25])
            }
            let updated = current + 1
            txn.updateData(["count": updated], forDocument: counterRef1)
            return updated
        }
        #expect(asyncAttempts.value == 2)
        #expect(nextCount as? Int64 == 26)
        #expect(try await counterRef2.getDocument(source: .server).data()?["count"] as? Int64 == 26)
        #expect(try await counterRef1.getDocument(source: .cache).data()?["count"] as? Int64 == 26)

        // Row 12: TransactionOptions(maxAttempts: 1) stops without retrying when read-set conflicts.
        let singleAttemptCounter = IntBox()
        await expectBridgeCode(.aborted) {
            _ = try await db1.runTransaction(options: TransactionOptions(maxAttempts: 1)) { txn in
                _ = singleAttemptCounter.increment()
                _ = try await txn.getDocument(counterRef1)
                try await counterRef2.setData(["count": 40])
                txn.setData(["count": 999], forDocument: counterRef1)
                return nil
            }
        }
        #expect(singleAttemptCounter.value == 1)
        #expect(try await counterRef2.getDocument(source: .server).data()?["count"] as? Int64 == 40)

        // Row 11 & #12 completion overloads: synchronous Transaction.getDocument(_:error:) and NSErrorPointer abort.
        let callbackResult = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Int64?, Error>) in
            let opts = TransactionOptions(maxAttempts: 3)
            db1.runTransaction(options: opts, block: { txn, errorPointer in
                guard let snap = txn.getDocument(counterRef1, error: errorPointer) else {
                    return nil
                }
                let val = ((snap.data()?["count"] as? Int64) ?? 0) + 5
                txn.updateData(["count": val], forDocument: counterRef1)
                return val
            }, completion: { value, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: value as? Int64)
                }
            })
        }
        #expect(callbackResult == 45)
        #expect(try await counterRef2.getDocument(source: .server).data()?["count"] as? Int64 == 45)

        let customDomainError = NSError(domain: "dev.pyric.txn", code: 77, userInfo: nil)
        let abortedError = await withCheckedContinuation { (cont: CheckedContinuation<NSError?, Never>) in
            db1.runTransaction({ txn, errorPointer in
                _ = txn.getDocument(counterRef1, error: errorPointer)
                txn.setData(["count": 9999], forDocument: counterRef1)
                errorPointer?.pointee = customDomainError
                return nil
            }, completion: { _, error in
                cont.resume(returning: error as NSError?)
            })
        }
        #expect(abortedError?.domain == "dev.pyric.txn")
        #expect(abortedError?.code == 77)
        #expect(try await counterRef2.getDocument(source: .server).data()?["count"] as? Int64 == 45)
    }

    @Test("firestore-swift#17: terminate() cancels active listeners, rejects post-terminate calls, and re-creates fresh handle")
    func terminateLifecycleLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app1 = makeLiveApp(prefix: "fs-term-1", host: host, port: port)
        let app2 = makeLiveApp(prefix: "fs-term-2", host: host, port: port)
        defer {
            Task {
                await app1.disconnectSharedBridge()
                await app2.disconnectSharedBridge()
            }
        }

        let tag = UUID().uuidString.lowercased()
        let email = "fs-term-\(tag)@example.test"
        let password = "CorrectHorse!17"
        let created = try await Auth.auth(app: app1).createUser(withEmail: email, password: password)
        _ = try await Auth.auth(app: app2).signIn(withEmail: email, password: password)
        let uid = created.user.uid

        let db1 = Firestore.firestore(app: app1)
        let externalDb = Firestore.firestore(app: app2)
        let docPath = "users/\(uid)/items/term-doc"
        try await db1.document(docPath).setData(["step": "v1"])

        let events = SyncEventLog()
        let reg = db1.document(docPath).addSnapshotListener { snap, _ in
            if let step = snap?.data()?["step"] as? String {
                events.append(step)
            }
        }
        try await events.waitForCount(1)
        #expect(events.values == ["v1"])

        try await db1.terminate()
        try await externalDb.document(docPath).setData(["step": "v2-after-terminate"])
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(events.values == ["v1"])
        reg.remove()

        await expectBridgeCode(.failedPrecondition) {
            _ = try await db1.document(docPath).getDocument()
        }
        await expectBridgeCode(.failedPrecondition) {
            try await db1.document(docPath).setData(["step": "rejected"])
        }
        await expectBridgeCode(.failedPrecondition) {
            _ = try await db1.collection("users/\(uid)/items").getDocuments()
        }
        await expectBridgeCode(.failedPrecondition) {
            let b = db1.batch()
            b.setData(["step": "rejected"], forDocument: db1.document(docPath))
            try await b.commit()
        }
        await expectBridgeCode(.failedPrecondition) {
            _ = try await db1.runTransaction { _ in return nil }
        }

        // Fresh Firestore.firestore(app:) after terminate() succeeds and reads live server data.
        let db2 = Firestore.firestore(app: app1)
        #expect(db2 !== db1)
        let freshSnap = try await db2.document(docPath).getDocument(source: .server)
        #expect(freshSnap.data()?["step"] as? String == "v2-after-terminate")

        try await awaitVoidCompletion { done in
            db2.terminate(completion: done)
        }
        await expectBridgeCode(.failedPrecondition) {
            _ = try await db2.document(docPath).getDocument()
        }
    }

    @Test("firestore-swift#21: getQuery(named:completion:) and async getQuery(named:) over bundled cache and live host")
    func getQueryNamedLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "fs-nq", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let tag = UUID().uuidString.lowercased()
        let created = try await Auth.auth(app: app).createUser(
            withEmail: "fs-nq-\(tag)@example.test",
            password: "CorrectHorse!21"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)

        // Unknown named query before bundle load resolves to nil on both async and completion APIs.
        #expect(await db.getQuery(named: "active-items") == nil)
        let missingBeforeLoad = await withCheckedContinuation { (cont: CheckedContinuation<Query?, Never>) in
            db.getQuery(named: "active-items") { query in
                cont.resume(returning: query)
            }
        }
        #expect(missingBeforeLoad == nil)

        // Fire-and-forget loadBundle followed immediately by getQuery(named:completion:) resolves in FIFO order.
        let bundleData = makeNamedQueryBundle(uid: uid)
        let _: LoadBundleTask = db.loadBundle(bundleData)
        let activeQueryViaCompletion = await withCheckedContinuation { (cont: CheckedContinuation<Query?, Never>) in
            db.getQuery(named: "active-items") { query in
                cont.resume(returning: query)
            }
        }
        let activeQuery = try #require(activeQueryViaCompletion)
        #expect(await db.getQuery(named: "non-existent-query") == nil)

        // Execute retrieved named query offline against cache: filters active == true, orders by rank, limits to 2.
        try await db.disableNetwork()
        let cachedSnap = try await activeQuery.getDocuments(source: .cache)
        #expect(cachedSnap.metadata.isFromCache == true)
        #expect(cachedSnap.documents.map(\.documentID) == ["nq-alpha", "nq-gamma"])

        let groupNamedQuery = try #require(await db.getQuery(named: "owner-entries-group"))
        #expect(groupNamedQuery.isCollectionGroup == true)
        let cachedGroupSnap = try await groupNamedQuery.getDocuments(source: .cache)
        #expect(cachedGroupSnap.documents.map(\.documentID) == ["ge-1"])

        // Re-enable network, seed live server documents, and execute the retrieved named query against .server!
        try await db.enableNetwork()
        try await db.document("users/\(uid)/items/srv-1").setData(["title": "Srv1", "active": true, "rank": 10])
        try await db.document("users/\(uid)/items/srv-2").setData(["title": "Srv2", "active": false, "rank": 15])
        try await db.document("users/\(uid)/items/srv-3").setData(["title": "Srv3", "active": true, "rank": 20])
        try await db.document("users/\(uid)/items/srv-4").setData(["title": "Srv4", "active": true, "rank": 30])

        let liveSnap = try await activeQuery.getDocuments(source: .server)
        #expect(liveSnap.metadata.isFromCache == false)
        #expect(liveSnap.documents.map(\.documentID) == ["srv-1", "srv-3"])

        // Terminated client returns nil, and clearPersistence removes stored named queries.
        try await db.terminate()
        #expect(await db.getQuery(named: "active-items") == nil)
        try await db.clearPersistence()

        let dbAfterClear = Firestore.firestore(app: app)
        #expect(await dbAfterClear.getQuery(named: "active-items") == nil)
    }
}
