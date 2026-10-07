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

    init(onFrame: @escaping @Sendable ([String: AnySendable], FakeReconnectSocket) -> Void) {
        self.onFrame = onFrame
    }

    var isOpen: Bool {
        lock.lock(); defer { lock.unlock() }
        return open
    }

    func send(_ string: String) async throws {
        guard isOpen else { throw PyricBridgeError.unavailable("socket closed") }
        guard let data = string.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AnySendable.self, from: data),
              let dict = frame.dictionaryValue else { return }
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
        let socket = FakeReconnectSocket { [weak self] frame, socket in
            self?.record(frame, from: socket)
        }
        append(socket)
        return socket
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

    @Test("An operation issued while the connection is interrupted fails at once with unavailable")
    func operationWhileInterruptedFails() async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        bridge.refuseConnections = true
        bridge.current.drop()
        try await until { await client.connectionState == .interrupted }

        await #expect(throws: PyricBridgeError.self) {
            _ = try await client.op(method: "getDoc", params: ["path": .string("rooms/a")])
        }
        #expect(bridge.ofType("worker-op").isEmpty)
        await client.disconnect()
    }

    @Test("The first connection retries when asked to; an operation issued during a failed attempt fails once")
    func firstConnectionRetries() async throws {
        let bridge = FakeReconnectBridge()
        bridge.refuseConnections = true
        let client = makeReconnectingClient(bridge, retryInitialConnection: true)
        let values = Collected<AnySendable>()
        let task = collect(client.subscribe(target: ["__ref": "doc", "path": "rooms/a"]), into: values)

        await #expect(throws: PyricBridgeError.self) {
            _ = try await client.op(method: "setDoc", params: ["path": .string("rooms/a")])
        }
        #expect(await client.isDisposed == false)

        bridge.refuseConnections = false
        try await until { await client.isConnected }
        #expect(bridge.ofType("worker-op").isEmpty)
        try await until { bridge.subs(forPath: "rooms/a").count == 1 }
        let subId = bridge.subs(forPath: "rooms/a")[0]["subId"]!.stringValue!
        bridge.current.deliver(["type": "worker-snap", "subId": subId, "value": ["path": "rooms/a", "exists": false]])
        try await until { values.count == 1 }
        task.cancel()
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
}
