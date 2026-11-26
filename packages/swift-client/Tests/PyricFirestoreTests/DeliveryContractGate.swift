import Foundation
import Testing
@testable import PyricFirestore

/// Deterministic continuation-backed signal for gate-based tests (ADR-0019 T1).
final class SignalGate: @unchecked Sendable {
    private let lock = NSLock()
    private var signaled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func signal() {
        lock.lock()
        guard !signaled else {
            lock.unlock()
            return
        }
        signaled = true
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending {
            waiter.resume()
        }
    }

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if signaled {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }
}

/// Deterministic continuation-backed counter gate (zero sleeps or polling).
final class CountGate: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0
    private var waiters: [(target: Int, continuation: CheckedContinuation<Void, Never>)] = []

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return _count
    }

    func increment() {
        lock.lock()
        _count += 1
        let current = _count
        var ready: [CheckedContinuation<Void, Never>] = []
        waiters.removeAll { entry in
            if current >= entry.target {
                ready.append(entry.continuation)
                return true
            }
            return false
        }
        lock.unlock()
        for continuation in ready {
            continuation.resume()
        }
    }

    func wait(atLeast target: Int) async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if _count >= target {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append((target: target, continuation: continuation))
            lock.unlock()
        }
    }
}

/// Thread-safe value recorder paired with a deterministic `CountGate`.
final class GatedBox<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    private let gate = CountGate()

    func append(_ item: T) {
        lock.lock()
        items.append(item)
        lock.unlock()
        gate.increment()
    }

    var all: [T] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    var count: Int {
        gate.count
    }

    func wait(atLeast target: Int) async {
        await gate.wait(atLeast: target)
    }
}

/// Event-driven wrapper around `FakeReconnectSocket` supporting deterministic
/// frame arrival gates and per-frame write suspension without polling loops.
final class GatedBridge: @unchecked Sendable {
    private struct FrameWaiter {
        let predicate: @Sendable ([[String: AnySendable]], [Int: [[String: AnySendable]]]) -> Bool
        let continuation: CheckedContinuation<Void, Never>
    }

    private struct SuspendRule {
        let socketNumber: Int
        let predicate: @Sendable ([String: AnySendable]) -> Bool
        let entered: SignalGate
        let release: SignalGate
    }

    private let lock = NSLock()
    private var _frames: [[String: AnySendable]] = []
    private var _socketFrames: [Int: [[String: AnySendable]]] = [:]
    private var _sockets: [FakeReconnectSocket] = []
    private var _hostInstanceId = "host-a"
    private var _refuseConnections = false
    private var _autoAck = true
    private var _connectCalls = 0
    private var frameWaiters: [FrameWaiter] = []
    private var socketCountGate = CountGate()
    private var suspendRule: SuspendRule?

    var hostInstanceId: String {
        get { lock.lock(); defer { lock.unlock() }; return _hostInstanceId }
        set { lock.lock(); _hostInstanceId = newValue; lock.unlock() }
    }

    var refuseConnections: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _refuseConnections }
        set { lock.lock(); _refuseConnections = newValue; lock.unlock() }
    }

    var autoAck: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _autoAck }
        set { lock.lock(); _autoAck = newValue; lock.unlock() }
    }

    var connectCalls: Int {
        lock.lock(); defer { lock.unlock() }; return _connectCalls
    }

    var socketCount: Int {
        lock.lock(); defer { lock.unlock() }; return _sockets.count
    }

    var current: FakeReconnectSocket {
        lock.lock(); defer { lock.unlock() }; return _sockets.last!
    }

    var frames: [[String: AnySendable]] {
        lock.lock(); defer { lock.unlock() }; return _frames
    }

    func frames(onSocket number: Int) -> [[String: AnySendable]] {
        lock.lock()
        defer { lock.unlock() }
        return _socketFrames[number] ?? []
    }

    /// Suspends sending the next matching frame on 1-based `socketNumber`.
    func suspendNextFrame(
        onSocket socketNumber: Int,
        matching predicate: @escaping @Sendable ([String: AnySendable]) -> Bool
    ) -> (entered: SignalGate, release: SignalGate) {
        let entered = SignalGate()
        let release = SignalGate()
        lock.lock()
        suspendRule = SuspendRule(
            socketNumber: socketNumber,
            predicate: predicate,
            entered: entered,
            release: release
        )
        lock.unlock()
        return (entered, release)
    }

    private func beginConnect() -> (refused: Bool, socketNumber: Int) {
        lock.lock()
        defer { lock.unlock() }
        _connectCalls += 1
        return (_refuseConnections, _sockets.count + 1)
    }

    private func appendSocket(_ socket: FakeReconnectSocket, number: Int) {
        lock.lock()
        _sockets.append(socket)
        _socketFrames[number] = []
        lock.unlock()
    }

    func connect(_ request: URLRequest) async throws -> any WebSocketTransport {
        let (refused, socketNumber) = beginConnect()
        if refused {
            throw PyricBridgeError.unavailable("connection refused")
        }
        let socket = FakeReconnectSocket(
            beforeSend: { [weak self] frame in
                await self?.maybeSuspend(socketNumber: socketNumber, frame: frame)
            },
            onFrame: { [weak self] frame, socket in
                self?.record(frame, socketNumber: socketNumber, from: socket)
            }
        )
        appendSocket(socket, number: socketNumber)
        socketCountGate.increment()
        return socket
    }

    func waitForSockets(atLeast target: Int) async {
        await socketCountGate.wait(atLeast: target)
    }

    func waitForFrames(_ predicate: @escaping @Sendable ([[String: AnySendable]]) -> Bool) async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if predicate(_frames) {
                lock.unlock()
                continuation.resume()
                return
            }
            frameWaiters.append(FrameWaiter(predicate: { all, _ in predicate(all) }, continuation: continuation))
            lock.unlock()
        }
    }

    func waitForSubs(onSocket socketNumber: Int, count: Int) async {
        await withCheckedContinuation { continuation in
            let check: @Sendable ([[String: AnySendable]], [Int: [[String: AnySendable]]]) -> Bool = { _, bySocket in
                (bySocket[socketNumber] ?? []).filter { $0["type"]?.stringValue == "worker-sub" }.count >= count
            }
            lock.lock()
            if check(_frames, _socketFrames) {
                lock.unlock()
                continuation.resume()
                return
            }
            frameWaiters.append(FrameWaiter(predicate: check, continuation: continuation))
            lock.unlock()
        }
    }

    func waitForSub(path: String, count: Int = 1) async {
        await waitForFrames { frames in
            frames.filter {
                $0["type"]?.stringValue == "worker-sub"
                    && $0["sub"]?["target"]?["path"]?.stringValue == path
            }.count >= count
        }
    }

    func waitForSub(target: String, count: Int = 1) async {
        await waitForFrames { frames in
            frames.filter {
                $0["type"]?.stringValue == "worker-sub"
                    && $0["sub"]?["target"]?.stringValue == target
            }.count >= count
        }
    }

    func waitForOp(method: String, path: String? = nil, count: Int = 1) async {
        await waitForFrames { frames in
            frames.filter { frame in
                guard frame["type"]?.stringValue == "worker-op",
                      frame["op"]?["method"]?.stringValue == method else {
                    return false
                }
                guard let path else { return true }
                return frame["op"]?["path"]?.stringValue == path
            }.count >= count
        }
    }

    func subs(onSocket socketNumber: Int) -> [[String: AnySendable]] {
        frames(onSocket: socketNumber).filter { $0["type"]?.stringValue == "worker-sub" }
    }

    func ops(named method: String) -> [[String: AnySendable]] {
        frames.filter {
            $0["type"]?.stringValue == "worker-op"
                && $0["op"]?["method"]?.stringValue == method
        }
    }

    func answer(_ frame: [String: AnySendable], value: Any = "done") {
        current.deliver(["type": "worker-res", "id": frame["id"]!.stringValue!, "ok": true, "value": value])
    }

    func makeClient(
        retryInitialConnection: Bool = false,
        retryDelay: TimeInterval = 0,
        attachTimeout: TimeInterval = 5
    ) -> PyricBridgeClient {
        PyricBridgeClient(
            retryInitialConnection: retryInitialConnection,
            reconnectDelay: { _ in retryDelay },
            attachTimeout: attachTimeout,
            transportFactory: { [weak self] request in
                guard let self else {
                    throw PyricBridgeError.unavailable("bridge deallocated")
                }
                return try await self.connect(request)
            }
        )
    }

    private func maybeSuspend(socketNumber: Int, frame: [String: AnySendable]) async {
        let matched: SuspendRule? = {
            lock.lock()
            defer { lock.unlock() }
            guard let rule = suspendRule,
                  rule.socketNumber == socketNumber,
                  rule.predicate(frame) else {
                return nil
            }
            suspendRule = nil
            return rule
        }()
        guard let matched else { return }
        matched.entered.signal()
        await matched.release.wait()
    }

    private func record(_ frame: [String: AnySendable], socketNumber: Int, from socket: FakeReconnectSocket) {
        var ready: [CheckedContinuation<Void, Never>] = []
        let host: String
        let acks: Bool
        lock.lock()
        _frames.append(frame)
        _socketFrames[socketNumber, default: []].append(frame)
        host = _hostInstanceId
        acks = _autoAck
        let snapshot = _frames
        let socketSnapshot = _socketFrames
        frameWaiters.removeAll { waiter in
            if waiter.predicate(snapshot, socketSnapshot) {
                ready.append(waiter.continuation)
                return true
            }
            return false
        }
        lock.unlock()

        for continuation in ready {
            continuation.resume()
        }
        guard frame["type"]?.stringValue == "attach", acks else { return }
        let sessionId = frame["clientSessionId"]?.stringValue ?? "session-1"
        socket.deliver([
            "type": "attach-ack",
            "protocol": 1,
            "peerConnected": true,
            "clientSessionId": sessionId,
            "hostInstanceId": host,
        ])
    }
}

/// Waits deterministically until `client.connectionStates` yields `target`.
func waitForState(_ client: PyricBridgeClient, _ target: BridgeConnectionState) async {
    let stream = client.connectionStates
    for await state in stream {
        if state == target {
            return
        }
    }
}

/// Interrupts `bridge` and waits deterministically for `.interrupted`.
func interruptGated(_ bridge: GatedBridge, _ client: PyricBridgeClient) async {
    let stream = client.connectionStates
    let reached = SignalGate()
    let watcher = Task {
        for await state in stream {
            if state == .interrupted {
                reached.signal()
                return
            }
        }
    }
    bridge.refuseConnections = true
    bridge.current.drop()
    await reached.wait()
    watcher.cancel()
}
