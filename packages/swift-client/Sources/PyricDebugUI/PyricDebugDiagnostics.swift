import Foundation
import PyricFirestore

/// Central diagnostics hub that receives and broadcasts Security Rules denial events.
public final class PyricDebugDiagnostics: @unchecked Sendable {
    public static let shared = PyricDebugDiagnostics()

    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<RulesDenialReport>.Continuation] = [:]
    private var _history: [RulesDenialReport] = []
    private let maxHistoryCount = 20

    private var denialTask: Task<Void, Never>?
    private weak var activeBridgeClient: PyricBridgeClient?

    public init(bridgeClient: PyricBridgeClient? = nil) {
        if let bridgeClient {
            attach(to: bridgeClient)
        }
    }

    public convenience init(firestore: Firestore) {
        self.init(bridgeClient: firestore.bridgeClient)
    }

    deinit {
        denialTask?.cancel()
    }

    /// Attaches diagnostics recording to the specified bridge client instance.
    public func attach(to bridgeClient: PyricBridgeClient) {
        lock.lock()
        denialTask?.cancel()
        self.activeBridgeClient = bridgeClient
        let stream = bridgeClient.denialStream
        denialTask = Task { [weak self] in
            for await error in stream {
                guard !Task.isCancelled else { break }
                self?.record(error: error)
            }
        }
        lock.unlock()
    }

    /// Attaches diagnostics recording to the bridge client owned by the specified Firestore instance.
    public func attach(to firestore: Firestore) {
        attach(to: firestore.bridgeClient)
    }

    /// Detaches from the currently observed bridge client.
    public func detach() {
        lock.lock()
        defer { lock.unlock() }
        denialTask?.cancel()
        denialTask = nil
        activeBridgeClient = nil
    }

    /// Access the recent denial history (capped at 20 reports).
    public var history: [RulesDenialReport] {
        lock.lock()
        defer { lock.unlock() }
        return _history
    }

    /// Subscribes to new Rules denial events as an AsyncStream.
    public var denialStream: AsyncStream<RulesDenialReport> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            continuations[id] = continuation
            lock.unlock()

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.continuations.removeValue(forKey: id)
                self.lock.unlock()
            }
        }
    }

    /// Records a new `RulesDenialReport` and notifies all active listeners.
    public func record(denial: RulesDenialReport) {
        lock.lock()
        _history.insert(denial, at: 0)
        if _history.count > maxHistoryCount {
            _history.removeLast()
        }
        let conts = Array(continuations.values)
        lock.unlock()

        for continuation in conts {
            continuation.yield(denial)
        }
    }

    /// Records an intercepted `PyricBridgeError` if it carries a Security Rules denial context.
    public func record(error: PyricBridgeError) {
        guard let report = RulesDenialReport.from(error: error) else { return }
        record(denial: report)
    }

    /// Clears the cached denial history.
    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        _history.removeAll()
    }

    /// Resets all diagnostic state: cancels observation, detaches bridge client, clears history,
    /// and finishes all active stream listeners.
    public func reset() {
        lock.lock()
        denialTask?.cancel()
        denialTask = nil
        activeBridgeClient = nil
        _history.removeAll()
        let conts = Array(continuations.values)
        continuations.removeAll()
        lock.unlock()

        for continuation in conts {
            continuation.finish()
        }
    }
}
