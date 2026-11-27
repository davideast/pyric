import Foundation

/// Lock-protected local broadcast streams, connection state snapshot, and
/// synchronous Auth restorer slot owned by `PyricBridgeClient`.
///
/// Registering continuations synchronously under one `NSLock` satisfies:
/// - D6 (S12): every close (`disconnect()` and no-retry closes) yields `.closed`
///   and finishes all three local streams; post-close registrations finish at once.
/// - D7 (S13-S15, S19): `remoteLensStream`, `denialStream`, `connectionStates`,
///   and `setAuthRestorer` take effect before the call returns.
/// - D9 (S26): state observers receive initial and subsequent values in strict
///   lock order matching `currentState`.
///
/// Lock hierarchy: `BridgeLocalStreams.lock` -> `ConnectionInfoHub.lock` ->
/// `DatabaseViewCoordinator.ActiveView.lock`. Observers must never call back
/// into `BridgeLocalStreams` while executing.
final class BridgeLocalStreams: @unchecked Sendable {
    private let lock = NSLock()
    private var _state: BridgeConnectionState = .connecting
    private var _closed = false
    private var _isDisposed = false
    private var _authRestorer: BridgeAuthRestorer?
    private var _appCheckTokenProvider: BridgeAppCheckTokenProvider?
    private var _appCheckTokenProviderId: UUID?
    private var _onDenial: (@Sendable (PyricBridgeError) -> Void)?

    private var stateContinuations: [UUID: AsyncStream<BridgeConnectionState>.Continuation] = [:]
    private var stateObservers: [UUID: @Sendable (BridgeConnectionState) -> Void] = [:]
    private var remoteLensContinuations: [UUID: AsyncStream<AuthLens>.Continuation] = [:]
    private var denialContinuations: [UUID: AsyncStream<PyricBridgeError>.Continuation] = [:]

    var currentState: BridgeConnectionState {
        lock.lock()
        defer { lock.unlock() }
        return _state
    }

    var isDisposed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isDisposed
    }

    var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _closed
    }

    var authRestorer: BridgeAuthRestorer? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _authRestorer
        }
        set {
            lock.lock()
            _authRestorer = newValue
            lock.unlock()
        }
    }

    var appCheckTokenProvider: BridgeAppCheckTokenProvider? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _appCheckTokenProvider
        }
        set {
            lock.lock()
            _appCheckTokenProvider = newValue
            _appCheckTokenProviderId = newValue != nil ? UUID() : nil
            lock.unlock()
        }
    }

    @discardableResult
    func setAppCheckTokenProvider(_ provider: BridgeAppCheckTokenProvider?) -> UUID? {
        lock.lock()
        defer { lock.unlock() }
        _appCheckTokenProvider = provider
        let id = provider != nil ? UUID() : nil
        _appCheckTokenProviderId = id
        return id
    }

    func clearAppCheckTokenProvider(id: UUID) {
        lock.lock()
        defer { lock.unlock() }
        if _appCheckTokenProviderId == id {
            _appCheckTokenProvider = nil
            _appCheckTokenProviderId = nil
        }
    }

    var onDenial: (@Sendable (PyricBridgeError) -> Void)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _onDenial
        }
        set {
            lock.lock()
            _onDenial = newValue
            lock.unlock()
        }
    }

    var stateContinuationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return stateContinuations.count
    }

    var remoteLensContinuationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return remoteLensContinuations.count
    }

    var denialContinuationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return denialContinuations.count
    }

    func makeConnectionStatesStream() -> AsyncStream<BridgeConnectionState> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            let current = _state
            if _closed {
                lock.unlock()
                continuation.yield(current)
                continuation.finish()
                return
            }
            stateContinuations[id] = continuation
            continuation.yield(current)
            lock.unlock()

            continuation.onTermination = { [weak self] _ in
                self?.removeStateContinuation(id)
            }
        }
    }

    func makeRemoteLensStream() -> AsyncStream<AuthLens> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            if _closed {
                lock.unlock()
                continuation.finish()
                return
            }
            remoteLensContinuations[id] = continuation
            lock.unlock()

            continuation.onTermination = { [weak self] _ in
                self?.removeRemoteLensContinuation(id)
            }
        }
    }

    func makeDenialStream() -> AsyncStream<PyricBridgeError> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            if _closed {
                lock.unlock()
                continuation.finish()
                return
            }
            denialContinuations[id] = continuation
            lock.unlock()

            continuation.onTermination = { [weak self] _ in
                self?.removeDenialContinuation(id)
            }
        }
    }

    /// Registers `observer` and delivers the current state synchronously under
    /// the lock so no transition can be missed or reordered against it.
    func addStateObserver(_ observer: @escaping @Sendable (BridgeConnectionState) -> Void) -> UUID {
        let id = UUID()
        lock.lock()
        stateObservers[id] = observer
        observer(_state)
        lock.unlock()
        return id
    }

    func removeStateObserver(_ id: UUID) {
        lock.lock()
        stateObservers.removeValue(forKey: id)
        lock.unlock()
    }

    func reopenForInitialRetry() {
        lock.lock()
        if !_isDisposed {
            _closed = false
        }
        lock.unlock()
    }

    func setState(_ next: BridgeConnectionState) {
        lock.lock()
        guard _state != next else {
            lock.unlock()
            return
        }
        _state = next
        // Notify synchronous observers before waking AsyncStream consumers so
        // callers awaiting connectionStates never race ahead of internal hubs.
        for observer in stateObservers.values {
            observer(next)
        }
        for continuation in stateContinuations.values {
            continuation.yield(next)
        }
        lock.unlock()
    }

    func yieldRemoteLens(_ lens: AuthLens) {
        lock.lock()
        for continuation in remoteLensContinuations.values {
            continuation.yield(lens)
        }
        lock.unlock()
    }

    func yieldDenial(_ error: PyricBridgeError) {
        lock.lock()
        let continuations = Array(denialContinuations.values)
        let callback = _onDenial
        lock.unlock()
        callback?(error)
        for continuation in continuations {
            continuation.yield(error)
        }
    }

    func closeAll(disposed: Bool) {
        lock.lock()
        _closed = true
        if disposed {
            _isDisposed = true
            _authRestorer = nil
            _appCheckTokenProvider = nil
            _appCheckTokenProviderId = nil
            _onDenial = nil
        }
        if _state != .closed {
            _state = .closed
            for observer in stateObservers.values {
                observer(.closed)
            }
            for continuation in stateContinuations.values {
                continuation.yield(.closed)
            }
        }
        let states = Array(stateContinuations.values)
        let lenses = Array(remoteLensContinuations.values)
        let denials = Array(denialContinuations.values)
        stateContinuations.removeAll()
        remoteLensContinuations.removeAll()
        denialContinuations.removeAll()
        lock.unlock()

        for continuation in states { continuation.finish() }
        for continuation in lenses { continuation.finish() }
        for continuation in denials { continuation.finish() }
    }

    private func removeStateContinuation(_ id: UUID) {
        lock.lock()
        stateContinuations.removeValue(forKey: id)
        lock.unlock()
    }

    private func removeRemoteLensContinuation(_ id: UUID) {
        lock.lock()
        remoteLensContinuations.removeValue(forKey: id)
        lock.unlock()
    }

    private func removeDenialContinuation(_ id: UUID) {
        lock.lock()
        denialContinuations.removeValue(forKey: id)
        lock.unlock()
    }
}
