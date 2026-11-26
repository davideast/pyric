import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth
@testable import PyricDatabase

private func makePr5Database(_ client: PyricBridgeClient) -> Database {
    Database(
        app: FirebaseApp(name: "dc5-db-\(UUID().uuidString)"),
        url: "https://default.firebaseio.com",
        bridgeClient: client
    )
}

private func makePr5Firestore(_ client: PyricBridgeClient) -> Firestore {
    let db = Firestore(
        bridgeClient: client,
        app: FirebaseApp(name: "dc5-fs-\(UUID().uuidString)")
    )
    return db
}

@Suite("ADR-0019 delivery contract: PR 5 (S20, S21, S24, S25, S27, S28)", .serialized)
struct DeliveryContractPr5Tests {

    @Test("S20: Two RTDB observers fed alternating frames deliver strictly in wire frame order")
    func s20RtdbTwoObserversFrameOrder() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makePr5Database(client)

        let delivered = GatedBox<Int>()
        let h1 = db.reference(withPath: "d8/a").observe(.value) { snap in
            delivered.append(Int("\(snap.value ?? -1)") ?? -1)
        }
        let h2 = db.reference(withPath: "d8/b").observe(.value) { snap in
            delivered.append(Int("\(snap.value ?? -1)") ?? -1)
        }
        await bridge.waitForSub(path: "/d8/a", count: 1)
        await bridge.waitForSub(path: "/d8/b", count: 1)
        let subA = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "/d8/a"
        }!["subId"]!.stringValue!
        let subB = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "/d8/b"
        }!["subId"]!.stringValue!

        let count = 2000
        for i in 0..<count {
            let sub = (i % 2 == 0) ? subA : subB
            bridge.current.deliver([
                "type": "worker-snap",
                "subId": sub,
                "value": ["exists": true, "value": i],
            ])
        }
        await delivered.wait(atLeast: count)
        let got = delivered.all
        var inversions = 0
        for idx in 1..<got.count where got[idx] < got[idx - 1] {
            inversions += 1
        }
        #expect(inversions == 0)

        db.reference(withPath: "d8/a").removeObserver(withHandle: h1)
        db.reference(withPath: "d8/b").removeObserver(withHandle: h2)
        await client.disconnect()
    }

    @Test("S20: Two Firestore document listeners fed alternating frames deliver strictly in wire frame order")
    func s20FirestoreTwoListenersFrameOrder() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let fs = makePr5Firestore(client)

        let delivered = GatedBox<Int>()
        let r1 = fs.document("d8/a").addSnapshotListener { snap, _ in
            if let raw = snap?.data()?["n"], let v = Int("\(raw)") { delivered.append(v) }
        }
        let r2 = fs.document("d8/b").addSnapshotListener { snap, _ in
            if let raw = snap?.data()?["n"], let v = Int("\(raw)") { delivered.append(v) }
        }
        await bridge.waitForSub(path: "d8/a", count: 1)
        await bridge.waitForSub(path: "d8/b", count: 1)
        let subA = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "d8/a"
        }!["subId"]!.stringValue!
        let subB = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "d8/b"
        }!["subId"]!.stringValue!

        let count = 1000
        for i in 0..<count {
            let sub = (i % 2 == 0) ? subA : subB
            bridge.current.deliver([
                "type": "worker-snap",
                "subId": sub,
                "value": ["path": i % 2 == 0 ? "d8/a" : "d8/b", "exists": true, "data": ["n": i]],
            ])
        }
        await delivered.wait(atLeast: count)
        let got = delivered.all
        var inversions = 0
        for idx in 1..<got.count where got[idx] < got[idx - 1] {
            inversions += 1
        }
        #expect(inversions == 0)

        r1.remove()
        r2.remove()
        await client.disconnect()
    }

    @Test("S21: Interleaved authState and idToken remote sync frames never leave currentUser stale")
    func s21AuthRemoteSyncFrameOrder() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let auth = Auth(app: FirebaseApp(name: "dc5-s21-\(UUID().uuidString)"), bridgeClient: client)

        let seen = GatedBox<String>()
        let handle = auth.addIDTokenDidChangeListener { _, user in
            seen.append(user?.uid ?? "nil")
        }
        await seen.wait(atLeast: 1)

        auth.startRemoteSync()
        await bridge.waitForSub(target: "authState", count: 1)
        await bridge.waitForSub(target: "idToken", count: 1)
        let sState = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?.stringValue == "authState"
        }!["subId"]!.stringValue!
        let sToken = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?.stringValue == "idToken"
        }!["subId"]!.stringValue!

        let totalFrames = 600
        for k in 1...totalFrames {
            let sub = (k % 2 == 1) ? sState : sToken
            bridge.current.deliver([
                "type": "worker-snap",
                "subId": sub,
                "value": ["user": ["uid": "u\(k)", "claims": ["firebase": ["sign_in_provider": "custom"]]]],
            ])
        }
        await seen.wait(atLeast: 1 + totalFrames)
        let expected = ["nil"] + (1...totalFrames).map { "u\($0)" }
        #expect(seen.all == expected)
        #expect(auth.currentUser?.uid == "u\(totalFrames)")

        auth.removeIDTokenDidChangeListener(handle)
        await client.disconnect()
    }

    @Test("S24: Concurrent Auth user transitions keep state/token listeners aligned with currentUser")
    func s24AuthConcurrentTransitionsMatchCurrentUser() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        let auth = Auth(app: FirebaseApp(name: "dc5-s24-\(UUID().uuidString)"), bridgeClient: client)
        let stateLast = GatedBox<String>()
        let tokenLast = GatedBox<String>()
        let h1 = auth.addStateDidChangeListener { _, user in
            stateLast.append(user?.uid ?? "nil")
        }
        let h2 = auth.addIDTokenDidChangeListener { _, user in
            tokenLast.append(user?.uid ?? "nil")
        }

        var mismatches = 0
        for r in 0..<2000 {
            let a = User(uid: "a\(r)")
            let b = User(uid: "b\(r)")
            DispatchQueue.concurrentPerform(iterations: 2) { idx in
                auth.applyUserTransition(idx == 0 ? a : b)
            }
            let current = auth.currentUser?.uid
            if stateLast.all.last != current || tokenLast.all.last != current {
                mismatches += 1
            }
        }
        #expect(mismatches == 0)
        auth.removeStateDidChangeListener(h1)
        auth.removeIDTokenDidChangeListener(h2)
        await client.disconnect()
    }

    @Test("S25: Database.authLensStream captures initial lens and yields transitions atomically under stateLock")
    func s25DatabaseAuthLensStreamConsistency() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        let db = makePr5Database(client)

        for r in 0..<200 {
            let target = AuthLens.asUser(uid: "u\(r)", tenant: nil, token: nil)
            let stream = db.authLensStream
            let sentinel = AuthLens.asUser(uid: "end\(r)", tenant: nil, token: nil)
            let collected = GatedBox<AuthLens>()
            let done = SignalGate()
            let task = Task {
                for await lens in stream {
                    collected.append(lens)
                    if lens == sentinel {
                        done.signal()
                        break
                    }
                }
            }
            db.switchLens(target)
            db.switchLens(sentinel)
            await done.wait()
            await task.value
            let all = collected.all
            #expect(all.last == sentinel)
            if let tIdx = all.firstIndex(of: target), let sIdx = all.lastIndex(of: sentinel) {
                #expect(tIdx < sIdx)
            } else {
                Issue.record("missing target lens \(target) in \(all)")
            }
        }
        await client.disconnect()
    }

    @Test("S27: RTDB observer callback never executes after removeObserver returns")
    func s27RtdbNoDeliveryAfterRemove() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makePr5Database(client)

        var lateDeliveries = 0
        for n in 0..<100 {
            let ref = db.reference(withPath: "s27/\(n)")
            let flag = GatedBox<Bool>()
            let late = GatedBox<Bool>()
            let handle = ref.observe(.value) { _ in
                if flag.count > 0 { late.append(true) }
            }
            await bridge.waitForSub(path: "/s27/\(n)", count: 1)
            let subId = bridge.subs(onSocket: 1).first {
                $0["sub"]?["target"]?["path"]?.stringValue == "/s27/\(n)"
            }!["subId"]!.stringValue!
            for i in 0..<40 {
                bridge.current.deliver([
                    "type": "worker-snap",
                    "subId": subId,
                    "value": ["exists": true, "value": i],
                ])
            }
            ref.removeObserver(withHandle: handle)
            flag.append(true)
            // Synchronize with actor after removal using a deterministic turn pass.
            await client.pass(turn: client.takeTurn())
            if late.count > 0 { lateDeliveries += 1 }
        }
        #expect(lateDeliveries == 0)
        await client.disconnect()
    }

    @Test("S28: Cancelled subscription is excluded synchronously from immediate re-attach restore")
    func s28CancelledSubscriptionNotRestoredOnImmediateReattach() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makePr5Database(client)

        for n in 0..<30 {
            let cancelledPath = "/s28/cancelled-\(n)"
            let keptPath = "/s28/kept-\(n)"
            let hCancel = db.reference(withPath: "s28/cancelled-\(n)").observe(.value) { _ in }
            let hKeep = db.reference(withPath: "s28/kept-\(n)").observe(.value) { _ in }
            await bridge.waitForSub(path: cancelledPath, count: 1)
            await bridge.waitForSub(path: keptPath, count: 1)

            let nextSocket = bridge.socketCount + 1
            // Remove observer and immediately drop socket without yielding for async unregister task.
            db.reference(withPath: "s28/cancelled-\(n)").removeObserver(withHandle: hCancel)
            bridge.current.drop()
            await bridge.waitForSockets(atLeast: nextSocket)
            await bridge.waitForSub(path: keptPath, count: 2)
            let restoredPaths = bridge.subs(onSocket: nextSocket).compactMap {
                $0["sub"]?["target"]?["path"]?.stringValue
            }
            #expect(!restoredPaths.contains(cancelledPath))
            #expect(restoredPaths.contains(keptPath))

            db.reference(withPath: "s28/kept-\(n)").removeObserver(withHandle: hKeep)
            await waitForState(client, .attached)
        }
        await client.disconnect()
    }

    @Test("S24: authStateDidChangeStream and idTokenDidChangeStream keep initial and concurrent updates aligned")
    func s24AuthStreamsConsistentWithCurrentUser() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        let auth = Auth(app: FirebaseApp(name: "dc5-s24-stream-\(UUID().uuidString)"), bridgeClient: client)

        for r in 0..<200 {
            let stateStream = auth.authStateDidChangeStream
            let tokenStream = auth.idTokenDidChangeStream
            let first = User(uid: "first-\(r)")
            let end = User(uid: "end-\(r)")
            let stateSeen = GatedBox<String>()
            let tokenSeen = GatedBox<String>()
            let stateDone = SignalGate()
            let tokenDone = SignalGate()

            let t1 = Task {
                for await u in stateStream {
                    let uid = u?.uid ?? "nil"
                    stateSeen.append(uid)
                    if uid == end.uid {
                        stateDone.signal()
                        break
                    }
                }
            }
            let t2 = Task {
                for await u in tokenStream {
                    let uid = u?.uid ?? "nil"
                    tokenSeen.append(uid)
                    if uid == end.uid {
                        tokenDone.signal()
                        break
                    }
                }
            }

            DispatchQueue.concurrentPerform(iterations: 2) { idx in
                if idx == 0 {
                    auth.applyUserTransition(first)
                } else {
                    auth.applyUserTransition(User(uid: "mid-\(r)"))
                }
            }
            auth.applyUserTransition(end)

            await stateDone.wait()
            await tokenDone.wait()
            await t1.value
            await t2.value
            #expect(stateSeen.all.last == end.uid)
            #expect(tokenSeen.all.last == end.uid)
            #expect(auth.currentUser?.uid == end.uid)
        }
        await client.disconnect()
    }

    @Test("S27: Firestore reg.remove() blocks until in-flight callback exits and suppresses queued frames")
    func s27FirestoreRemoveWaitsForInFlightCallback() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let fs = makePr5Firestore(client)

        let entered = SignalGate()
        let release = DispatchSemaphore(value: 0)
        let exited = GatedBox<Bool>()
        let afterRemove = GatedBox<Bool>()
        let callbackCount = GatedBox<Int>()

        let reg = fs.document("s27/doc").addSnapshotListener { snap, _ in
            let n = (snap?.data()?["n"]).flatMap { Int("\($0)") } ?? -1
            if afterRemove.count > 0 {
                afterRemove.append(true)
            }
            callbackCount.append(n)
            if n == 1 {
                entered.signal()
                release.wait()
                exited.append(true)
            }
        }
        await bridge.waitForSub(path: "s27/doc", count: 1)
        let subId = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "s27/doc"
        }!["subId"]!.stringValue!

        bridge.current.deliver([
            "type": "worker-snap",
            "subId": subId,
            "value": ["path": "s27/doc", "exists": true, "data": ["n": 1]],
        ])
        bridge.current.deliver([
            "type": "worker-snap",
            "subId": subId,
            "value": ["path": "s27/doc", "exists": true, "data": ["n": 2]],
        ])
        await entered.wait()

        let removeStarted = SignalGate()
        let removeFinished = SignalGate()
        let exitedBeforeRemoveReturned = GatedBox<Bool>()
        DispatchQueue.global().async {
            removeStarted.signal()
            reg.remove()
            exitedBeforeRemoveReturned.append(exited.count == 1)
            afterRemove.append(true)
            removeFinished.signal()
        }
        await removeStarted.wait()
        release.signal()
        await removeFinished.wait()

        await client.pass(turn: client.takeTurn())
        #expect(exitedBeforeRemoveReturned.all == [true])
        #expect(afterRemove.all == [true])
        #expect(callbackCount.all == [1])
        await client.disconnect()
    }

    @Test("S27: Re-entrant removeObserver inside RTDB callback does not deadlock and stops later frames")
    func s27RtdbReentrantRemoveInsideCallback() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makePr5Database(client)
        let ref = db.reference(withPath: "s27/reentrant")

        final class HandleSlot: @unchecked Sendable {
            private let lock = NSLock()
            private var value: UInt = 0
            func set(_ h: UInt) { lock.lock(); value = h; lock.unlock() }
            func get() -> UInt { lock.lock(); defer { lock.unlock() }; return value }
        }
        let slot = HandleSlot()
        let seen = GatedBox<Int>()
        let removedGate = SignalGate()
        let handle = ref.observe(.value) { snap in
            let v = Int("\(snap.value ?? -1)") ?? -1
            seen.append(v)
            ref.removeObserver(withHandle: slot.get())
            removedGate.signal()
        }
        slot.set(handle)

        await bridge.waitForSub(path: "/s27/reentrant", count: 1)
        let subId = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "/s27/reentrant"
        }!["subId"]!.stringValue!

        bridge.current.deliver([
            "type": "worker-snap",
            "subId": subId,
            "value": ["exists": true, "value": 10],
        ])
        bridge.current.deliver([
            "type": "worker-snap",
            "subId": subId,
            "value": ["exists": true, "value": 20],
        ])
        await removedGate.wait()
        await client.pass(turn: client.takeTurn())
        #expect(seen.all == [10])
        await client.disconnect()
    }

    @Test("S28: Removal marks admitted subscription cancelled synchronously before actor unregister")
    func s28SyncCancelledFlagSetBeforeActorTurn() async throws {
        // Direct synchronous state-table contract without any background Task race.
        let table = BridgePendingSubscriptions()
        let pendingId = table.reserve(
            target: .string("pending"),
            actAs: nil,
            includeMetadataChanges: false,
            listenSource: nil
        )
        #expect(table.cancel(id: pendingId))
        #expect(!table.isCancelled(id: pendingId))

        let admittedId = table.reserve(
            target: .string("admitted"),
            actAs: nil,
            includeMetadataChanges: false,
            listenSource: nil
        )
        #expect(table.take(id: admittedId) != nil)
        #expect(!table.cancel(id: admittedId))
        #expect(table.isCancelled(id: admittedId))
        table.clearCancelled(id: admittedId)
        #expect(!table.isCancelled(id: admittedId))

        // Live Database and Firestore handles immediately mark cancelled or already removed.
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makePr5Database(client)
        let fs = makePr5Firestore(client)

        let hRtdb = db.reference(withPath: "s28/sync-rtdb").observe(.value) { _ in }
        let rFs = fs.document("s28/sync-fs").addSnapshotListener { _, _ in }
        await bridge.waitForSub(path: "/s28/sync-rtdb", count: 1)
        await bridge.waitForSub(path: "s28/sync-fs", count: 1)

        let rtdbSubId = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "/s28/sync-rtdb"
        }!["subId"]!.stringValue!
        let fsSubId = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "s28/sync-fs"
        }!["subId"]!.stringValue!

        #expect(!client.isSubscriptionCancelled(rtdbSubId))
        #expect(!client.isSubscriptionCancelled(fsSubId))
        db.reference(withPath: "s28/sync-rtdb").removeObserver(withHandle: hRtdb)
        let rtdbCancelledSync = client.isSubscriptionCancelled(rtdbSubId)
        rFs.remove()
        let fsCancelledSync = client.isSubscriptionCancelled(fsSubId)

        let rtdbActive = await client.activeSubs[rtdbSubId] != nil
        let fsActive = await client.activeSubs[fsSubId] != nil
        #expect(rtdbCancelledSync || !rtdbActive)
        #expect(fsCancelledSync || !fsActive)

        await client.disconnect()
    }
}
