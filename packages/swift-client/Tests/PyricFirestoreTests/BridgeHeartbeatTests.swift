import Foundation
import Testing
@testable import PyricFirestore

@Suite("Bridge heartbeat")
struct BridgeHeartbeatTests {

    /// A reconnecting client whose heartbeat runs every `interval` and treats
    /// `timeout` of silence as a drop.
    private func makeHeartbeatClient(
        _ bridge: FakeReconnectBridge,
        interval: TimeInterval = 0.05,
        timeout: TimeInterval = 0.25
    ) async -> PyricBridgeClient {
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        await client.setHeartbeatForTesting(interval: interval, livenessTimeout: timeout)
        return client
    }

    @Test("Sends a heartbeat ping at attach")
    func testHeartbeatPingAtAttach() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        try await until { await mock.sentPingCount == 1 }
        await client.disconnect()
    }

    @Test("A client on one supplied channel closes when the host is silent, failing its operations")
    func testSingleChannelClosesOnSilence() async throws {
        let mock = MockWebSocketChannel()
        let client = PyricBridgeClient(channel: mock)
        await client.setHeartbeatForTesting(interval: 0.05, livenessTimeout: 0.25)

        let connectTask = Task { try await client.connect() }
        _ = try await mock.awaitNextSentMessage()
        try mock.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let opTask = Task<AnySendable, Error> {
            try await client.op(method: "getDoc", params: ["path": "rooms/a"])
        }
        let opFrame = try await mock.awaitNextSentMessage()
        #expect(opFrame["type"]?.stringValue == "worker-op")

        do {
            _ = try await opTask.value
            Issue.record("Expected the in-flight op to fail when the host went silent")
        } catch let err as PyricBridgeError {
            #expect(err.code == "unavailable")
            #expect(err.message.contains("sent nothing for 45 seconds"))
        }
        #expect(await client.connectionState == .closed)
        #expect(await client.isConnected == false)
        try await until { await mock.isClosed }
        #expect(await mock.sentPingCount >= 1)

        await client.disconnect()
    }

    @Test("A ping is sent at attach, before the first interval passes")
    func pingAtAttach() async throws {
        let bridge = FakeReconnectBridge()
        let client = await makeHeartbeatClient(bridge, interval: 30, timeout: 90)
        try await client.connect()
        try await until { bridge.ofType("ping").count == 1 }
        let ping = bridge.ofType("ping")[0]
        #expect(ping["id"]?.stringValue?.isEmpty == false)
        #expect(ping.keys.sorted() == ["id", "type"])
        await client.disconnect()
    }

    @Test("Pings follow at each interval, each with its own id, and answered pings keep the client attached past the timeout")
    func pingsEveryIntervalAndPongsKeepAttached() async throws {
        let bridge = FakeReconnectBridge()
        bridge.answersPings = true
        let client = await makeHeartbeatClient(bridge, interval: 0.05, timeout: 0.5)
        try await client.connect()
        try await until { bridge.ofType("ping").count >= 4 }
        try await Task.sleep(nanoseconds: 1_000_000_000)

        #expect(await client.connectionState == .attached)
        #expect(bridge.connectCalls == 1)
        let ids = bridge.ofType("ping").compactMap { $0["id"]?.stringValue }
        #expect(ids.count >= 6)
        #expect(Set(ids).count == ids.count)
        await client.disconnect()
    }

    @Test("Any frame from the host counts as traffic, not only pong")
    func anyFrameKeepsAttached() async throws {
        let bridge = FakeReconnectBridge()
        let client = await makeHeartbeatClient(bridge, interval: 0.05, timeout: 0.5)
        try await client.connect()
        for _ in 0..<20 {
            bridge.current.deliver(["type": "worker-event", "event": "noop"])
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(await client.connectionState == .attached)
        #expect(bridge.connectCalls == 1)
        await client.disconnect()
    }

    @Test("A silent host is a drop: the in-flight operation fails once, the old socket closes, and the client reconnects")
    func silentHostIsADrop() async throws {
        let bridge = FakeReconnectBridge()
        let client = await makeHeartbeatClient(bridge, interval: 0.05, timeout: 1.0)
        let states = Collected<BridgeConnectionState>()
        let watcher = Task { for await state in client.connectionStates { states.append(state) } }
        // The first socket answers pings until the operation is on it, then goes
        // silent. A drop declared before the frame was written would hold the
        // operation and send it on the new socket, where it waits out the 35 s
        // op timeout instead of failing as lost (#1473).
        bridge.answersPings = true
        try await client.connect()
        let silent = bridge.current

        let inFlight = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await until { bridge.ops(named: "setDoc").count == 1 }
        #expect(bridge.socketCount == 1)
        silent.answersPings = false
        do {
            _ = try await inFlight.value
            Issue.record("expected the in-flight operation to fail")
        } catch let error as PyricBridgeError {
            #expect(error.code == .unavailable)
            #expect(error.message.contains("connection was lost"))
        }

        try await until { states.all.contains(.interrupted) }
        try await until { !silent.isOpen }
        try await until { bridge.connectCalls == 2 && bridge.socketCount == 2 }
        try await until { await client.connectionState == .attached }
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.ops(named: "setDoc").count == 1)
        watcher.cancel()
        await client.disconnect()
    }

    @Test("Silence is detected at the liveness timeout, not at the next interval after it")
    func silenceDetectedAtTheTimeout() async throws {
        let bridge = FakeReconnectBridge()
        // Ticks at 0 and 1.0 s. A fixed wait would next check at 2.0 s; the
        // wait is cut to the 1.5 s timeout instead.
        let client = await makeHeartbeatClient(bridge, interval: 1.0, timeout: 1.5)
        let clock = ContinuousClock()
        let interruptedAt = Collected<ContinuousClock.Instant>()
        let watcher = Task {
            for await state in client.connectionStates where state == .interrupted {
                interruptedAt.append(clock.now)
            }
        }
        let start = clock.now
        try await client.connect()
        bridge.refuseConnections = true
        try await until { interruptedAt.count == 1 }

        let elapsed = start.duration(to: interruptedAt.all[0])
        #expect(elapsed >= .milliseconds(1400))
        #expect(elapsed < .milliseconds(1850))
        watcher.cancel()
        await client.disconnect()
    }

    @Test("An operation issued after a silence drop is held and sent once after the re-attach")
    func operationAfterSilenceIsHeld() async throws {
        let bridge = FakeReconnectBridge()
        let client = await makeHeartbeatClient(bridge, interval: 0.05, timeout: 0.25)
        try await client.connect()
        bridge.refuseConnections = true
        try await until { await client.connectionState == .interrupted }

        let write = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(bridge.ops(named: "setDoc").isEmpty)

        bridge.answersPings = true
        bridge.refuseConnections = false
        try await until { bridge.ops(named: "setDoc").count == 1 }
        bridge.answer(bridge.ops(named: "setDoc")[0])
        let value = try await write.value
        #expect(value.stringValue == "done")
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(bridge.ops(named: "setDoc").count == 1)
        await client.disconnect()
    }

    @Test("No ping reaches a socket after it drops, and none is sent after disconnect()")
    func noPingOnAnOldSocket() async throws {
        let bridge = FakeReconnectBridge()
        bridge.answersPings = true
        let client = await makeHeartbeatClient(bridge, interval: 0.05, timeout: 5)
        try await client.connect()
        let first = bridge.current
        try await until { first.pingsAttempted >= 2 }

        bridge.refuseConnections = true
        first.drop()
        try await until { await client.connectionState == .interrupted }
        let pingsAtDrop = first.pingsAttempted
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(first.pingsAttempted == pingsAtDrop)

        bridge.refuseConnections = false
        try await until { await client.connectionState == .attached }
        let second = bridge.current
        #expect(second !== first)
        try await until { second.pingsAttempted >= 2 }
        #expect(first.pingsAttempted == pingsAtDrop)

        await client.disconnect()
        let pingsAtDisconnect = second.pingsAttempted
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(second.pingsAttempted == pingsAtDisconnect)
        #expect(first.pingsAttempted == pingsAtDrop)
    }
}
