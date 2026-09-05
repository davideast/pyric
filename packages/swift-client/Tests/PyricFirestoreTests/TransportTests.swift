import Foundation
import Testing
@testable import PyricFirestore

// ── Mock Transport Harness ───────────────────────────────────────────────────

public actor MockWebSocketChannel: WebSocketTransport {
    private nonisolated let incomingContinuation: AsyncThrowingStream<String, Error>.Continuation
    public nonisolated let incomingStream: AsyncThrowingStream<String, Error>

    private nonisolated let sentContinuation: AsyncStream<[String: AnySendable]>.Continuation
    public nonisolated let sentStream: AsyncStream<[String: AnySendable]>

    public private(set) var isClosed = false

    public init() {
        let (inStream, inCont) = AsyncThrowingStream<String, Error>.makeStream()
        self.incomingStream = inStream
        self.incomingContinuation = inCont

        let (sStream, sCont) = AsyncStream<[String: AnySendable]>.makeStream()
        self.sentStream = sStream
        self.sentContinuation = sCont
    }

    public func send(_ text: String) async throws {
        guard !isClosed else {
            throw PyricBridgeError.unavailable("Cannot send message: WebSocket is closed.")
        }
        if let data = text.data(using: .utf8),
           let obj = try? JSONDecoder().decode(AnySendable.self, from: data),
           let dict = obj.dictionaryValue {
            sentContinuation.yield(dict)
        }
    }

    public nonisolated func receive() async throws -> String {
        for try await msg in incomingStream {
            return msg
        }
        throw PyricBridgeError.unavailable("WebSocket stream finished.")
    }

    public func close(closeCode: Int = 1000, reason: String? = nil) async {
        isClosed = true
        incomingContinuation.finish()
        sentContinuation.finish()
    }

    public nonisolated func simulateServerMessage(_ dict: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: dict)
        let str = String(decoding: data, as: UTF8.self)
        incomingContinuation.yield(str)
    }

    public nonisolated func awaitNextSentMessage(timeoutSeconds: Double = 2.0) async throws -> [String: AnySendable] {
        let stream = self.sentStream
        return try await withThrowingTaskGroup(of: [String: AnySendable].self) { group in
            group.addTask {
                var iterator = stream.makeAsyncIterator()
                if let next = await iterator.next() {
                    return next
                }
                throw PyricBridgeError.unavailable("Stream terminated")
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                throw PyricBridgeError.deadlineExceeded("Timed out waiting for client frame")
            }
            let res = try await group.next()!
            group.cancelAll()
            return res
        }
    }
}

// ── Transport Test Suite ─────────────────────────────────────────────────────

@Suite("Pyric Bridge Transport Suite")
struct TransportTests {

    // ── 1. URLRequest & Host Header Guard ──────────────────────────────────────

    @Test("Constructs URLRequest with mandatory Host header for DNS-rebinding protection")
    func testURLRequestFormation() throws {
        let defaultURL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!
        let request = PyricBridgeClient.makeWebSocketRequest(url: defaultURL)

        #expect(request.url == defaultURL)
        #expect(request.value(forHTTPHeaderField: "Host") == "127.0.0.1:5174",
                "Host header must match 127.0.0.1:5174 to satisfy Pyric server's isAllowedUpgrade guard")

        // Custom host/port
        let customURL = URL(string: "ws://localhost:8080/__pyric/sandbox")!
        let customRequest = PyricBridgeClient.makeWebSocketRequest(url: customURL)
        #expect(customRequest.value(forHTTPHeaderField: "Host") == "localhost:8080")
    }

    // ── 2. Connection Handshake ────────────────────────────────────────────────

    @Test("Sends attach frame and completes connect() when peerConnected is true")
    func testConnectHandshakeSuccess() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task {
            try await client.connect()
        }

        // 1. Verify client sent attach frame
        let attachFrame = try await mock.awaitNextSentMessage()
        #expect(attachFrame["type"]?.stringValue == "attach")
        #expect(attachFrame["protocol"]?.intValue == 1)

        // 2. Simulate bridge response with peerConnected: true
        try mock.simulateServerMessage([
            "type": "attach-ack",
            "protocol": 1,
            "bridgeVersion": "0.1.0",
            "peerConnected": true
        ])

        try await connectTask.value
        let isConnected = await client.isConnected
        #expect(isConnected)
        let isDisposed = await client.isDisposed
        #expect(!isDisposed)

        await client.disconnect()
    }

    @Test("Throws unavailable error when peerConnected is false (no browser tab open)")
    func testConnectHandshakeNoPeer() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task {
            try await client.connect()
        }

        _ = try await mock.awaitNextSentMessage()

        // Simulate bridge response with peerConnected: false
        try mock.simulateServerMessage([
            "type": "attach-ack",
            "protocol": 1,
            "bridgeVersion": "0.1.0",
            "peerConnected": false
        ])

        do {
            try await connectTask.value
            Issue.record("Expected connect to throw when peerConnected is false")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
        }

        let isConnected = await client.isConnected
        #expect(!isConnected)
    }

    // ── 3. One-Shot RPC Operations (worker-op / worker-res) ────────────────────

    @Test("Dispatches worker-op and resolves correlated worker-res by unique ID")
    func testWorkerOpSuccess() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        // Connect first
        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "protocol": 1, "peerConnected": true])
        try await connectTask.value

        // Launch op
        let opTask = Task<AnySendable, Error> {
            try await client.op(
                method: "getDoc",
                params: ["path": "users/alovelace"],
                actAs: ["mode": "admin"]
            )
        }

        let opFrame = try await mock.awaitNextSentMessage()
        #expect(opFrame["type"]?.stringValue == "worker-op")
        let reqId = try #require(opFrame["id"]?.stringValue)
        let opPayload = try #require(opFrame["op"]?.dictionaryValue)
        #expect(opPayload["method"]?.stringValue == "getDoc")
        #expect(opPayload["path"]?.stringValue == "users/alovelace")

        // Simulate successful worker-res
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": reqId,
            "ok": true,
            "value": [
                "id": "alovelace",
                "exists": true,
                "data": ["json": "{\"name\": \"Ada\"}"]
            ] as [String: Any]
        ])

        let result = try await opTask.value
        #expect(result["id"]?.stringValue == "alovelace")
        #expect(result["exists"]?.boolValue == true)

        await client.disconnect()
    }

    @Test("Propagates structured PyricBridgeError with denialContext on ok: false")
    func testWorkerOpErrorPropagation() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let opTask = Task<AnySendable, Error> {
            try await client.op(method: "deleteDoc", params: ["path": "secret/doc"])
        }
        let opFrame = try await mock.awaitNextSentMessage()
        let reqId = try #require(opFrame["id"]?.stringValue)

        // Simulate rejection with denialContext
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": reqId,
            "ok": false,
            "error": [
                "code": "permission-denied",
                "message": "Missing or insufficient permissions.",
                "denialContext": [
                    "rule": ["line": 42]
                ]
            ] as [String: Any]
        ])

        do {
            _ = try await opTask.value
            Issue.record("Expected opTask to throw PyricBridgeError")
        } catch let err as PyricBridgeError {
            #expect(err.code == "permission-denied")
            #expect(err.message.contains("Missing or insufficient permissions"))
            #expect(err.denialContext?["rule"] != nil)
        }

        await client.disconnect()
    }

    @Test("Times out and throws deadlineExceeded when response is delayed")
    func testWorkerOpTimeout() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock, defaultOpTimeout: 0.05) // 50ms

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let opTask = Task<AnySendable, Error> {
            try await client.op(method: "hangingOp", params: [:])
        }

        _ = try await mock.awaitNextSentMessage()
        // Do not respond; wait for timeout

        do {
            _ = try await opTask.value
            Issue.record("Expected timeout error")
        } catch let err as PyricBridgeError {
            #expect(err.code == "deadline-exceeded")
        }

        await client.disconnect()
    }

    // ── 4. Streaming Subscriptions (worker-sub / snap / unsub) ─────────────────

    @Test("Streams snapshots and sends worker-unsub when task is cancelled")
    func testSubscriptionStreamingAndUnsubscribe() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let target: [String: Any] = ["__ref": "doc", "path": "chats/room1"]
        let stream = client.subscribe(target: target)

        let collectTask = Task<[AnySendable], Error> {
            var received: [AnySendable] = []
            for try await snap in stream {
                received.append(snap)
                if received.count == 2 { break }
            }
            return received
        }

        // Verify worker-sub sent
        let subFrame = try await mock.awaitNextSentMessage()
        #expect(subFrame["type"]?.stringValue == "worker-sub")
        let subId = try #require(subFrame["subId"]?.stringValue)

        // Deliver 2 snapshots
        try mock.simulateServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": ["id": "room1", "count": 1] as [String: Any]
        ])
        try mock.simulateServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": ["id": "room1", "count": 2] as [String: Any]
        ])

        let results = try await collectTask.value
        #expect(results.count == 2)
        #expect(results[0]["count"]?.intValue == 1)
        #expect(results[1]["count"]?.intValue == 2)

        // Cancelling subscription sends worker-unsub
        let unsubFrame = try await mock.awaitNextSentMessage()
        #expect(unsubFrame["type"]?.stringValue == "worker-unsub")
        #expect(unsubFrame["subId"]?.stringValue == subId)

        await client.disconnect()
    }

    @Test("Terminates subscription stream on __error snap and auto-unsubscribes")
    func testSubscriptionTerminalError() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let stream = client.subscribe(target: ["__ref": "doc", "path": "forbidden/doc"])

        let streamTask = Task {
            for try await _ in stream {
                // Should not yield any valid snapshot
            }
        }

        let subFrame = try await mock.awaitNextSentMessage()
        let subId = try #require(subFrame["subId"]?.stringValue)

        // Deliver terminal error snapshot
        try mock.simulateServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "__error": [
                    "code": "permission-denied",
                    "message": "Access denied by security rules."
                ]
            ] as [String: Any]
        ])

        do {
            try await streamTask.value
            Issue.record("Expected stream to fail with permission-denied")
        } catch let err as PyricBridgeError {
            #expect(err.code == "permission-denied")
        }

        // Verify worker-unsub was sent
        let unsubFrame = try await mock.awaitNextSentMessage()
        #expect(unsubFrame["type"]?.stringValue == "worker-unsub")
        #expect(unsubFrame["subId"]?.stringValue == subId)

        await client.disconnect()
    }

    // ── 5. Keepalive Ping / Pong ───────────────────────────────────────────────

    @Test("Responds immediately to keepalive ping with matching pong ID")
    func testPingPongKeepalive() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        // Server sends ping
        try mock.simulateServerMessage([
            "type": "ping",
            "id": "ping-test-456"
        ])

        let pongFrame = try await mock.awaitNextSentMessage()
        #expect(pongFrame["type"]?.stringValue == "pong")
        #expect(pongFrame["id"]?.stringValue == "ping-test-456")

        await client.disconnect()
    }

    // ── 6. Disconnect & Lifecycle Cleanup ──────────────────────────────────────

    @Test("Disconnect terminates pending operations and active subscriptions with unavailable error")
    func testDisconnectTeardown() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        // Start pending op
        let pendingOpTask = Task<AnySendable, Error> {
            try await client.op(method: "slowOp", params: [:])
        }
        _ = try await mock.awaitNextSentMessage()

        // Start active subscription
        let subStream = client.subscribe(target: ["__ref": "collection", "path": "items"])
        let subTask = Task<Void, Error> {
            for try await _ in subStream {}
        }
        _ = try await mock.awaitNextSentMessage()

        // Disconnect
        await client.disconnect()

        let isConnected = await client.isConnected
        #expect(!isConnected)
        let isDisposed = await client.isDisposed
        #expect(isDisposed)

        // Verify pending op threw .unavailable
        do {
            _ = try await pendingOpTask.value
            Issue.record("Expected pending op to throw on disconnect")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
        }

        // Verify active sub threw .unavailable
        do {
            try await subTask.value
            Issue.record("Expected active sub to throw on disconnect")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
        }

        // Subsequent calls reject immediately
        do {
            _ = try await client.op(method: "anotherOp", params: [:])
            Issue.record("Expected anotherOp to throw on disconnected client")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
        }
    }

    // ── 7. Bridge Operations Conveniences ──────────────────────────────────────

    @Test("Verifies BridgeOperations RPC convenience helpers")
    func testBridgeOperationsConveniences() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        // getDoc
        let getDocTask = Task<AnySendable, Error> {
            try await client.getDoc(path: "cities/SF")
        }
        let getDocFrame = try await mock.awaitNextSentMessage()
        let getDocOp = try #require(getDocFrame["op"]?.dictionaryValue)
        #expect(getDocOp["method"]?.stringValue == "getDoc")
        #expect(getDocOp["path"]?.stringValue == "cities/SF")
        let getDocId = try #require(getDocFrame["id"]?.stringValue)
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": getDocId,
            "ok": true,
            "value": ["name": "San Francisco"] as [String: Any]
        ])
        let getDocRes = try await getDocTask.value
        #expect(getDocRes["name"]?.stringValue == "San Francisco")

        // setDoc
        let setDocTask = Task<Void, Error> {
            try await client.setDoc(path: "cities/SF", data: ["population": 880000])
        }
        let setDocFrame = try await mock.awaitNextSentMessage()
        let setDocOp = try #require(setDocFrame["op"]?.dictionaryValue)
        #expect(setDocOp["method"]?.stringValue == "setDoc")
        let setDocId = try #require(setDocFrame["id"]?.stringValue)
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": setDocId,
            "ok": true
        ])
        try await setDocTask.value

        // count
        let countTask = Task<Int, Error> {
            try await client.count(source: .collection(path: "cities"))
        }
        let countFrame = try await mock.awaitNextSentMessage()
        let countOp = try #require(countFrame["op"]?.dictionaryValue)
        #expect(countOp["method"]?.stringValue == "count")
        let countId = try #require(countFrame["id"]?.stringValue)
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": countId,
            "ok": true,
            "value": ["count": 42] as [String: Any]
        ])
        let countVal = try await countTask.value
        #expect(countVal == 42)

        await client.disconnect()
    }

    @Test("Instance-scoped onDenial isolates callbacks between distinct bridge clients")
    func testInstanceOnDenialIsolation() async throws {
        let mock1 = MockWebSocketChannel()
        let client1 = PyricBridgeClient(channel: mock1)
        let connectTask1 = Task { try await client1.connect() }
        _ = try await mock1.awaitNextSentMessage()
        try mock1.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask1.value

        let mock2 = MockWebSocketChannel()
        let client2 = PyricBridgeClient(channel: mock2)
        let connectTask2 = Task { try await client2.connect() }
        _ = try await mock2.awaitNextSentMessage()
        try mock2.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask2.value

        final class Box: @unchecked Sendable {
            var c1: [PyricBridgeError] = []
            var c2: [PyricBridgeError] = []
        }
        let box = Box()

        client1.onDenial = { err in box.c1.append(err) }
        client2.onDenial = { err in box.c2.append(err) }

        let opTask1 = Task<AnySendable, Error> {
            try await client1.op(method: "getDoc", params: ["path": "forbidden/doc"])
        }
        let frame1 = try await mock1.awaitNextSentMessage()
        let id1 = try #require(frame1["id"]?.stringValue)
        try mock1.simulateServerMessage([
            "type": "worker-res",
            "id": id1,
            "ok": false,
            "error": [
                "code": "permission-denied",
                "message": "Rules check failed",
                "denialContext": ["rule": ["line": 77]]
            ] as [String: Any]
        ])

        _ = try? await opTask1.value
        try await Task.sleep(nanoseconds: 20_000_000)

        #expect(box.c1.count == 1)
        #expect(box.c1.first?.denialContext?["rule"]?["line"]?.intValue == 77)
        #expect(box.c2.isEmpty)

        await client1.disconnect()
        await client2.disconnect()
    }
}
