import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth

@Suite("firestore-swift Instance & Lifecycle Live-Host Conformance (Rows 15, 16, 18, 19, 20)", .serialized)
struct FirestoreLifecycleLiveHostConformanceTests {

    @Test("firestore-swift#15 & #18: disableNetwork, enableNetwork, and waitForPendingWrites over live host")
    func networkToggleAndPendingWritesLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let writerApp = makeLiveApp(prefix: "fs-net-writer", host: host, port: port)
        let readerApp = makeLiveApp(prefix: "fs-net-reader", host: host, port: port)
        defer {
            Task {
                await writerApp.disconnectSharedBridge()
                await readerApp.disconnectSharedBridge()
            }
        }

        let writerAuth = Auth.auth(app: writerApp)
        let readerAuth = Auth.auth(app: readerApp)
        let db = Firestore.firestore(app: writerApp)
        let readerDb = Firestore.firestore(app: readerApp)

        let tag = UUID().uuidString.lowercased()
        let email = "fs-net-\(tag)@example.test"
        let password = "CorrectHorse!15"
        let created = try await writerAuth.createUser(withEmail: email, password: password)
        let uid = created.user.uid
        _ = try await readerAuth.signIn(withEmail: email, password: password)

        // Idle waitForPendingWrites resolves immediately (async and completion).
        try await db.waitForPendingWrites()
        try await awaitVoidCompletion { done in
            db.waitForPendingWrites(completion: done)
        }

        let item1Ref = db.document("users/\(uid)/items/item-1")
        try await item1Ref.setData(["stage": "online-v1", "rank": 1])
        let onlineSnap = try await item1Ref.getDocument()
        #expect(onlineSnap.exists == true)
        #expect(onlineSnap.metadata.isFromCache == false)
        #expect(onlineSnap.metadata.hasPendingWrites == false)
        #expect(onlineSnap.data()?["stage"] as? String == "online-v1")

        let (snapStream, snapCont) = AsyncStream<DocumentSnapshot>.makeStream()
        let reg = item1Ref.addSnapshotListener(includeMetadataChanges: true) { snap, _ in
            if let snap {
                snapCont.yield(snap)
            }
        }
        defer { reg.remove() }
        var snapIter = snapStream.makeAsyncIterator()

        let initialLive = try #require(await snapIter.next())
        #expect(initialLive.metadata.isFromCache == false)
        #expect(initialLive.metadata.hasPendingWrites == false)
        #expect(initialLive.data()?["stage"] as? String == "online-v1")

        // Disable Firestore network: listener transitions to cache, while Auth on writerApp remains online.
        try await db.disableNetwork()
        let gapSnap = try #require(await snapIter.next())
        #expect(gapSnap.metadata.isFromCache == true)
        #expect(gapSnap.metadata.hasPendingWrites == false)
        #expect(gapSnap.data()?["stage"] as? String == "online-v1")

        let refreshedToken = try await created.user.getIDToken(forcingRefresh: true)
        #expect(refreshedToken.split(separator: ".").count == 3)

        await expectBridgeCode(.unavailable) {
            _ = try await item1Ref.getDocument(source: .server)
        }
        await expectBridgeCode(.unavailable) {
            _ = try await db.document("users/\(uid)/items/uncached").getDocument()
        }

        // Stage offline setData + WriteBatch; both remain pending until enableNetwork().
        let writeSettled = FlagBox()
        let offlineWriteTask = Task {
            try await item1Ref.setData(["stage": "offline-v2", "rank": 2])
            writeSettled.set()
        }
        let offlineSnap = try #require(await snapIter.next())
        #expect(offlineSnap.metadata.isFromCache == true)
        #expect(offlineSnap.metadata.hasPendingWrites == true)
        #expect(offlineSnap.data()?["stage"] as? String == "offline-v2")
        #expect(writeSettled.isSet == false)

        let batch = db.batch()
        batch.setData(["stage": "batch-v2", "rank": 3], forDocument: db.document("users/\(uid)/items/item-2"))
        let batchSettled = FlagBox()
        let offlineBatchTask = Task {
            try await batch.commit()
            batchSettled.set()
        }

        // Start waitForPendingWrites while offline; verify it stays pending while writes are unacknowledged.
        let pendingWaitSettled = FlagBox()
        let waitTask = Task {
            try await db.waitForPendingWrites()
            pendingWaitSettled.set()
        }
        try await Task.sleep(nanoseconds: 40_000_000)
        #expect(writeSettled.isSet == false)
        #expect(batchSettled.isSet == false)
        #expect(pendingWaitSettled.isSet == false)

        // Local cache query sees staged writes, while live host (readerDb) still holds online-v1 only.
        let localQuery = try await db.collection("users/\(uid)/items").order(by: "rank").getDocuments()
        #expect(localQuery.metadata.isFromCache == true)
        #expect(localQuery.metadata.hasPendingWrites == true)
        #expect(localQuery.documents.map(\.documentID) == ["item-1", "item-2"])

        let serverBeforeEnable = try await readerDb.document("users/\(uid)/items/item-1").getDocument(source: .server)
        #expect(serverBeforeEnable.data()?["stage"] as? String == "online-v1")
        let item2BeforeEnable = try await readerDb.document("users/\(uid)/items/item-2").getDocument(source: .server)
        #expect(item2BeforeEnable.exists == false)

        //Also stage a rule-denied offline write to another user's path.
        let deniedRef = db.document("users/other-uid-\(tag)/items/forbidden")
        let deniedTask = Task<FirestoreErrorCode?, Never> {
            do {
                try await deniedRef.setData(["spoof": true])
                return nil
            } catch let err as PyricBridgeError {
                return err.code
            } catch {
                return .unknown
            }
        }
        try await Task.sleep(nanoseconds: 25_000_000)
        let deniedLocal = try await deniedRef.getDocument(source: .cache)
        #expect(deniedLocal.exists == true)
        #expect(deniedLocal.metadata.hasPendingWrites == true)

        // Re-enable network via completion overload: flushes allowed writes, rejects denied write, resolves waitForPendingWrites.
        try await awaitVoidCompletion { done in
            db.enableNetwork(completion: done)
        }
        try await offlineWriteTask.value
        try await offlineBatchTask.value
        try await waitTask.value
        #expect(writeSettled.isSet == true)
        #expect(batchSettled.isSet == true)
        #expect(pendingWaitSettled.isSet == true)

        let deniedCode = await deniedTask.value
        #expect(deniedCode == .permissionDenied)
        await expectBridgeCode(.unavailable) {
            _ = try await deniedRef.getDocument(source: .cache)
        }

        // Metadata listener receives settled online snapshot with hasPendingWrites == false, isFromCache == false.
        var settledOnline: DocumentSnapshot?
        for _ in 0..<4 {
            if let next = await snapIter.next(),
               next.metadata.isFromCache == false,
               next.metadata.hasPendingWrites == false,
               next.data()?["stage"] as? String == "offline-v2" {
                settledOnline = next
                break
            }
        }
        #expect(settledOnline != nil)

        let serverAfterEnable = try await readerDb.collection("users/\(uid)/items").order(by: "rank").getDocuments(source: .server)
        #expect(serverAfterEnable.documents.map(\.documentID) == ["item-1", "item-2"])
        #expect(serverAfterEnable.documents.first?.data()["stage"] as? String == "offline-v2")

        await writerApp.disconnectSharedBridge()
        await readerApp.disconnectSharedBridge()
    }

    @Test("firestore-swift#16: clearPersistence lifecycle preconditions and offline cache clearing over live host")
    func clearPersistenceLifecycleLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "fs-clear", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-clear-\(tag)@example.test",
            password: "CorrectHorse!16"
        )
        let uid = created.user.uid

        // 1. clearPersistence() succeeds before Firestore instance is started.
        let db1 = Firestore.firestore(app: app)
        try await db1.clearPersistence()

        // 2. Warm cache via live write + active listener; clearPersistence() rejects with failed-precondition.
        let cachedPath = "users/\(uid)/items/persisted-1"
        try await db1.document(cachedPath).setData(["title": "Warm Entry", "v": 1])
        let (firstSnapStream, firstSnapCont) = AsyncStream<DocumentSnapshot>.makeStream()
        let activeListener = db1.document(cachedPath).addSnapshotListener { snap, _ in
            if let snap { firstSnapCont.yield(snap) }
        }
        var firstSnapIter = firstSnapStream.makeAsyncIterator()
        _ = await firstSnapIter.next()

        await expectBridgeCode(.failedPrecondition) {
            try await db1.clearPersistence()
        }
        await expectBridgeCode(.failedPrecondition) {
            try await awaitVoidCompletion { done in
                db1.clearPersistence(completion: done)
            }
        }

        // 3. terminate() cancels active listeners and stops db1 without disconnecting Auth on the shared FirebaseApp.
        try await db1.terminate()
        let tokenAfterTerminate = try await created.user.getIDToken()
        #expect(tokenAfterTerminate.split(separator: ".").count == 3)
        activeListener.remove()

        // Before clearPersistence(), a fresh handle on the same app still sees the persisted cache entry.
        let dbBeforeClear = Firestore.firestore(app: app)
        #expect(dbBeforeClear !== db1)
        let warmFromCache = try await dbBeforeClear.document(cachedPath).getDocument(source: .cache)
        #expect(warmFromCache.exists == true)
        #expect(warmFromCache.metadata.isFromCache == true)
        #expect(warmFromCache.data()?["title"] as? String == "Warm Entry")

        // 4. Terminate dbBeforeClear and run clearPersistence(); cache is now empty while live server still has data.
        try await dbBeforeClear.terminate()
        try await awaitVoidCompletion { done in
            dbBeforeClear.clearPersistence(completion: done)
        }

        let dbAfterClear = Firestore.firestore(app: app)
        await expectBridgeCode(.unavailable) {
            _ = try await dbAfterClear.document(cachedPath).getDocument(source: .cache)
        }
        let fromServer = try await dbAfterClear.document(cachedPath).getDocument(source: .server)
        #expect(fromServer.exists == true)
        #expect(fromServer.metadata.isFromCache == false)
        #expect(fromServer.data()?["title"] as? String == "Warm Entry")

        await app.disconnectSharedBridge()
    }

    @Test("firestore-swift#19: addSnapshotsInSyncListener ordering, coalescing, and removal over live host")
    func snapshotsInSyncListenerLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "fs-sync", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-sync-\(tag)@example.test",
            password: "CorrectHorse!19"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)

        let docRef = db.document("users/\(uid)/items/sync-1")
        try await docRef.setData(["phase": "seeded"])

        let log = SyncEventLog()
        let syncReg = db.addSnapshotsInSyncListener {
            log.append("sync")
        }
        try await log.waitForCount(1)
        #expect(log.values == ["sync"])

        // Attach document listener; initial snapshot arrives before its paired sync callback.
        let docReg = docRef.addSnapshotListener { snap, _ in
            if let phase = snap?.data()?["phase"] as? String {
                log.append("snap:\(phase)")
            }
        }
        try await log.waitForCount(3)
        #expect(log.values == ["sync", "snap:seeded", "sync"])

        // Live write triggers snapshot delivery followed by sync callback.
        try await docRef.setData(["phase": "updated"])
        try await log.waitForCount(5)
        #expect(log.values == ["sync", "snap:seeded", "sync", "snap:updated", "sync"])

        // Removing the sync registration stops further sync notifications while doc listener stays active.
        syncReg.remove()
        try await docRef.setData(["phase": "after-remove"])
        try await log.waitForCount(6)
        try await Task.sleep(nanoseconds: 40_000_000)
        #expect(log.values == ["sync", "snap:seeded", "sync", "snap:updated", "sync", "snap:after-remove"])

        docReg.remove()
        await app.disconnectSharedBridge()
    }

    @Test("firestore-swift#20: loadBundle Data and InputStream cache hydration, progress, and malformed rejection over live host")
    func loadBundleCacheHydrationLiveHostConformance() async throws {
        guard let (host, port) = try liveHostEndpoint() else {
            return
        }

        let app = makeLiveApp(prefix: "fs-bundle", host: host, port: port)
        defer {
            Task { await app.disconnectSharedBridge() }
        }

        let auth = Auth.auth(app: app)
        let tag = UUID().uuidString.lowercased()
        let created = try await auth.createUser(
            withEmail: "fs-bundle-\(tag)@example.test",
            password: "CorrectHorse!20"
        )
        let uid = created.user.uid
        let db = Firestore.firestore(app: app)

        let bundleBytes = makeSampleBundle(uid: uid)
        let observedSteps = SyncProgressLog()
        let bundleTask: LoadBundleTask = db.loadBundle(bundleBytes)
        let observerHandle = bundleTask.addObserver { progress in
            observedSteps.append(progress)
        }
        try await observedSteps.waitForTerminalState()
        bundleTask.removeObserverWithHandle(observerHandle)

        let finalProgress = try await db.loadBundle(bundleBytes)

        #expect(finalProgress.state == .success)
        #expect(finalProgress.documentsLoaded == 3)
        #expect(finalProgress.totalDocuments == 3)
        #expect(finalProgress.bytesLoaded == finalProgress.totalBytes)
        #expect(finalProgress.totalBytes > 0)

        let recordedStates = observedSteps.values
        #expect(recordedStates.first?.state == .inProgress)
        #expect(recordedStates.first?.documentsLoaded == 0)
        #expect(recordedStates.last?.state == .success)
        #expect(recordedStates.last?.documentsLoaded == 3)

        // Hydrated existing document with rich REST types is readable from cache.
        let alphaPath = "users/\(uid)/items/bundle-alpha"
        let alphaCache = try await db.document(alphaPath).getDocument(source: .cache)
        #expect(alphaCache.exists == true)
        #expect(alphaCache.metadata.isFromCache == true)
        #expect(alphaCache.metadata.hasPendingWrites == false)
        #expect(alphaCache.data()?["title"] as? String == "Bundled Alpha")
        #expect(alphaCache.data()?["active"] as? Bool == true)
        #expect(alphaCache.data()?["rank"] as? Int64 == 1)
        #expect(alphaCache.data()?["score"] as? Double == 9.5)
        let ts = alphaCache.data()?["publishedAt"] as? Timestamp
        #expect(ts == Timestamp(seconds: 1_768_478_400, nanoseconds: 125_000_000))
        let gp = alphaCache.data()?["coords"] as? GeoPoint
        #expect(gp == GeoPoint(latitude: 37.7749, longitude: -122.4194))
        let blob = alphaCache.data()?["payload"] as? Data
        #expect(blob == Data([0x41, 0x42, 0x43]))

        // Bundled non-existent document (`exists: false`) is cached as exists == false.
        let ghostCache = try await db.document("users/\(uid)/items/bundle-ghost").getDocument(source: .cache)
        #expect(ghostCache.exists == false)
        #expect(ghostCache.metadata.isFromCache == true)

        // Filtered & ordered cache query evaluates against bundled documents.
        let cachedActive = try await db.collection("users/\(uid)/items")
            .whereField("active", isEqualTo: true)
            .order(by: "rank")
            .getDocuments(source: .cache)
        #expect(cachedActive.metadata.isFromCache == true)
        #expect(cachedActive.documents.map(\.documentID) == ["bundle-alpha"])

        // Live server was NOT mutated by loadBundle (fetchCalls == 0 parity).
        let alphaOnServer = try await db.document(alphaPath).getDocument(source: .server)
        #expect(alphaOnServer.exists == false)

        // InputStream + completion overload loads a second bundle cleanly.
        let streamBundle = makeSingleDocBundle(docPath: "users/\(uid)/items/stream-doc", title: "From Stream")
        let inputStream = InputStream(data: streamBundle)
        let streamProgress = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<LoadBundleTaskProgress, Error>) in
            _ = db.loadBundle(inputStream) { progress, error in
                if let error {
                    cont.resume(throwing: error)
                } else if let progress {
                    cont.resume(returning: progress)
                }
            }
        }
        #expect(streamProgress.state == .success)
        #expect(streamProgress.documentsLoaded == 1)
        let streamCached = try await db.document("users/\(uid)/items/stream-doc").getDocument(source: .cache)
        #expect(streamCached.data()?["title"] as? String == "From Stream")

        // Malformed bundle fails asynchronously with .invalidArgument and emits .error state.
        let malformedLog = SyncProgressLog()
        let badData = Data("not-a-length-prefixed-bundle".utf8)
        await expectBridgeCode(.invalidArgument) {
            let badTask = db.loadBundle(badData, completion: nil)
            badTask.addObserver { p in malformedLog.append(p) }
            _ = try await db.loadBundle(badData)
        }
        try await malformedLog.waitForTerminalState()
        #expect(malformedLog.values.last?.state == .error)

        await app.disconnectSharedBridge()
    }
}
