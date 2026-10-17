import Foundation
import Testing
@testable import PyricFirestore

// Firestore writes issued back to back from one caller through the
// completion-block forms reach the bridge in the order the app called them
// (#1032). The fake bridge lives in BridgeReconnectTests.swift.

private let roundCount = 1000

private func makeFirestore(_ client: PyricBridgeClient) -> Firestore {
    Firestore(bridgeClient: client, app: FirebaseApp(name: "fs-order-\(UUID().uuidString)"))
}

/// The document a write frame targets: its own path, or a batch's first write path.
private func targetPath(_ op: AnySendable) -> String? {
    op["path"]?.stringValue ?? op["writes"]?.arrayValue?.first?["path"]?.stringValue
}

private func writeFrames(_ bridge: FakeReconnectBridge) -> [[String: AnySendable]] {
    bridge.ofType("worker-op").filter { frame in
        guard let op = frame["op"] else { return false }
        return targetPath(op)?.hasPrefix("order/") == true
    }
}

/// The `method step` of every write frame, in the order the bridge received them.
private func sentSteps(_ bridge: FakeReconnectBridge) -> [String] {
    writeFrames(bridge).map { frame in
        let op = frame["op"]
        let method = op?["method"]?.stringValue ?? "?"
        let step = op?["data"]?["step"]?.stringValue ?? "-"
        return "\(method) \(step)"
    }
}

/// Issues `setData` then `updateData` on one document, `count` times, without waiting.
private func issueSetThenUpdate(_ db: Firestore, count: Int, completions: Collected<String?>) {
    let done: @Sendable (Error?) -> Void = { error in completions.append(error.map { "\($0)" }) }
    let doc = db.document("order/doc")
    for n in 0..<count {
        doc.setData(["step": "set-\(n)"], completion: done)
        doc.updateData(["step": "update-\(n)"], completion: done)
    }
}

private func expectedSetThenUpdate(count: Int) -> [String] {
    (0..<count).flatMap { n in ["setDoc set-\(n)", "updateDoc update-\(n)"] }
}

/// The write forms `issueEveryForm` cycles through, and the frame each one sends.
/// `enableNetwork` sends nothing, so it has no frame.
private let everyForm = [
    "setDoc", "setDoc merge", "setDoc mergeFields", "updateDoc", "deleteDoc", "batchCommit", "setDoc add", "enableNetwork",
]

/// Issues `count` calls without waiting, cycling through `everyForm`, each to its own path `order/<n>`.
/// Write completions go to `completions` and `enableNetwork` completions to `network`.
private func issueEveryForm(
    _ db: Firestore,
    count: Int,
    completions: Collected<String?>,
    network: Collected<String?>
) {
    let done: @Sendable (Error?) -> Void = { error in completions.append(error.map { "\($0)" }) }
    let enabled: @Sendable (Error?) -> Void = { error in network.append(error.map { "\($0)" }) }
    for n in 0..<count {
        let doc = db.document("order/\(n)")
        switch everyForm[n % everyForm.count] {
        case "setDoc": doc.setData(["step": "\(n)"], completion: done)
        case "setDoc merge": doc.setData(["step": "\(n)"], merge: true, completion: done)
        case "setDoc mergeFields": doc.setData(["step": "\(n)"], mergeFields: ["step"], completion: done)
        case "updateDoc": doc.updateData(["step": "\(n)"], completion: done)
        case "deleteDoc": doc.delete(completion: done)
        case "batchCommit":
            let batch = db.batch()
            batch.setData(["step": "\(n)"], forDocument: doc)
            batch.commit(completion: done)
        case "setDoc add": db.collection("order/\(n)/adds").addDocument(data: ["step": "\(n)"], completion: done)
        default: db.enableNetwork(completion: enabled)
        }
    }
}

private func expectedEveryForm(count: Int) -> [String] {
    (0..<count).compactMap { n in
        let form = everyForm[n % everyForm.count]
        switch form {
        case "enableNetwork": return nil
        case "deleteDoc", "batchCommit": return "\(form) -"
        default: return "\(form.split(separator: " ")[0]) \(n)"
        }
    }
}

/// Whether every write frame's path, `order/<n>` or `order/<n>/adds/<id>`, follows the one before it.
private func pathsInCallOrder(_ bridge: FakeReconnectBridge) -> Bool {
    let indexes = writeFrames(bridge).map { frame in
        frame["op"].flatMap(targetPath).flatMap { Int($0.split(separator: "/")[1]) } ?? -1
    }
    return indexes == indexes.sorted() && !indexes.contains(-1)
}

/// Answers every write frame, then waits for every completion block to run without an error.
private func answerAll(_ bridge: FakeReconnectBridge, completions: Collected<String?>, count: Int) async throws {
    for frame in writeFrames(bridge) { bridge.answer(frame) }
    try await until { completions.count == count }
    #expect(completions.all.allSatisfy { $0 == nil })
}

@Suite("Firestore write order from completion-block forms")
struct FirestoreWriteOrderTests {

    @Test("setData then updateData on one document, back to back, are sent in call order while connected")
    func connectedSetThenUpdateKeepCallOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeFirestore(client)
        let completions = Collected<String?>()

        issueSetThenUpdate(db, count: roundCount, completions: completions)
        try await until { writeFrames(bridge).count == 2 * roundCount }

        #expect(sentSteps(bridge) == expectedSetThenUpdate(count: roundCount))
        try await answerAll(bridge, completions: completions, count: 2 * roundCount)
        await client.disconnect()
    }

    @Test("setData then updateData on one document, issued during a disconnect, are sent in call order after the re-attach")
    func heldSetThenUpdateKeepCallOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        try await client.connect()
        let db = makeFirestore(client)
        let completions = Collected<String?>()
        try await interrupt(bridge, client)

        issueSetThenUpdate(db, count: roundCount, completions: completions)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(writeFrames(bridge).isEmpty)

        bridge.refuseConnections = false
        try await until { writeFrames(bridge).count == 2 * roundCount }

        #expect(sentSteps(bridge) == expectedSetThenUpdate(count: roundCount))
        #expect(bridge.socketCount == 2)
        try await answerAll(bridge, completions: completions, count: 2 * roundCount)
        await client.disconnect()
    }

    @Test("Every completion-block write form, cycled back to back, is sent in call order while connected")
    func connectedEveryFormKeepsCallOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeFirestore(client)
        let completions = Collected<String?>()
        let network = Collected<String?>()
        let expected = expectedEveryForm(count: roundCount)

        issueEveryForm(db, count: roundCount, completions: completions, network: network)
        try await until { writeFrames(bridge).count == expected.count }

        #expect(sentSteps(bridge) == expected)
        #expect(pathsInCallOrder(bridge))
        try await answerAll(bridge, completions: completions, count: expected.count)
        try await until { network.count == roundCount - expected.count }
        #expect(network.all.allSatisfy { $0 == nil })
        await client.disconnect()
    }

    @Test("Every completion-block write form, issued during a disconnect, is sent in call order after the re-attach")
    func heldEveryFormKeepsCallOrder() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        try await client.connect()
        let db = makeFirestore(client)
        let completions = Collected<String?>()
        let network = Collected<String?>()
        let expected = expectedEveryForm(count: roundCount)
        try await interrupt(bridge, client)

        issueEveryForm(db, count: roundCount, completions: completions, network: network)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(writeFrames(bridge).isEmpty)

        bridge.refuseConnections = false
        try await until { writeFrames(bridge).count == expected.count }

        #expect(sentSteps(bridge) == expected)
        #expect(pathsInCallOrder(bridge))
        // An enableNetwork issued while held joins a connection attempt that may fail, so only its writes are checked.
        try await answerAll(bridge, completions: completions, count: expected.count)
        await client.disconnect()
    }

    @Test("A write that fails before it is sent does not stall the writes after it")
    func failedWritesDoNotStallTheNext() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeFirestore(client)
        let doc = db.document("order/doc")
        let errors = Collected<String?>()
        let done: @Sendable (Error?) -> Void = { error in errors.append(error.map { "\($0)" }) }

        doc.setData(["step": NSObject()], completion: done)
        doc.setData(["step": NSObject()], merge: true, completion: done)
        doc.setData(["step": "x"], mergeFields: ["missing"], completion: done)
        doc.updateData([1: "x"], completion: done)
        let batch = db.batch()
        batch.setData(["step": "batch"], forDocument: doc)
        batch.commit(completion: done)
        batch.commit(completion: done)
        doc.setData(["step": "after"], completion: done)

        try await until { writeFrames(bridge).count == 2 && errors.count == 5 }
        #expect(sentSteps(bridge) == ["batchCommit -", "setDoc after"])
        #expect(errors.all.allSatisfy { $0 != nil })

        for frame in writeFrames(bridge) { bridge.answer(frame) }
        try await until { errors.count == 7 }
        #expect(errors.all.suffix(2).allSatisfy { $0 == nil })
        await client.disconnect()
    }

    @Test("disableNetwork(completion:) disconnects after the writes issued before it are sent, and they fail as disconnected")
    func disableNetworkComesAfterEarlierWrites() async throws {
        for _ in 0..<50 {
            let bridge = FakeReconnectBridge()
            let client = makeReconnectingClient(bridge)
            try await client.connect()
            let db = makeFirestore(client)
            let errors = Collected<String?>()
            let disabled = Collected<String?>()

            db.document("order/doc").setData(["step": "before"]) { error in errors.append(error.map { "\($0)" }) }
            db.disableNetwork { error in disabled.append(error.map { "\($0)" }) }
            try await until { errors.count == 1 && disabled.count == 1 }

            #expect(disabled.all == [nil])
            let message = errors.all[0] ?? ""
            #expect(message.contains("disconnected"), "the write was not admitted before the disconnect: \(message)")
        }
    }
}
