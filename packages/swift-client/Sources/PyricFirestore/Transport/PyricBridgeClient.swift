import Foundation

/// Internal container for an in-flight worker operation.
private struct PendingOp: Sendable {
    let continuation: CheckedContinuation<AnySendable, Error>
    let timeoutTask: Task<Void, Never>
}

/// A live subscription and what it needs to be restored after a drop.
private struct ActiveSub {
    let continuation: AsyncThrowingStream<BridgeSubscriptionEvent, Error>.Continuation
    let payload: [String: AnySendable]
    let includeMetadataChanges: Bool
    var lastValue: AnySendable?
    var awaitsRestoredValue = false
}

/// The bridge client's transport state.
///
/// `interrupted` covers every reconnect attempt after a drop. `closed` means no
/// reconnect is scheduled.
public enum BridgeConnectionState: Sendable, Equatable {
    case connecting
    case attached
    case interrupted
    case closed
}

/// Sends one worker operation on the connection being restored.
public typealias BridgeRestoreOperation = @Sendable (_ method: String, _ params: [String: AnySendable]) async throws -> AnySendable

/// Re-establishes the session's Auth user on a replaced bridge host.
public typealias BridgeAuthRestorer = @Sendable (_ op: BridgeRestoreOperation) async throws -> Void

/// The wait in seconds before reconnect attempt `attempt` (0-based): 250 ms
/// doubling to a 5 s cap, plus up to 250 ms of jitter, never above 5 s.
public func bridgeReconnectDelay(attempt: Int, random: Double = Double.random(in: 0..<1)) -> TimeInterval {
    let exponent = min(max(attempt, 0), 10)
    let base = min(5000.0, 250.0 * Double(1 << exponent))
    let jitter = random * min(250.0, base / 10.0)
    return min(5000.0, base + jitter).rounded(.down) / 1000.0
}

private let connectionLostMessage =
    "The bridge connection was lost. Requests already sent may have completed; check state before retrying."
private let policyCloseCode = 1008

/// Pure-Swift WebSocket transport connecting to the Pyric local sandbox bridge.
///
/// After the first attach, a dropped socket is reopened with bounded backoff.
/// The client re-attaches with its `clientSessionId` and re-sends every live
/// subscription. Operations in flight at the drop fail once with
/// `unavailable` and are never re-sent. A client built on one supplied channel
/// cannot reopen it, so a drop fails its operations and subscriptions instead.
public actor PyricBridgeClient {
    public let endpoint: URL
    public let headers: [String: String]
    public let defaultOpTimeout: TimeInterval
    /// Retry the first connection on the reconnect schedule instead of failing.
    public let retryInitialConnection: Bool

    private var transport: (any WebSocketTransport)?
    private let fixedTransport: (any WebSocketTransport)?
    private let transportFactory: (@Sendable (URLRequest) async throws -> any WebSocketTransport)?
    private let reconnectDelay: @Sendable (Int) -> TimeInterval

    public private(set) var isConnected: Bool = false
    public private(set) var isDisposed: Bool = false
    public private(set) var connectionState: BridgeConnectionState = .connecting
    /// The client session ID acknowledged by the bridge.
    public private(set) var clientSessionId: String?

    private var hostInstanceId: String?
    private var hasEverAttached = false
    private var connectionGeneration = 0
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var authRestorer: BridgeAuthRestorer?

    private var opCounter: Int = 0
    private var subCounter: Int = 0

    private var connectTask: Task<Void, Error>?
    private var receiveTask: Task<Void, Never>?
    private var handshakeContinuation: CheckedContinuation<Bool, Error>?

    private let denialLock = NSLock()
    nonisolated(unsafe) private var _onDenial: (@Sendable (PyricBridgeError) -> Void)?

    /// Instance-scoped callback invoked whenever a Security Rules denial is intercepted.
    public nonisolated var onDenial: (@Sendable (PyricBridgeError) -> Void)? {
        get {
            denialLock.lock()
            defer { denialLock.unlock() }
            return _onDenial
        }
        set {
            denialLock.lock()
            defer { denialLock.unlock() }
            _onDenial = newValue
        }
    }
    private var remoteLensContinuations: [UUID: AsyncStream<AuthLens>.Continuation] = [:]
    private var denialContinuations: [UUID: AsyncStream<PyricBridgeError>.Continuation] = [:]
    private var stateContinuations: [UUID: AsyncStream<BridgeConnectionState>.Continuation] = [:]

    private var pendingOps: [String: PendingOp] = [:]
    private var activeSubs: [String: ActiveSub] = [:]

    public init(
        endpoint: URL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
        headers: [String: String] = ["Host": "127.0.0.1:5174"],
        defaultOpTimeout: TimeInterval = 35.0,
        retryInitialConnection: Bool = false,
        reconnectDelay: (@Sendable (Int) -> TimeInterval)? = nil,
        transportFactory: (@Sendable (URLRequest) async throws -> any WebSocketTransport)? = nil
    ) {
        self.endpoint = endpoint
        self.headers = headers
        self.defaultOpTimeout = defaultOpTimeout
        self.retryInitialConnection = retryInitialConnection
        self.reconnectDelay = reconnectDelay ?? { bridgeReconnectDelay(attempt: $0) }
        self.transportFactory = transportFactory
        self.fixedTransport = nil
    }

    public init(
        channel: any WebSocketTransport,
        endpoint: URL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
        headers: [String: String] = ["Host": "127.0.0.1:5174"],
        defaultOpTimeout: TimeInterval = 35.0
    ) {
        self.endpoint = endpoint
        self.headers = headers
        self.defaultOpTimeout = defaultOpTimeout
        self.retryInitialConnection = false
        self.reconnectDelay = { bridgeReconnectDelay(attempt: $0) }
        self.transport = channel
        self.fixedTransport = channel
        self.transportFactory = nil
    }

    /// Constructs a URLRequest populating the Host header for DNS-rebinding protection.
    public static func makeWebSocketRequest(url: URL, headers: [String: String] = [:]) -> URLRequest {
        var request = URLRequest(url: url)
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if request.value(forHTTPHeaderField: "Host") == nil {
            let hostStr = (url.port != nil) ? "\(url.host ?? "127.0.0.1"):\(url.port!)" : (url.host ?? "127.0.0.1:5174")
            request.setValue(hostStr, forHTTPHeaderField: "Host")
        }
        return request
    }

    /// Runs on a re-attach to a replaced host, before subscriptions are re-sent.
    public func setAuthRestorer(_ restorer: BridgeAuthRestorer?) {
        authRestorer = restorer
    }

    /// Transport state changes, starting with the current state.
    public nonisolated var connectionStates: AsyncStream<BridgeConnectionState> {
        AsyncStream { continuation in
            let id = UUID()
            Task { [weak self] in
                await self?.registerStateContinuation(id: id, continuation: continuation)
            }
            continuation.onTermination = { [weak self] _ in
                Task { [weak self] in
                    await self?.unregisterStateContinuation(id: id)
                }
            }
        }
    }

    private func registerStateContinuation(id: UUID, continuation: AsyncStream<BridgeConnectionState>.Continuation) {
        stateContinuations[id] = continuation
        continuation.yield(connectionState)
    }

    private func unregisterStateContinuation(id: UUID) {
        stateContinuations.removeValue(forKey: id)
    }

    private func setState(_ next: BridgeConnectionState) {
        guard connectionState != next else { return }
        connectionState = next
        for continuation in stateContinuations.values { continuation.yield(next) }
    }

    private var canReopen: Bool { fixedTransport == nil }

    // ─── Connection Lifecycle ────────────────────────────────────────────────

    /// Establishes the WebSocket connection and completes the attach / attach-ack handshake.
    /// While the connection is interrupted, starts the next attempt at once.
    public func connect() async throws {
        if isConnected { return }
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if let existing = connectTask {
            return try await existing.value
        }
        reconnectTask?.cancel()
        reconnectTask = nil
        try await startAttempt().value
    }

    private func startAttempt() -> Task<Void, Error> {
        connectionGeneration += 1
        let generation = connectionGeneration
        if !hasEverAttached { setState(.connecting) }
        let task = Task { [weak self] in
            guard let self else { throw PyricBridgeError.unavailable("Client was deallocated.") }
            try await self.runAttempt(generation: generation)
        }
        connectTask = task
        return task
    }

    private func isCurrent(_ generation: Int) -> Bool {
        generation == connectionGeneration && !isDisposed
    }

    private func runAttempt(generation: Int) async throws {
        do {
            let changedHost = try await openAndAttach(generation: generation)
            if changedHost, let restorer = authRestorer {
                do {
                    try await restorer { [weak self] method, params in
                        guard let self else { throw PyricBridgeError.unavailable("Client was deallocated.") }
                        return try await self.dispatchOp(method: method, params: params, actAs: nil, timeout: nil)
                    }
                } catch {
                    // The Auth observers report the host's state when the restore fails.
                }
                guard isCurrent(generation) else {
                    throw PyricBridgeError.unavailable(connectionLostMessage)
                }
            }
            await finishAttach()
        } catch {
            let failure = (error as? PyricBridgeError)
                ?? PyricBridgeError.unavailable("Failed to connect to Pyric bridge: \(error)")
            if isCurrent(generation) {
                handleConnectionLoss(generation: generation, error: failure, closeCode: nil)
            }
            throw failure
        }
    }

    /// Opens a transport, sends `attach`, and returns whether the host changed.
    private func openAndAttach(generation: Int) async throws -> Bool {
        let request = Self.makeWebSocketRequest(url: endpoint, headers: headers)
        let opened: any WebSocketTransport
        if let fixedTransport {
            opened = fixedTransport
        } else if let factory = transportFactory {
            opened = try await factory(request)
        } else {
            opened = URLSessionWebSocketTransport(request: request)
        }
        guard isCurrent(generation) else {
            if fixedTransport == nil { await opened.close(closeCode: 1000, reason: "Superseded") }
            throw PyricBridgeError.unavailable(connectionLostMessage)
        }
        transport = opened
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(generation: generation, transport: opened)
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.handshakeContinuation = continuation
            let attachFrame = AttachFrame(clientSessionId: clientSessionId)
            Task {
                do {
                    try await self.sendRaw(attachFrame)
                } catch {
                    self.handleConnectionLoss(
                        generation: generation,
                        error: PyricBridgeError.unavailable("Failed to send attach frame: \(error)"),
                        closeCode: nil
                    )
                }
            }
        }
    }

    private func finishAttach() async {
        connectTask = nil
        hasEverAttached = true
        reconnectAttempt = 0
        let restored = activeSubs
        for (subId, var sub) in restored {
            sub.awaitsRestoredValue = sub.lastValue != nil
            activeSubs[subId] = sub
        }
        isConnected = true
        setState(.attached)
        for (subId, sub) in restored.sorted(by: { $0.key < $1.key }) {
            try? await sendRaw(WorkerSubFrame(subId: subId, sub: sub.payload))
        }
    }

    private func resumeHandshake(returning result: Result<Bool, Error>) {
        guard let continuation = handshakeContinuation else { return }
        handshakeContinuation = nil
        switch result {
        case .success(let changedHost):
            continuation.resume(returning: changedHost)
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }

    private func handleConnectionLoss(generation: Int, error: PyricBridgeError, closeCode: Int?) {
        guard isCurrent(generation) else { return }
        let permitsRetry = canReopen
            && (hasEverAttached || retryInitialConnection)
            && closeCode != policyCloseCode
        connectionGeneration += 1
        connectTask = nil
        isConnected = false
        receiveTask?.cancel()
        receiveTask = nil
        let closing = transport
        if canReopen { transport = nil }
        resumeHandshake(returning: .failure(error))

        guard permitsRetry else {
            setState(.closed)
            failPendingOperations(code: error.code, message: error.message)
            failSubscriptions(code: error.code, message: error.message)
            return
        }

        let wasAttached = connectionState == .attached
        setState(.interrupted)
        failPendingOperations(code: .unavailable, message: connectionLostMessage)
        if wasAttached { reportGap() }
        if let closing {
            Task { await closing.close(closeCode: 1000, reason: "Reconnecting") }
        }

        let delay = reconnectDelay(reconnectAttempt)
        reconnectAttempt += 1
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
            guard !Task.isCancelled else { return }
            await self?.reconnectTimerFired()
        }
    }

    private func reconnectTimerFired() {
        reconnectTask = nil
        guard !isDisposed, connectTask == nil, !isConnected else { return }
        let attempt = startAttempt()
        Task { _ = try? await attempt.value }
    }

    private func reportGap() {
        for sub in activeSubs.values where sub.includeMetadataChanges && sub.lastValue != nil {
            sub.continuation.yield(.gap)
        }
    }

    // ─── One-Shot RPC Operations ─────────────────────────────────────────────

    /// Dispatches a one-shot worker operation and awaits the correlated result.
    public func op(
        method: String,
        params: [String: AnySendable] = [:],
        actAs: AuthLens? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> AnySendable {
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if !isConnected {
            if hasEverAttached && canReopen {
                throw PyricBridgeError.unavailable(connectionLostMessage)
            }
            try await connect()
        }
        try ensureConnected()
        return try await dispatchOp(method: method, params: params, actAs: actAs, timeout: timeout)
    }

    private func dispatchOp(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens?,
        timeout: TimeInterval?
    ) async throws -> AnySendable {
        opCounter += 1
        let id = "rop-\(opCounter)"
        let opTimeout = timeout ?? defaultOpTimeout

        var opPayload = params
        opPayload["method"] = .string(method)
        if let actAs {
            opPayload["actAs"] = actAs.toAnySendable()
        }

        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(opTimeout * 1_000_000_000))
                if !Task.isCancelled {
                    await self?.handleOpTimeout(id: id, timeout: opTimeout, method: method)
                }
            }

            self.pendingOps[id] = PendingOp(continuation: continuation, timeoutTask: timeoutTask)

            Task {
                do {
                    let frame = WorkerOpFrame(id: id, op: opPayload)
                    try await self.sendRaw(frame)
                } catch {
                    self.failDispatch(id: id, error: error)
                }
            }
        }
    }

    private func failDispatch(id: String, error: Error) {
        guard let pending = pendingOps.removeValue(forKey: id) else { return }
        pending.timeoutTask.cancel()
        pending.continuation.resume(
            throwing: PyricBridgeError.unavailable("Failed to dispatch op to bridge: \(error)")
        )
    }

    private func handleOpTimeout(id: String, timeout: TimeInterval, method: String) {
        guard let pending = pendingOps.removeValue(forKey: id) else { return }
        pending.continuation.resume(
            throwing: PyricBridgeError.deadlineExceeded(
                "Remote sandbox op timed out after \(Int(timeout * 1000))ms (op: \(method)). Is pyric sandbox still running?"
            )
        )
    }

    /// Lists all sandbox users via the auth.listUsers RPC.
    public func authListUsers() async throws -> [AnySendable] {
        let res = try await op(method: "auth.listUsers", params: [:])
        return res.arrayValue ?? []
    }

    /// Exposes pushed remote lens changes from desktop Pyric Studio.
    public nonisolated var remoteLensStream: AsyncStream<AuthLens> {
        AsyncStream { continuation in
            let id = UUID()
            Task { [weak self] in
                await self?.registerRemoteLensContinuation(id: id, continuation: continuation)
            }
            continuation.onTermination = { [weak self] _ in
                Task { [weak self] in
                    await self?.unregisterRemoteLensContinuation(id: id)
                }
            }
        }
    }

    private func registerRemoteLensContinuation(id: UUID, continuation: AsyncStream<AuthLens>.Continuation) {
        remoteLensContinuations[id] = continuation
    }

    private func unregisterRemoteLensContinuation(id: UUID) {
        remoteLensContinuations.removeValue(forKey: id)
    }

    /// Exposes Security Rules denial errors intercepted from bridge responses and snapshots.
    public nonisolated var denialStream: AsyncStream<PyricBridgeError> {
        AsyncStream { continuation in
            let id = UUID()
            Task { [weak self] in
                await self?.registerDenialContinuation(id: id, continuation: continuation)
            }
            continuation.onTermination = { [weak self] _ in
                Task { [weak self] in
                    await self?.unregisterDenialContinuation(id: id)
                }
            }
        }
    }

    private func registerDenialContinuation(id: UUID, continuation: AsyncStream<PyricBridgeError>.Continuation) {
        denialContinuations[id] = continuation
    }

    private func unregisterDenialContinuation(id: UUID) {
        denialContinuations.removeValue(forKey: id)
    }

    // ─── Streaming Subscriptions ─────────────────────────────────────────────

    /// Establishes a real-time subscription for a document or query target.
    public nonisolated func subscribe(
        target: AnySendable,
        actAs: AnySendable? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) -> PyricSubscriptionStream {
        PyricSubscriptionStream(
            client: self,
            target: target,
            actAs: actAs,
            includeMetadataChanges: includeMetadataChanges,
            listenSource: listenSource
        )
    }

    public nonisolated func subscribe(
        target: TargetDescriptor,
        actAs: AuthLens? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) -> PyricSubscriptionStream {
        subscribe(target: target.toAnySendable(), actAs: actAs?.toAnySendable(), includeMetadataChanges: includeMetadataChanges, listenSource: listenSource)
    }

    public nonisolated func subscribe(
        target: [String: Any],
        actAs: AnySendable? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) -> PyricSubscriptionStream {
        subscribe(target: AnySendable.from(target), actAs: actAs, includeMetadataChanges: includeMetadataChanges, listenSource: listenSource)
    }

    /// Explicitly unregisters an active subscription and dispatches a worker-unsub frame.
    public func unsubscribe(subId: String) async {
        await unregisterSubscription(subId: subId)
    }

    func registerSubscription(
        target: AnySendable,
        actAs: AnySendable?,
        includeMetadataChanges: Bool,
        listenSource: String?,
        continuation: AsyncThrowingStream<BridgeSubscriptionEvent, Error>.Continuation
    ) async throws -> String {
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }

        subCounter += 1
        let subId = "rsub-\(subCounter)"

        var subPayload: [String: AnySendable] = [
            "target": target
        ]
        if let actAs {
            subPayload["actAs"] = actAs
        }
        if includeMetadataChanges {
            subPayload["includeMetadataChanges"] = .bool(true)
        }
        if let listenSource, listenSource != "defaultSource" {
            subPayload["listenSource"] = .string(listenSource)
        }
        activeSubs[subId] = ActiveSub(
            continuation: continuation,
            payload: subPayload,
            includeMetadataChanges: includeMetadataChanges
        )

        if isConnected {
            try await sendRaw(WorkerSubFrame(subId: subId, sub: subPayload))
            return subId
        }
        // Not attached: the next attach sends this subscription.
        if hasEverAttached && canReopen {
            return subId
        }
        if retryInitialConnection {
            Task { [weak self] in try? await self?.connect() }
            return subId
        }
        do {
            try await connect()
        } catch {
            activeSubs.removeValue(forKey: subId)
            throw error
        }
        return subId
    }

    func unregisterSubscription(subId: String) async {
        guard activeSubs.removeValue(forKey: subId) != nil else { return }
        if isConnected && !isDisposed {
            try? await sendRaw(WorkerUnsubFrame(subId: subId))
        }
    }

    // ─── Incoming Message Processing & Event Loop ───────────────────────────

    private func receiveLoop(generation: Int, transport: any WebSocketTransport) async {
        while !Task.isCancelled && isCurrent(generation) {
            do {
                let rawText = try await transport.receive()
                guard isCurrent(generation) else { break }
                handleMessage(rawText, generation: generation)
            } catch {
                handleConnectionLoss(
                    generation: generation,
                    error: PyricBridgeError.unavailable("WebSocket connection error: \(error)"),
                    closeCode: (error as? WebSocketCloseError)?.closeCode
                )
                break
            }
        }
    }

    private func handleMessage(_ raw: String, generation: Int) {
        guard let data = raw.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = json["type"]?.stringValue else {
            return
        }

        switch type {
        case "attach-ack":
            handleAttachAck(json, generation: generation)
        case "worker-res":
            handleWorkerRes(json)
        case "worker-snap":
            handleWorkerSnap(json)
        case "worker-event":
            handleWorkerEvent(json)
        case "ping":
            handlePing(json)
        case "pong":
            break
        default:
            break
        }
    }

    private func handleWorkerEvent(_ msg: AnySendable) {
        guard let event = msg["event"]?.stringValue, event == "remote-lens" else { return }
        let lensData = msg["lens"] ?? msg["payload"]?["lens"] ?? msg["payload"]
        guard let lensData, let mode = lensData["mode"]?.stringValue else { return }

        let lens: AuthLens
        switch mode {
        case "admin":
            lens = .admin
        case "anon":
            lens = .anon
        case "app-session":
            lens = .appSession
        case "as":
            let uid = lensData["uid"]?.stringValue ?? ""
            let tenant = lensData["tenant"]?.stringValue
            let token = lensData["token"]?.dictionaryValue
            lens = .asUser(uid: uid, tenant: tenant, token: token)
        default:
            return
        }

        for cont in remoteLensContinuations.values {
            cont.yield(lens)
        }
    }

    private func handleAttachAck(_ msg: AnySendable, generation: Int) {
        guard handshakeContinuation != nil else { return }
        let peerConnected = msg["peerConnected"]?.boolValue ?? false
        guard peerConnected else {
            handleConnectionLoss(
                generation: generation,
                error: PyricBridgeError.unavailable(
                    "No browser tab is connected to the sandbox; open pyric sandbox in a browser and retry."
                ),
                closeCode: nil
            )
            return
        }
        if let ackSessionId = msg["clientSessionId"]?.stringValue ?? msg["sessionId"]?.stringValue {
            clientSessionId = ackSessionId
        }
        let ackHostId = msg["hostInstanceId"]?.stringValue
        let changedHost = hasEverAttached && hostInstanceId != nil && ackHostId != nil && ackHostId != hostInstanceId
        if let ackHostId { hostInstanceId = ackHostId }
        resumeHandshake(returning: .success(changedHost))
    }

    private func handleWorkerRes(_ msg: AnySendable) {
        guard let id = msg["id"]?.stringValue,
              let pending = pendingOps.removeValue(forKey: id) else {
            return
        }
        pending.timeoutTask.cancel()

        let ok = msg["ok"]?.boolValue ?? false
        if ok {
            let result = msg["value"] ?? msg["res"] ?? .null
            pending.continuation.resume(returning: result)
        } else {
            let errorObj = msg["error"] ?? msg["err"]
            let code = errorObj?["code"]?.stringValue ?? "unknown"
            let message = errorObj?["message"]?.stringValue ?? "unknown sandbox error"
            let denialContext = errorObj?["denialContext"]
            let envelope = errorObj?["envelope"]

            let error = PyricBridgeError.fromCode(
                code: code,
                message: message,
                denialContext: denialContext,
                envelope: envelope
            )
            if denialContext != nil || error.code == .permissionDenied {
                for cont in denialContinuations.values {
                    cont.yield(error)
                }
                onDenial?(error)
            }
            pending.continuation.resume(throwing: error)
        }
    }

    private func handleWorkerSnap(_ msg: AnySendable) {
        guard let subId = msg["subId"]?.stringValue,
              var sub = activeSubs[subId],
              let value = msg["value"] ?? msg["res"] else {
            return
        }

        // Terminal snapshot error check
        let errObj = value["__error"] ?? msg["error"] ?? msg["err"]
        if let errObj {
            activeSubs.removeValue(forKey: subId)
            if isConnected && !isDisposed {
                Task { [weak self] in
                    try? await self?.sendRaw(WorkerUnsubFrame(subId: subId))
                }
            }
            let code = errObj["code"]?.stringValue ?? "permission-denied"
            let message = errObj["message"]?.stringValue ?? "Subscription error"
            let denialContext = errObj["denialContext"]

            let error = PyricBridgeError.fromCode(
                code: code,
                message: message,
                denialContext: denialContext
            )
            if denialContext != nil || error.code == .permissionDenied {
                for cont in denialContinuations.values {
                    cont.yield(error)
                }
                onDenial?(error)
            }
            sub.continuation.finish(throwing: error)
            return
        }

        if sub.awaitsRestoredValue {
            sub.awaitsRestoredValue = false
            let unchanged = sub.lastValue == value
            // Production raises a sync-state-only change only to metadata listeners.
            if unchanged && !sub.includeMetadataChanges {
                activeSubs[subId] = sub
                return
            }
        }
        sub.lastValue = value
        activeSubs[subId] = sub
        sub.continuation.yield(.value(value))
    }

    private func handlePing(_ msg: AnySendable) {
        guard let id = msg["id"]?.stringValue else { return }
        Task { [weak self] in
            try? await self?.sendRaw(PongFrame(id: id))
        }
    }

    private func failPendingOperations(code: FirestoreErrorCode, message: String) {
        let pending = pendingOps
        pendingOps.removeAll()
        for (_, op) in pending {
            op.timeoutTask.cancel()
            op.continuation.resume(
                throwing: PyricBridgeError(code: code, message: message)
            )
        }
    }

    private func failSubscriptions(code: FirestoreErrorCode, message: String) {
        let subs = activeSubs
        activeSubs.removeAll()
        for (_, sub) in subs {
            sub.continuation.finish(throwing: PyricBridgeError(code: code, message: message))
        }
    }

    private func sendRaw<T: Encodable>(_ message: T) async throws {
        guard let transport, !isDisposed else {
            throw PyricBridgeError.unavailable("Cannot send message: WebSocket is closed.")
        }
        let data = try JSONEncoder().encode(message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw PyricBridgeError.internalError("Failed to encode frame to UTF-8")
        }
        try await transport.send(text)
    }

    private func ensureConnected() throws {
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if !isConnected {
            throw PyricBridgeError.unavailable("PyricBridgeClient is not connected. Call connect() first.")
        }
    }

    // ─── Teardown ────────────────────────────────────────────────────────────

    /// Closes the connection and cancels all outstanding operations and subscriptions.
    public func disconnect() async {
        isDisposed = true
        isConnected = false
        connectionGeneration += 1
        connectTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        authRestorer = nil
        setState(.closed)

        failPendingOperations(code: .unavailable, message: "PyricBridgeClient disconnected.")
        failSubscriptions(code: .unavailable, message: "PyricBridgeClient disconnected.")
        resumeHandshake(returning: .failure(PyricBridgeError.unavailable("PyricBridgeClient disconnected.")))

        for cont in remoteLensContinuations.values { cont.finish() }
        remoteLensContinuations.removeAll()
        for cont in denialContinuations.values { cont.finish() }
        denialContinuations.removeAll()
        for cont in stateContinuations.values { cont.finish() }
        stateContinuations.removeAll()
        onDenial = nil

        receiveTask?.cancel()
        receiveTask = nil

        let closing = transport
        transport = nil
        await closing?.close(closeCode: 1000, reason: "Client disconnect")
    }
}

/// Thrown by a transport's `receive()` when the peer closed the socket with a code.
public struct WebSocketCloseError: Error, Sendable {
    public let closeCode: Int
    public let reason: String?

    public init(closeCode: Int, reason: String? = nil) {
        self.closeCode = closeCode
        self.reason = reason
    }
}
