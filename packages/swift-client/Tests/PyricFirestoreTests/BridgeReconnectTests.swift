import Foundation
import Testing
@testable import PyricFirestore

// ── Fake bridge: one new socket per connection, frames recorded across all ──

final class FakeReconnectSocket: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: [String] = []
    private var waiters: [CheckedContinuation<String, Error>] = []
    private var open = true
    private var closeCode: Int?
    private let onFrame: @Sendable ([String: AnySendable], FakeReconnectSocket) -> Void
    private let beforeSend: @Sendable ([String: AnySendable]) async -> Void
    private var _answersPings: Bool

    /// Whether the host behind this socket answers `ping` with `pong`. A test
    /// turns it off to make an open socket go silent from that moment.
    var answersPings: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _answersPings }
        set { lock.lock(); _answersPings = newValue; lock.unlock() }
    }

    init(
        answersPings: Bool = false,
        beforeSend: @escaping @Sendable ([String: AnySendable]) async -> Void = { _ in },
        onFrame: @escaping @Sendable ([String: AnySendable], FakeReconnectSocket) -> Void
    ) {
        self._answersPings = answersPings
        self.beforeSend = beforeSend
        self.onFrame = onFrame
    }

    private var pingAttempts = 0

    var isOpen: Bool {
        lock.lock(); defer { lock.unlock() }
        return open
    }

    /// Pings the client tried to send on this socket, including after it closed.
    var pingsAttempted: Int {
        lock.lock(); defer { lock.unlock() }
        return pingAttempts
    }

    private func countPingAttempt() {
        lock.lock(); pingAttempts += 1; lock.unlock()
    }

    func send(_ string: String) async throws {
        if string.contains("\"type\":\"ping\"") { countPingAttempt() }
        guard isOpen else { throw PyricBridgeError.unavailable("socket closed") }
        guard let data = string.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AnySendable.self, from: data),
              let dict = frame.dictionaryValue else { return }
        await beforeSend(dict)
        onFrame(dict, self)
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !buffer.isEmpty {
                let next = buffer.removeFirst()
                lock.unlock()
                continuation.resume(returning: next)
                return
            }
            if !open {
                let code = closeCode
                lock.unlock()
                continuation.resume(throwing: code.map { WebSocketCloseError(closeCode: $0) as Error }
                    ?? PyricBridgeError.unavailable("socket dropped"))
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func close(closeCode: Int, reason: String?) async {
        drop()
    }

    func deliver(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        let text = String(decoding: data, as: UTF8.self)
        lock.lock()
        guard open else { lock.unlock(); return }
        if !waiters.isEmpty {
            let waiter = waiters.removeFirst()
            lock.unlock()
            waiter.resume(returning: text)
            return
        }
        buffer.append(text)
        lock.unlock()
    }

    func drop(code: Int? = nil) {
        lock.lock()
        guard open else { lock.unlock(); return }
        open = false
        closeCode = code
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending {
            waiter.resume(throwing: code.map { WebSocketCloseError(closeCode: $0) as Error }
                ?? PyricBridgeError.unavailable("socket dropped"))
        }
    }
}

final class FakeReconnectBridge: @unchecked Sendable {
    private let lock = NSLock()
    private var _frames: [[String: AnySendable]] = []
    private var _sockets: [FakeReconnectSocket] = []
    private var _hostInstanceId = "host-a"
    private var _refuseConnections = false

    var hostInstanceId: String {
        get { lock.lock(); defer { lock.unlock() }; return _hostInstanceId }
        set { lock.lock(); _hostInstanceId = newValue; lock.unlock() }
    }

    var refuseConnections: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _refuseConnections }
        set { lock.lock(); _refuseConnections = newValue; lock.unlock() }
    }

    private var _autoAck = true
    private var _connectCalls = 0
    private var _answersPings = false

    /// Whether sockets opened from now on answer `ping` with `pong`. Off by
    /// default, so a client with a short liveness timeout sees a silent host.
    /// A socket keeps the setting it was opened with.
    var answersPings: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _answersPings }
        set { lock.lock(); _answersPings = newValue; lock.unlock() }
    }

    var autoAck: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _autoAck }
        set { lock.lock(); _autoAck = newValue; lock.unlock() }
    }

    var connectCalls: Int {
        lock.lock(); defer { lock.unlock() }; return _connectCalls
    }

    private func countConnect() {
        lock.lock(); _connectCalls += 1; lock.unlock()
    }

    var frames: [[String: AnySendable]] {
        lock.lock(); defer { lock.unlock() }; return _frames
    }

    var socketCount: Int {
        lock.lock(); defer { lock.unlock() }; return _sockets.count
    }

    var current: FakeReconnectSocket {
        lock.lock(); defer { lock.unlock() }; return _sockets.last!
    }

    func connect(_ request: URLRequest) async throws -> any WebSocketTransport {
        countConnect()
        if refuseConnections { throw PyricBridgeError.unavailable("connection refused") }
        let socket = FakeReconnectSocket(
            answersPings: answersPings,
            beforeSend: { [weak self] frame in await self?.gate(frame) },
            onFrame: { [weak self] frame, socket in self?.record(frame, from: socket) }
        )
        append(socket)
        return socket
    }

    private var _suspendedMethod: String?
    private var _suspendedWrites: [CheckedContinuation<Void, Never>] = []

    /// Suspends the socket write of every `worker-op` for `method` until `releaseWrites()`.
    func suspendWrites(ofMethod method: String) {
        lock.lock(); _suspendedMethod = method; lock.unlock()
    }

    func releaseWrites() {
        lock.lock()
        let suspended = _suspendedWrites
        _suspendedWrites.removeAll()
        _suspendedMethod = nil
        lock.unlock()
        for write in suspended { write.resume() }
    }

    var suspendedWriteCount: Int {
        lock.lock(); defer { lock.unlock() }; return _suspendedWrites.count
    }

    private func gate(_ frame: [String: AnySendable]) async {
        let method = frame["op"]?["method"]?.stringValue
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            let suspends = method != nil && method == _suspendedMethod
            guard suspends else {
                lock.unlock()
                continuation.resume()
                return
            }
            _suspendedWrites.append(continuation)
            lock.unlock()
        }
    }

    private func append(_ socket: FakeReconnectSocket) {
        lock.lock(); _sockets.append(socket); lock.unlock()
    }

    private func record(_ frame: [String: AnySendable], from socket: FakeReconnectSocket) {
        lock.lock()
        _frames.append(frame)
        let host = _hostInstanceId
        let acks = _autoAck
        lock.unlock()
        if frame["type"]?.stringValue == "ping", socket.answersPings, let id = frame["id"]?.stringValue {
            Task { socket.deliver(["type": "pong", "id": id]) }
            return
        }
        guard frame["type"]?.stringValue == "attach", acks else { return }
        let sessionId = frame["clientSessionId"]?.stringValue ?? "session-1"
        Task {
            socket.deliver([
                "type": "attach-ack",
                "protocol": 1,
                "peerConnected": true,
                "clientSessionId": sessionId,
                "hostInstanceId": host,
            ])
        }
    }

    func ofType(_ type: String) -> [[String: AnySendable]] {
        frames.filter { $0["type"]?.stringValue == type }
    }

    func subs(forPath path: String) -> [[String: AnySendable]] {
        ofType("worker-sub").filter { $0["sub"]?["target"]?["path"]?.stringValue == path }
    }

    func subs(forTarget target: String) -> [[String: AnySendable]] {
        ofType("worker-sub").filter { $0["sub"]?["target"]?.stringValue == target }
    }

    func ops(named method: String) -> [[String: AnySendable]] {
        ofType("worker-op").filter { $0["op"]?["method"]?.stringValue == method }
    }

    /// Answers a sent `worker-op` frame successfully on the current socket.
    func answer(_ frame: [String: AnySendable], value: Any = "done") {
        current.deliver(["type": "worker-res", "id": frame["id"]!.stringValue!, "ok": true, "value": value])
    }
}

let notRestoredMessage = "The bridge connection was not restored within 10 seconds. The request was not sent."

/// Drops the socket and keeps the bridge refusing connections, so the client stays interrupted.
func interrupt(_ bridge: FakeReconnectBridge, _ client: PyricBridgeClient) async throws {
    bridge.refuseConnections = true
    bridge.current.drop()
    try await until { await client.connectionState == .interrupted }
}

final class Collected<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func append(_ item: T) { lock.lock(); items.append(item); lock.unlock() }
    var all: [T] { lock.lock(); defer { lock.unlock() }; return items }
    var count: Int { all.count }
}

func until(_ condition: @Sendable () async -> Bool) async throws {
    for _ in 0..<1200 {
        if await condition() { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
    Issue.record("condition not reached")
    throw PyricBridgeError.deadlineExceeded("condition not reached")
}

func makeReconnectingClient(
    _ bridge: FakeReconnectBridge,
    retryInitialConnection: Bool = false,
    retryDelay: TimeInterval = 0,
    attachTimeout: TimeInterval = 5
) -> PyricBridgeClient {
    PyricBridgeClient(
        retryInitialConnection: retryInitialConnection,
        reconnectDelay: { _ in retryDelay },
        attachTimeout: attachTimeout,
        transportFactory: { request in try await bridge.connect(request) }
    )
}

func collect(_ stream: PyricSubscriptionStream, into box: Collected<AnySendable>, errors: Collected<String>? = nil) -> Task<Void, Never> {
    Task {
        do {
            for try await value in stream { box.append(value) }
        } catch {
            errors?.append("\(error)")
        }
    }
}

@Suite("Bridge reconnect")
struct BridgeReconnectTests {

    @Test("A pending operation fails once with unavailable on a drop and is never re-sent")
    func pendingOperationFailsOnce() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()

        let pending = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await until { bridge.ops(named: "setDoc").count == 1 }
        let sentId = bridge.ops(named: "setDoc")[0]["id"]?.stringValue

        bridge.current.drop()
        do {
            _ = try await pending.value
            Issue.record("expected unavailable")
        } catch let error as PyricBridgeError {
            #expect(error.code == .unavailable)
            #expect(error.message.contains("connection was lost"))
        }
        try await until { await client.isConnected }
        #expect(bridge.ofType("worker-op").filter { $0["id"]?.stringValue == sentId }.count == 1)
        await client.disconnect()
    }

    @Test("Re-attaches with the session id from the first attach-ack and re-sends live listens")
    func reattachesAndRestoresListens() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        let values = Collected<AnySendable>()
        let errors = Collected<String>()
        let task = collect(client.subscribe(target: ["__ref": "doc", "path": "rooms/a"]), into: values, errors: errors)

        try await until { bridge.subs(forPath: "rooms/a").count == 1 }
        let subId = bridge.subs(forPath: "rooms/a")[0]["subId"]!.stringValue!
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["path": "rooms/a", "exists": true, "data": ["n": 1]]])
        try await until { values.count == 1 }

        bridge.current.drop()
        try await until { bridge.subs(forPath: "rooms/a").count == 2 }
        let reattach = bridge.ofType("attach").last!
        #expect(reattach["clientSessionId"]?.stringValue == "session-1")
        #expect(bridge.subs(forPath: "rooms/a")[1]["subId"]?.stringValue == subId)

        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["path": "rooms/a", "exists": true, "data": ["n": 2]]])
        try await until { values.count == 2 }
        #expect(values.all[1]["data"]?["n"]?.intValue == 2)
        #expect(errors.all.isEmpty)
        task.cancel()
        await client.disconnect()
    }

    @Test("A restored value equal to the last one is not raised to a listener without metadata changes")
    func unchangedRestoredValueIsSuppressed() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        let values = Collected<AnySendable>()
        let task = collect(client.subscribe(target: .string("authState")), into: values)

        try await until { bridge.subs(forTarget: "authState").count == 1 }
        let subId = bridge.subs(forTarget: "authState")[0]["subId"]!.stringValue!
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["uid": "u1"]])
        try await until { values.count == 1 }

        bridge.current.drop()
        try await until { bridge.subs(forTarget: "authState").count == 2 }
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["uid": "u1"]])
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(values.count == 1)

        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["uid": "u2"]])
        try await until { values.count == 2 }
        task.cancel()
        await client.disconnect()
    }

    @Test("A subscription with metadata changes receives a gap on the drop, then the restored value")
    func metadataSubscriptionReceivesGap() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        let events = Collected<BridgeSubscriptionEvent>()
        let stream = client.subscribe(target: ["__ref": "collection", "path": "rooms"], includeMetadataChanges: true).events
        let task = Task {
            do { for try await event in stream { events.append(event) } } catch {}
        }

        try await until { bridge.subs(forPath: "rooms").count == 1 }
        let subId = bridge.subs(forPath: "rooms")[0]["subId"]!.stringValue!
        let docs: [String: Any] = ["docs": [["path": "rooms/a", "exists": true, "data": ["n": 1]]]]
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": docs])
        try await until { events.count == 1 }

        bridge.current.drop()
        try await until { events.count == 2 }
        #expect(events.all[1] == .gap)

        try await until { bridge.subs(forPath: "rooms").count == 2 }
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": docs])
        try await until { events.count == 3 }
        if case .value = events.all[2] {} else { Issue.record("expected the restored value") }
        task.cancel()
        await client.disconnect()
    }

    @Test("An operation issued while interrupted reaches the host exactly once after re-attach")
    func heldOperationIsSentOnceAfterReattach() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        try await client.connect()
        try await interrupt(bridge, client)

        let write = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(bridge.ops(named: "setDoc").isEmpty)

        bridge.refuseConnections = false
        try await until { bridge.ops(named: "setDoc").count == 1 }
        bridge.answer(bridge.ops(named: "setDoc")[0])
        let value = try await write.value
        #expect(value.stringValue == "done")
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.ops(named: "setDoc").count == 1)
        await client.disconnect()
    }

    @Test("An operation issued while restoring on a replaced host is sent after the Auth restore and the listener replay")
    func heldOperationFollowsTheRestore() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        await client.setAuthRestorer { op in
            _ = try await op("auth.restorePortSession", ["uid": .string("u1"), "tenantId": .null])
        }
        let values = Collected<AnySendable>()
        let listener = collect(client.subscribe(target: ["__ref": "doc", "path": "rooms/a"]), into: values)
        try await until { bridge.subs(forPath: "rooms/a").count == 1 }

        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        try await until { bridge.ops(named: "auth.restorePortSession").count == 1 }
        // The client is restoring until the restore is answered.
        let write = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(bridge.ops(named: "setDoc").isEmpty)

        bridge.answer(bridge.ops(named: "auth.restorePortSession")[0], value: ["uid": "u1"])
        try await until { bridge.ops(named: "setDoc").count == 1 }
        bridge.answer(bridge.ops(named: "setDoc")[0])
        _ = try await write.value

        let frames = bridge.frames
        let restoredAuth = frames.lastIndex { $0["op"]?["method"]?.stringValue == "auth.restorePortSession" }
        let resubscribed = frames.lastIndex {
            $0["type"]?.stringValue == "worker-sub" && $0["sub"]?["target"]?["path"]?.stringValue == "rooms/a"
        }
        let held = frames.firstIndex { $0["op"]?["method"]?.stringValue == "setDoc" }
        #expect(restoredAuth != nil && resubscribed != nil && held != nil)
        if let restoredAuth, let resubscribed, let held {
            #expect(resubscribed > restoredAuth)
            #expect(held > resubscribed)
        }
        #expect(bridge.ops(named: "setDoc").count == 1)
        listener.cancel()
        await client.disconnect()
    }

    @Test("An operation issued while held operations are still being sent follows them, in issue order")
    func operationIssuedDuringFlushFollowsHeldOperations() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        try await client.connect()
        try await interrupt(bridge, client)

        let first = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await Task.sleep(nanoseconds: 20_000_000)
        let second = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/b")]) }
        try await Task.sleep(nanoseconds: 20_000_000)

        // The first held write suspends in the socket, so the flush is in progress.
        bridge.suspendWrites(ofMethod: "setDoc")
        bridge.refuseConnections = false
        try await until { bridge.suspendedWriteCount == 1 }
        let third = Task { try await client.op(method: "getDoc", params: ["path": .string("rooms/c")]) }
        try await Task.sleep(nanoseconds: 50_000_000)
        bridge.releaseWrites()

        try await until { bridge.ops(named: "setDoc").count == 2 && bridge.ops(named: "getDoc").count == 1 }
        let order = bridge.ofType("worker-op").compactMap { $0["op"]?["path"]?.stringValue }
        #expect(order == ["rooms/a", "rooms/b", "rooms/c"])
        for frame in bridge.ofType("worker-op") { bridge.answer(frame) }
        for task in [first, second, third] { _ = try await task.value }
        await client.disconnect()
    }

    @Test("An operation held past the deadline fails once, saying it was not sent, and a later attach never sends it")
    func heldOperationPastDeadlineIsNeverSent() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        await client.setHoldDeadlineForTesting(0.1)
        try await client.connect()
        try await interrupt(bridge, client)

        do {
            _ = try await client.op(method: "setDoc", params: ["path": .string("rooms/a")])
            Issue.record("expected the hold to expire")
        } catch let error as PyricBridgeError {
            #expect(error.code == .unavailable)
            #expect(error.message == notRestoredMessage)
        }

        bridge.refuseConnections = false
        try await until { await client.isConnected }
        let ping = Task { try await client.op(method: "ping") }
        try await until { bridge.ops(named: "ping").count == 1 }
        bridge.answer(bridge.ops(named: "ping")[0])
        _ = try await ping.value
        #expect(bridge.ops(named: "setDoc").isEmpty)
        await client.disconnect()
    }

    @Test("A failed Auth restore on a replaced host fails held operations without sending them")
    func failedAuthRestoreFailsHeldOperations() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        await client.setAuthRestorer { op in
            _ = try await op("auth.restorePortSession", ["uid": .string("u1"), "tenantId": .null])
        }
        try await client.connect()
        bridge.hostInstanceId = "host-b"
        try await interrupt(bridge, client)

        let write = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await Task.sleep(nanoseconds: 50_000_000)
        bridge.refuseConnections = false
        try await until { bridge.ops(named: "auth.restorePortSession").count == 1 }
        let restore = bridge.ops(named: "auth.restorePortSession")[0]
        bridge.current.deliver([
            "type": "worker-res", "id": restore["id"]!.stringValue!, "ok": false,
            "error": ["code": "internal", "message": "restore failed"],
        ])

        do {
            _ = try await write.value
            Issue.record("expected the held operation to fail")
        } catch let error as PyricBridgeError {
            #expect(error.code == .unavailable)
            #expect(error.message.contains("could not be restored"))
            #expect(error.message.hasSuffix("The request was not sent."))
        }
        try await until { await client.isConnected }
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.ops(named: "setDoc").isEmpty)
        await client.disconnect()
    }

    @Test("disconnect() while holding fails held operations once and sends none")
    func disconnectFailsHeldOperations() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge, retryDelay: 0.02)
        try await client.connect()
        try await interrupt(bridge, client)

        let settled = Collected<String>()
        let first = Task {
            defer { settled.append("first") }
            return try await client.op(method: "setDoc", params: ["path": .string("rooms/a")])
        }
        let second = Task {
            defer { settled.append("second") }
            return try await client.op(method: "setDoc", params: ["path": .string("rooms/b")])
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(settled.all.isEmpty)

        await client.disconnect()
        for task in [first, second] {
            do {
                _ = try await task.value
                Issue.record("expected the held operation to fail")
            } catch let error as PyricBridgeError {
                #expect(error.code == .unavailable)
                #expect(error.message == "PyricBridgeClient disconnected.")
            }
        }
        bridge.refuseConnections = false
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(bridge.ops(named: "setDoc").isEmpty)
    }

    @Test("The first connection retries when asked to; an operation issued before it attaches is held and sent once")
    func firstConnectionRetries() async throws {
        let bridge = FakeReconnectBridge()
        bridge.refuseConnections = true
        let client = makeReconnectingClient(bridge, retryInitialConnection: true, retryDelay: 0.02)
        let values = Collected<AnySendable>()
        let task = collect(client.subscribe(target: ["__ref": "doc", "path": "rooms/a"]), into: values)

        let write = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/a")]) }
        try await until { bridge.connectCalls >= 2 }
        #expect(await client.isDisposed == false)
        #expect(bridge.ofType("worker-op").isEmpty)

        bridge.refuseConnections = false
        try await until { bridge.ops(named: "setDoc").count == 1 }
        bridge.answer(bridge.ops(named: "setDoc")[0])
        _ = try await write.value
        try await until { bridge.subs(forPath: "rooms/a").count == 1 }
        let subId = bridge.subs(forPath: "rooms/a")[0]["subId"]!.stringValue!
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["path": "rooms/a", "exists": false]])
        try await until { values.count == 1 }
        #expect(bridge.ops(named: "setDoc").count == 1)
        task.cancel()
        await client.disconnect()
    }

    @Test("Before the first attach, an operation held past the deadline fails once and is never sent")
    func preAttachOperationPastDeadlineIsNeverSent() async throws {
        let bridge = FakeReconnectBridge()
        bridge.refuseConnections = true
        let client = makeReconnectingClient(bridge, retryInitialConnection: true, retryDelay: 0.02)
        await client.setHoldDeadlineForTesting(0.1)

        do {
            _ = try await client.op(method: "setDoc", params: ["path": .string("rooms/a")])
            Issue.record("expected the hold to expire")
        } catch let error as PyricBridgeError {
            #expect(error.code == .unavailable)
            #expect(error.message == notRestoredMessage)
        }
        #expect(bridge.connectCalls >= 2)

        bridge.refuseConnections = false
        try await until { await client.isConnected }
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.ops(named: "setDoc").isEmpty)
        await client.disconnect()
    }

    @Test("Without retryInitialConnection an operation fails with the first failed attempt and is never sent")
    func preAttachOperationWithoutRetryFailsOnce() async throws {
        let bridge = FakeReconnectBridge()
        bridge.refuseConnections = true
        let client = makeReconnectingClient(bridge)
        await #expect(throws: PyricBridgeError.self) {
            _ = try await client.op(method: "setDoc", params: ["path": .string("rooms/a")])
        }
        #expect(await client.connectionState == .closed)

        bridge.refuseConnections = false
        try await client.connect()
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.ops(named: "setDoc").isEmpty)
        await client.disconnect()
    }

    @Test("Without retryInitialConnection the first failed attempt fails connect and schedules nothing")
    func firstFailureWithoutRetryCloses() async throws {
        let bridge = FakeReconnectBridge()
        bridge.refuseConnections = true
        let client = makeReconnectingClient(bridge)
        await #expect(throws: PyricBridgeError.self) {
            try await client.connect()
        }
        #expect(await client.connectionState == .closed)
        bridge.refuseConnections = false
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.socketCount == 0)
        await client.disconnect()
    }

    @Test("A policy close (1008) closes the client instead of reconnecting")
    func policyCloseDoesNotReconnect() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        bridge.current.drop(code: 1008)
        try await until { await client.connectionState == .closed }
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.ofType("attach").count == 1)
        await client.disconnect()
    }

    @Test("A replaced host runs the Auth restore before any listen is re-sent")
    func replacedHostRestoresAuthFirst() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        let restores = Collected<String>()
        await client.setAuthRestorer { op in
            restores.append("called")
            _ = try await op("auth.restorePortSession", ["uid": .string("u1"), "tenantId": .null])
        }
        let values = Collected<AnySendable>()
        let task = collect(client.subscribe(target: ["__ref": "doc", "path": "rooms/a"]), into: values)
        try await until { bridge.subs(forPath: "rooms/a").count == 1 }

        bridge.current.drop()
        try await until { bridge.subs(forPath: "rooms/a").count == 2 }
        #expect(restores.all.isEmpty)

        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        try await until { bridge.ops(named: "auth.restorePortSession").count == 1 }
        let restore = bridge.ops(named: "auth.restorePortSession")[0]
        #expect(restore["op"]?["uid"]?.stringValue == "u1")
        #expect(bridge.subs(forPath: "rooms/a").count == 2)

        bridge.current.deliver(["type": "worker-res", "id": restore["id"]!.stringValue!, "ok": true, "value": ["uid": "u1"]])
        try await until { bridge.subs(forPath: "rooms/a").count == 3 }
        task.cancel()
        await client.disconnect()
    }

    /// Attaches to host-a, then re-attaches to a replaced host-b whose Auth restore is in flight.
    private func replaceHostAndAwaitRestore(_ bridge: FakeReconnectBridge, _ client: PyricBridgeClient) async throws {
        await client.setAuthRestorer { op in
            _ = try await op("auth.restorePortSession", ["uid": .string("u1"), "tenantId": .null])
        }
        try await client.connect()
        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        try await until { bridge.ops(named: "auth.restorePortSession").count == 1 }
    }

    @Test("A drop during the Auth restore on a replaced host restores Auth on the next attach to that host")
    func dropDuringRestoreRetriesTheRestore() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await replaceHostAndAwaitRestore(bridge, client)
        bridge.current.drop()

        try await until { bridge.ops(named: "auth.restorePortSession").count == 2 }
        let retried = bridge.ops(named: "auth.restorePortSession")[1]
        #expect(retried["op"]?["uid"]?.stringValue == "u1")
        bridge.answer(retried, value: ["uid": "u1"])
        try await until { await client.isConnected }
        await client.disconnect()
    }

    @Test("An operation held across a drop during the Auth restore is sent once, after the restore completes")
    func heldOperationWaitsForTheRetriedRestore() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await replaceHostAndAwaitRestore(bridge, client)
        let write = Task { try await client.op(method: "setDoc", params: ["path": .string("rooms/b")]) }
        try await Task.sleep(nanoseconds: 30_000_000)
        bridge.current.drop()

        try await until { bridge.ops(named: "auth.restorePortSession").count == 2 }
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.ops(named: "setDoc").isEmpty)

        bridge.answer(bridge.ops(named: "auth.restorePortSession")[1], value: ["uid": "u1"])
        try await until { bridge.ops(named: "setDoc").count == 1 }
        let frames = bridge.frames
        let restoredAuth = frames.lastIndex { $0["op"]?["method"]?.stringValue == "auth.restorePortSession" }
        let held = frames.firstIndex { $0["op"]?["method"]?.stringValue == "setDoc" }
        #expect(restoredAuth != nil && held != nil)
        if let restoredAuth, let held {
            #expect(held > restoredAuth)
        }
        bridge.answer(bridge.ops(named: "setDoc")[0])
        _ = try await write.value
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.ops(named: "setDoc").count == 1)
        await client.disconnect()
    }

    @Test("A resume to the same host after a completed restore does not restore Auth again")
    func resumeAfterCompletedRestoreDoesNotRestoreAgain() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await replaceHostAndAwaitRestore(bridge, client)
        bridge.answer(bridge.ops(named: "auth.restorePortSession")[0], value: ["uid": "u1"])
        try await until { await client.isConnected }

        bridge.current.drop()
        try await until { bridge.ofType("attach").count == 3 }
        try await until { await client.isConnected }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(bridge.ops(named: "auth.restorePortSession").count == 1)
        await client.disconnect()
    }

    @Test("Reconnect delays follow the bounded jittered schedule")
    func reconnectSchedule() {
        let bases: [Double] = [250, 500, 1000, 2000, 4000, 5000, 5000, 5000]
        for (attempt, base) in bases.enumerated() {
            for random in [0.0, 0.5, 0.999] {
                let delay = bridgeReconnectDelay(attempt: attempt, random: random) * 1000
                #expect(delay >= base)
                #expect(delay <= min(5000, base + min(250, base / 10)))
            }
        }
        #expect(bridgeReconnectDelay(attempt: 60, random: 0.999) <= 5.0)
    }

    @Test("A query listener with metadata changes reports the gap with fromCache, then the changes made during it")
    func queryListenerReportsGap() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        let firestore = Firestore(bridgeClient: client, app: FirebaseApp(name: "reconnect-\(UUID().uuidString)"))
        let snapshots = Collected<QuerySnapshot>()
        let registration = firestore.collection("rooms").addSnapshotListener(includeMetadataChanges: true) { snapshot, _ in
            if let snapshot { snapshots.append(snapshot) }
        }

        try await until { bridge.subs(forPath: "rooms").count == 1 }
        let subId = bridge.subs(forPath: "rooms")[0]["subId"]!.stringValue!
        let docA: [String: Any] = ["path": "rooms/a", "exists": true, "data": ["n": 1]]
        let docB: [String: Any] = ["path": "rooms/b", "exists": true, "data": ["n": 1]]
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["docs": [docA]]])
        try await until { snapshots.count == 1 }
        #expect(snapshots.all[0].metadata.isFromCache == false)

        bridge.current.drop()
        try await until { snapshots.count == 2 }
        let gap = snapshots.all[1]
        #expect(gap.metadata.isFromCache == true)
        #expect(gap.metadata.hasPendingWrites == false)
        #expect(gap.documents.map(\.documentID) == ["a"])
        #expect(gap.documentChanges.isEmpty)

        try await until { bridge.subs(forPath: "rooms").count == 2 }
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["docs": [docA, docB]]])
        try await until { snapshots.count == 3 }
        let restored = snapshots.all[2]
        #expect(restored.metadata.isFromCache == false)
        #expect(restored.documentChanges.map(\.document.documentID) == ["b"])
        #expect(restored.documentChanges.map(\.type) == [.added])
        registration.remove()
        await client.disconnect()
    }

    @Test("Before the first attach, an operation waits for the next scheduled attempt instead of starting one")
    func preAttachOperationWaitsForScheduledAttempt() async throws {
        let bridge = FakeReconnectBridge()
        bridge.refuseConnections = true
        let client = makeReconnectingClient(bridge, retryInitialConnection: true, retryDelay: 0.15)
        await #expect(throws: PyricBridgeError.self) {
            try await client.connect()
        }
        #expect(bridge.connectCalls == 1)

        let queued = Task { try await client.op(method: "getDoc", params: ["path": .string("rooms/a")]) }
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(bridge.connectCalls == 1)

        bridge.refuseConnections = false
        try await until { bridge.ops(named: "getDoc").count == 1 }
        #expect(bridge.connectCalls == 2)
        let sent = bridge.ops(named: "getDoc")[0]
        bridge.current.deliver(["type": "worker-res", "id": sent["id"]!.stringValue!, "ok": true, "value": NSNull()])
        _ = try await queued.value
        await client.disconnect()
    }

    @Test("An attempt that is not acknowledged within the attach timeout fails")
    func attachTimeoutFailsTheAttempt() async throws {
        let bridge = FakeReconnectBridge()
        bridge.autoAck = false
        let client = makeReconnectingClient(bridge, attachTimeout: 0.05)
        do {
            try await client.connect()
            Issue.record("expected a timeout")
        } catch let error as PyricBridgeError {
            #expect(error.code == .unavailable)
            #expect(error.message.contains("Timed out"))
        }
        await client.disconnect()
    }

    // ── Heartbeat (ADR-0019, heartbeat amendment) ──

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
