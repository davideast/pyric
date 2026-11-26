import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth
@testable import PyricDatabase

private func makeFirestore(_ client: PyricBridgeClient) -> Firestore {
    Firestore(bridgeClient: client, app: FirebaseApp(name: "dc-fs-\(UUID().uuidString)"))
}

private func makeDatabase(_ client: PyricBridgeClient) -> Database {
    Database(
        app: FirebaseApp(name: "dc-db-\(UUID().uuidString)"),
        url: "https://default.firebaseio.com",
        bridgeClient: client
    )
}

private func openSubTask(
    _ client: PyricBridgeClient,
    path: String,
    into values: GatedBox<AnySendable>? = nil
) -> Task<Void, Never> {
    let iterator = client.subscribe(
        target: AnySendable.dictionary(["service": .string("rtdb"), "path": .string(path)])
    ).makeAsyncIterator()
    return Task {
        do {
            while let value = try await iterator.next() {
                values?.append(value)
            }
        } catch {}
    }
}

@Suite("ADR-0019 delivery contract: PR 3 (S6, S9, S11-S19, S26)", .serialized)
struct DeliveryContractPr3Tests {

    @Test("S6: Firestore settings update keeps Firestore, Auth, and Database on one shared client")
    func s6SharedBridgeAfterSettingsUpdate() async throws {
        let app = FirebaseApp(name: "dc-s6-\(UUID().uuidString)")
        let auth = Auth.auth(app: app)
        let db = Database.database(app: app)
        let fs = Firestore.firestore(app: app)
        #expect(fs.bridgeClient === auth.bridgeClient)
        #expect(fs.bridgeClient === db.bridgeClient)

        // A local .info/connected read marks Database as used without opening a socket.
        let initial = try await db.reference(withPath: ".info/connected").getData()
        #expect(initial.value as? Bool == false)

        let updated = fs.settings
        updated.host = "127.0.0.1:9455"
        updated.sslEnabled = false
        fs.settings = updated

        #expect(fs.bridgeClient === auth.bridgeClient)
        #expect(fs.bridgeClient === db.bridgeClient)
        await app.delete()
    }

    @Test("S9: Restore replays 10+ subscriptions in creation order before a late interrupted subscription")
    func s9RestoreOrderNumericCreation() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()

        var tasks: [Task<Void, Never>] = []
        for i in 1...10 {
            tasks.append(openSubTask(client, path: "/r\(i)"))
            await bridge.waitForSub(path: "/r\(i)", count: 1)
        }

        await interruptGated(bridge, client)
        tasks.append(openSubTask(client, path: "/late"))

        bridge.refuseConnections = false
        await bridge.waitForSubs(onSocket: 2, count: 11)
        let order = bridge.subs(onSocket: 2).compactMap {
            $0["sub"]?["target"]?["path"]?.stringValue
        }
        let expected = (1...10).map { "/r\($0)" } + ["/late"]
        #expect(order == expected)

        for task in tasks { task.cancel() }
        await client.disconnect()
    }

    @Test("S11: A subscription opened mid-restore waits behind the restored subscriptions")
    func s11SubscriptionDuringRestoreWaits() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()

        let t1 = openSubTask(client, path: "/r1")
        await bridge.waitForSub(path: "/r1", count: 1)
        let t2 = openSubTask(client, path: "/r2")
        await bridge.waitForSub(path: "/r2", count: 1)

        let (entered, release) = bridge.suspendNextFrame(onSocket: 2) { frame in
            frame["type"]?.stringValue == "worker-sub"
                && frame["sub"]?["target"]?["path"]?.stringValue == "/r1"
        }

        bridge.current.drop()
        await entered.wait()

        // Register a new subscription while /r1 is suspended inside finishAttach.
        let t3 = openSubTask(client, path: "/during-restore")
        await client.pass(turn: client.takeTurn())
        release.signal()

        await bridge.waitForSubs(onSocket: 2, count: 3)
        let order = bridge.subs(onSocket: 2).compactMap {
            $0["sub"]?["target"]?["path"]?.stringValue
        }
        #expect(order == ["/r1", "/r2", "/during-restore"])

        for task in [t1, t2, t3] { task.cancel() }
        await client.disconnect()
    }

    @Test("S12: Local streams finish on policy close (1008) and when created after close")
    func s12LocalStreamsFinishOnEveryClose() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()

        let states = GatedBox<BridgeConnectionState>()
        let stateStream = client.connectionStates
        let lensStream = client.remoteLensStream
        let denialStream = client.denialStream

        let stateDone = SignalGate()
        let lensDone = SignalGate()
        let denialDone = SignalGate()

        let tState = Task {
            for await state in stateStream { states.append(state) }
            stateDone.signal()
        }
        let tLens = Task {
            for await _ in lensStream {}
            lensDone.signal()
        }
        let tDenial = Task {
            for await _ in denialStream {}
            denialDone.signal()
        }
        await states.wait(atLeast: 1)
        #expect(states.all.first == .attached)

        bridge.current.drop(code: 1008)
        await stateDone.wait()
        await lensDone.wait()
        await denialDone.wait()
        #expect(states.all.last == .closed)
        _ = (tState, tLens, tDenial)

        // Creating streams after policy close finishes immediately.
        var postPolicyStates: [BridgeConnectionState] = []
        for await s in client.connectionStates { postPolicyStates.append(s) }
        #expect(postPolicyStates == [.closed])
        var postPolicyLens = 0
        for await _ in client.remoteLensStream { postPolicyLens += 1 }
        #expect(postPolicyLens == 0)
        var postPolicyDenials = 0
        for await _ in client.denialStream { postPolicyDenials += 1 }
        #expect(postPolicyDenials == 0)

        // Creating streams after disconnect() also finishes immediately.
        let bridge2 = GatedBridge()
        let client2 = bridge2.makeClient()
        try await client2.connect()
        await client2.disconnect()

        var postDisconnectStates: [BridgeConnectionState] = []
        for await s in client2.connectionStates { postDisconnectStates.append(s) }
        #expect(postDisconnectStates == [.closed])
        var postDisconnectLens = 0
        for await _ in client2.remoteLensStream { postDisconnectLens += 1 }
        #expect(postDisconnectLens == 0)
        var postDisconnectDenials = 0
        for await _ in client2.denialStream { postDisconnectDenials += 1 }
        #expect(postDisconnectDenials == 0)
    }

    @Test("S13: remoteLensStream registers synchronously without dropping an immediate push")
    func s13RemoteLensStreamSynchronousRegistration() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()

        for n in 0..<50 {
            let stream = client.remoteLensStream
            #expect(client.remoteLensContinuationCount == 1)
            let seen = GatedBox<AuthLens>()
            let done = SignalGate()
            let consumer = Task {
                for await lens in stream {
                    seen.append(lens)
                    if lens == .asUser(uid: "sentinel-\(n)", tenant: nil, token: nil) {
                        done.signal()
                        break
                    }
                }
            }
            bridge.current.deliver([
                "type": "worker-event",
                "event": "remote-lens",
                "lens": ["mode": "as", "uid": "first-\(n)"],
            ])
            bridge.current.deliver([
                "type": "worker-event",
                "event": "remote-lens",
                "lens": ["mode": "as", "uid": "sentinel-\(n)"],
            ])
            await done.wait()
            await consumer.value
            #expect(seen.all.contains(.asUser(uid: "first-\(n)", tenant: nil, token: nil)))
        }

        await client.disconnect()
    }

    @Test("S14: denialStream registers synchronously without dropping an immediate denial")
    func s14DenialStreamSynchronousRegistration() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()

        for n in 0..<50 {
            let op1 = Task { try? await client.op(method: "probe.denied", params: ["n": .int(Int64(n))]) }
            await bridge.waitForOp(method: "probe.denied", count: n + 1)
            let frame1 = bridge.ops(named: "probe.denied")[n]

            let stream = client.denialStream
            #expect(client.denialContinuationCount == 1)
            let seen = GatedBox<String>()
            let done = SignalGate()
            let consumer = Task {
                for await err in stream {
                    seen.append(err.message)
                    if err.message == "sentinel-\(n)" {
                        done.signal()
                        break
                    }
                }
            }
            bridge.current.deliver([
                "type": "worker-res",
                "id": frame1["id"]!.stringValue!,
                "ok": false,
                "error": ["code": "permission-denied", "message": "first-\(n)"],
            ])
            _ = await op1.value

            let op2 = Task { try? await client.op(method: "probe.sentinel", params: ["n": .int(Int64(n))]) }
            await bridge.waitForOp(method: "probe.sentinel", count: n + 1)
            let frame2 = bridge.ops(named: "probe.sentinel")[n]
            bridge.current.deliver([
                "type": "worker-res",
                "id": frame2["id"]!.stringValue!,
                "ok": false,
                "error": ["code": "permission-denied", "message": "sentinel-\(n)"],
            ])
            _ = await op2.value
            await done.wait()
            await consumer.value
            #expect(seen.all.contains("first-\(n)"))
        }

        await client.disconnect()
    }

    @Test("S15: connectionStates captures the state at creation before an immediate drop")
    func s15ConnectionStatesSynchronousRegistration() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()

        for _ in 0..<50 {
            let stream = client.connectionStates
            #expect(client.stateContinuationCount == 1)
            let got = GatedBox<BridgeConnectionState>()
            let consumer = Task {
                for await state in stream {
                    got.append(state)
                    if got.count == 2 { break }
                }
            }
            bridge.refuseConnections = true
            bridge.current.drop()
            await got.wait(atLeast: 2)
            await consumer.value
            #expect(got.all == [.attached, .interrupted])

            bridge.refuseConnections = false
            await waitForState(client, .attached)
        }

        await client.disconnect()
    }

    @Test("S16: RTDB observe registers synchronously ahead of a subsequent setValue")
    func s16RtdbObserveTakesTurnBeforeWrite() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makeDatabase(client)

        let gate = CallOrderGate(client)
        let ref = db.reference(withPath: "s16/gated")
        let handle = ref.observe(.value) { _ in }
        #expect(gate.callTurnsTaken() == 1)
        ref.setValue(1) { _, _ in }
        #expect(gate.callTurnsTaken() == 2)
        try await gate.open(afterCalls: 2) { false }

        await bridge.waitForSub(path: "/s16/gated", count: 1)
        await bridge.waitForOp(method: "rtdb.set", path: "/s16/gated", count: 1)
        let frames = bridge.frames
        let subIdx = frames.firstIndex {
            $0["type"]?.stringValue == "worker-sub" && $0["sub"]?["target"]?["path"]?.stringValue == "/s16/gated"
        }
        let opIdx = frames.firstIndex {
            $0["type"]?.stringValue == "worker-op" && $0["op"]?["path"]?.stringValue == "/s16/gated"
        }
        #expect(subIdx != nil && opIdx != nil)
        if let subIdx, let opIdx {
            #expect(subIdx < opIdx)
        }
        ref.removeObserver(withHandle: handle)

        for n in 0..<40 {
            let r = db.reference(withPath: "s16/\(n)")
            let h = r.observe(.value) { _ in }
            r.setValue(n) { _, _ in }
            await bridge.waitForSub(path: "/s16/\(n)", count: 1)
            await bridge.waitForOp(method: "rtdb.set", path: "/s16/\(n)", count: 1)
            let snap = bridge.frames
            let s = snap.firstIndex {
                $0["type"]?.stringValue == "worker-sub" && $0["sub"]?["target"]?["path"]?.stringValue == "/s16/\(n)"
            }!
            let o = snap.firstIndex {
                $0["type"]?.stringValue == "worker-op" && $0["op"]?["path"]?.stringValue == "/s16/\(n)"
            }!
            #expect(s < o)
            r.removeObserver(withHandle: h)
        }

        await client.disconnect()
    }

    @Test("S17: Firestore addSnapshotListener registers synchronously ahead of a subsequent setData")
    func s17FirestoreListenTakesTurnBeforeWrite() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let fs = makeFirestore(client)

        let gate = CallOrderGate(client)
        let doc = fs.document("s17/gated")
        let reg = doc.addSnapshotListener { _, _ in }
        #expect(gate.callTurnsTaken() == 1)
        doc.setData(["n": 1], completion: nil)
        #expect(gate.callTurnsTaken() == 2)
        try await gate.open(afterCalls: 2) { false }

        await bridge.waitForSub(path: "s17/gated", count: 1)
        await bridge.waitForOp(method: "setDoc", path: "s17/gated", count: 1)
        let frames = bridge.frames
        let subIdx = frames.firstIndex {
            $0["type"]?.stringValue == "worker-sub" && $0["sub"]?["target"]?["path"]?.stringValue == "s17/gated"
        }
        let opIdx = frames.firstIndex {
            $0["type"]?.stringValue == "worker-op" && $0["op"]?["path"]?.stringValue == "s17/gated"
        }
        #expect(subIdx != nil && opIdx != nil)
        if let subIdx, let opIdx {
            #expect(subIdx < opIdx)
        }
        reg.remove()

        for n in 0..<40 {
            let d = fs.document("s17/\(n)")
            let r = d.addSnapshotListener { _, _ in }
            d.setData(["n": n], completion: nil)
            await bridge.waitForSub(path: "s17/\(n)", count: 1)
            await bridge.waitForOp(method: "setDoc", path: "s17/\(n)", count: 1)
            let snap = bridge.frames
            let s = snap.firstIndex {
                $0["type"]?.stringValue == "worker-sub" && $0["sub"]?["target"]?["path"]?.stringValue == "s17/\(n)"
            }!
            let o = snap.firstIndex {
                $0["type"]?.stringValue == "worker-op" && $0["op"]?["path"]?.stringValue == "s17/\(n)"
            }!
            #expect(s < o)
            r.remove()
        }

        await client.disconnect()
    }

    @Test("S18: Auth startRemoteSync registers authState and idToken synchronously before returning")
    func s18AuthStartRemoteSyncSynchronous() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let auth = Auth(app: FirebaseApp(name: "dc-s18-\(UUID().uuidString)"), bridgeClient: client)

        let gate = CallOrderGate(client)
        auth.startRemoteSync()
        #expect(gate.callTurnsTaken() == 2)
        auth.signInAnonymously(completion: nil)
        #expect(gate.callTurnsTaken() == 3)
        try await gate.open(afterCalls: 3) { false }

        await bridge.waitForSub(target: "authState", count: 1)
        await bridge.waitForSub(target: "idToken", count: 1)
        await bridge.waitForOp(method: "auth.signInAnonymously", count: 1)
        let frames = bridge.frames
        let authSub = frames.firstIndex {
            $0["type"]?.stringValue == "worker-sub" && $0["sub"]?["target"]?.stringValue == "authState"
        }!
        let tokenSub = frames.firstIndex {
            $0["type"]?.stringValue == "worker-sub" && $0["sub"]?["target"]?.stringValue == "idToken"
        }!
        let signInOp = frames.firstIndex {
            $0["type"]?.stringValue == "worker-op" && $0["op"]?["method"]?.stringValue == "auth.signInAnonymously"
        }!
        #expect(authSub < signInOp)
        #expect(tokenSub < signInOp)
        await client.disconnect()
    }

    @Test("S19: Auth installs authRestorer synchronously during init without a background Task hop")
    func s19AuthRestorerInstalledSynchronously() async throws {
        for _ in 0..<25 {
            let bridge = GatedBridge()
            let client = bridge.makeClient()
            try await client.connect()
            let auth = Auth(app: FirebaseApp(name: "dc-s19-\(UUID().uuidString)"), bridgeClient: client)
            #expect(client.hasAuthRestorer == true)
            #expect(client.remoteLensContinuationCount == 1)
            auth.applyUserTransition(User(uid: "u1"))

            // Immediately trigger replaced-host reconnect without yielding for any Task.
            bridge.hostInstanceId = "host-b"
            bridge.current.drop()
            await bridge.waitForOp(method: "auth.restorePortSession", count: 1)
            bridge.answer(bridge.ops(named: "auth.restorePortSession")[0], value: ["uid": "u1"])
            await waitForState(client, .attached)
            await client.disconnect()
        }
    }

    @Test("S26: .info/connected getData and listeners read the exact same synchronous snapshot")
    func s26InfoConnectedSingleSnapshot() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        let db = makeDatabase(client)
        let info = db.reference(withPath: ".info/connected")

        let firstObserved = GatedBox<Bool>()
        let h1 = info.observe(.value) { snap in
            firstObserved.append(snap.value as? Bool ?? false)
        }
        await firstObserved.wait(atLeast: 1)
        #expect(firstObserved.all == [false])

        for round in 0..<25 {
            bridge.refuseConnections = false
            if round == 0 {
                try await client.connect()
            }
            await waitForState(client, .attached)

            let readTrue = try await info.getData().value as? Bool
            #expect(readTrue == true)

            // A brand-new listener registered immediately after getData() returns true
            // must observe true first, never a stale false from a lagging tracker task.
            let secondObserved = GatedBox<Bool>()
            let h2 = info.observe(.value) { snap in
                secondObserved.append(snap.value as? Bool ?? false)
            }
            await secondObserved.wait(atLeast: 1)
            #expect(secondObserved.all.first == true)
            info.removeObserver(withHandle: h2)

            await interruptGated(bridge, client)
            let readFalse = try await info.getData().value as? Bool
            #expect(readFalse == false)
            let thirdObserved = GatedBox<Bool>()
            let h3 = info.observe(.value) { snap in
                thirdObserved.append(snap.value as? Bool ?? false)
            }
            await thirdObserved.wait(atLeast: 1)
            #expect(thirdObserved.all.first == false)
            info.removeObserver(withHandle: h3)
        }

        info.removeObserver(withHandle: h1)
        await client.disconnect()
    }

    @Test("S11: Non-refusal send failure during restore does not spin finishAttach")
    func s11NonRefusalRestoreSendErrorDoesNotSpin() async throws {
        let bridge = GatedBridge()
        let socketCount = CountGate()
        let client = PyricBridgeClient(
            reconnectDelay: { _ in 0 },
            transportFactory: { request in
                guard let inner = try await bridge.connect(request) as? FakeReconnectSocket else {
                    throw PyricBridgeError.internalError("unexpected socket type")
                }
                let wrapped = ClosingSocket(inner: inner)
                socketCount.increment()
                if socketCount.count == 2 {
                    wrapped.failSends(ofType: "worker-sub")
                }
                return wrapped
            }
        )
        try await client.connect()
        let subTask = openSubTask(client, path: "/r1")
        await bridge.waitForSub(path: "/r1", count: 1)

        bridge.current.drop(code: 1006)
        await socketCount.wait(atLeast: 2)
        await waitForState(client, .attached)

        // Confirm finishAttach completed and released held-op draining.
        let probeTurn = client.takeTurn()
        let probe = Task {
            try await client.op(turn: probeTurn, method: "getDoc", params: ["path": .string("rooms/ok")])
        }
        await bridge.waitForOp(method: "getDoc", path: "rooms/ok", count: 1)
        bridge.answer(bridge.ops(named: "getDoc")[0])
        _ = try await probe.value

        subTask.cancel()
        await client.disconnect()
    }
}
