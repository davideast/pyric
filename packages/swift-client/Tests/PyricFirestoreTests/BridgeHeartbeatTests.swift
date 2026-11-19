import Foundation
import Testing
@testable import PyricFirestore

@Suite("Bridge heartbeat")
struct BridgeHeartbeatTests {

    /// A reconnecting client whose heartbeat runs every `interval` on `clock`
    /// and treats `timeout` of silence as a drop.
    private func makeHeartbeatClient(
        _ bridge: FakeReconnectBridge,
        clock: TestBridgeClock? = nil,
        interval: TimeInterval = 0.05,
        timeout: TimeInterval = 0.25
    ) async -> PyricBridgeClient {
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        if let clock {
            await client.setClockForTesting(clock)
        }
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
        let clock = TestBridgeClock()
        let client = PyricBridgeClient(channel: mock)
        await client.setClockForTesting(clock)
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
        try await until {
            let pings = await mock.sentPingCount
            return pings == 1 && clock.nextWakeMilliseconds == 50
        }

        for step in 1...4 {
            clock.advance(by: 0.05)
            try await until {
                let pings = await mock.sentPingCount
                return pings == step + 1 && clock.nextWakeMilliseconds == 50
            }
        }
        clock.advance(by: 0.05)

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
        let clock = TestBridgeClock()
        let client = await makeHeartbeatClient(bridge, clock: clock, interval: 30, timeout: 90)
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
        let clock = TestBridgeClock()
        let client = await makeHeartbeatClient(bridge, clock: clock, interval: 0.05, timeout: 0.5)
        try await client.connect()
        try await until {
            let received = await client.receivedFrameCount
            return bridge.ofType("ping").count == 1 && received == 2 && clock.nextWakeMilliseconds == 50
        }

        // Advance 20 intervals (1.0 s total, twice the 0.5 s liveness timeout).
        for step in 1...20 {
            clock.advance(by: 0.05)
            try await until {
                let received = await client.receivedFrameCount
                return bridge.ofType("ping").count == step + 1 && received == step + 2 && clock.nextWakeMilliseconds == 50
            }
        }

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
        let clock = TestBridgeClock()
        let client = await makeHeartbeatClient(bridge, clock: clock, interval: 0.05, timeout: 0.5)
        try await client.connect()
        try await until {
            let received = await client.receivedFrameCount
            return bridge.ofType("ping").count == 1 && received == 1 && clock.nextWakeMilliseconds == 50
        }

        // Deliver 20 non-pong frames across 1.0 s (twice the 0.5 s liveness timeout).
        for step in 1...20 {
            bridge.current.deliver(["type": "worker-event", "event": "noop"])
            try await until {
                let received = await client.receivedFrameCount
                return received == step + 1 && clock.nextWakeMilliseconds == 50
            }
            clock.advance(by: 0.05)
            try await until {
                bridge.ofType("ping").count == step + 1 && clock.nextWakeMilliseconds == 50
            }
        }

        #expect(await client.connectionState == .attached)
        #expect(bridge.connectCalls == 1)
        await client.disconnect()
    }

    @Test("A silent host is a drop: the in-flight operation fails once, the old socket closes, and the client reconnects")
    func silentHostIsADrop() async throws {
        let bridge = FakeReconnectBridge()
        let clock = TestBridgeClock()
        let client = await makeHeartbeatClient(bridge, clock: clock, interval: 0.05, timeout: 1.0)
        let states = Collected<BridgeConnectionState>()
        let watcher = Task { for await state in client.connectionStates { states.append(state) } }
        // The first socket answers pings until the operation is on it, then goes
        // silent. A drop declared before the frame was written would hold the
        // operation and send it on the new socket, where it waits out the 35 s
        // op timeout instead of failing as lost (#1473).
        bridge.answersPings = true
        try await client.connect()
        let silent = bridge.current
        try await until {
            let received = await client.receivedFrameCount
            return silent.pingsAttempted == 1 && received == 2 && clock.nextWakeMilliseconds == 50
        }

        let inFlight = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await until { bridge.ops(named: "setDoc").count == 1 }
        try #require(bridge.socketCount == 1)
        silent.answersPings = false
        let baselinePings = silent.pingsAttempted

        for step in 1...19 {
            clock.advance(by: 0.05)
            try await until {
                silent.pingsAttempted == baselinePings + step && clock.nextWakeMilliseconds == 50
            }
        }
        clock.advance(by: 0.05)

        do {
            _ = try await inFlight.value
            Issue.record("expected the in-flight operation to fail")
        } catch let error as PyricBridgeError {
            #expect(error.code == .unavailable)
            #expect(error.message.contains("connection was lost"))
        }

        try await until { states.all.contains(.interrupted) }
        try await until { !silent.isOpen }
        try await until { clock.nextWakeMilliseconds == 20 }
        clock.advance(by: 0.02)
        try await until { bridge.connectCalls == 2 && bridge.socketCount == 2 }
        try await until { await client.connectionState == .attached }
        #expect(bridge.ops(named: "setDoc").count == 1)
        watcher.cancel()
        await client.disconnect()
    }

    @Test("Silence is detected at the liveness timeout, not at the next interval after it")
    func silenceDetectedAtTheTimeout() async throws {
        let bridge = FakeReconnectBridge()
        let clock = TestBridgeClock()
        // Ticks at 0 and 1.0 s. A fixed wait would next check at 2.0 s; the
        // wait is cut to the 1.5 s timeout instead.
        let client = await makeHeartbeatClient(bridge, clock: clock, interval: 1.0, timeout: 1.5)
        try await client.connect()
        bridge.refuseConnections = true
        try await until { bridge.ofType("ping").count == 1 && clock.nextWakeMilliseconds == 1000 }

        clock.advance(by: 1.0)
        try await until { bridge.ofType("ping").count == 2 && clock.nextWakeMilliseconds == 500 }
        #expect(await client.connectionState == .attached)

        clock.advance(by: 0.49)
        #expect(await client.connectionState == .attached)

        clock.advance(by: 0.01)
        try await until { await client.connectionState == .interrupted }
        await client.disconnect()
    }

    @Test("An operation issued after a silence drop is held and sent once after the re-attach")
    func operationAfterSilenceIsHeld() async throws {
        let bridge = FakeReconnectBridge()
        let clock = TestBridgeClock()
        let client = await makeHeartbeatClient(bridge, clock: clock, interval: 0.05, timeout: 0.25)
        try await client.connect()
        bridge.refuseConnections = true
        try await until { bridge.ofType("ping").count == 1 && clock.nextWakeMilliseconds == 50 }

        for step in 1...4 {
            clock.advance(by: 0.05)
            try await until { bridge.ofType("ping").count == step + 1 && clock.nextWakeMilliseconds == 50 }
        }
        clock.advance(by: 0.05)
        try await until { await client.connectionState == .interrupted }

        let write = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await until { await client.heldOperationCount == 1 }
        #expect(bridge.ops(named: "setDoc").isEmpty)

        bridge.answersPings = true
        bridge.refuseConnections = false
        try await until { clock.nextWakeMilliseconds == 20 }
        clock.advance(by: 0.02)
        try await until { bridge.ops(named: "setDoc").count == 1 }
        bridge.answer(bridge.ops(named: "setDoc")[0])
        let value = try await write.value
        #expect(value.stringValue == "done")
        #expect(bridge.ops(named: "setDoc").count == 1)
        await client.disconnect()
    }

    @Test("No ping reaches a socket after it drops, and none is sent after disconnect()")
    func noPingOnAnOldSocket() async throws {
        let bridge = FakeReconnectBridge()
        bridge.answersPings = true
        let clock = TestBridgeClock()
        let client = await makeHeartbeatClient(bridge, clock: clock, interval: 0.05, timeout: 5)
        try await client.connect()
        let first = bridge.current
        try await until {
            let received = await client.receivedFrameCount
            return first.pingsAttempted == 1 && received == 2 && clock.nextWakeMilliseconds == 50
        }
        clock.advance(by: 0.05)
        try await until { first.pingsAttempted >= 2 && clock.nextWakeMilliseconds == 50 }

        bridge.refuseConnections = true
        first.drop()
        try await until { await client.connectionState == .interrupted }
        try await until { clock.nextWakeMilliseconds == 20 }
        let pingsAtDrop = first.pingsAttempted
        let callsAtDrop = bridge.connectCalls
        clock.advance(by: 0.30)
        try await until { bridge.connectCalls > callsAtDrop && clock.nextWakeMilliseconds == 20 }
        #expect(first.pingsAttempted == pingsAtDrop)

        bridge.refuseConnections = false
        clock.advance(by: 0.02)
        try await until { await client.connectionState == .attached }
        let second = bridge.current
        #expect(second !== first)
        try await until { second.pingsAttempted >= 1 && clock.nextWakeMilliseconds == 50 }
        clock.advance(by: 0.05)
        try await until { second.pingsAttempted >= 2 }
        #expect(first.pingsAttempted == pingsAtDrop)

        await client.disconnect()
        let pingsAtDisconnect = second.pingsAttempted
        clock.advance(by: 0.30)
        #expect(second.pingsAttempted == pingsAtDisconnect)
        #expect(first.pingsAttempted == pingsAtDrop)
    }
}
