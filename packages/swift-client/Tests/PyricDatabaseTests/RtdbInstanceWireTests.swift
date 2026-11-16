import Foundation
import Testing
@testable import PyricDatabase
@testable import PyricFirestore

private final class RecordingRtdbTransport: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incomingQueue: [String] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []
    private var _recordedOps: [(method: String, instance: String?)] = []
    private var _recordedSubs: [(path: String, instance: String?)] = []

    var recordedOps: [(method: String, instance: String?)] {
        lock.lock()
        defer { lock.unlock() }
        return _recordedOps
    }

    var recordedSubs: [(path: String, instance: String?)] {
        lock.lock()
        defer { lock.unlock() }
        return _recordedSubs
    }

    func send(_ string: String) async throws {
        for (msg, cont) in handleSendSync(string) {
            cont.resume(returning: msg)
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if !incomingQueue.isEmpty {
                let msg = incomingQueue.removeFirst()
                lock.unlock()
                cont.resume(returning: msg)
            } else {
                receiveContinuations.append(cont)
                lock.unlock()
            }
        }
    }

    func close(closeCode: Int = 1000, reason: String? = nil) async {
        for cont in takePendingReceivers() {
            cont.resume(throwing: PyricBridgeError.unavailable("closed"))
        }
    }

    private func takePendingReceivers() -> [CheckedContinuation<String, Error>] {
        lock.lock()
        defer { lock.unlock() }
        let pending = receiveContinuations
        receiveContinuations.removeAll()
        return pending
    }

    private func enqueue(_ dict: [String: Any]) -> (String, CheckedContinuation<String, Error>)? {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else {
            return nil
        }
        if !receiveContinuations.isEmpty {
            return (str, receiveContinuations.removeFirst())
        }
        incomingQueue.append(str)
        return nil
    }

    private func handleSendSync(_ raw: String) -> [(String, CheckedContinuation<String, Error>)] {
        lock.lock()
        defer { lock.unlock() }
        var toResume: [(String, CheckedContinuation<String, Error>)] = []
        guard let data = raw.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let dict = json.dictionaryValue,
              let type = dict["type"]?.stringValue else {
            return []
        }

        if type == "attach" {
            if let r = enqueue(["type": "attach-ack", "protocol": 1, "peerConnected": true]) {
                toResume.append(r)
            }
        } else if type == "worker-op" {
            let id = dict["id"]?.stringValue ?? ""
            let op = dict["op"]?.dictionaryValue ?? [:]
            let method = op["method"]?.stringValue ?? ""
            let instance = op["instance"]?.stringValue
            _recordedOps.append((method: method, instance: instance))

            let resValue: Any
            if method == "rtdb.get" {
                resValue = ["key": "item", "value": 1, "priority": NSNull(), "entries": []]
            } else if method == "rtdb.transactionCommit" {
                resValue = [
                    "committed": true,
                    "retry": false,
                    "snapshot": ["key": "item", "value": 2, "priority": NSNull(), "entries": []]
                ]
            } else {
                resValue = NSNull()
            }
            if let r = enqueue(["type": "worker-res", "id": id, "ok": true, "value": resValue]) {
                toResume.append(r)
            }
        } else if type == "worker-sub" {
            let subId = dict["subId"]?.stringValue ?? ""
            let sub = dict["sub"]?.dictionaryValue ?? [:]
            let target = sub["target"]?.dictionaryValue ?? [:]
            let path = target["path"]?.stringValue ?? "/"
            let instance = target["instance"]?.stringValue
            _recordedSubs.append((path: path, instance: instance))

            let snap: [String: Any] = ["key": "item", "value": 1, "priority": NSNull(), "entries": []]
            if let r = enqueue(["type": "worker-snap", "subId": subId, "value": snap]) {
                toResume.append(r)
            }
        }

        return toResume
    }
}

@Suite("RTDB Wire Instance Parity Suite")
struct RtdbInstanceWireTests {

    @Test("DatabaseInstanceResolver extracts non-default instances and omits defaults")
    func testInstanceResolution() {
        #expect(
            DatabaseInstanceResolver.resolveInstanceName(from: "https://my-app-secondary.firebaseio.com")
                == "my-app-secondary"
        )
        #expect(
            DatabaseInstanceResolver.resolveInstanceName(
                from: "https://my-app-eu.europe-west1.firebasedatabase.app"
            ) == "my-app-eu"
        )
        #expect(
            DatabaseInstanceResolver.resolveInstanceName(from: "http://127.0.0.1:9000/?ns=secondary-ns")
                == "secondary-ns"
        )
        #expect(DatabaseInstanceResolver.resolveInstanceName(from: "my-secondary") == "my-secondary")

        #expect(DatabaseInstanceResolver.resolveInstanceName(from: "https://default.firebaseio.com") == nil)
        #expect(DatabaseInstanceResolver.resolveInstanceName(from: "default") == nil)
        #expect(DatabaseInstanceResolver.resolveInstanceName(from: "") == nil)
        #expect(DatabaseInstanceResolver.resolveInstanceName(from: nil) == nil)
        #expect(DatabaseInstanceResolver.resolveInstanceName(from: "http://localhost:9000") == nil)
        #expect(DatabaseInstanceResolver.resolveInstanceName(from: "http://127.0.0.1:9000") == nil)
        #expect(DatabaseInstanceResolver.resolveInstanceName(from: "http://127.0.0.1:9000/?ns=default") == nil)
    }

    @Test("Non-default Database serializes wire instance on all rtdb ops and subscriptions")
    func testNonDefaultInstanceWireParity() async throws {
        let transport = RecordingRtdbTransport()
        let client = PyricBridgeClient(channel: transport)
        let app = FirebaseApp(name: "rtdb-inst-\(UUID().uuidString)")
        let db = Database(
            app: app,
            url: "https://my-app-secondary.firebaseio.com",
            bridgeClient: client
        )

        let ref = db.reference(withPath: "items/item")
        _ = try await ref.getData()
        try await ref.setValue("v1")
        try await ref.setPriority(1)
        try await ref.setValue("v2", andPriority: 2)
        try await ref.updateChildValues(["a": 1])
        try await ref.removeValue()
        _ = try await ref.runTransactionBlock { mutable in
            mutable.value = 2
            return TransactionResult.success(withValue: mutable)
        }
        try await ref.onDisconnectSetValue("offline")
        try await ref.onDisconnectUpdateChildValues(["b": 2])
        try await ref.onDisconnectRemoveValue()
        try await ref.cancelDisconnectOperations()

        for try await _ in ref.valueStream {
            break
        }

        try await db.goOffline()
        try await db.goOnline()

        let expectedMethods: Set<String> = [
            "rtdb.get",
            "rtdb.set",
            "rtdb.setPriority",
            "rtdb.setWithPriority",
            "rtdb.update",
            "rtdb.remove",
            "rtdb.transactionCommit",
            "rtdb.onDisconnectSet",
            "rtdb.onDisconnectUpdate",
            "rtdb.onDisconnectRemove",
            "rtdb.onDisconnectCancel",
            "rtdb.goOffline",
            "rtdb.goOnline"
        ]

        let ops = transport.recordedOps
        let observedMethods = Set(ops.map(\.method))
        #expect(expectedMethods.isSubset(of: observedMethods))
        for entry in ops {
            #expect(entry.instance == "my-app-secondary", "Expected instance on \(entry.method)")
        }

        let subs = transport.recordedSubs
        #expect(!subs.isEmpty)
        for sub in subs {
            #expect(sub.instance == "my-app-secondary")
        }

        await client.disconnect()
    }

    @Test("Default Database omits wire instance on rtdb ops and subscriptions")
    func testDefaultInstanceOmitsWireField() async throws {
        let transport = RecordingRtdbTransport()
        let client = PyricBridgeClient(channel: transport)
        let app = FirebaseApp(name: "rtdb-default-\(UUID().uuidString)")
        let db = Database(
            app: app,
            url: "https://default.firebaseio.com",
            bridgeClient: client
        )

        let ref = db.reference(withPath: "items/item")
        try await ref.setValue("v1")
        _ = try await ref.getData()
        for try await _ in ref.valueStream {
            break
        }

        for entry in transport.recordedOps {
            #expect(entry.instance == nil, "Expected nil instance on \(entry.method)")
        }
        #expect(!transport.recordedSubs.isEmpty)
        for sub in transport.recordedSubs {
            #expect(sub.instance == nil)
        }

        await client.disconnect()
    }
}
