import Foundation
@testable import PyricFirestore

/// In-memory mock WebSocket transport simulating the Pyric bridge for fast, hermetic conformance testing.
public final class ConformanceMockHarness: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incomingQueue: [String] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []

    public private(set) var sentMessages: [[String: AnySendable]] = []
    public private(set) var isClosed: Bool = false
    public var autoRespond: Bool = true

    public var customDocData: [String: [String: Any]] = [:]

    public private(set) var client: PyricBridgeClient!
    public private(set) var firestore: Firestore!

    public init() {}

    // MARK: - WebSocketTransport Protocol

    public func send(_ string: String) async throws {
        let (response, continuationToResume) = try handleSendSync(string)
        if let continuationToResume, let response {
            continuationToResume.resume(returning: response)
        }
    }

    private func handleSendSync(_ string: String) throws -> (String?, CheckedContinuation<String, Error>?) {
        lock.lock()
        defer { lock.unlock() }

        guard !isClosed else {
            throw PyricBridgeError.unavailable("Cannot send message: WebSocket is closed.")
        }

        guard let data = string.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let dict = json.dictionaryValue else {
            return (nil, nil)
        }

        sentMessages.append(dict)

        guard autoRespond else {
            return (nil, nil)
        }

        let type = dict["type"]?.stringValue
        var responseString: String? = nil

        if type == "attach" {
            responseString = encodeDict([
                "type": "attach-ack",
                "protocol": 1,
                "bridgeVersion": "0.1.0",
                "peerConnected": true
            ])
        } else if type == "worker-op" {
            let id = dict["id"]?.stringValue ?? ""
            let op = dict["op"]?.dictionaryValue ?? [:]
            let method = op["method"]?.stringValue ?? ""
            responseString = handleWorkerOp(id: id, method: method, op: op)
        } else if type == "worker-sub" {
            let subId = dict["subId"]?.stringValue ?? ""
            let sub = dict["sub"]?.dictionaryValue ?? [:]
            let target = sub["target"]?.dictionaryValue ?? [:]
            responseString = handleWorkerSub(subId: subId, target: target)
        } else if type == "ping" {
            let id = dict["id"]?.stringValue ?? ""
            responseString = encodeDict(["type": "pong", "id": id])
        }

        if let responseString {
            if !receiveContinuations.isEmpty {
                let cont = receiveContinuations.removeFirst()
                return (responseString, cont)
            } else {
                incomingQueue.append(responseString)
            }
        }

        return (nil, nil)
    }

    public func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            handleReceiveSync(continuation)
        }
    }

    private func handleReceiveSync(_ continuation: CheckedContinuation<String, Error>) {
        lock.lock()
        defer { lock.unlock() }

        if isClosed {
            continuation.resume(throwing: PyricBridgeError.unavailable("WebSocket stream closed."))
            return
        }
        if !incomingQueue.isEmpty {
            let msg = incomingQueue.removeFirst()
            continuation.resume(returning: msg)
        } else {
            receiveContinuations.append(continuation)
        }
    }

    public func close(closeCode: Int = 1000, reason: String? = nil) async {
        let continuations = handleCloseSync()
        for continuation in continuations {
            continuation.resume(throwing: PyricBridgeError.unavailable("WebSocket closed: \(reason ?? "normal")"))
        }
    }

    private func handleCloseSync() -> [CheckedContinuation<String, Error>] {
        lock.lock()
        defer { lock.unlock() }

        isClosed = true
        let continuations = receiveContinuations
        receiveContinuations.removeAll()
        incomingQueue.removeAll()
        return continuations
    }

    // MARK: - Protocol Simulators

    private func handleWorkerOp(id: String, method: String, op: [String: AnySendable]) -> String {
        switch method {
        case "getDoc":
            let path = op["path"]?.stringValue ?? "users/alice"
            let docId = path.split(separator: "/").last.map(String.init) ?? "alice"
            let docPayload = customDocData[path] ?? ["name": "Alice", "age": 30]
            let envelope = encodeDict(docPayload)

            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": [
                    "id": docId,
                    "path": path,
                    "exists": true,
                    "data": ["json": envelope]
                ] as [String: Any]
            ])

        case "getDocs":
            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": [
                    "docs": [
                        [
                            "id": "1",
                            "path": "users/1",
                            "exists": true,
                            "data": ["json": "{\"name\":\"A\"}"]
                        ],
                        [
                            "id": "2",
                            "path": "users/2",
                            "exists": true,
                            "data": ["json": "{\"name\":\"B\"}"]
                        ]
                    ]
                ] as [String: Any]
            ])

        case "count":
            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": ["count": 42]
            ])

        case "aggregate":
            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": [
                    "data": [
                        "sum_score": 150.0,
                        "avg_score": 75.0
                    ]
                ] as [String: Any]
            ])

        case "addDoc":
            let coll = op["collectionPath"]?.stringValue ?? "coll"
            let autoId = "auto-doc-id-12345"
            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": [
                    "id": autoId,
                    "path": "\(coll)/\(autoId)"
                ]
            ])

        default:
            // setDoc, updateDoc, deleteDoc, batchCommit, txnCommit
            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": NSNull()
            ])
        }
    }

    private func handleWorkerSub(subId: String, target: [String: AnySendable]) -> String {
        let refType = target["__ref"]?.stringValue
        if refType == "doc" {
            let path = target["path"]?.stringValue ?? "users/alice"
            let docId = path.split(separator: "/").last.map(String.init) ?? "alice"
            return encodeDict([
                "type": "worker-snap",
                "subId": subId,
                "value": [
                    "id": docId,
                    "path": path,
                    "exists": true,
                    "data": ["json": "{\"status\":\"online\"}"]
                ] as [String: Any]
            ])
        } else {
            let path = target["path"]?.stringValue ?? "users"
            return encodeDict([
                "type": "worker-snap",
                "subId": subId,
                "value": [
                    "docs": [
                        [
                            "id": "doc1",
                            "path": "\(path)/doc1",
                            "exists": true,
                            "data": ["json": "{\"item\":1}"]
                        ] as [String: Any]
                    ]
                ] as [String: Any]
            ])
        }
    }

    private func enqueueIncomingLocked(_ message: String) {
        if !receiveContinuations.isEmpty {
            let continuation = receiveContinuations.removeFirst()
            continuation.resume(returning: message)
        } else {
            incomingQueue.append(message)
        }
    }

    private func encodeDict(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return str
    }

    // MARK: - Inspection Helpers

    public func lastWorkerOp() -> [String: AnySendable]? {
        lock.lock()
        defer { lock.unlock() }
        guard let lastOpFrame = sentMessages.last(where: { $0["type"]?.stringValue == "worker-op" }),
              let op = lastOpFrame["op"]?.dictionaryValue else {
            return nil
        }
        return op
    }

    public func lastSentMessage() -> [String: AnySendable]? {
        lock.lock()
        defer { lock.unlock() }
        return sentMessages.last
    }

    // MARK: - Factory Lifecycle

    public static func create() async throws -> ConformanceMockHarness {
        let harness = ConformanceMockHarness()
        let client = PyricBridgeClient(channel: harness)
        try await client.connect()
        let firestore = Firestore(bridgeClient: client)
        Firestore.shared = firestore
        harness.client = client
        harness.firestore = firestore
        return harness
    }
}
