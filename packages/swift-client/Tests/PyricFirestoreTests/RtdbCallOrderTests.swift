import Foundation
import Testing
@testable import PyricFirestore
import PyricDatabase

// D1 (ADR-0019): every Realtime Database call that sends takes its place in
// call order, including onDisconnect, which has only async forms. Each test
// makes a completion-block write, then the call under test, with the client's
// admission order held by a `CallOrderGate`; the write must reach the bridge first.

private func makeDatabase(_ client: PyricBridgeClient) -> Database {
    Database(
        app: FirebaseApp(name: "rtdb-call-order-\(UUID().uuidString)"),
        url: "https://default.firebaseio.com",
        bridgeClient: client
    )
}

/// A Realtime Database call made after the earlier write, and the frame it sends.
struct RtdbLaterCall: CustomTestStringConvertible, Sendable {
    let name: String
    let method: String
    let path: String?
    let issue: @Sendable (Database) -> Void

    var testDescription: String { name }
}

private let later = "order/later"

private func laterCall(
    _ name: String,
    _ method: String,
    path: String? = "/\(later)",
    _ call: @escaping @Sendable (Database, DatabaseReference) async throws -> Void
) -> RtdbLaterCall {
    RtdbLaterCall(name: name, method: method, path: path) { db in
        Task { try? await call(db, db.reference(withPath: later)) }
    }
}

let rtdbLaterCalls: [RtdbLaterCall] = [
    laterCall("await setValue(_:)", "rtdb.set") { _, ref in try await ref.setValue(2) },
    laterCall("await setPriority(_:)", "rtdb.setPriority") { _, ref in try await ref.setPriority(2) },
    laterCall("await setValue(_:andPriority:)", "rtdb.setWithPriority") { _, ref in
        try await ref.setValue(2, andPriority: 1)
    },
    laterCall("await updateChildValues(_:)", "rtdb.update") { _, ref in try await ref.updateChildValues(["n": 2]) },
    laterCall("await removeValue()", "rtdb.remove") { _, ref in try await ref.removeValue() },
    laterCall("await getData()", "rtdb.get") { _, ref in _ = try await ref.getData() },
    laterCall("await observeSingleEvent(of:)", "rtdb.get") { _, ref in _ = try await ref.observeSingleEvent(of: .value) },
    laterCall("await runTransactionBlock(_:)", "rtdb.get") { _, ref in
        _ = try await ref.runTransactionBlock { data in TransactionResult.success(withValue: data) }
    },
    laterCall("await onDisconnect().setValue(_:)", "rtdb.onDisconnectSet") { _, ref in
        try await ref.onDisconnect().setValue("offline")
    },
    laterCall("await onDisconnect().setValue(_:andPriority:)", "rtdb.onDisconnectSet") { _, ref in
        try await ref.onDisconnect().setValue("offline", andPriority: 1)
    },
    laterCall("await onDisconnect().updateChildValues(_:)", "rtdb.onDisconnectUpdate") { _, ref in
        try await ref.onDisconnect().updateChildValues(["n": 2])
    },
    laterCall("await onDisconnect().removeValue()", "rtdb.onDisconnectRemove") { _, ref in
        try await ref.onDisconnect().removeValue()
    },
    laterCall("await onDisconnect().cancel()", "rtdb.onDisconnectCancel") { _, ref in
        try await ref.onDisconnect().cancel()
    },
    laterCall("await goOffline()", "rtdb.goOffline", path: nil) { db, _ in try await db.goOffline() },
    laterCall("await goOnline()", "rtdb.goOnline", path: nil) { db, _ in try await db.goOnline() },
]

@Suite("Realtime Database call order")
struct RtdbCallOrderTests {

    @Test("A completion-block write reaches the bridge before a later call", arguments: rtdbLaterCalls)
    func writeThenLaterCall(_ call: RtdbLaterCall) async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeDatabase(client)

        let gate = CallOrderGate(client)
        db.reference(withPath: "order/earlier").setValue(1) { _, _ in }
        call.issue(db)
        try await gate.open(afterCalls: 2) { hasArrived(bridge, call.method, path: call.path) }

        try await until { hasArrived(bridge, "rtdb.set", path: "/order/earlier") && hasArrived(bridge, call.method, path: call.path) }
        let earlier = try #require(arrival(bridge, "rtdb.set", path: "/order/earlier"))
        let laterCall = try #require(arrival(bridge, call.method, path: call.path))
        #expect(earlier < laterCall, "\(call.name) reached the bridge before the write issued ahead of it")
        await client.disconnect()
    }
}
