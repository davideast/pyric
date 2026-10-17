import Foundation

/// How far a pending operation's frame has got toward the socket.
private enum OpWrite: Sendable {
    /// Waiting in the send chain. The frame has not been handed to a socket.
    case queued
    case writing
    /// Still being written when its socket dropped. The write's result decides.
    case writingOnLostSocket
    case written
}

/// Internal container for a dispatched worker operation.
private struct PendingOp: Sendable {
    let continuation: CheckedContinuation<AnySendable, Error>
    let timeoutTask: Task<Void, Never>
    /// Its place in the order operations were admitted.
    let sequence: Int
    let issuedAt: ContinuousClock.Instant
    /// False for Auth restore traffic and on a client that cannot reopen its
    /// channel: those fail as before instead of being held.
    let holdable: Bool
    let method: String
    let payload: [String: AnySendable]
    let timeout: TimeInterval
    var write: OpWrite = .queued
}

/// The result of one attempt to write an operation frame.
private enum WriteOutcome {
    case written
    /// The transport did not take the frame, so it never left the device.
    case refused(Error)
    /// The frame may have reached the host.
    case failed(Error)
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
private let holdExpiredMessage =
    "The bridge connection was not restored within 10 seconds. The request was not sent."
private let authRestoreFailedMessage =
    "The bridge connection was restored, but the signed-in user could not be restored on the new host. The request was not sent."
private let silentHostMessage =
    "The bridge sent nothing for 45 seconds, so the connection was treated as lost."
private let policyCloseCode = 1008
private let defaultHoldDeadline: TimeInterval = 10
/// ADR-0019, heartbeat amendment: a ping at attach, then one every 15 seconds.
private let defaultHeartbeatInterval: TimeInterval = 15
/// ADR-0019, heartbeat amendment: 45 seconds with no frame of any kind is a drop.
private let defaultLivenessTimeout: TimeInterval = 45

/// Pure-Swift WebSocket transport connecting to the Pyric local sandbox bridge.
///
/// After the first attach, a dropped socket is reopened with bounded backoff.
/// The client re-attaches with its `clientSessionId` and re-sends every live
/// subscription. Operations in flight at the drop fail once with
/// `unavailable` and are never re-sent. An operation issued while the client
/// is not attached is held for up to 10 seconds and sent once after the next
/// attach's restore, or fails saying it was not sent. So is an operation whose
/// frame never left the device: one the transport refused, or one still
/// queued in the client at the drop. A client built on one
/// supplied channel cannot reopen it, so a drop fails its operations and
/// subscriptions instead.
///
/// While attached, the client sends a `ping` at once and then every 15
/// seconds. Before each one it checks how long the socket has been silent: 45
/// seconds with no frame of any kind is a drop (ADR-0019).
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
    /// Seconds an attempt may take to attach before it counts as failed.
    private let attachTimeout: TimeInterval
    /// Seconds an operation is held while the client is not attached (ADR-0019
    /// decision 7). Fixed at 10; only tests change it.
    private var holdDeadline: TimeInterval = defaultHoldDeadline
    /// Seconds between heartbeats. Fixed at 15; only tests change it.
    private var heartbeatInterval: TimeInterval = defaultHeartbeatInterval
    /// Seconds of silence that count as a drop. Fixed at 45; only tests change it.
    private var livenessTimeout: TimeInterval = defaultLivenessTimeout
    /// Measures silence. It keeps running while the device sleeps, so an app
    /// resumed after a suspension sees the whole gap on its first heartbeat.
    private let clock = ContinuousClock()
    /// When the current socket last delivered a frame.
    private var lastFrameAt: ContinuousClock.Instant = ContinuousClock().now
    private var heartbeatTask: Task<Void, Never>?
    private var pingCounter = 0

    public private(set) var isConnected: Bool = false
    public private(set) var isDisposed: Bool = false
    public private(set) var connectionState: BridgeConnectionState = .connecting
    /// The client session ID acknowledged by the bridge.
    public private(set) var clientSessionId: String?

    private var hostInstanceId: String?
    /// Set when an attach acknowledgement shows a replaced host. Cleared only when
    /// the Auth restore runs to its result on a current connection, so a drop
    /// during the restore leaves it set and the next attach to that host restores again.
    private var needsAuthRestore = false
    private var hasEverAttached = false
    private var connectionGeneration = 0
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var attachDeadlineTask: Task<Void, Never>?
    /// Callers waiting for the next scheduled attempt.
    private var nextAttemptWaiters: [CheckedContinuation<Void, Error>] = []
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
    /// Operations not handed to a socket, in admission order.
    private var heldOps = HeldOperationQueue()
    /// True from an attach until its held operations are all sent. A new
    /// operation issued meanwhile joins the end of the held queue, so every
    /// operation reaches the socket in issue order.
    private var drainingHeldOps = false
    /// True from the first refused operation frame until the socket's close.
    /// The socket is closing, so new operations are held instead of written.
    private var socketRefusing = false
    /// The socket write of the last operation frame dispatched. Each write
    /// waits for the one before it, never for a reply, so frames leave in
    /// dispatch order and operations still pipeline.
    private var lastOpWrite: Task<Void, Never>?
    private let turnCounter = OperationTurnCounter()
    /// The turn admitted next. Operations started with a turn wait for it.
    private var nextTurn = 0
    private var turnWaiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var activeSubs: [String: ActiveSub] = [:]

    public init(
        endpoint: URL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
        headers: [String: String] = ["Host": "127.0.0.1:5174"],
        defaultOpTimeout: TimeInterval = 35.0,
        retryInitialConnection: Bool = false,
        reconnectDelay: (@Sendable (Int) -> TimeInterval)? = nil,
        attachTimeout: TimeInterval = 5.0,
        transportFactory: (@Sendable (URLRequest) async throws -> any WebSocketTransport)? = nil
    ) {
        self.endpoint = endpoint
        self.headers = headers
        self.defaultOpTimeout = defaultOpTimeout
        self.retryInitialConnection = retryInitialConnection
        self.reconnectDelay = reconnectDelay ?? { bridgeReconnectDelay(attempt: $0) }
        self.attachTimeout = attachTimeout
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
        self.attachTimeout = 5.0
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

    /// Test-only: shortens the hold deadline, and `nil` restores it. The
    /// deadline is fixed at 10 seconds; this is not a user setting and is not public.
    func setHoldDeadlineForTesting(_ seconds: TimeInterval?) {
        holdDeadline = seconds ?? defaultHoldDeadline
    }

    /// Test-only: shortens the heartbeat interval and the liveness timeout, and
    /// `nil` restores them. They are fixed at 15 and 45 seconds; this is not a
    /// user setting and is not public. Set it before connecting.
    func setHeartbeatForTesting(interval: TimeInterval?, livenessTimeout timeout: TimeInterval?) {
        heartbeatInterval = interval ?? defaultHeartbeatInterval
        livenessTimeout = timeout ?? defaultLivenessTimeout
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
    /// Joins the attempt in progress or, while a retry is scheduled, the next
    /// scheduled attempt. Starts an attempt only when none is in progress or scheduled.
    public func connect() async throws {
        if isConnected { return }
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if let existing = connectTask {
            return try await existing.value
        }
        if reconnectTask != nil {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                nextAttemptWaiters.append(continuation)
            }
            return
        }
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
        let waiters = nextAttemptWaiters
        nextAttemptWaiters.removeAll()
        if !waiters.isEmpty {
            Task {
                do {
                    try await task.value
                    for waiter in waiters { waiter.resume() }
                } catch {
                    for waiter in waiters { waiter.resume(throwing: error) }
                }
            }
        }
        attachDeadlineTask?.cancel()
        let timeout = attachTimeout
        attachDeadlineTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.attachDeadlinePassed(generation: generation)
        }
        return task
    }

    private func failNextAttemptWaiters(_ error: Error) {
        let waiters = nextAttemptWaiters
        nextAttemptWaiters.removeAll()
        for waiter in waiters { waiter.resume(throwing: error) }
    }

    private func attachDeadlinePassed(generation: Int) {
        guard isCurrent(generation), !isConnected else { return }
        handleConnectionLoss(
            generation: generation,
            error: PyricBridgeError.unavailable("Timed out connecting to the Pyric bridge."),
            closeCode: nil
        )
    }

    private func isCurrent(_ generation: Int) -> Bool {
        generation == connectionGeneration && !isDisposed
    }

    private func runAttempt(generation: Int) async throws {
        do {
            let restoresAuth = try await openAndAttach(generation: generation)
            if restoresAuth, let restorer = authRestorer {
                var restoreFailed = false
                do {
                    try await restorer { [weak self] method, params in
                        guard let self else { throw PyricBridgeError.unavailable("Client was deallocated.") }
                        // Restore traffic is never held: a refusal fails the restore.
                        return try await self.dispatchOp(
                            method: method, params: params, actAs: nil, timeout: nil, turn: nil, holdable: false
                        )
                    }
                } catch {
                    // The Auth observers report the host's state when the restore fails.
                    restoreFailed = true
                }
                guard isCurrent(generation) else {
                    throw PyricBridgeError.unavailable(connectionLostMessage)
                }
                needsAuthRestore = false
                // A held operation must run as the user the app had when it issued it.
                if restoreFailed {
                    failHeldOperations(code: .unavailable, message: authRestoreFailedMessage)
                }
            }
            await finishAttach(generation: generation)
        } catch {
            let failure = (error as? PyricBridgeError)
                ?? PyricBridgeError.unavailable("Failed to connect to Pyric bridge: \(error)")
            if isCurrent(generation) {
                handleConnectionLoss(generation: generation, error: failure, closeCode: nil)
            }
            throw failure
        }
    }

    /// Opens a transport, sends `attach`, and returns whether Auth must be restored.
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

    private func finishAttach(generation: Int) async {
        attachDeadlineTask?.cancel()
        attachDeadlineTask = nil
        connectTask = nil
        hasEverAttached = true
        reconnectAttempt = 0
        let restored = activeSubs
        for (subId, var sub) in restored {
            sub.awaitsRestoredValue = sub.lastValue != nil
            activeSubs[subId] = sub
        }
        // New operations queue behind held ones until the held queue is drained.
        drainingHeldOps = true
        isConnected = true
        setState(.attached)
        startHeartbeat(generation: generation)
        for (subId, sub) in restored.sorted(by: { $0.key < $1.key }) {
            // A listener cancelled while an earlier frame was being sent is not re-sent.
            guard activeSubs[subId] != nil else { continue }
            try? await sendRaw(WorkerSubFrame(subId: subId, sub: sub.payload))
        }
        await sendHeldOperations(generation: generation)
    }

    private func resumeHandshake(returning result: Result<Bool, Error>) {
        guard let continuation = handshakeContinuation else { return }
        handshakeContinuation = nil
        switch result {
        case .success(let restoresAuth):
            continuation.resume(returning: restoresAuth)
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
        drainingHeldOps = false
        socketRefusing = false
        attachDeadlineTask?.cancel()
        attachDeadlineTask = nil
        stopHeartbeat()
        receiveTask?.cancel()
        receiveTask = nil
        let closing = transport
        if canReopen { transport = nil }
        resumeHandshake(returning: .failure(error))

        guard permitsRetry else {
            setState(.closed)
            failPendingOperations(code: error.code, message: error.message)
            failHeldOperations(code: error.code, message: error.message)
            failSubscriptions(code: error.code, message: error.message)
            failNextAttemptWaiters(error)
            return
        }

        let wasAttached = connectionState == .attached
        setState(.interrupted)
        settlePendingOperationsAtDrop()
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

    // ─── Heartbeat ───────────────────────────────────────────────────────────

    /// Pings the socket of this attach at once, then every interval, until
    /// the attach ends. Each tick checks for silence before it sends, and the
    /// wait before the next tick never passes the moment the socket would
    /// reach the liveness timeout, so silence is detected at 45 seconds.
    private func startHeartbeat(generation: Int) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = await self?.heartbeatTick(generation: generation) else { return }
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
    }

    private func stopHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    /// Sends one heartbeat, or treats a silent socket as dropped. Returns the
    /// seconds to wait before the next tick, or nil when the heartbeat stops.
    private func heartbeatTick(generation: Int) async -> TimeInterval? {
        guard isCurrent(generation), isConnected else { return nil }
        if secondsOfSilence() >= livenessTimeout {
            dropSilentConnection(generation: generation)
            return nil
        }
        pingCounter += 1
        // sendRaw reads the current socket before it suspends, so a ping never
        // reaches a socket replaced since the check above.
        try? await sendRaw(PingFrame(id: "hb-\(pingCounter)"))
        let untilTimeout = livenessTimeout - secondsOfSilence()
        return max(0, min(heartbeatInterval, untilTimeout))
    }

    private func secondsOfSilence() -> TimeInterval {
        seconds(since: lastFrameAt)
    }

    private func seconds(since instant: ContinuousClock.Instant) -> TimeInterval {
        let parts = instant.duration(to: clock.now).components
        return Double(parts.seconds) + Double(parts.attoseconds) / 1e18
    }

    private func dropSilentConnection(generation: Int) {
        let silentTransport = transport
        handleConnectionLoss(
            generation: generation,
            error: PyricBridgeError.unavailable(silentHostMessage),
            closeCode: nil
        )
        // A reconnecting client closes the old socket in handleConnectionLoss.
        // A client on one supplied channel is now closed; release the socket.
        if !canReopen, let silentTransport {
            Task { await silentTransport.close(closeCode: 1000, reason: "No frame received") }
        }
    }

    private func reportGap() {
        for sub in activeSubs.values where sub.includeMetadataChanges && sub.lastValue != nil {
            sub.continuation.yield(.gap)
        }
    }

    // ─── One-Shot RPC Operations ─────────────────────────────────────────────

    /// Dispatches a one-shot worker operation and awaits the correlated result.
    ///
    /// While the client is not attached, the operation is held, not sent: it is
    /// sent once after the next attach's restore, or fails after 10 seconds
    /// saying it was not sent.
    public func op(
        method: String,
        params: [String: AnySendable] = [:],
        actAs: AuthLens? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> AnySendable {
        try await admit(method: method, params: params, actAs: actAs, timeout: timeout, turn: nil)
    }

    // ─── Call Order ──────────────────────────────────────────────────────────

    /// Takes the next place in the order operations are admitted. Call it
    /// synchronously where the app makes the call, then present the turn to
    /// `op(turn:…)` from the task that runs it.
    package nonisolated func takeTurn() -> OperationTurn {
        turnCounter.take()
    }

    /// Dispatches an operation once every turn taken before this one has been
    /// sent, held, or has failed, so tasks started in call order reach the
    /// socket in call order. The turn is released as soon as the operation is
    /// sent or held, or when it throws first, never after waiting for a reply.
    package func op(
        turn: OperationTurn,
        method: String,
        params: [String: AnySendable] = [:],
        actAs: AuthLens? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> AnySendable {
        await waitForTurn(turn)
        // Releases the turn on a throw before it was sent or held; a no-op otherwise.
        defer { releaseTurn(turn) }
        return try await admit(method: method, params: params, actAs: actAs, timeout: timeout, turn: turn)
    }

    /// Waits for a turn and releases it at once, for a call that turns out to send nothing.
    package func pass(turn: OperationTurn) async {
        await waitForTurn(turn)
        releaseTurn(turn)
    }

    private func waitForTurn(_ turn: OperationTurn) async {
        guard turn.number > nextTurn else { return }
        await withCheckedContinuation { continuation in
            turnWaiters[turn.number] = continuation
        }
    }

    /// Lets the next turn in. Releasing a turn that is not the current one does nothing.
    private func releaseTurn(_ turn: OperationTurn?) {
        guard let turn, turn.number == nextTurn else { return }
        nextTurn += 1
        turnWaiters.removeValue(forKey: nextTurn)?.resume()
    }

    private func admit(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens?,
        timeout: TimeInterval?,
        turn: OperationTurn?
    ) async throws -> AnySendable {
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        let acceptsNewOps = isConnected && !drainingHeldOps && !socketRefusing
        if acceptsNewOps {
            return try await dispatchOp(
                method: method, params: params, actAs: actAs, timeout: timeout, turn: turn, holdable: canReopen
            )
        }
        guard canReopen else {
            // One supplied channel cannot be reopened, so there is nothing to hold for.
            try await connect()
            try ensureConnected()
            return try await dispatchOp(
                method: method, params: params, actAs: actAs, timeout: timeout, turn: turn, holdable: false
            )
        }
        let closedAfterAttach = hasEverAttached && connectionState == .closed
        if closedAfterAttach {
            throw PyricBridgeError.unavailable(connectionLostMessage)
        }
        return try await hold(method: method, params: params, actAs: actAs, timeout: timeout, turn: turn)
    }

    /// The next operation's id and its place in admission order.
    private func nextOpId() -> (id: String, sequence: Int) {
        opCounter += 1
        return ("rop-\(opCounter)", opCounter)
    }

    private func opPayload(method: String, params: [String: AnySendable], actAs: AuthLens?) -> [String: AnySendable] {
        var payload = params
        payload["method"] = .string(method)
        if let actAs {
            payload["actAs"] = actAs.toAnySendable()
        }
        return payload
    }

    private func dispatchOp(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens?,
        timeout: TimeInterval?,
        turn: OperationTurn?,
        holdable: Bool
    ) async throws -> AnySendable {
        let (id, sequence) = nextOpId()
        let issuedAt = clock.now
        let opTimeout = timeout ?? defaultOpTimeout
        let payload = opPayload(method: method, params: params, actAs: actAs)

        return try await withCheckedThrowingContinuation { continuation in
            self.registerPendingOp(
                id: id,
                sequence: sequence,
                issuedAt: issuedAt,
                holdable: holdable,
                method: method,
                payload: payload,
                timeout: opTimeout,
                continuation: continuation
            )
            self.writeAfterLastOp(id: id)
            self.releaseTurn(turn)
        }
    }

    /// Writes an operation frame once the previous one's socket write is done.
    /// An operation that failed, timed out, or was held before its turn to write is not sent.
    private func writeAfterLastOp(id: String) {
        let previous = lastOpWrite
        lastOpWrite = Task {
            await previous?.value
            await self.sendOpFrame(id: id)
        }
    }

    /// Pending and still waiting to be written.
    private func isPending(_ id: String) -> Bool {
        pendingOps[id]?.write == .queued
    }

    /// Records an operation as dispatched and starts its own timeout.
    private func registerPendingOp(
        id: String,
        sequence: Int,
        issuedAt: ContinuousClock.Instant,
        holdable: Bool,
        method: String,
        payload: [String: AnySendable],
        timeout: TimeInterval,
        continuation: CheckedContinuation<AnySendable, Error>
    ) {
        let timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            if !Task.isCancelled {
                await self?.handleOpTimeout(id: id, timeout: timeout, method: method)
            }
        }
        pendingOps[id] = PendingOp(
            continuation: continuation,
            timeoutTask: timeoutTask,
            sequence: sequence,
            issuedAt: issuedAt,
            holdable: holdable,
            method: method,
            payload: payload,
            timeout: timeout
        )
    }

    /// Writes a pending operation's frame. The check that it is still queued
    /// and the mark that it is being written happen in one step on the actor,
    /// so an operation held meanwhile is never written.
    private func sendOpFrame(id: String) async {
        guard isPending(id), var op = pendingOps[id] else { return }
        let canWrite = transport != nil && !isDisposed && !socketRefusing
        guard canWrite else {
            settleWrite(id: id, .refused(WebSocketSendRefusedError()))
            return
        }
        op.write = .writing
        pendingOps[id] = op
        do {
            try await sendRaw(WorkerOpFrame(id: id, op: op.payload))
            settleWrite(id: id, .written)
        } catch let error as WebSocketSendRefusedError {
            settleWrite(id: id, .refused(error))
        } catch {
            settleWrite(id: id, .failed(error))
        }
    }

    private func settleWrite(id: String, _ outcome: WriteOutcome) {
        guard let op = pendingOps[id] else { return }
        if op.write == .writingOnLostSocket {
            settleWriteOnLostSocket(id: id, outcome)
            return
        }
        switch outcome {
        case .written:
            pendingOps[id]?.write = .written
        case .refused(let error):
            refuse(id: id, error: error)
        case .failed(let error):
            failDispatch(id: id, error: error)
        }
    }

    /// A write that returned after its socket dropped. Only a refusal shows
    /// that the frame never left the device; any other result means the host
    /// may have seen it.
    private func settleWriteOnLostSocket(id: String, _ outcome: WriteOutcome) {
        guard let op = pendingOps.removeValue(forKey: id) else { return }
        if case .refused = outcome {
            holdAgain(id: id, op)
            return
        }
        op.timeoutTask.cancel()
        op.continuation.resume(throwing: PyricBridgeError.unavailable(connectionLostMessage))
    }

    /// A refusal on the current socket means it is closing. The operation, and
    /// every one queued behind it, waits for the close, which decides whether
    /// the client reconnects (ADR-0019 decision 2).
    private func refuse(id: String, error: Error) {
        guard let op = pendingOps[id], op.holdable else {
            failDispatch(id: id, error: error)
            return
        }
        socketRefusing = true
        pendingOps[id]?.write = .queued
        holdQueuedOperations()
    }

    /// Moves every holdable operation not yet handed to a socket into the held queue.
    private func holdQueuedOperations() {
        for (id, op) in pendingOps where op.holdable && op.write == .queued {
            pendingOps.removeValue(forKey: id)
            holdAgain(id: id, op)
        }
    }

    /// At a drop the client recovers from, an operation whose frame reached
    /// the socket fails, because the host may have applied it. One not yet
    /// handed over is held, and one being written waits for its write.
    private func settlePendingOperationsAtDrop() {
        holdQueuedOperations()
        for (id, op) in pendingOps {
            let writeInProgress = op.holdable && op.write == .writing
            if writeInProgress {
                pendingOps[id]?.write = .writingOnLostSocket
                continue
            }
            let awaitsItsWrite = op.write == .writingOnLostSocket
            if awaitsItsWrite { continue }
            pendingOps.removeValue(forKey: id)
            op.timeoutTask.cancel()
            op.continuation.resume(throwing: PyricBridgeError.unavailable(connectionLostMessage))
        }
    }

    /// Returns a dispatched operation to its place in the held queue. Its
    /// timeout restarts when it is sent; the hold deadline runs from issue.
    private func holdAgain(id: String, _ op: PendingOp) {
        op.timeoutTask.cancel()
        let remaining = holdDeadline - seconds(since: op.issuedAt)
        guard remaining > 0 else {
            op.continuation.resume(throwing: PyricBridgeError.unavailable(holdExpiredMessage))
            return
        }
        heldOps.insert(HeldOp(
            id: id,
            sequence: op.sequence,
            issuedAt: op.issuedAt,
            method: op.method,
            payload: op.payload,
            timeout: op.timeout,
            continuation: op.continuation,
            deadlineTask: holdDeadlineTask(id: id, after: remaining)
        ))
    }

    private func holdDeadlineTask(id: String, after seconds: TimeInterval) -> Task<Void, Never> {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.holdDeadlinePassed(id: id)
        }
    }

    /// Holds an operation until the client attaches, for at most the hold deadline.
    private func hold(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens?,
        timeout: TimeInterval?,
        turn: OperationTurn?
    ) async throws -> AnySendable {
        let (id, sequence) = nextOpId()
        let issuedAt = clock.now
        let opTimeout = timeout ?? defaultOpTimeout
        let payload = opPayload(method: method, params: params, actAs: actAs)

        return try await withCheckedThrowingContinuation { continuation in
            self.heldOps.insert(HeldOp(
                id: id,
                sequence: sequence,
                issuedAt: issuedAt,
                method: method,
                payload: payload,
                timeout: opTimeout,
                continuation: continuation,
                deadlineTask: self.holdDeadlineTask(id: id, after: self.holdDeadline)
            ))
            self.releaseTurn(turn)
            self.startAttemptIfIdle()
        }
    }

    /// Starts an attempt only when none is in progress or scheduled, so holding
    /// never starts one ahead of the schedule.
    private func startAttemptIfIdle() {
        let attemptPending = connectTask != nil || reconnectTask != nil
        guard !attemptPending, !isConnected else { return }
        let attempt = startAttempt()
        Task { _ = try? await attempt.value }
    }

    private func holdDeadlinePassed(id: String) {
        guard let held = heldOps.remove(id: id) else { return }
        held.continuation.resume(throwing: PyricBridgeError.unavailable(holdExpiredMessage))
    }

    /// Sends held operations once, in admission order, including any issued
    /// while this runs. It first waits for every write started before the
    /// drop, so a late refusal returns its operation to the queue ahead of
    /// those held after it. An operation still held when the connection drops
    /// again, or when the socket refuses a frame, stays held under its deadline.
    private func sendHeldOperations(generation: Int) async {
        await lastOpWrite?.value
        while isCurrent(generation), isConnected, !socketRefusing, let held = heldOps.popFirst() {
            held.deadlineTask.cancel()
            registerPendingOp(
                id: held.id,
                sequence: held.sequence,
                issuedAt: held.issuedAt,
                holdable: true,
                method: held.method,
                payload: held.payload,
                timeout: held.timeout,
                continuation: held.continuation
            )
            await sendOpFrame(id: held.id)
        }
        if isCurrent(generation) {
            drainingHeldOps = false
        }
    }

    private func failHeldOperations(code: FirestoreErrorCode, message: String) {
        for op in heldOps.removeAll() {
            op.deadlineTask.cancel()
            op.continuation.resume(throwing: PyricBridgeError(code: code, message: message))
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
                lastFrameAt = clock.now
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
        if changedHost { needsAuthRestore = true }
        resumeHandshake(returning: .success(needsAuthRestore))
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
        drainingHeldOps = false
        socketRefusing = false
        connectionGeneration += 1
        connectTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        attachDeadlineTask?.cancel()
        attachDeadlineTask = nil
        stopHeartbeat()
        authRestorer = nil
        setState(.closed)
        failNextAttemptWaiters(PyricBridgeError.unavailable("PyricBridgeClient disconnected."))

        failPendingOperations(code: .unavailable, message: "PyricBridgeClient disconnected.")
        failHeldOperations(code: .unavailable, message: "PyricBridgeClient disconnected.")
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
