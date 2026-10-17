import Foundation
import Testing
@testable import PyricFirestore

// A frame that never left the device is held for the reconnect instead of
// failing as in flight (#1033, ADR-0019 amendment of 2026-10-17). The fake
// bridge lives in BridgeReconnectTests.swift; each socket it opens is wrapped
// here so a test can make it refuse frames, as a closing URLSession task does.

/// A socket of the reconnect fake that can start closing: from `beginClosing()`
/// it refuses every frame with `WebSocketSendRefusedError`, until the test
/// closes it with `finishClosing(code:)`.
final class ClosingSocket: WebSocketTransport, @unchecked Sendable {
    let inner: FakeReconnectSocket
    private let lock = NSLock()
    private var refusing = false
    private var holdsRefusals = false
    private var heldRefusals: [CheckedContinuation<Void, Never>] = []
    private var _failingType: String?
    private var _sent: [[String: AnySendable]] = []

    init(inner: FakeReconnectSocket) {
        self.inner = inner
    }

    /// Frames this socket handed to the host, in order.
    var sent: [[String: AnySendable]] {
        lock.lock(); defer { lock.unlock() }; return _sent
    }

    /// The `path` of each `worker-op` this socket handed to the host, in order.
    var opPaths: [String] {
        sent.filter { $0["type"]?.stringValue == "worker-op" }.compactMap { $0["op"]?["path"]?.stringValue }
    }

    var waitingRefusals: Int {
        lock.lock(); defer { lock.unlock() }; return heldRefusals.count
    }

    /// Refuses every frame from now on. With `holdingRefusals`, each refused
    /// `worker-op` or `worker-sub` waits for `releaseRefusals()` before it throws.
    func beginClosing(holdingRefusals: Bool = false) {
        lock.lock(); refusing = true; holdsRefusals = holdingRefusals; lock.unlock()
    }

    func releaseRefusals() {
        lock.lock()
        let held = heldRefusals
        heldRefusals.removeAll()
        holdsRefusals = false
        lock.unlock()
        for refusal in held { refusal.resume() }
    }

    /// Makes every send of a frame of `type` throw an error that is not a refusal.
    func failSends(ofType type: String) {
        lock.lock(); _failingType = type; lock.unlock()
    }

    func finishClosing(code: Int? = nil) {
        inner.drop(code: code)
    }

    func send(_ string: String) async throws {
        if isRefusing {
            let carriesWork = string.contains("\"type\":\"worker-op\"") || string.contains("\"type\":\"worker-sub\"")
            if carriesWork { await waitIfHoldingRefusals() }
            throw WebSocketSendRefusedError()
        }
        if let failingType, string.contains("\"type\":\"\(failingType)\"") {
            throw PyricBridgeError.internalError("socket write failed")
        }
        try await inner.send(string)
        record(string)
    }

    func receive() async throws -> String {
        try await inner.receive()
    }

    func close(closeCode: Int, reason: String?) async {
        await inner.close(closeCode: closeCode, reason: reason)
    }

    private var isRefusing: Bool {
        lock.lock(); defer { lock.unlock() }; return refusing
    }

    private var failingType: String? {
        lock.lock(); defer { lock.unlock() }; return _failingType
    }

    private func waitIfHoldingRefusals() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            guard holdsRefusals else {
                lock.unlock()
                continuation.resume()
                return
            }
            heldRefusals.append(continuation)
            lock.unlock()
        }
    }

    private func record(_ string: String) {
        guard let data = string.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AnySendable.self, from: data),
              let dict = frame.dictionaryValue else { return }
        lock.lock(); _sent.append(dict); lock.unlock()
    }
}

/// The reconnect fake, with each socket it opens wrapped in a `ClosingSocket`.
final class ClosingBridge: @unchecked Sendable {
    let fake = FakeReconnectBridge()
    private let lock = NSLock()
    private var _sockets: [ClosingSocket] = []

    var sockets: [ClosingSocket] {
        lock.lock(); defer { lock.unlock() }; return _sockets
    }

    var current: ClosingSocket { sockets.last! }

    func connect(_ request: URLRequest) async throws -> any WebSocketTransport {
        guard let inner = try await fake.connect(request) as? FakeReconnectSocket else {
            throw PyricBridgeError.internalError("unexpected socket type")
        }
        let socket = ClosingSocket(inner: inner)
        append(socket)
        return socket
    }

    private func append(_ socket: ClosingSocket) {
        lock.lock(); _sockets.append(socket); lock.unlock()
    }

    /// Answers every `worker-op` the current socket received.
    func answerAll() {
        for frame in current.sent where frame["type"]?.stringValue == "worker-op" {
            fake.answer(frame)
        }
    }
}

private func makeClient(_ bridge: ClosingBridge, retryDelay: TimeInterval = 0) -> PyricBridgeClient {
    PyricBridgeClient(
        reconnectDelay: { _ in retryDelay },
        transportFactory: { request in try await bridge.connect(request) }
    )
}

/// Issues a `setDoc` to `path` with a turn taken now, so writes issued one
/// after another are admitted in that order.
private func issueWrite(_ client: PyricBridgeClient, _ path: String, method: String = "setDoc") -> Task<AnySendable, Error> {
    let turn = client.takeTurn()
    return Task { try await client.op(turn: turn, method: method, params: ["path": .string(path)]) }
}

/// Returns once every write issued before it has been sent, held, or has failed.
private func admitted(_ client: PyricBridgeClient) async {
    await client.pass(turn: client.takeTurn())
}

/// Awaits a write that must fail, and returns its error.
private func failure(of task: Task<AnySendable, Error>) async -> PyricBridgeError? {
    do {
        _ = try await task.value
        Issue.record("expected the write to fail")
        return nil
    } catch let error as PyricBridgeError {
        return error
    } catch {
        Issue.record("unexpected error \(error)")
        return nil
    }
}

@Suite("Refused sends")
struct RefusedSendTests {

    @Test("A write still queued behind an open write at a drop is held and sent after the re-attach, ahead of a write issued after the drop")
    func queuedWritesAtDropAreHeld() async throws {
        let bridge = ClosingBridge()
        let client = makeClient(bridge, retryDelay: 0.02)
        try await client.connect()
        let old = bridge.current

        bridge.fake.suspendWrites(ofMethod: "slowOp")
        let x = issueWrite(client, "rooms/x", method: "slowOp")
        try await until { bridge.fake.suspendedWriteCount == 1 }
        let a = issueWrite(client, "rooms/a")
        let a2 = issueWrite(client, "rooms/a2")
        await admitted(client)

        try await interrupt(bridge.fake, client)
        let b = issueWrite(client, "rooms/b")
        await admitted(client)
        bridge.fake.releaseWrites()

        let lost = await failure(of: x)
        #expect(lost?.code == .unavailable)
        #expect(lost?.message.contains("connection was lost") == true)

        bridge.fake.refuseConnections = false
        try await until { bridge.sockets.count == 2 && bridge.current.opPaths.count == 3 }
        #expect(bridge.current.opPaths == ["rooms/a", "rooms/a2", "rooms/b"])
        #expect(old.opPaths == ["rooms/x"])
        bridge.answerAll()
        for write in [a, a2, b] { _ = try await write.value }
        await client.disconnect()
    }

    @Test("A refused write and the write queued behind it are sent after the re-attach, in order, ahead of a later write")
    func refusedWriteKeepsItsPlace() async throws {
        let bridge = ClosingBridge()
        let client = makeClient(bridge)
        try await client.connect()
        let old = bridge.current

        old.beginClosing(holdingRefusals: true)
        let a = issueWrite(client, "rooms/a")
        let a2 = issueWrite(client, "rooms/a2")
        await admitted(client)
        try await until { old.waitingRefusals == 1 }
        old.releaseRefusals()
        let b = issueWrite(client, "rooms/b")
        await admitted(client)
        old.finishClosing(code: 1006)

        try await until { bridge.sockets.count == 2 && bridge.current.opPaths.count == 3 }
        #expect(bridge.current.opPaths == ["rooms/a", "rooms/a2", "rooms/b"])
        #expect(old.opPaths.isEmpty)
        bridge.answerAll()
        for write in [a, a2, b] { _ = try await write.value }
        await client.disconnect()
    }

    @Test("A refusal that returns after the drop and the re-attach is still sent ahead of a write issued after them")
    func lateRefusalIsSentFirst() async throws {
        let bridge = ClosingBridge()
        let client = makeClient(bridge)
        try await client.connect()
        let old = bridge.current

        old.beginClosing(holdingRefusals: true)
        let a = issueWrite(client, "rooms/a")
        try await until { old.waitingRefusals == 1 }
        old.finishClosing(code: 1006)
        try await until { bridge.sockets.count == 2 }
        try await until { await client.connectionState == .attached }

        let b = issueWrite(client, "rooms/b")
        await admitted(client)
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.current.opPaths.isEmpty)
        old.releaseRefusals()

        try await until { bridge.current.opPaths.count == 2 }
        #expect(bridge.current.opPaths == ["rooms/a", "rooms/b"])
        bridge.answerAll()
        for write in [a, b] { _ = try await write.value }
        await client.disconnect()
    }

    @Test("A send that throws an error other than a refusal fails the write, and it is never re-sent")
    func otherSendErrorFails() async throws {
        let bridge = ClosingBridge()
        let client = makeClient(bridge)
        try await client.connect()
        let old = bridge.current

        old.failSends(ofType: "worker-op")
        let error = await failure(of: issueWrite(client, "rooms/a"))
        #expect(error?.code == .unavailable)
        #expect(error?.message.contains("Failed to dispatch") == true)

        old.finishClosing(code: 1006)
        try await until { bridge.sockets.count == 2 }
        try await until { await client.isConnected }
        let probe = issueWrite(client, "rooms/probe")
        try await until { bridge.current.opPaths.count == 1 }
        #expect(bridge.current.opPaths == ["rooms/probe"])
        bridge.answerAll()
        _ = try await probe.value
        await client.disconnect()
    }

    @Test("A refused write fails with the close error when the close is a policy close (1008), and nothing is sent")
    func refusalThenPolicyCloseFails() async throws {
        let bridge = ClosingBridge()
        let client = makeClient(bridge)
        try await client.connect()
        let old = bridge.current

        old.beginClosing()
        let a = issueWrite(client, "rooms/a")
        await admitted(client)
        try await Task.sleep(nanoseconds: 30_000_000)
        old.finishClosing(code: 1008)

        let error = await failure(of: a)
        #expect(error?.code == .unavailable)
        #expect(error?.message.contains("WebSocket connection error") == true)
        #expect(error?.message.contains("1008") == true)
        try await until { await client.connectionState == .closed }
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.fake.ofType("attach").count == 1)
        #expect(bridge.fake.ofType("worker-op").isEmpty)
        await client.disconnect()
    }

    @Test("A refused write fails once with the disconnect error when the app disconnects")
    func refusalThenDisconnectFails() async throws {
        let bridge = ClosingBridge()
        let client = makeClient(bridge)
        try await client.connect()

        bridge.current.beginClosing()
        let a = issueWrite(client, "rooms/a")
        await admitted(client)
        try await Task.sleep(nanoseconds: 30_000_000)
        await client.disconnect()

        let error = await failure(of: a)
        #expect(error?.code == .unavailable)
        #expect(error?.message == "PyricBridgeClient disconnected.")
        #expect(bridge.fake.ofType("worker-op").isEmpty)
    }

    @Test("A refused write fails at the hold deadline, measured from when it was issued")
    func refusedWriteFailsAtHoldDeadline() async throws {
        let bridge = ClosingBridge()
        let client = makeClient(bridge)
        await client.setHoldDeadlineForTesting(0.2)
        try await client.connect()

        bridge.current.beginClosing()
        let issued = ContinuousClock.now
        let error = await failure(of: issueWrite(client, "rooms/a"))
        let waited = issued.duration(to: .now)
        #expect(error?.code == .unavailable)
        #expect(error?.message == notRestoredMessage)
        #expect(waited >= .milliseconds(180))
        #expect(waited < .seconds(2))
        await client.disconnect()
    }

    @Test("A client on one supplied channel fails a refused write, as before")
    func suppliedChannelRefusalFails() async throws {
        let bridge = ClosingBridge()
        let channel = try await bridge.connect(PyricBridgeClient.makeWebSocketRequest(url: URL(string: "ws://127.0.0.1:1")!))
        let client = PyricBridgeClient(channel: channel)
        try await client.connect()

        bridge.current.beginClosing()
        let error = await failure(of: issueWrite(client, "rooms/a"))
        #expect(error?.code == .unavailable)
        #expect(error?.message.contains("Failed to dispatch") == true)
        await client.disconnect()
    }

    @Test("URLSessionWebSocketTransport refuses a frame once its task has stopped running, without sending it")
    func urlSessionTransportRefusesAfterClose() async throws {
        let request = PyricBridgeClient.makeWebSocketRequest(url: URL(string: "ws://127.0.0.1:1")!)
        let transport = URLSessionWebSocketTransport(request: request)
        await transport.close(closeCode: 1000, reason: nil)
        do {
            try await transport.send("{}")
            Issue.record("expected the send to be refused")
        } catch {
            #expect(error is WebSocketSendRefusedError)
        }
    }
}
