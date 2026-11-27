import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

let connectionLostMessage =
    "The bridge connection was lost. Requests already sent may have completed; check state before retrying."
let holdExpiredMessage =
    "The bridge connection was not restored within 10 seconds. The request was not sent."
let authRestoreFailedMessage =
    "The bridge connection was restored, but the signed-in user could not be restored on the new host. The request was not sent."
let silentHostMessage =
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
/// subscription in creation order. Operations in flight at the drop fail once
/// with `unavailable` and are never re-sent. Operations issued while not
/// attached, or whose frame never left the device, are held for up to 10
/// seconds and sent once after the next attach's restore.
public actor PyricBridgeClient {
    public nonisolated let endpoint: URL
    public nonisolated let headers: [String: String]
    public let defaultOpTimeout: TimeInterval
    /// Retry the first connection on the reconnect schedule instead of failing.
    public let retryInitialConnection: Bool
    package nonisolated let hasInjectedChannel: Bool

    var transport: (any WebSocketTransport)?
    let fixedTransport: (any WebSocketTransport)?
    private let transportFactory: (@Sendable (URLRequest) async throws -> any WebSocketTransport)?
    private let reconnectDelay: @Sendable (Int) -> TimeInterval
    private let attachTimeout: TimeInterval
    var holdDeadline: TimeInterval = defaultHoldDeadline
    var heartbeatInterval: TimeInterval = defaultHeartbeatInterval
    var livenessTimeout: TimeInterval = defaultLivenessTimeout
    var clock: any BridgeClock
    var lastFrameAt: TimeInterval
    /// Monotonic count of frames delivered to `receiveLoop`, for test synchronization.
    var receivedFrameCount: Int = 0
    var heartbeatTask: Task<Void, Never>?
    var pingCounter = 0

    public internal(set) var isConnected: Bool = false
    public internal(set) var isDisposed: Bool = false
    public internal(set) var connectionState: BridgeConnectionState = .connecting
    /// The client session ID acknowledged by the bridge.
    public internal(set) var clientSessionId: String?

    var hostInstanceId: String?
    var needsAuthRestore = false
    var hasEverAttached = false
    var connectionGeneration = 0
    private var reconnectAttempt = 0
    var reconnectTask: Task<Void, Never>?
    private var attachDeadlineTask: Task<Void, Never>?
    private var attemptWaiters: [CheckedContinuation<Void, Error>] = []
    private var nextAttemptWaiters: [CheckedContinuation<Void, Error>] = []

    var opCounter: Int = 0
    var attemptTask: Task<Void, Never>?
    var receiveTask: Task<Void, Never>?
    var handshakeContinuation: CheckedContinuation<Bool, Error>?

    let localStreams = BridgeLocalStreams()
    let pendingSubs = BridgePendingSubscriptions()
    /// Single serial dispatcher delivering subscription events in socket frame
    /// arrival order across all listeners on this client (ADR-0019 D8, S20).
    package nonisolated let deliveryQueue = DispatchQueue(label: "dev.pyric.bridge.delivery")

    /// Instance-scoped callback invoked whenever a Security Rules denial is intercepted.
    public nonisolated var onDenial: (@Sendable (PyricBridgeError) -> Void)? {
        get { localStreams.onDenial }
        set { localStreams.onDenial = newValue }
    }

    var pendingOps: [String: PendingOp] = [:]
    var heldOps = HeldOperationQueue()
    var deferredSubsDuringDrain: [(sequence: Int, subId: String)] = []
    var restoringSubscriptions = false
    var drainingHeldOps = false
    var socketRefusing = false
    var lastOpWrite: Task<Void, Never>?
    let turnCounter = OperationTurnCounter()
    var nextTurn = 0
    var turnWaiters: [Int: CheckedContinuation<Void, Never>] = [:]
    var activeSubs: [String: ActiveSub] = [:]

    public static func defaultHeaders(for url: URL) -> [String: String] {
        let rawHost = url.host ?? "127.0.0.1"
        let formattedHost = (rawHost.contains(":") && !rawHost.hasPrefix("["))
            ? "[\(rawHost)]"
            : rawHost
        let hostHeader = (url.port != nil)
            ? "\(formattedHost):\(url.port!)"
            : (url.host != nil ? formattedHost : "127.0.0.1:5174")
        return ["Host": hostHeader]
    }

    public init(
        endpoint: URL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
        headers: [String: String]? = nil,
        defaultOpTimeout: TimeInterval = 35.0,
        retryInitialConnection: Bool = false,
        reconnectDelay: (@Sendable (Int) -> TimeInterval)? = nil,
        attachTimeout: TimeInterval = 5.0,
        transportFactory: (@Sendable (URLRequest) async throws -> any WebSocketTransport)? = nil
    ) {
        self.endpoint = endpoint
        self.headers = headers ?? Self.defaultHeaders(for: endpoint)
        self.defaultOpTimeout = defaultOpTimeout
        self.retryInitialConnection = retryInitialConnection
        self.reconnectDelay = reconnectDelay ?? { bridgeReconnectDelay(attempt: $0) }
        self.attachTimeout = attachTimeout
        self.transportFactory = transportFactory
        self.fixedTransport = nil
        self.hasInjectedChannel = false
        let initialClock = ContinuousBridgeClock()
        self.clock = initialClock
        self.lastFrameAt = initialClock.now()
    }

    public init(
        channel: any WebSocketTransport,
        endpoint: URL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
        headers: [String: String]? = nil,
        defaultOpTimeout: TimeInterval = 35.0
    ) {
        self.endpoint = endpoint
        self.headers = headers ?? Self.defaultHeaders(for: endpoint)
        self.defaultOpTimeout = defaultOpTimeout
        self.retryInitialConnection = false
        self.reconnectDelay = { bridgeReconnectDelay(attempt: $0) }
        self.attachTimeout = 5.0
        self.transport = channel
        self.fixedTransport = channel
        self.hasInjectedChannel = true
        self.transportFactory = nil
        let initialClock = ContinuousBridgeClock()
        self.clock = initialClock
        self.lastFrameAt = initialClock.now()
    }

    /// Constructs a URLRequest populating the Host header for DNS-rebinding protection.
    public static func makeWebSocketRequest(url: URL, headers: [String: String] = [:]) -> URLRequest {
        var request = URLRequest(url: url)
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if request.value(forHTTPHeaderField: "Host") == nil {
            if let hostStr = Self.defaultHeaders(for: url)["Host"] {
                request.setValue(hostStr, forHTTPHeaderField: "Host")
            }
        }
        return request
    }

    /// Test-only: shortens the hold deadline, and `nil` restores it.
    func setHoldDeadlineForTesting(_ seconds: TimeInterval?) {
        holdDeadline = seconds ?? defaultHoldDeadline
    }

    /// Test-only: shortens the heartbeat interval and liveness timeout.
    func setHeartbeatForTesting(interval: TimeInterval?, livenessTimeout timeout: TimeInterval?) {
        heartbeatInterval = interval ?? defaultHeartbeatInterval
        livenessTimeout = timeout ?? defaultLivenessTimeout
    }

    /// Test-only: replaces the bridge clock before connecting.
    func setClockForTesting(_ testClock: any BridgeClock) {
        clock = testClock
        lastFrameAt = testClock.now()
    }

    var heldOperationCount: Int { heldOps.count }
    var attemptWaiterCount: Int { attemptWaiters.count }
    nonisolated var hasAuthRestorer: Bool { localStreams.authRestorer != nil }
    nonisolated var stateContinuationCount: Int { localStreams.stateContinuationCount }
    nonisolated var remoteLensContinuationCount: Int { localStreams.remoteLensContinuationCount }
    nonisolated var denialContinuationCount: Int { localStreams.denialContinuationCount }

    /// Runs on a re-attach to a replaced host, before subscriptions are re-sent.
    /// Installs synchronously so an immediate re-attach never skips the restore.
    public nonisolated func setAuthRestorer(_ restorer: BridgeAuthRestorer?) {
        localStreams.authRestorer = restorer
    }

    package nonisolated var appCheckTokenProvider: BridgeAppCheckTokenProvider? {
        get { localStreams.appCheckTokenProvider }
    }

    package nonisolated func setAppCheckTokenProvider(_ provider: BridgeAppCheckTokenProvider?) {
        localStreams.appCheckTokenProvider = provider
    }

    /// Synchronous snapshot of the latest connection state.
    package nonisolated var currentConnectionState: BridgeConnectionState {
        localStreams.currentState
    }

    package nonisolated func addConnectionStateObserver(
        _ observer: @escaping @Sendable (BridgeConnectionState) -> Void
    ) -> UUID {
        localStreams.addStateObserver(observer)
    }

    package nonisolated func removeConnectionStateObserver(_ id: UUID) {
        localStreams.removeStateObserver(id)
    }

    /// Transport state changes, starting synchronously with the current state.
    public nonisolated var connectionStates: AsyncStream<BridgeConnectionState> {
        localStreams.makeConnectionStatesStream()
    }

    /// Exposes pushed remote lens changes from desktop Pyric Studio.
    public nonisolated var remoteLensStream: AsyncStream<AuthLens> {
        localStreams.makeRemoteLensStream()
    }

    /// Exposes Security Rules denial errors intercepted from bridge responses and snapshots.
    public nonisolated var denialStream: AsyncStream<PyricBridgeError> {
        localStreams.makeDenialStream()
    }

    private func setState(_ next: BridgeConnectionState) {
        guard connectionState != next else { return }
        connectionState = next
        localStreams.setState(next)
    }

    var canReopen: Bool { fixedTransport == nil }

    // -- Connection Lifecycle --

    /// Establishes the WebSocket connection and completes the attach / attach-ack handshake.
    public func connect() async throws {
        if isConnected { return }
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if attemptTask != nil {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                attemptWaiters.append(continuation)
            }
            return
        }
        if reconnectTask != nil {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                nextAttemptWaiters.append(continuation)
            }
            return
        }
        startAttempt()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            attemptWaiters.append(continuation)
        }
    }

    func startAttempt() {
        connectionGeneration += 1
        let generation = connectionGeneration
        if !hasEverAttached {
            localStreams.reopenForInitialRetry()
            setState(.connecting)
        }
        attemptWaiters.append(contentsOf: nextAttemptWaiters)
        nextAttemptWaiters.removeAll()
        attemptTask = Task { [weak self] in
            await self?.runAttempt(generation: generation)
        }
        attachDeadlineTask?.cancel()
        let activeClock = clock
        let deadline = activeClock.now() + attachTimeout
        attachDeadlineTask = Task { [weak self] in
            try? await activeClock.sleepUntil(deadline: deadline)
            guard !Task.isCancelled else { return }
            await self?.attachDeadlinePassed(generation: generation)
        }
    }

    private func takeAttemptWaiters() -> [CheckedContinuation<Void, Error>] {
        let waiters = attemptWaiters
        attemptWaiters.removeAll()
        return waiters
    }

    private func failAttemptWaiters(_ error: Error) {
        for waiter in takeAttemptWaiters() {
            waiter.resume(throwing: error)
        }
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

    func isCurrent(_ generation: Int) -> Bool {
        generation == connectionGeneration && !isDisposed
    }

    private func runAttempt(generation: Int) async {
        guard isCurrent(generation) else { return }
        do {
            guard let restoresAuth = try await openAndAttach(generation: generation),
                  isCurrent(generation) else {
                return
            }
            if restoresAuth, let restorer = localStreams.authRestorer {
                var restoreFailed = false
                do {
                    try await restorer { [weak self] method, params in
                        guard let self else { throw PyricBridgeError.unavailable("Client was deallocated.") }
                        return try await self.dispatchOp(
                            method: method, params: params, actAs: nil, timeout: nil, turn: nil, holdable: false
                        )
                    }
                } catch {
                    restoreFailed = true
                }
                guard isCurrent(generation) else { return }
                needsAuthRestore = false
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
        }
    }

    private func openAndAttach(generation: Int) async throws -> Bool? {
        guard isCurrent(generation) else { return nil }
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
            return nil
        }
        transport = opened
        lastFrameAt = clock.now()
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(generation: generation, transport: opened)
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.handshakeContinuation = continuation
            let attachFrame = AttachFrame(clientSessionId: clientSessionId)
            Task { [weak self] in
                await self?.sendAttach(generation: generation, frame: attachFrame)
            }
        }
    }

    private func sendAttach(generation: Int, frame: AttachFrame) async {
        guard isCurrent(generation) else { return }
        do {
            try await sendRaw(frame)
        } catch {
            handleConnectionLoss(
                generation: generation,
                error: PyricBridgeError.unavailable("Failed to send attach frame: \(error)"),
                closeCode: nil
            )
        }
    }

    private func finishAttach(generation: Int) async {
        guard isCurrent(generation) else { return }
        attachDeadlineTask?.cancel()
        attachDeadlineTask = nil
        attemptTask = nil
        let waiters = takeAttemptWaiters()
        defer {
            for waiter in waiters { waiter.resume() }
        }
        hasEverAttached = true
        reconnectAttempt = 0
        drainPendingSubscriptions()
        for (subId, var sub) in activeSubs {
            sub.awaitsRestoredValue = sub.lastValue != nil
            sub.sentInGeneration = nil
            activeSubs[subId] = sub
        }
        // New subscriptions wait behind the restore loop; new ops wait behind held ops.
        restoringSubscriptions = true
        drainingHeldOps = true
        isConnected = true
        setState(.attached)
        startHeartbeat(generation: generation)

        while isCurrent(generation), isConnected, !socketRefusing {
            drainPendingSubscriptions()
            let batch = activeSubs
                .filter { $0.value.sentInGeneration != generation }
                .sorted { $0.value.sequence < $1.value.sequence }
            guard !batch.isEmpty else { break }
            var refused = false
            for (subId, sub) in batch {
                guard isCurrent(generation), isConnected, !socketRefusing else { break }
                if pendingSubs.isCancelled(id: subId) {
                    activeSubs.removeValue(forKey: subId)
                    continue
                }
                guard var current = activeSubs[subId], current.sentInGeneration != generation else { continue }
                current.sentInGeneration = generation
                activeSubs[subId] = current
                let wirePayload = await BridgeAppCheckAttachment.attachToSubPayload(
                    sub.payload,
                    tokenProvider: localStreams.appCheckTokenProvider
                )
                guard isCurrent(generation), isConnected, !socketRefusing, !pendingSubs.isCancelled(id: subId) else { break }
                do {
                    try await sendRaw(WorkerSubFrame(subId: subId, sub: wirePayload))
                } catch is WebSocketSendRefusedError where canReopen {
                    if activeSubs[subId]?.sentInGeneration == generation {
                        activeSubs[subId]?.sentInGeneration = nil
                    }
                    if isCurrent(generation) {
                        socketRefusing = true
                    }
                    refused = true
                    break
                } catch {
                    // Keep `sentInGeneration = generation` so a non-refusal error
                    // cannot spin the restore loop on this generation; the next
                    // attach resets `sentInGeneration` for every live subscription.
                }
            }
            if refused { break }
        }
        if isCurrent(generation) {
            restoringSubscriptions = false
        }
        await sendHeldOperations(generation: generation)
    }

    func resumeHandshake(returning result: Result<Bool, Error>) {
        guard let continuation = handshakeContinuation else { return }
        handshakeContinuation = nil
        switch result {
        case .success(let restoresAuth):
            continuation.resume(returning: restoresAuth)
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }

    func handleConnectionLoss(generation: Int, error: PyricBridgeError, closeCode: Int?) {
        guard isCurrent(generation) else { return }
        let permitsRetry = canReopen
            && (hasEverAttached || retryInitialConnection)
            && closeCode != policyCloseCode
        let wasAttached = connectionState == .attached
        connectionGeneration += 1
        attemptTask?.cancel()
        attemptTask = nil
        isConnected = false
        restoringSubscriptions = false
        drainingHeldOps = false
        deferredSubsDuringDrain.removeAll()
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
            connectionState = .closed
            localStreams.closeAll(disposed: false)
            pendingSubs.failAll(error: error)
            failAttemptWaiters(error)
            failPendingOperations(code: error.code, message: error.message)
            failHeldOperations(code: error.code, message: error.message)
            failSubscriptions(code: error.code, message: error.message)
            failNextAttemptWaiters(error)
            if canReopen, let closing {
                Task { await closing.close(closeCode: 1000, reason: "Connection closed") }
            }
            return
        }

        setState(.interrupted)
        failAttemptWaiters(error)
        settlePendingOperationsAtDrop()
        if wasAttached { reportGap() }
        if let closing {
            Task { await closing.close(closeCode: 1000, reason: "Reconnecting") }
        }

        let delay = reconnectDelay(reconnectAttempt)
        let activeClock = clock
        let deadline = activeClock.now() + delay
        reconnectAttempt += 1
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            if delay > 0 {
                try? await activeClock.sleepUntil(deadline: deadline)
            }
            guard !Task.isCancelled else { return }
            await self?.reconnectTimerFired()
        }
    }

    private func reconnectTimerFired() {
        reconnectTask = nil
        guard !isDisposed, attemptTask == nil, !isConnected else { return }
        startAttempt()
    }

    func seconds(since instant: TimeInterval) -> TimeInterval {
        max(0, clock.now() - instant)
    }

    private func reportGap() {
        for (subId, sub) in activeSubs where sub.includeMetadataChanges && sub.lastValue != nil {
            guard !pendingSubs.isCancelled(id: subId) else { continue }
            sub.deliver(.gap)
        }
    }

    // -- Teardown --

    /// Closes the connection and cancels all outstanding operations and subscriptions.
    public func disconnect() async {
        let closing = close()
        await closing?.close(closeCode: 1000, reason: "Client disconnect")
    }

    /// Marks the client disposed and fails everything outstanding, without suspending.
    func close() -> (any WebSocketTransport)? {
        isDisposed = true
        isConnected = false
        restoringSubscriptions = false
        drainingHeldOps = false
        deferredSubsDuringDrain.removeAll()
        socketRefusing = false
        connectionGeneration += 1
        attemptTask?.cancel()
        attemptTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        attachDeadlineTask?.cancel()
        attachDeadlineTask = nil
        stopHeartbeat()
        connectionState = .closed
        localStreams.closeAll(disposed: true)

        let disconnectError = PyricBridgeError.unavailable("PyricBridgeClient disconnected.")
        pendingSubs.failAll(error: disconnectError)
        failAttemptWaiters(disconnectError)
        failNextAttemptWaiters(disconnectError)
        failPendingOperations(code: .unavailable, message: disconnectError.message)
        failHeldOperations(code: .unavailable, message: disconnectError.message)
        failSubscriptions(code: .unavailable, message: disconnectError.message)
        resumeHandshake(returning: .failure(disconnectError))

        receiveTask?.cancel()
        receiveTask = nil

        let closing = transport
        transport = nil
        return closing
    }
}
