import Foundation
import Testing
@testable import PyricFirestore
import PyricDatabase

// Writes issued back to back from one caller through the completion-block
// forms reach the bridge in the order the app called them (#1026). The fake
// bridge lives in BridgeReconnectTests.swift.

private let writeCount = 1000

private func makeDatabase(_ client: PyricBridgeClient) -> Database {
    Database(app: FirebaseApp(name: "order-\(UUID().uuidString)"), url: "https://default.firebaseio.com", bridgeClient: client)
}

/// The methods `issueWrites` sends, in turn.
private let writeMethods = ["rtdb.set", "rtdb.update", "rtdb.remove", "rtdb.setPriority", "rtdb.setWithPriority"]

/// Issues `count` writes without waiting between them, each through a
/// completion-block form and each to its own path `order/<n>`, cycling
/// through the forms in `writeMethods` order.
private func issueWrites(_ db: Database, count: Int, completions: Collected<String?>) {
    let done: @Sendable (Error?, DatabaseReference) -> Void = { error, _ in
        completions.append(error.map { "\($0)" })
    }
    for n in 0..<count {
        let ref = db.reference(withPath: "order/\(n)")
        switch n % writeMethods.count {
        case 0: ref.setValue(n, withCompletionBlock: done)
        case 1: ref.updateChildValues(["n": n], withCompletionBlock: done)
        case 2: ref.removeValue(completionBlock: done)
        case 3: ref.setPriority(n, withCompletionBlock: done)
        default: ref.setValue(n, andPriority: n, withCompletionBlock: done)
        }
    }
}

/// Calls the non-async `goOffline()`, a write, then the non-async `goOnline()`,
/// `count` times. Synchronous, so the non-async overloads are the ones called.
private func issueTogglesAroundWrites(_ db: Database, count: Int) {
    for n in 0..<count {
        db.goOffline()
        db.reference(withPath: "order/\(n)").setValue(n) { _, _ in }
        db.goOnline()
    }
}

private func writeFrames(_ bridge: FakeReconnectBridge) -> [[String: AnySendable]] {
    bridge.ofType("worker-op").filter { $0["op"]?["path"]?.stringValue?.hasPrefix("/order/") == true }
}

/// The `(method, path)` of every write frame, in the order the bridge received them.
private func sentOrder(_ bridge: FakeReconnectBridge) -> [String] {
    writeFrames(bridge).map { frame in
        "\(frame["op"]?["method"]?.stringValue ?? "?") \(frame["op"]?["path"]?.stringValue ?? "?")"
    }
}

private func expectedOrder(count: Int) -> [String] {
    (0..<count).map { n in "\(writeMethods[n % writeMethods.count]) /order/\(n)" }
}

/// Answers every write frame, then waits for every completion block to run without an error.
private func answerAll(_ bridge: FakeReconnectBridge, completions: Collected<String?>, count: Int) async throws {
    for frame in writeFrames(bridge) { bridge.answer(frame) }
    try await until { completions.count == count }
    #expect(completions.all.allSatisfy { $0 == nil })
}

@Suite("RTDB write order from completion-block forms")
struct RtdbWriteOrderTests {

    @Test("Back-to-back completion-block writes are sent in call order while connected")
    func connectedWritesKeepCallOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeDatabase(client)
        let completions = Collected<String?>()

        issueWrites(db, count: writeCount, completions: completions)
        try await until { writeFrames(bridge).count == writeCount }

        #expect(sentOrder(bridge) == expectedOrder(count: writeCount))
        try await answerAll(bridge, completions: completions, count: writeCount)
        await client.disconnect()
    }

    @Test("Back-to-back completion-block writes issued during a disconnect are sent in call order after the re-attach")
    func heldWritesKeepCallOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        try await client.connect()
        let db = makeDatabase(client)
        let completions = Collected<String?>()
        try await interrupt(bridge, client)

        issueWrites(db, count: writeCount, completions: completions)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(writeFrames(bridge).isEmpty)

        bridge.refuseConnections = false
        try await until { writeFrames(bridge).count == writeCount }

        #expect(sentOrder(bridge) == expectedOrder(count: writeCount))
        #expect(bridge.socketCount == 2)
        try await answerAll(bridge, completions: completions, count: writeCount)
        await client.disconnect()
    }

    @Test("A write is sent while the reply to an earlier write is still pending, and replies may arrive in either order")
    func writesPipeline() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeDatabase(client)
        let completed = Collected<String>()

        db.reference(withPath: "order/0").setValue(0) { _, ref in completed.append(ref.key ?? "?") }
        db.reference(withPath: "order/1").setValue(1) { _, ref in completed.append(ref.key ?? "?") }
        try await until { writeFrames(bridge).count == 2 }
        #expect(completed.all.isEmpty)

        bridge.answer(writeFrames(bridge)[1])
        try await until { completed.count == 1 }
        #expect(completed.all == ["1"])
        bridge.answer(writeFrames(bridge)[0])
        try await until { completed.count == 2 }
        #expect(completed.all == ["1", "0"])
        await client.disconnect()
    }

    @Test("A write that fails before it is sent does not stall the write after it")
    func failedWriteReleasesItsTurn() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeDatabase(client)
        let errors = Collected<String?>()

        // JSON cannot carry NaN, so this frame fails to encode and is never sent.
        db.reference(withPath: "order/0").setValue(Double.nan) { error, _ in errors.append(error.map { "\($0)" }) }
        db.reference(withPath: "order/1").setValue(1) { error, _ in errors.append(error.map { "\($0)" }) }
        try await until { writeFrames(bridge).count == 1 && errors.count == 1 }
        #expect(sentOrder(bridge) == ["rtdb.set /order/1"])
        #expect(errors.all[0] != nil)

        bridge.answer(writeFrames(bridge)[0])
        try await until { errors.count == 2 }
        #expect(errors.all[1] == nil)
        await client.disconnect()
    }

    @Test("A turn whose operation throws before it is sent or held lets the next turn in")
    func turnIsReleasedOnAnEarlyThrow() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        await client.disconnect()
        let first = client.takeTurn()
        let second = client.takeTurn()

        // The second turn arrives first and waits for the first.
        let next = Task { try await client.op(turn: second, method: "rtdb.set", params: ["path": "/order/1"]) }
        try await Task.sleep(nanoseconds: 20_000_000)
        await #expect(throws: PyricBridgeError.self) {
            try await client.op(turn: first, method: "rtdb.set", params: ["path": "/order/0"])
        }
        await #expect(throws: PyricBridgeError.self) { try await next.value }
    }

    @Test("A transaction on `.info` sends nothing for its first read and does not stall the write after it")
    func infoTransactionPassesItsTurn() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeDatabase(client)
        let aborted = Collected<Bool>()
        let errors = Collected<String?>()

        db.reference(withPath: ".info/connected").runTransactionBlock({ _ in .abort() }) { _, committed, _ in
            aborted.append(!committed)
        }
        db.reference(withPath: "order/0").setValue(0) { error, _ in errors.append(error.map { "\($0)" }) }
        try await until { writeFrames(bridge).count == 1 && aborted.count == 1 }
        bridge.answer(writeFrames(bridge)[0])
        try await until { errors.count == 1 }
        #expect(errors.all == [nil])
        #expect(bridge.ops(named: "rtdb.get").isEmpty)
        await client.disconnect()
    }

    @Test("A transaction's first read is sent in call order between the writes around it")
    func transactionReadKeepsCallOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeDatabase(client)

        for round in 0..<200 {
            db.reference(withPath: "order/\(3 * round)").setValue(round) { _, _ in }
            db.reference(withPath: "order/\(3 * round + 1)").runTransactionBlock({ _ in .abort() }) { _, _, _ in }
            db.reference(withPath: "order/\(3 * round + 2)").setValue(round) { _, _ in }
        }
        try await until { writeFrames(bridge).count == 600 }

        let expected = (0..<600).map { n in "\(n % 3 == 1 ? "rtdb.get" : "rtdb.set") /order/\(n)" }
        #expect(sentOrder(bridge) == expected)
        await client.disconnect()
    }

    @Test("goOffline() and goOnline() without await are sent in call order with the writes around them")
    func connectionTogglesKeepCallOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeDatabase(client)

        issueTogglesAroundWrites(db, count: 300)
        let ordered: @Sendable () -> [String] = {
            bridge.ofType("worker-op").map { frame in
                let method = frame["op"]?["method"]?.stringValue ?? "?"
                return method == "rtdb.set" ? "set \(frame["op"]?["path"]?.stringValue ?? "?")" : method
            }
        }
        try await until { ordered().count == 900 }

        let expected = (0..<300).flatMap { n in ["rtdb.goOffline", "set /order/\(n)", "rtdb.goOnline"] }
        #expect(ordered() == expected)
        await client.disconnect()
    }
}

@Suite("Bridge operation frame order")
struct BridgeOperationFrameOrderTests {

    @Test("An operation admitted after another is not written to the socket until the earlier frame's write is done")
    func framesLeaveInAdmissionOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        bridge.suspendWrites(ofMethod: "setDoc")

        let first = Task { try await client.op(method: "setDoc", params: ["path": "rooms/a"]) }
        try await until { bridge.suspendedWriteCount == 1 }
        let second = Task { try await client.op(method: "updateDoc", params: ["path": "rooms/b"]) }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(bridge.ops(named: "updateDoc").isEmpty)

        bridge.releaseWrites()
        try await until { bridge.ofType("worker-op").count == 2 }
        let methods = bridge.ofType("worker-op").map { $0["op"]?["method"]?.stringValue }
        #expect(methods == ["setDoc", "updateDoc"])
        for frame in bridge.ofType("worker-op") { bridge.answer(frame) }
        _ = try await first.value
        _ = try await second.value
        await client.disconnect()
    }
}
