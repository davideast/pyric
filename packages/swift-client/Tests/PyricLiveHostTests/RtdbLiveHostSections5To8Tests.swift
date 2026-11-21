import Foundation
import Testing
@testable import PyricDatabase
@testable import PyricFirestore
import FirebaseAuth

private final class EventBox<Element: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Element] = []

    func append(_ element: Element) {
        lock.lock()
        items.append(element)
        lock.unlock()
    }

    var snapshot: [Element] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return items.count
    }
}

extension LiveHostConformanceTests {

    // -- Hermetic Parity Checks for Sections 5-8 & FirebaseApp Options --

    @Test("FirebaseApp.options.databaseURL, compareRtdbKeys, MutableData write-back, and DatabaseQueryValidator parity")
    func rtdbSectionsFiveThroughEightHermeticParity() async throws {
        // 1. FirebaseApp.options.databaseURL & projectID wiring without Firestore coupling.
        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            let projOnlyOpts = FirebaseOptions(googleAppID: "1:100:ios:projonly", gcmSenderID: "100")
            projOnlyOpts.projectID = "demo-swift-live"
            let projOnlyName = "rtdb-projonly-\(UUID().uuidString)"
            FirebaseApp.configure(name: projOnlyName, options: projOnlyOpts)
            let projOnlyApp1 = try #require(FirebaseApp.app(name: projOnlyName))
            let projOnlyDb1 = Database.database(app: projOnlyApp1)
            #expect(projOnlyDb1.url == "https://demo-swift-live-default-rtdb.firebaseio.com")
            #expect(projOnlyDb1.wireInstance == nil)

            // Reconfiguring the same named FirebaseApp evicts the stale Database handle.
            FirebaseApp.configure(name: projOnlyName, options: projOnlyOpts)
            let projOnlyApp2 = try #require(FirebaseApp.app(name: projOnlyName))
            let projOnlyDb2 = Database.database(app: projOnlyApp2)
            #expect(projOnlyDb2 !== projOnlyDb1)

            let defaultOpts = FirebaseOptions(googleAppID: "1:100:ios:default", gcmSenderID: "100")
            defaultOpts.projectID = "demo-swift-live"
            defaultOpts.databaseURL = "https://demo-swift-live-default-rtdb.firebaseio.com/"
            let appName = "rtdb-opts-\(UUID().uuidString)"
            FirebaseApp.configure(name: appName, options: defaultOpts)
            let configuredApp = try #require(FirebaseApp.app(name: appName))
            let defaultDb = Database.database(app: configuredApp)
            #expect(defaultDb.url == "https://demo-swift-live-default-rtdb.firebaseio.com")
            #expect(defaultDb.wireInstance == nil)
            #expect(Database.database(app: configuredApp, url: "https://default.firebaseio.com") === defaultDb)

            let shardOpts = FirebaseOptions(googleAppID: "1:100:ios:shard", gcmSenderID: "100")
            shardOpts.projectID = "demo-swift-live"
            shardOpts.databaseURL = "https://shard-05.firebaseio.com"
            let shardApp = FirebaseApp(name: "rtdb-shard-opts-\(UUID().uuidString)", options: shardOpts)
            let shardDb = Database.database(app: shardApp)
            #expect(shardDb.url == "https://shard-05.firebaseio.com")
            #expect(shardDb.wireInstance == "shard-05")
            #expect(
                Database.database(app: shardApp, url: "https://shard-05.europe-west1.firebasedatabase.app")
                    === shardDb
            )

        // 2. RTDB 32-bit signed integer numeric-first key ordering.
        let unsortedKeys = ["b", "10", "-2", "2", "a", "2147483648", "02"]
        let sortedKeys = unsortedKeys.sorted {
            DataSnapshot.compareRtdbKeys($0, $1) == .orderedAscending
        }
        #expect(sortedKeys == ["-2", "2", "02", "10", "2147483648", "a", "b"])

        // 3. MutableData nested subtree write-back, array child write-back, and nil pruning.
        let rootMutable = MutableData(
            key: "cart",
            value: [
                "items": ["alpha", "beta"],
                "meta": ["count": 2]
            ] as [String: Any]
        )
        #expect(rootMutable.childrenCount == 2)
        #expect(rootMutable.hasChildren() == true)
        #expect(rootMutable.hasChild(atPath: "meta/count") == true)
        #expect(int64Of(rootMutable.childData(byAppendingPath: "meta/count").value) == 2)
        #expect(rootMutable.childData(byAppendingPath: "items/1").value as? String == "beta")

        rootMutable.childData(byAppendingPath: "meta/count").value = 3
        rootMutable.childData(byAppendingPath: "items/1").value = "BRAVO"
        let mutatedRoot = try #require(rootMutable.value as? [String: Any])
        #expect(int64Of((mutatedRoot["meta"] as? [String: Any])?["count"]) == 3)
        #expect((mutatedRoot["items"] as? [String: Any])?["1"] as? String == "BRAVO")
        #expect((mutatedRoot["items"] as? [String: Any])?["0"] as? String == "alpha")

        rootMutable.childData(byAppendingPath: "meta/count").value = nil
        #expect(rootMutable.hasChild(atPath: "meta") == false)

        // 4. DatabaseQueryValidator upstream constraint checks.
        let baseRef = defaultDb.reference(withPath: "users/u1/catalog")
        let normalizedNested = try baseRef.validatedQueryOrdered(byChild: "/meta/rank/")
        #expect(normalizedNested.orderBySpec?["path"]?.stringValue == "meta/rank")

        #expect(throws: DatabaseQueryValidationError.multipleOrderBy) {
            _ = try normalizedNested.validatedQueryOrderedByKey()
        }
        #expect(throws: DatabaseQueryValidationError.emptyOrderByChildPath) {
            _ = try baseRef.validatedQueryOrdered(byChild: "///")
        }
        #expect(throws: DatabaseQueryValidationError.invalidOrderByChildPath("bad$key")) {
            _ = try baseRef.validatedQueryOrdered(byChild: "bad$key")
        }
        #expect(throws: DatabaseQueryValidationError.duplicateStartBound) {
            _ = try baseRef
                .validatedQueryOrdered(byChild: "score")
                .validatedQueryStarting(atValue: 10)
                .validatedQueryStarting(afterValue: 20)
        }
        #expect(throws: DatabaseQueryValidationError.duplicateEndBound) {
            _ = try baseRef
                .validatedQueryOrdered(byChild: "score")
                .validatedQueryEqual(toValue: 10)
                .validatedQueryEnding(atValue: 20)
        }
        #expect(throws: DatabaseQueryValidationError.childKeyNotAllowedForOrderByKey) {
            _ = try baseRef
                .validatedQueryOrderedByKey()
                .validatedQueryStarting(atValue: "a", childKey: "extra")
        }
        #expect(throws: DatabaseQueryValidationError.nonStringBoundForOrderByKey) {
            _ = try baseRef
                .validatedQueryOrderedByKey()
                .validatedQueryStarting(atValue: 42)
        }
        #expect(throws: DatabaseQueryValidationError.nonStringBoundForOrderByKey) {
            _ = try baseRef
                .validatedQueryStarting(atValue: 42)
                .validatedQueryOrderedByKey()
        }
        #expect(throws: DatabaseQueryValidationError.nonPositiveLimit) {
            _ = try baseRef.validatedQueryLimited(toFirst: 0)
        }
        #expect(throws: DatabaseQueryValidationError.multipleLimits) {
            _ = try baseRef
                .validatedQueryLimited(toFirst: 2)
                .validatedQueryLimited(toLast: 2)
        }
            await projOnlyApp2.delete()
            await configuredApp.delete()
        }
    }

    // -- Live Pyric Host Conformance: Sections 5 & 7 (Reads, Snapshots & Queries) --

    @Test("Live host: Sections 5 and 7 conformance (getData, DataSnapshot, export format, ordering, cursors, limits)")
    func liveHostSectionsFiveAndSevenReadsSnapshotsAndQueries() async throws {
        guard let (host, port) = try liveEndpointFromEnv() else {
            return
        }

        let opts = FirebaseOptions(googleAppID: "1:200:ios:s57", gcmSenderID: "200")
        opts.projectID = "demo-swift-live"
        opts.databaseURL = "https://demo-swift-live-default-rtdb.firebaseio.com"
        let app = FirebaseApp(name: "rtdb-live-s57-\(UUID().uuidString)", options: opts)
        let mainDb = Database.database(app: app)
        #expect(mainDb.wireInstance == nil)
        mainDb.useEmulator(withHost: host, port: port)
        let auth = Auth.auth(app: app)

        do {
            let email = "rtdb-s57-\(UUID().uuidString.prefix(8))@example.test"
            let created = try await auth.createUser(withEmail: email, password: "correct-horse-battery")
            let uid = created.user.uid
            let userRoot = mainDb.reference(withPath: "users/\(uid)")

            // Section 5: absent snapshot, scalar/array/dictionary values, priorities, export format, child paths.
            let absentRef = userRoot.child("snapshots/absent")
            let absentSnap = try await absentRef.getData()
            #expect(absentSnap.exists() == false)
            #expect(absentSnap.key == "absent")
            #expect(absentSnap.value == nil)
            #expect(absentSnap.priority == nil)
            #expect(absentSnap.valueInExportFormat() == nil)
            #expect(absentSnap.childrenCount == 0)
            #expect(absentSnap.hasChildren() == false)

            let completionSnap: DataSnapshot = try await withCheckedThrowingContinuation { cont in
                absentRef.getData { err, snap in
                    if let err {
                        cont.resume(throwing: err)
                    } else if let snap {
                        cont.resume(returning: snap)
                    } else {
                        cont.resume(throwing: PyricBridgeError.internalError("Missing snapshot"))
                    }
                }
            }
            #expect(completionSnap.exists() == false)

            let leafPrioRef = userRoot.child("snapshots/orbiter")
            try await leafPrioRef.setValue("voyager", andPriority: 42)
            let leafSnap = try await leafPrioRef.observeSingleEvent(of: .value)
            #expect(leafSnap.exists() == true)
            #expect(leafSnap.key == "orbiter")
            #expect(leafSnap.value as? String == "voyager")
            #expect(int64Of(leafSnap.priority) == 42)
            let leafExport = try #require(leafSnap.valueInExportFormat() as? [String: Any])
            #expect(leafExport[".value"] as? String == "voyager")
            #expect(int64Of(leafExport[".priority"]) == 42)

            let typesRef = userRoot.child("snapshots/types")
            try await typesRef.setValue([
                "flag": true,
                "count": 19,
                "ratio": 2.75,
                "label": "telemetry",
                "tags": ["alpha", "beta", "gamma"],
                "nested": ["owner": "ops"]
            ] as [String: Any], andPriority: "p-types")
            try await typesRef.child("nested/owner").setPriority(7)

            let typesSnap = try await typesRef.getData()
            #expect(typesSnap.exists() == true)
            #expect(typesSnap.key == "types")
            #expect(typesSnap.priority as? String == "p-types")
            #expect(typesSnap.childrenCount == 6)
            #expect(typesSnap.hasChildren() == true)
            #expect(typesSnap.hasChild("nested/owner") == true)
            #expect(typesSnap.hasChild("nested/missing") == false)
            #expect(typesSnap.childSnapshot(forPath: "flag").value as? Bool == true)
            #expect(int64Of(typesSnap.childSnapshot(forPath: "count").value) == 19)
            #expect(doubleOf(typesSnap.childSnapshot(forPath: "ratio").value) == 2.75)
            #expect(typesSnap.childSnapshot(forPath: "tags/1").value as? String == "beta")
            let nestedOwnerSnap = typesSnap.childSnapshot(forPath: "nested/owner")
            #expect(nestedOwnerSnap.value as? String == "ops")
            #expect(int64Of(nestedOwnerSnap.priority) == 7)
            let typesExport = try #require(typesSnap.valueInExportFormat() as? [String: Any])
            #expect(typesExport[".priority"] as? String == "p-types")

            // Numeric-first child ordering via `children` NSEnumerator.
            let numKeysRef = userRoot.child("snapshots/numkeys")
            try await numKeysRef.setValue(["b": "two", "10": "ten", "2": "pair", "a": "one"] as [String: Any])
            let numKeysSnap = try await numKeysRef.getData()
            let enumKeys = numKeysSnap.children.allObjects
                .compactMap { ($0 as? DataSnapshot)?.key }
            #expect(enumKeys == ["2", "10", "a", "b"])

            // Section 7: Queries over indexed `catalog` and `scores`.
            let catalogRef = userRoot.child("catalog")
            try await catalogRef.setValue([
                "item-a": ["score": 30, "role": "pilot", "meta": ["rank": 3]],
                "item-b": ["score": 10, "role": "medic", "meta": ["rank": 1]],
                "item-c": ["score": 20, "role": "pilot", "meta": ["rank": 2]],
                "item-d": ["score": 20, "role": "engineer", "meta": ["rank": 4]],
                "item-e": ["score": 40, "role": "pilot", "meta": ["rank": 5]]
            ] as [String: Any])

            let byScore = try await catalogRef.queryOrdered(byChild: "score").getData()
            #expect(byScore.childrenSnapshots.compactMap { $0.key } == ["item-b", "item-c", "item-d", "item-a", "item-e"])

            let byNestedRank = try await catalogRef.queryOrdered(byChild: "meta/rank").getData()
            #expect(byNestedRank.childrenSnapshots.compactMap { $0.key } == ["item-b", "item-c", "item-a", "item-d", "item-e"])

            let byKeyInclusive = try await catalogRef
                .queryOrderedByKey()
                .queryStarting(atValue: "item-b")
                .queryEnding(atValue: "item-d")
                .getData()
            #expect(byKeyInclusive.childrenSnapshots.compactMap { $0.key } == ["item-b", "item-c", "item-d"])

            let byKeyExclusive = try await catalogRef
                .queryOrderedByKey()
                .queryStarting(afterValue: "item-b")
                .queryEnding(beforeValue: "item-e")
                .getData()
            #expect(byKeyExclusive.childrenSnapshots.compactMap { $0.key } == ["item-c", "item-d"])

            let equalRole = try await catalogRef
                .queryOrdered(byChild: "role")
                .queryEqual(toValue: "pilot")
                .getData()
            #expect(equalRole.childrenSnapshots.compactMap { $0.key } == ["item-a", "item-c", "item-e"])

            let equalTieBreak = try await catalogRef
                .queryOrdered(byChild: "score")
                .queryEqual(toValue: 20, childKey: "item-d")
                .getData()
            #expect(equalTieBreak.childrenSnapshots.compactMap { $0.key } == ["item-d"])

            let firstTwo = try await catalogRef
                .queryOrdered(byChild: "score")
                .queryLimited(toFirst: 2)
                .getData()
            #expect(firstTwo.childrenSnapshots.compactMap { $0.key } == ["item-b", "item-c"])
            #expect(firstTwo.childrenCount == 2)
            #expect(firstTwo.hasChild("item-b") == true)
            #expect(firstTwo.hasChild("item-e") == false)
            #expect(firstTwo.childSnapshot(forPath: "item-e/role").exists() == false)

            let lastTwo = try await catalogRef
                .queryOrdered(byChild: "score")
                .queryLimited(toLast: 2)
                .getData()
            #expect(lastTwo.childrenSnapshots.compactMap { $0.key } == ["item-a", "item-e"])
            #expect(lastTwo.hasChild("item-b") == false)

            let scoresRef = userRoot.child("scores")
            try await scoresRef.setValue(["s1": 50, "s2": 15, "s3": 35, "s4": 25] as [String: Any])
            let byValueAll = try await scoresRef.queryOrderedByValue().getData()
            #expect(byValueAll.childrenSnapshots.compactMap { $0.key } == ["s2", "s4", "s3", "s1"])

            let byValueWindow = try await scoresRef
                .queryOrderedByValue()
                .queryStarting(afterValue: 15)
                .queryEnding(beforeValue: 50)
                .getData()
            #expect(byValueWindow.childrenSnapshots.compactMap { $0.key } == ["s4", "s3"])

            await mainDb.bridgeClient.disconnect()
            Auth.reset()
            Database.reset()
            FirebaseApp.resetAppsForTesting()
        } catch {
            await mainDb.bridgeClient.disconnect()
            Auth.reset()
            Database.reset()
            FirebaseApp.resetAppsForTesting()
            throw error
        }
    }

    // -- Live Pyric Host Conformance: Sections 6 & 8 (Listeners, Transactions & OnDisconnect) --

    @Test("Live host: Sections 6 and 8 conformance (listeners/childMoved/cancel, transactions, OnDisconnect socket drop)")
    func liveHostSectionsSixAndEightListenersTransactionsAndOnDisconnect() async throws {
        guard let (host, port) = try liveEndpointFromEnv() else {
            return
        }

        try await withRtdbSession(host: host, port: port) { auth, mainDb, _ in
            let email = "rtdb-s68-\(UUID().uuidString.prefix(8))@example.test"
            let password = "correct-horse-battery"
            let created = try await auth.createUser(withEmail: email, password: password)
            let uid = created.user.uid
            let userRoot = mainDb.reference(withPath: "users/\(uid)")

            // 1. Section 6: observe(.value), valueStream, permission-denied withCancel, child events & cancel.
            let deniedErrBox = EventBox<String>()
            let deniedRef = mainDb.reference(withPath: "users/forbidden-uid/secret")
            let deniedHandle = deniedRef.observe(.value, with: { _ in }, withCancel: { err in
                deniedErrBox.append(String(describing: err))
            })
            try await waitUntil { deniedErrBox.count == 1 }
            deniedRef.removeObserver(withHandle: deniedHandle)

            let liveStatusRef = userRoot.child("listeners/status")
            try await liveStatusRef.setValue("booting")
            let observedValuesA = EventBox<String>()
            let observedValuesB = EventBox<String>()
            let handleA = liveStatusRef.observe(.value) { snap in
                if let str = snap.value as? String {
                    observedValuesA.append(str)
                }
            }
            let handleB = liveStatusRef.observe(.value) { snap in
                if let str = snap.value as? String {
                    observedValuesB.append(str)
                }
            }
            try await waitUntil { observedValuesA.snapshot == ["booting"] && observedValuesB.snapshot == ["booting"] }

            try await liveStatusRef.setValue("online")
            try await waitUntil {
                observedValuesA.snapshot == ["booting", "online"]
                    && observedValuesB.snapshot == ["booting", "online"]
            }

            // Detach handleA only; handleB continues receiving updates, then removeAllObservers() silences all.
            liveStatusRef.removeObserver(withHandle: handleA)
            try await liveStatusRef.setValue("degraded")
            try await waitUntil { observedValuesB.snapshot == ["booting", "online", "degraded"] }
            #expect(observedValuesA.snapshot == ["booting", "online"])
            _ = handleB
            liveStatusRef.removeAllObservers()
            try await liveStatusRef.setValue("silent")
            try await Task.sleep(nanoseconds: 80_000_000)
            #expect(observedValuesB.snapshot == ["booting", "online", "degraded"])

            // Child events (.childAdded, .childChanged, .childMoved, .childRemoved) on an indexed ordered query.
            let boardRef = userRoot.child("catalog")
            try await boardRef.setValue([
                "c1": ["score": 10],
                "c2": ["score": 20]
            ] as [String: Any])
            let boardQuery = boardRef.queryOrdered(byChild: "score")
            let addedEvents = EventBox<String>()
            let changedEvents = EventBox<String>()
            let movedEvents = EventBox<String>()
            let removedEvents = EventBox<String>()

            let addH = boardQuery.observe(.childAdded, andPreviousSiblingKeyWith: { snap, prev in
                addedEvents.append("\(snap.key ?? "?"):\(prev ?? "nil")")
            })
            let chgH = boardQuery.observe(.childChanged, andPreviousSiblingKeyWith: { snap, prev in
                let sc = self.int64Of((snap.value as? [String: Any])?["score"]) ?? -1
                changedEvents.append("\(snap.key ?? "?")=\(sc):\(prev ?? "nil")")
            })
            let movH = boardQuery.observe(.childMoved, andPreviousSiblingKeyWith: { snap, prev in
                movedEvents.append("\(snap.key ?? "?"):\(prev ?? "nil")")
            })
            let remH = boardQuery.observe(.childRemoved) { snap in
                removedEvents.append(snap.key ?? "?")
            }

            try await waitUntil { addedEvents.snapshot == ["c1:nil", "c2:c1"] }

            try await boardRef.child("c3").setValue(["score": 15] as [String: Any])
            try await waitUntil { addedEvents.snapshot == ["c1:nil", "c2:c1", "c3:c1"] }

            // Raise c1's score from 10 to 30 so c1 moves after c2 ([c3(15), c2(20), c1(30)]).
            try await boardRef.child("c1").setValue(["score": 30] as [String: Any])
            try await waitUntil {
                changedEvents.snapshot == ["c1=30:c2"] && movedEvents.snapshot == ["c1:c2"]
            }

            try await boardRef.child("c3").removeValue()
            try await waitUntil { removedEvents.snapshot == ["c3"] }
            boardQuery.removeObserver(withHandle: addH)
            boardQuery.removeObserver(withHandle: chgH)
            boardQuery.removeObserver(withHandle: movH)
            boardQuery.removeObserver(withHandle: remH)

            // 2. Section 8: Optimistic concurrency transactions (`tx-run` + `tx-abort` + rules denial).
            let deniedTxRef = mainDb.reference(withPath: "users/intruder-uid/wallet")
            do {
                _ = try await deniedTxRef.runTransactionBlock { current in
                    current.value = 1
                    return .success(withValue: current)
                }
                Issue.record("Expected rules-denied runTransactionBlock to throw")
            } catch let bridgeErr as PyricBridgeError {
                #expect(bridgeErr.code == .permissionDenied)
            }

            let walletRef = userRoot.child("wallet")
            let initTx = try await walletRef.runTransactionBlock { current in
                #expect(current.value == nil)
                current.value = ["credits": 100, "tier": "bronze"] as [String: Any]
                current.priority = 7
                return .success(withValue: current)
            }
            #expect(initTx.committed == true)
            #expect(int64Of(initTx.snapshot.priority) == 7)

            // Nested MutableData write-back + completion-block transaction overload.
            let nestedTx = try await walletRef.runTransactionBlock { current in
                current.childData(byAppendingPath: "credits").value = 150
                return .success(withValue: current)
            }
            #expect(nestedTx.committed == true)
            #expect(int64Of(nestedTx.snapshot.childSnapshot(forPath: "credits").value) == 150)

            let completionCommitted: Bool = try await withCheckedThrowingContinuation { cont in
                walletRef.child("credits").runTransactionBlock({ current in
                    let base = self.int64Of(current.value) ?? 0
                    current.value = base + 25
                    return .success(withValue: current)
                }, andCompletionBlock: { err, committed, _ in
                    if let err {
                        cont.resume(throwing: err)
                    } else {
                        cont.resume(returning: committed)
                    }
                }, withLocalEvents: false)
            }
            #expect(completionCommitted == true)
            #expect(int64Of(try await walletRef.child("credits").getData().value) == 175)

            // Contention test across a second independent FirebaseApp/WebSocket peer, plus real socket drop OnDisconnect.
            let peerApp = FirebaseApp(name: "rtdb-peer-\(UUID().uuidString)")
            let peerDb = Database.database(app: peerApp)
            peerDb.useEmulator(withHost: host, port: port)
            let peerAuth = Auth.auth(app: peerApp)
            _ = try await peerAuth.signIn(withEmail: email, password: password)

            let peerCreditsRef = peerDb.reference(withPath: "users/\(uid)/wallet/credits")
            try await withThrowingTaskGroup(of: Bool.self) { group in
                for idx in 0..<4 {
                    let targetRef = (idx % 2 == 0) ? walletRef.child("credits") : peerCreditsRef
                    group.addTask {
                        let outcome = try await targetRef.runTransactionBlock { mutable in
                            let current = self.int64Of(mutable.value) ?? 0
                            mutable.value = current + 10
                            return .success(withValue: mutable)
                        }
                        return outcome.committed
                    }
                }
                for try await committed in group {
                    #expect(committed == true)
                }
            }
            #expect(int64Of(try await walletRef.child("credits").getData().value) == 215)

            // Abort leaves server value untouched at 215.
            let abortedTx = try await walletRef.child("credits").runTransactionBlock { mutable in
                mutable.value = 9999
                return .abort()
            }
            #expect(abortedTx.committed == false)
            #expect(int64Of(abortedTx.snapshot.value) == 215)
            #expect(int64Of(try await walletRef.child("credits").getData().value) == 215)

            // 3. Section 8: OnDisconnect cancel, goOffline execution, and real WebSocket disconnect execution.
            let presenceRef = userRoot.child("presence/primary")
            try await presenceRef.setValue("online")
            try await withCompletionRef { cb in
                presenceRef.onDisconnectSetValue("canceled-offline", withCompletionBlock: cb)
            }
            try await withCompletionRef { cb in
                presenceRef.cancelDisconnectOperations(completionBlock: cb)
            }
            try await mainDb.goOffline()
            try await mainDb.goOnline()
            #expect(try await presenceRef.getData().value as? String == "online")

            let ephemeralRef = userRoot.child("presence/ephemeral")
            try await ephemeralRef.setValue("temp-token")
            try await presenceRef.onDisconnectSetValue("offline-clean", andPriority: 9)
            try await ephemeralRef.onDisconnectRemoveValue()
            try await mainDb.goOffline()
            try await mainDb.goOnline()
            let afterOfflineSnap = try await presenceRef.getData()
            #expect(afterOfflineSnap.value as? String == "offline-clean")
            #expect(int64Of(afterOfflineSnap.priority) == 9)
            #expect(try await ephemeralRef.getData().exists() == false)

            // Real socket close on `peerApp` triggers queued OnDisconnect operations observed live by `mainDb`.
            let dropBannerRef = userRoot.child("presence/peerSocket")
            let dropMetaRef = userRoot.child("presence/peerMeta")
            let peerBannerRef = peerDb.reference(withPath: "users/\(uid)/presence/peerSocket")
            let peerMetaRef = peerDb.reference(withPath: "users/\(uid)/presence/peerMeta")
            try await peerBannerRef.setValue("connected")
            try await peerMetaRef.setValue(["state": "active"] as [String: Any])

            let peerStates = EventBox<String>()
            let watchHandle = dropBannerRef.observe(.value) { snap in
                if let s = snap.value as? String {
                    peerStates.append(s)
                }
            }
            try await waitUntil { peerStates.snapshot.last == "connected" }

            try await peerBannerRef.onDisconnectSetValue("socket-closed")
            try await peerMetaRef.onDisconnectUpdateChildValues([
                "state": "disconnected",
                "closedAt": ServerValue.timestamp()
            ])
            await peerApp.disconnectSharedBridge()

            try await waitUntil { peerStates.snapshot.contains("socket-closed") }
            dropBannerRef.removeObserver(withHandle: watchHandle)
            let metaSnap = try await dropMetaRef.getData()
            let metaDict = try #require(metaSnap.value as? [String: Any])
            #expect(metaDict["state"] as? String == "disconnected")
            #expect((int64Of(metaDict["closedAt"]) ?? 0) > 1_500_000_000_000)
        }
    }

    private func waitUntil(
        timeoutSeconds: Double = 5.0,
        predicate: @escaping @Sendable () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while !predicate() {
            if Date() >= deadline {
                Issue.record("Timed out waiting for live-host condition after \(timeoutSeconds)s")
                return
            }
            try await Task.sleep(nanoseconds: 15_000_000)
        }
    }
}
