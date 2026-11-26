import Foundation
import Testing
@testable import PyricFirestore
@testable import PyricDatabase

private func makeDrainDatabase(_ client: PyricBridgeClient) -> Database {
    Database(
        app: FirebaseApp(name: "dc-drain-\(UUID().uuidString)"),
        url: "https://default.firebaseio.com",
        bridgeClient: client
    )
}

private func syncGoOffline(_ db: Database) {
    db.goOffline()
}

private func syncGoOnline(_ db: Database) {
    db.goOnline()
}

private func summarizeDrainFrames(_ frames: [[String: AnySendable]]) -> [String] {
    frames.compactMap { frame in
        switch frame["type"]?.stringValue {
        case "worker-op":
            let method = frame["op"]?["method"]?.stringValue ?? "?"
            let path = frame["op"]?["path"]?.stringValue ?? ""
            return "op:\(method):\(path)"
        case "worker-sub":
            let path = frame["sub"]?["target"]?["path"]?.stringValue ?? "?"
            return "sub:\(path)"
        default:
            return nil
        }
    }
}

@Suite("ADR-0019 delivery contract: PR 3 drain, refusal, and presence turn ordering", .serialized)
struct DeliveryContractPr3DrainTests {

    @Test("D5/D7: During sendHeldOperations, held1 -> held2 -> op3 -> sub preserves exact admission order")
    func drainOrderHeldThenOpThenSub() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makeDrainDatabase(client)

        await interruptGated(bridge, client)
        let d1 = SignalGate()
        let d2 = SignalGate()
        let d3 = SignalGate()
        db.reference(withPath: "drain/h1").setValue(1) { _, _ in d1.signal() }
        db.reference(withPath: "drain/h2").setValue(2) { _, _ in d2.signal() }
        await client.pass(turn: client.takeTurn())
        #expect(await client.heldOperationCount == 2)

        let (entered, release) = bridge.suspendNextFrame(onSocket: 2) { frame in
            frame["type"]?.stringValue == "worker-op"
                && frame["op"]?["path"]?.stringValue == "/drain/h1"
        }
        bridge.refuseConnections = false
        await entered.wait()

        // While held1 is suspended in sendHeldOperations, issue op3 then sub.
        db.reference(withPath: "drain/op3").setValue(3) { _, _ in d3.signal() }
        let handle = db.reference(withPath: "drain/sub").observe(.value) { _ in }
        await client.pass(turn: client.takeTurn())
        release.signal()

        await bridge.waitForSub(path: "/drain/sub", count: 1)
        await bridge.waitForOp(method: "rtdb.set", path: "/drain/op3", count: 1)
        let summary = summarizeDrainFrames(bridge.frames(onSocket: 2))
        #expect(summary == [
            "op:rtdb.set:/drain/h1",
            "op:rtdb.set:/drain/h2",
            "op:rtdb.set:/drain/op3",
            "sub:/drain/sub",
        ])

        for op in bridge.ops(named: "rtdb.set") { bridge.answer(op) }
        await d1.wait()
        await d2.wait()
        await d3.wait()
        db.reference(withPath: "drain/sub").removeObserver(withHandle: handle)
        await client.disconnect()
    }

    @Test("D5/D7: During sendHeldOperations, held1 -> sub -> op3 preserves exact admission order")
    func drainOrderHeldThenSubThenOp() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makeDrainDatabase(client)

        await interruptGated(bridge, client)
        let d1 = SignalGate()
        let d3 = SignalGate()
        db.reference(withPath: "drain2/h1").setValue(1) { _, _ in d1.signal() }
        await client.pass(turn: client.takeTurn())
        #expect(await client.heldOperationCount == 1)

        let (entered, release) = bridge.suspendNextFrame(onSocket: 2) { frame in
            frame["type"]?.stringValue == "worker-op"
                && frame["op"]?["path"]?.stringValue == "/drain2/h1"
        }
        bridge.refuseConnections = false
        await entered.wait()

        // While held1 is suspended in sendHeldOperations, issue sub then op3.
        let handle = db.reference(withPath: "drain2/sub").observe(.value) { _ in }
        db.reference(withPath: "drain2/op3").setValue(3) { _, _ in d3.signal() }
        await client.pass(turn: client.takeTurn())
        release.signal()

        await bridge.waitForSub(path: "/drain2/sub", count: 1)
        await bridge.waitForOp(method: "rtdb.set", path: "/drain2/op3", count: 1)
        let summary = summarizeDrainFrames(bridge.frames(onSocket: 2))
        #expect(summary == [
            "op:rtdb.set:/drain2/h1",
            "sub:/drain2/sub",
            "op:rtdb.set:/drain2/op3",
        ])

        for op in bridge.ops(named: "rtdb.set") { bridge.answer(op) }
        await d1.wait()
        await d3.wait()
        db.reference(withPath: "drain2/sub").removeObserver(withHandle: handle)
        await client.disconnect()
    }

    @Test("D5/D7: A refused worker-sub marks socketRefusing so a queued op is held behind it; late refusal does not poison socket 2")
    func refusedWorkerSubHoldsFollowingOpAndLateRefusalDoesNotPoisonNextSocket() async throws {
        let bridge = GatedBridge()
        let sockets = GatedBox<ClosingSocket>()
        let client = PyricBridgeClient(
            reconnectDelay: { _ in 0 },
            transportFactory: { request in
                guard let inner = try await bridge.connect(request) as? FakeReconnectSocket else {
                    throw PyricBridgeError.internalError("unexpected socket type")
                }
                let wrapped = ClosingSocket(inner: inner)
                sockets.append(wrapped)
                return wrapped
            }
        )
        try await client.connect()
        let db = makeDrainDatabase(client)
        let firstSocket = sockets.all[0]

        firstSocket.beginClosing(holdingRefusals: true)
        let handle = db.reference(withPath: "refused/sub").observe(.value) { _ in }
        let writeDone = SignalGate()
        db.reference(withPath: "refused/op").setValue(1) { _, _ in writeDone.signal() }
        await client.pass(turn: client.takeTurn())

        // Drop socket 1 BEFORE releasing the held refusal on worker-sub so the refusal
        // returns late after socket 2 attaches; it must NOT poison socket 2.
        firstSocket.finishClosing(code: 1006)
        await sockets.wait(atLeast: 2)
        await waitForState(client, .attached)
        firstSocket.releaseRefusals()

        await bridge.waitForSub(path: "/refused/sub", count: 1)
        await bridge.waitForOp(method: "rtdb.set", path: "/refused/op", count: 1)
        #expect(summarizeDrainFrames(bridge.frames(onSocket: 1)).isEmpty)
        let summary2 = summarizeDrainFrames(bridge.frames(onSocket: 2))
        #expect(summary2 == [
            "sub:/refused/sub",
            "op:rtdb.set:/refused/op",
        ])

        // Verify socket 2 still dispatches new operations immediately (not poisoned).
        let afterDone = SignalGate()
        db.reference(withPath: "refused/after").setValue(2) { _, _ in afterDone.signal() }
        await bridge.waitForOp(method: "rtdb.set", path: "/refused/after", count: 1)
        for op in bridge.ops(named: "rtdb.set") { bridge.answer(op) }
        await writeDone.wait()
        await afterDone.wait()
        db.reference(withPath: "refused/sub").removeObserver(withHandle: handle)
        await client.disconnect()
    }

    @Test("D1/D9: goOnline reserves its turn before .info/connected true triggers onDisconnectSet")
    func goOnlinePrecedesPresenceCallbackOnDisconnect() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makeDrainDatabase(client)
        let status = db.reference(withPath: "presence/u1")
        let infoValues = GatedBox<Bool>()
        let handle = db.reference(withPath: ".info/connected").observe(.value) { snap in
            let connected = snap.value as? Bool ?? false
            infoValues.append(connected)
            guard connected else { return }
            Task {
                try? await status.onDisconnect().setValue("offline")
            }
        }
        await infoValues.wait(atLeast: 1)
        await bridge.waitForOp(method: "rtdb.onDisconnectSet", path: "/presence/u1", count: 1)
        bridge.answer(bridge.ops(named: "rtdb.onDisconnectSet")[0])

        for round in 1...15 {
            syncGoOffline(db)
            await infoValues.wait(atLeast: 2 * round)
            await bridge.waitForOp(method: "rtdb.goOffline", count: round)
            bridge.answer(bridge.ops(named: "rtdb.goOffline")[round - 1])

            if round % 2 == 1 {
                syncGoOnline(db)
            } else {
                let onlineTask = Task { try await db.goOnline() }
                await bridge.waitForOp(method: "rtdb.goOnline", count: round)
                bridge.answer(bridge.ops(named: "rtdb.goOnline")[round - 1])
                try await onlineTask.value
            }

            await bridge.waitForOp(method: "rtdb.goOnline", count: round)
            if round % 2 == 1 {
                bridge.answer(bridge.ops(named: "rtdb.goOnline")[round - 1])
            }
            await bridge.waitForOp(method: "rtdb.onDisconnectSet", path: "/presence/u1", count: round + 1)
            bridge.answer(bridge.ops(named: "rtdb.onDisconnectSet")[round])

            let frames = bridge.frames
            let onlineIndices = frames.indices.filter {
                frames[$0]["op"]?["method"]?.stringValue == "rtdb.goOnline"
            }
            let rearmIndices = frames.indices.filter {
                frames[$0]["op"]?["method"]?.stringValue == "rtdb.onDisconnectSet"
            }
            #expect(onlineIndices[round - 1] < rearmIndices[round])
        }

        db.reference(withPath: ".info/connected").removeObserver(withHandle: handle)
        await client.disconnect()
    }

    @Test("D5/D7: A live worker-sub refusal holds a queued op on the same open socket until reconnect")
    func liveRefusedWorkerSubHoldsQueuedOpBeforeDrop() async throws {
        final class RefuseOnceSubSocket: WebSocketTransport, @unchecked Sendable {
            private let inner: FakeReconnectSocket
            private let lock = NSLock()
            private var refuseNextSub = false
            private var refused = SignalGate()

            init(_ inner: FakeReconnectSocket) {
                self.inner = inner
            }

            func armSingleSubRefusal() -> SignalGate {
                lock.lock()
                refuseNextSub = true
                let gate = SignalGate()
                refused = gate
                lock.unlock()
                return gate
            }

            func send(_ string: String) async throws {
                let shouldRefuse: SignalGate? = {
                    lock.lock()
                    defer { lock.unlock() }
                    guard refuseNextSub, string.contains("\"type\":\"worker-sub\"") else { return nil }
                    refuseNextSub = false
                    return refused
                }()
                if let gate = shouldRefuse {
                    gate.signal()
                    throw WebSocketSendRefusedError()
                }
                try await inner.send(string)
            }

            func receive() async throws -> String { try await inner.receive() }
            func close(closeCode: Int, reason: String?) async { await inner.close(closeCode: closeCode, reason: reason) }
            func drop() { inner.drop(code: 1006) }
        }

        let bridge = GatedBridge()
        let wrappedSockets = GatedBox<RefuseOnceSubSocket>()
        let client = PyricBridgeClient(
            reconnectDelay: { _ in 0 },
            transportFactory: { request in
                guard let inner = try await bridge.connect(request) as? FakeReconnectSocket else {
                    throw PyricBridgeError.internalError("unexpected socket type")
                }
                let wrapped = RefuseOnceSubSocket(inner)
                wrappedSockets.append(wrapped)
                return wrapped
            }
        )
        try await client.connect()
        let db = makeDrainDatabase(client)

        let refusedGate = wrappedSockets.all[0].armSingleSubRefusal()
        let handle = db.reference(withPath: "live-refuse/sub").observe(.value) { _ in }
        let writeDone = SignalGate()
        db.reference(withPath: "live-refuse/op").setValue(1) { _, _ in writeDone.signal() }
        await refusedGate.wait()
        await client.flushSocketWrites()

        // Even though socket 1 is still open and only refused worker-sub once,
        // socketRefusing must hold live-refuse/op off socket 1 until reconnect.
        #expect(summarizeDrainFrames(bridge.frames(onSocket: 1)).isEmpty)
        #expect(await client.heldOperationCount == 1)

        wrappedSockets.all[0].drop()
        await bridge.waitForSub(path: "/live-refuse/sub", count: 1)
        await bridge.waitForOp(method: "rtdb.set", path: "/live-refuse/op", count: 1)
        #expect(summarizeDrainFrames(bridge.frames(onSocket: 2)) == [
            "sub:/live-refuse/sub",
            "op:rtdb.set:/live-refuse/op",
        ])

        bridge.answer(bridge.ops(named: "rtdb.set")[0])
        await writeDone.wait()
        db.reference(withPath: "live-refuse/sub").removeObserver(withHandle: handle)
        await client.disconnect()
    }
}
