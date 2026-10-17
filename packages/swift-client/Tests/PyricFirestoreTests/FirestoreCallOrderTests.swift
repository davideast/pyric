import Foundation
import Testing
@testable import PyricFirestore

// D1 (ADR-0019): every Firestore call that sends takes its place in call order,
// not only the completion-block writes. Each test makes a completion-block
// write, then the call under test, with the client's admission order held by
// a `CallOrderGate`; the write must reach the bridge first.

private let callbackQueue = DispatchQueue(label: "fs-call-order.callbacks")

private func makeFirestore(_ client: PyricBridgeClient) -> Firestore {
    let db = Firestore(bridgeClient: client, app: FirebaseApp(name: "fs-call-order-\(UUID().uuidString)"))
    db.settings.dispatchQueue = callbackQueue
    return db
}

/// A Firestore call made after the earlier write, and the frame it sends.
struct FirestoreLaterCall: CustomTestStringConvertible, Sendable {
    let name: String
    let method: String
    let path: String?
    let issue: @Sendable (Firestore) -> Void

    var testDescription: String { name }
}

private let later = "order/later"

private func readInTransaction(_ db: Firestore) -> @Sendable (Transaction, NSErrorPointer) -> Any? {
    { txn, error in
        _ = txn.getDocument(db.document(later), error: error)
        return nil
    }
}

let firestoreLaterCalls: [FirestoreLaterCall] = [
    FirestoreLaterCall(name: "await getDocument()", method: "getDoc", path: later) { db in
        Task { _ = try? await db.document(later).getDocument() }
    },
    FirestoreLaterCall(name: "getDocument(completion:)", method: "getDoc", path: later) { db in
        db.document(later).getDocument { _, _ in }
    },
    FirestoreLaterCall(name: "await setData(_:merge:)", method: "setDoc", path: later) { db in
        Task { try? await db.document(later).setData(["n": 2], merge: true) }
    },
    FirestoreLaterCall(name: "await setData(_:mergeFields:)", method: "setDoc", path: later) { db in
        Task { try? await db.document(later).setData(["n": 2], mergeFields: ["n"]) }
    },
    FirestoreLaterCall(name: "await updateData()", method: "updateDoc", path: later) { db in
        Task { try? await db.document(later).updateData(["n": 2]) }
    },
    FirestoreLaterCall(name: "await delete()", method: "deleteDoc", path: later) { db in
        Task { try? await db.document(later).delete() }
    },
    FirestoreLaterCall(name: "await addDocument(data:)", method: "setDoc", path: "adds/") { db in
        Task { _ = try? await db.collection("adds").addDocument(data: ["n": 2]) }
    },
    FirestoreLaterCall(name: "await WriteBatch.commit()", method: "batchCommit", path: later) { db in
        let batch = db.batch()
        batch.setData(["n": 2], forDocument: db.document(later))
        Task { try? await batch.commit() }
    },
    FirestoreLaterCall(name: "await getDocuments()", method: "getDocs", path: nil) { db in
        Task { _ = try? await db.collection("order").getDocuments() }
    },
    FirestoreLaterCall(name: "getDocuments(completion:)", method: "getDocs", path: nil) { db in
        db.collection("order").getDocuments { _, _ in }
    },
    FirestoreLaterCall(name: "await count.getAggregation()", method: "count", path: nil) { db in
        Task { _ = try? await db.collection("order").count.getAggregation(source: .server) }
    },
    FirestoreLaterCall(name: "aggregate.getAggregation(completion:)", method: "aggregate", path: nil) { db in
        db.collection("order").aggregate([AggregateField.sum("n")]).getAggregation(source: .server) { _, _ in }
    },
    FirestoreLaterCall(name: "await runTransaction(_:)", method: "getDoc", path: later) { db in
        Task {
            _ = try? await db.runTransaction(options: TransactionOptions(maxAttempts: 1)) { txn in
                _ = try await txn.getDocument(db.document(later))
                return nil
            }
        }
    },
    FirestoreLaterCall(name: "runTransaction(_:completion:)", method: "getDoc", path: later) { db in
        db.runTransaction(
            options: TransactionOptions(maxAttempts: 1),
            block: readInTransaction(db),
            completion: { _, _ in }
        )
    },
]

@Suite("Firestore call order")
struct FirestoreCallOrderTests {

    @Test("A completion-block write reaches the bridge before a later call", arguments: firestoreLaterCalls)
    func writeThenLaterCall(_ call: FirestoreLaterCall) async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let db = makeFirestore(client)

        let gate = CallOrderGate(client)
        db.document("order/earlier").setData(["n": 1], completion: nil)
        call.issue(db)
        try await gate.open(afterCalls: 2) { hasArrived(bridge, call.method, path: call.path) }

        try await until { hasArrived(bridge, "setDoc", path: "order/earlier") && hasArrived(bridge, call.method, path: call.path) }
        let earlier = try #require(arrival(bridge, "setDoc", path: "order/earlier"))
        let laterCall = try #require(arrival(bridge, call.method, path: call.path))
        #expect(earlier < laterCall, "\(call.name) reached the bridge before the write issued ahead of it")
        await client.disconnect()
    }
}
