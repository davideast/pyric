import Foundation
import Testing
@testable import PyricFirestore

@Suite("Pyric Bridge Transport Adversarial Stress Tests", .serialized)
struct TransportStressTests {

    // ─── 1. URLRequest & DNS-Rebinding Protection (server.ts:126) ─────────────

    @Test("Verifies URLRequest default and custom Host headers against DNS rebinding protection")
    func testHostHeaderVariations() throws {
        // Default loopback endpoint
        let defaultURL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!
        let req1 = PyricBridgeClient.makeWebSocketRequest(url: defaultURL)
        #expect(req1.value(forHTTPHeaderField: "Host") == "127.0.0.1:5174")

        // Custom localhost port
        let localPortURL = URL(string: "ws://localhost:9099/__pyric/sandbox")!
        let req2 = PyricBridgeClient.makeWebSocketRequest(url: localPortURL)
        #expect(req2.value(forHTTPHeaderField: "Host") == "localhost:9099")

        // Custom loopback port
        let loopbackPortURL = URL(string: "ws://127.0.0.1:3000/__pyric/sandbox")!
        let req3 = PyricBridgeClient.makeWebSocketRequest(url: loopbackPortURL)
        #expect(req3.value(forHTTPHeaderField: "Host") == "127.0.0.1:3000")

        // URL without explicit port defaults to host without port
        let noPortURL = URL(string: "ws://127.0.0.1/__pyric/sandbox")!
        let req4 = PyricBridgeClient.makeWebSocketRequest(url: noPortURL)
        #expect(req4.value(forHTTPHeaderField: "Host") == "127.0.0.1")

        // Explicit header override in dictionary
        let customHeaders = ["Host": "allowed-domain.test:5174", "Authorization": "Bearer token123"]
        let req5 = PyricBridgeClient.makeWebSocketRequest(url: defaultURL, headers: customHeaders)
        #expect(req5.value(forHTTPHeaderField: "Host") == "allowed-domain.test:5174")
        #expect(req5.value(forHTTPHeaderField: "Authorization") == "Bearer token123")
    }

    // ─── 2. Handshake Logic & Correlation ────────────────────────────────────

    @Test("Attach frame format matches Pyric bridge specification")
    func testAttachFrameStructure() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        let attachFrame = try await mock.awaitNextSentMessage()

        #expect(attachFrame["type"]?.stringValue == "attach")
        #expect(attachFrame["protocol"]?.intValue == 1)

        try mock.simulateServerMessage(["type": "attach-ack", "protocol": 1, "peerConnected": true])
        try await connectTask.value
        await client.disconnect()
    }

    @Test("Handles peerConnected: false with user-friendly error and leaves client disconnected")
    func testPeerConnectedFalseDetailed() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()

        try mock.simulateServerMessage([
            "type": "attach-ack",
            "protocol": 1,
            "bridgeVersion": "0.1.0",
            "peerConnected": false
        ])

        do {
            try await connectTask.value
            Issue.record("Expected connection to fail when peerConnected is false")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
            #expect(err.message.contains("No browser tab is connected"))
        }

        let isConnected = await client.isConnected
        #expect(!isConnected)
        await client.disconnect()

        // Verify fresh client can connect when peerConnected is true
        let mock2 = MockWebSocketChannel()
        let client2 = PyricBridgeClient(channel: mock2)
        let retryTask = Task { try await client2.connect() }
        _ = try await mock2.awaitNextSentMessage()
        try mock2.simulateServerMessage([
            "type": "attach-ack",
            "protocol": 1,
            "peerConnected": true
        ])
        try await retryTask.value
        let retryConnected = await client2.isConnected
        #expect(retryConnected)

        await client2.disconnect()
    }

    @Test("Multiple concurrent connect() calls share a single attach frame and resolve together")
    func testConcurrentConnectThunderingHerd() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        // Launch 10 concurrent connect tasks
        let tasks = (0..<10).map { _ in
            Task { try await client.connect() }
        }

        // Exactly one attach frame should be emitted
        let attachFrame = try await mock.awaitNextSentMessage()
        #expect(attachFrame["type"]?.stringValue == "attach")

        // Complete handshake
        try mock.simulateServerMessage([
            "type": "attach-ack",
            "protocol": 1,
            "peerConnected": true
        ])

        // All 10 tasks must complete successfully without error
        for task in tasks {
            try await task.value
        }

        let isConnected = await client.isConnected
        #expect(isConnected)

        // Calling connect() when already connected returns immediately
        try await client.connect()

        await client.disconnect()
    }

    @Test("Interleaved server frames (e.g. keepalive ping) during handshake do not disrupt connect")
    func testInterleavedFramesDuringHandshake() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()

        // Server sends ping BEFORE attach-ack
        try mock.simulateServerMessage([
            "type": "ping",
            "id": "early-ping-1"
        ])

        // Client must respond with pong
        let pongFrame = try await mock.awaitNextSentMessage()
        #expect(pongFrame["type"]?.stringValue == "pong")
        #expect(pongFrame["id"]?.stringValue == "early-ping-1")

        // Now server sends attach-ack
        try mock.simulateServerMessage([
            "type": "attach-ack",
            "peerConnected": true
        ])

        try await connectTask.value
        let isConnected = await client.isConnected
        #expect(isConnected)

        await client.disconnect()
    }

    @Test("Transport failure during handshake aborts connect with unavailable error")
    func testTransportFailureDuringHandshake() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()

        // Transport closes abruptly
        await mock.close(closeCode: 1006, reason: "Abnormal closure")

        do {
            try await connectTask.value
            Issue.record("Expected connectTask to throw on channel close")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
        }

        let isConnected = await client.isConnected
        #expect(!isConnected)
    }

    @Test("Calling connect() or op() after disconnect() throws unavailable error")
    func testOperationsAfterDisposal() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        await client.disconnect()

        do {
            try await client.connect()
            Issue.record("Expected connect to throw after disconnect")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
        }

        do {
            _ = try await client.op(method: "getDoc", params: [:])
            Issue.record("Expected op to throw after disconnect")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
        }
    }

    // ─── 3. RPC Correlation, Timeouts & DenialContext ─────────────────────────

    @Test("Monotonic operation ID generation rop-1, rop-2, etc.")
    func testMonotonicOpIds() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        for expectedIndex in 1...5 {
            let task = Task<AnySendable, Error> {
                try await client.op(method: "testMethod", params: ["idx": .int(Int64(expectedIndex))])
            }
            let frame = try await mock.awaitNextSentMessage()
            let id = frame["id"]?.stringValue
            #expect(id == "rop-\(expectedIndex)")

            try mock.simulateServerMessage([
                "type": "worker-res",
                "id": "rop-\(expectedIndex)",
                "ok": true,
                "value": ["result": expectedIndex] as [String: Any]
            ])
            let res = try await task.value
            #expect(res["result"]?.intValue == Int64(expectedIndex))
        }

        await client.disconnect()
    }

    @Test("Concurrent out-of-order RPC responses are correlated correctly by unique ID")
    func testConcurrentOutOfOrderRpcResponses() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let opCount = 15
        var tasks: [Int: Task<AnySendable, Error>] = [:]

        // Launch 15 operations concurrently
        for i in 1...opCount {
            tasks[i] = Task {
                try await client.op(method: "queryDoc", params: ["num": .int(Int64(i))])
            }
        }

        // Collect all frames sent by client and correlate ID with task index
        var idToNum: [String: Int64] = [:]
        for _ in 1...opCount {
            let frame = try await mock.awaitNextSentMessage()
            let id = try #require(frame["id"]?.stringValue)
            let op = try #require(frame["op"]?.dictionaryValue)
            let num = try #require(op["num"]?.intValue)
            idToNum[id] = num
        }
        #expect(idToNum.count == opCount)

        // Respond to operations in arbitrary / reversed order
        for (id, num) in idToNum.reversed() {
            try mock.simulateServerMessage([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": ["token": "val-\(num)"] as [String: Any]
            ])
        }

        // Verify each task resolved with its exact corresponding response
        for i in 1...opCount {
            let res = try await tasks[i]!.value
            #expect(res["token"]?.stringValue == "val-\(i)")
        }

        await client.disconnect()
    }

    @Test("Uncorrelated and duplicate worker-res frames are safely ignored")
    func testUncorrelatedAndDuplicateResponses() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        // Send worker-res for non-existent ID
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": "rop-non-existent-999",
            "ok": true,
            "value": "spurious"
        ])

        // Now run a normal op
        let opTask = Task<AnySendable, Error> {
            try await client.op(method: "normalOp", params: [:])
        }
        let frame = try await mock.awaitNextSentMessage()
        let id = try #require(frame["id"]?.stringValue)

        // Respond once
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": id,
            "ok": true,
            "value": "first-response"
        ])

        // Duplicate response for same ID
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": id,
            "ok": true,
            "value": "duplicate-response"
        ])

        let result = try await opTask.value
        #expect(result.stringValue == "first-response")

        await client.disconnect()
    }

    @Test("RPC timeout triggers deadlineExceeded and late responses are discarded safely")
    func testRpcTimeoutAndLateResponseDiscarded() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock, defaultOpTimeout: 0.05) // 50ms

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let opTask = Task<AnySendable, Error> {
            try await client.op(method: "longRunningOp", params: [:])
        }

        let frame = try await mock.awaitNextSentMessage()
        let id = try #require(frame["id"]?.stringValue)

        // Wait for timeout
        do {
            _ = try await opTask.value
            Issue.record("Expected timeout error")
        } catch let err as PyricBridgeError {
            #expect(err.code == "deadline-exceeded")
            #expect(err.message.contains("timed out after 50ms"))
        }

        // Bridge sends late response after timeout
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": id,
            "ok": true,
            "value": "late-data"
        ])

        // Subsequent operation should work without issue
        let nextOpTask = Task<AnySendable, Error> {
            try await client.op(method: "nextOp", params: [:])
        }
        let nextFrame = try await mock.awaitNextSentMessage()
        let nextId = try #require(nextFrame["id"]?.stringValue)
        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": nextId,
            "ok": true,
            "value": "next-success"
        ])
        let nextRes = try await nextOpTask.value
        #expect(nextRes.stringValue == "next-success")

        await client.disconnect()
    }

    @Test("Complex nested denialContext and envelope are faithfully parsed into PyricBridgeError")
    func testDenialContextAndEnvelopePreservation() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let opTask = Task<AnySendable, Error> {
            try await client.op(method: "updateDoc", params: ["path": "users/secret"])
        }
        let frame = try await mock.awaitNextSentMessage()
        let id = try #require(frame["id"]?.stringValue)

        // Complex denialContext structure with rule line, request vars, auth claims, and envelope
        let errorPayload: [String: Any] = [
            "code": "permission-denied",
            "message": "False evaluation in rule condition at firestore.rules:45",
            "denialContext": [
                "line": 45,
                "column": 12,
                "expression": "request.auth.token.role == 'admin'",
                "variables": [
                    "request.auth.uid": "user-789",
                    "request.auth.token.role": "member"
                ] as [String: Any],
                "matchedPath": "users/secret"
            ] as [String: Any],
            "envelope": [
                "traceId": "sec-eval-99901",
                "auditLogged": true
            ] as [String: Any]
        ]

        try mock.simulateServerMessage([
            "type": "worker-res",
            "id": id,
            "ok": false,
            "error": errorPayload
        ])

        do {
            _ = try await opTask.value
            Issue.record("Expected opTask to throw permission-denied")
        } catch let err as PyricBridgeError {
            #expect(err.code == "permission-denied")
            #expect(err.message.contains("firestore.rules:45"))

            // Verify denialContext fields
            let denial = try #require(err.denialContext)
            #expect(denial["line"]?.intValue == 45)
            #expect(denial["expression"]?.stringValue == "request.auth.token.role == 'admin'")
            let vars = try #require(denial["variables"])
            #expect(vars["request.auth.uid"]?.stringValue == "user-789")
            #expect(vars["request.auth.token.role"]?.stringValue == "member")

            // Verify envelope fields
            let env = try #require(err.envelope)
            #expect(env["traceId"]?.stringValue == "sec-eval-99901")
            #expect(env["auditLogged"]?.boolValue == true)
        }

        await client.disconnect()
    }

    // ─── 4. Streaming Subscriptions & Unsubscription ───────────────────────────

    @Test("Subscription lifecycle: worker-sub registration, multi-event delivery, and worker-unsub on break")
    func testStreamingLifecycleBreak() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let target: [String: Any] = ["__ref": "query", "path": "messages"]
        let stream = client.subscribe(
            target: target,
            includeMetadataChanges: true,
            listenSource: "cache"
        )

        let readerTask = Task<[String], Error> {
            var msgs: [String] = []
            for try await snap in stream {
                if let text = snap["text"]?.stringValue {
                    msgs.append(text)
                }
                if msgs.count == 3 {
                    break // Breaks loop, triggering iterator cleanup
                }
            }
            return msgs
        }

        // 1. Verify worker-sub frame structure
        let subFrame = try await mock.awaitNextSentMessage()
        #expect(subFrame["type"]?.stringValue == "worker-sub")
        let subId = try #require(subFrame["subId"]?.stringValue)
        let subPayload = try #require(subFrame["sub"]?.dictionaryValue)
        #expect(subPayload["includeMetadataChanges"]?.boolValue == true)
        #expect(subPayload["listenSource"]?.stringValue == "cache")

        // 2. Deliver 3 snapshots
        for i in 1...3 {
            try mock.simulateServerMessage([
                "type": "worker-snap",
                "subId": subId,
                "value": ["text": "msg-\(i)"] as [String: Any]
            ])
        }

        let collected = try await readerTask.value
        #expect(collected == ["msg-1", "msg-2", "msg-3"])

        // 3. Verify worker-unsub frame was dispatched
        let unsubFrame = try await mock.awaitNextSentMessage()
        #expect(unsubFrame["type"]?.stringValue == "worker-unsub")
        #expect(unsubFrame["subId"]?.stringValue == subId)

        await client.disconnect()
    }

    @Test("Subscription unregisters when task is cancelled asynchronously")
    func testStreamingLifecycleTaskCancellation() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let stream = client.subscribe(target: ["__ref": "doc", "path": "live/stock"])
        let consumeTask = Task<Void, Error> {
            for try await _ in stream {
                // Infinite consumption until cancelled
            }
        }

        let subFrame = try await mock.awaitNextSentMessage()
        let subId = try #require(subFrame["subId"]?.stringValue)

        // Cancel the consumer task
        consumeTask.cancel()

        // Verify worker-unsub is emitted upon cancellation
        let unsubFrame = try await mock.awaitNextSentMessage()
        #expect(unsubFrame["type"]?.stringValue == "worker-unsub")
        #expect(unsubFrame["subId"]?.stringValue == subId)

        await client.disconnect()
    }

    @Test("Multiple concurrent subscriptions route snapshots without cross-talk")
    func testMultipleSubscriptionsIsolation() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let stream1 = client.subscribe(target: ["path": "channel-1"])
        let stream2 = client.subscribe(target: ["path": "channel-2"])

        let task1 = Task<[Int64], Error> {
            var items: [Int64] = []
            for try await snap in stream1 {
                items.append(snap["seq"]!.intValue!)
                if items.count == 2 { break }
            }
            return items
        }

        let task2 = Task<[Int64], Error> {
            var items: [Int64] = []
            for try await snap in stream2 {
                items.append(snap["seq"]!.intValue!)
                if items.count == 2 { break }
            }
            return items
        }

        let sub1 = try await mock.awaitNextSentMessage()
        let sub2 = try await mock.awaitNextSentMessage()
        let id1: String
        let id2: String
        if sub1["sub"]?["target"]?["path"]?.stringValue == "channel-1" {
            id1 = try #require(sub1["subId"]?.stringValue)
            id2 = try #require(sub2["subId"]?.stringValue)
        } else {
            id1 = try #require(sub2["subId"]?.stringValue)
            id2 = try #require(sub1["subId"]?.stringValue)
        }

        // Interleave snapshot events
        try mock.simulateServerMessage(["type": "worker-snap", "subId": id1, "value": ["seq": 101] as [String: Any]])
        try mock.simulateServerMessage(["type": "worker-snap", "subId": id2, "value": ["seq": 201] as [String: Any]])
        try mock.simulateServerMessage(["type": "worker-snap", "subId": id1, "value": ["seq": 102] as [String: Any]])
        try mock.simulateServerMessage(["type": "worker-snap", "subId": id2, "value": ["seq": 202] as [String: Any]])

        let res1 = try await task1.value
        let res2 = try await task2.value
        #expect(res1 == [101, 102] as [Int64])
        #expect(res2 == [201, 202] as [Int64])

        await client.disconnect()
    }

    // ─── 5. Keepalive Ping / Pong ──────────────────────────────────────────────

    @Test("Handles rapid bursts of keepalive pings with immediate matching pongs")
    func testKeepalivePingPongBurst() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let pingIds = ["ping-101", "ping-102", "ping-103", "ping-104", "ping-105"]

        // Send 5 rapid pings
        for id in pingIds {
            try mock.simulateServerMessage([
                "type": "ping",
                "id": id
            ])
        }

        // Verify 5 matching pongs arrive
        var receivedPongIds: [String] = []
        for _ in 0..<5 {
            let pongFrame = try await mock.awaitNextSentMessage()
            #expect(pongFrame["type"]?.stringValue == "pong")
            receivedPongIds.append(pongFrame["id"]!.stringValue!)
        }

        #expect(receivedPongIds.sorted() == pingIds.sorted())

        // Also verify incoming pong frame from server is safely ignored
        try mock.simulateServerMessage([
            "type": "pong",
            "id": "ignored-pong-id"
        ])

        await client.disconnect()
    }
}
