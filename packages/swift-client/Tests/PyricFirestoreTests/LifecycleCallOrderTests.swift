import Foundation
import Testing
@testable import PyricFirestore

// D2 (ADR-0019): a close takes its place in call order like any operation.
// A write issued before `terminate` or `disableNetwork` is admitted first and
// then failed by the close (D6); a write issued after it fails as disposed,
// whichever task the scheduler runs first. The client's admission order is
// held by a `CallOrderGate` while the calls are made.

private let callbackQueue = DispatchQueue(label: "lifecycle-call-order.callbacks")

private let closeError = "PyricBridgeClient disconnected."
private let disposedError = "PyricBridgeClient has been disposed."

private func makeFirestore(_ client: PyricBridgeClient) -> Firestore {
    let db = Firestore(bridgeClient: client, app: FirebaseApp(name: "lifecycle-call-order-\(UUID().uuidString)"))
    db.settings.dispatchQueue = callbackQueue
    return db
}

private func message(_ error: Error?) -> String? {
    guard let error else { return nil }
    if let bridgeError = error as? PyricBridgeError { return bridgeError.message }
    return "\(error)"
}

/// A call that closes the client, and how a test makes it.
struct CloseCall: CustomTestStringConvertible, Sendable {
    let name: String
    let issue: @Sendable (Firestore, Collected<Bool>) -> Void

    var testDescription: String { name }
}

let closeCalls: [CloseCall] = [
    CloseCall(name: "terminate(completion:)") { db, closed in
        db.terminate { _ in closed.append(true) }
    },
    CloseCall(name: "await terminate()") { db, closed in
        Task {
            try? await db.terminate()
            closed.append(true)
        }
    },
    CloseCall(name: "disableNetwork(completion:)") { db, closed in
        db.disableNetwork { _ in closed.append(true) }
    },
    CloseCall(name: "await disableNetwork()") { db, closed in
        Task {
            try? await db.disableNetwork()
            closed.append(true)
        }
    },
]

@Suite("Close call order")
struct LifecycleCallOrderTests {

    @Test("A write issued before a close is admitted, then failed by the close", arguments: closeCalls)
    func writeThenClose(_ close: CloseCall) async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeFirestore(client)
        let written = Collected<String?>()
        let closed = Collected<Bool>()

        let gate = CallOrderGate(client)
        db.document("order/earlier").setData(["n": 1]) { error in written.append(message(error)) }
        close.issue(db, closed)
        try await gate.open(afterCalls: 2) { closed.count == 1 }

        try await until { written.count == 1 && closed.count == 1 }
        #expect(written.all == [closeError], "the write issued before \(close.name) was not admitted before the close")
    }

    // Only a completion-block close has a call after it in program order while
    // it runs: code after `await terminate()` runs once the close is done.
    @Test(
        "A write issued after a close fails as disposed and is never sent",
        arguments: closeCalls.filter { $0.name.hasSuffix("(completion:)") }
    )
    func closeThenWrite(_ close: CloseCall) async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeFirestore(client)
        let written = Collected<String?>()
        let closed = Collected<Bool>()

        let gate = CallOrderGate(client)
        close.issue(db, closed)
        let doc = db.document("order/later")
        Task {
            do {
                try await doc.setData(["n": 2], merge: false)
                written.append(nil)
            } catch {
                written.append(message(error))
            }
        }
        // A close that takes no turn shuts the client at once, and the write then settles.
        try await gate.open(afterCalls: 2) { written.count == 1 || hasArrived(bridge, "setDoc", path: "order/later") }

        try await until { written.count == 1 && closed.count == 1 }
        #expect(written.all == [disposedError], "the write issued after \(close.name) was admitted ahead of it")
        #expect(!hasArrived(bridge, "setDoc", path: "order/later"))
    }

    @Test("A completion-block write issued after disableNetwork(completion:) fails as disposed")
    func disableThenCompletionWrite() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeFirestore(client)
        let written = Collected<String?>()
        let closed = Collected<Bool>()

        let gate = CallOrderGate(client)
        db.disableNetwork { _ in closed.append(true) }
        db.document("order/later").setData(["n": 2]) { error in written.append(message(error)) }
        try await gate.open(afterCalls: 2) { hasArrived(bridge, "setDoc", path: "order/later") }

        try await until { written.count == 1 && closed.count == 1 }
        #expect(written.all == [disposedError])
        #expect(!hasArrived(bridge, "setDoc", path: "order/later"))
    }
}
