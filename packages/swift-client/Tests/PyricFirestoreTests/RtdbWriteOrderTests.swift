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
}
