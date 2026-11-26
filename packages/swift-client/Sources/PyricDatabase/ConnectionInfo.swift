import Foundation
import PyricFirestore

/// Serves `/.info` from the client, as every production SDK keeps it
/// (ADR-0019, amendment of 2026-10-16). A read or listener on these paths
/// never reaches the host and is never replayed on re-attach.
///
/// `connected` is true while the bridge client is `attached` and the database
/// is online. Both `currentlyConnected` and `connectedValues` read from
/// `database.connectionInfoHub`, a single lock-protected snapshot (D9, S26).
enum ConnectionInfo {

    /// Whether the first segment of `path` is `.info`.
    static func isInfoPath(_ path: String) -> Bool {
        segments(of: path).first == ".info"
    }

    static func isConnected(_ state: BridgeConnectionState, online: Bool) -> Bool {
        state == .attached && online
    }

    /// The snapshot wire served at `path` for the given `connected` value.
    static func wire(at path: String, connected: Bool) -> AnySendable {
        let served = value(at: path, connected: connected)
        return .dictionary(["exists": .bool(!served.isNull), "value": served])
    }

    /// The current value of `connected` for `database`, read synchronously from
    /// the same snapshot that drives `.info/connected` listeners.
    static func currentlyConnected(_ database: Database) -> Bool {
        database.connectionInfoHub.isConnected
    }

    /// The `connected` values of `database`: the current one first, then each change.
    static func connectedValues(of database: Database) -> AsyncStream<Bool> {
        database.connectionInfoHub.valuesStream()
    }

    private static func segments(of path: String) -> [String] {
        path.split(separator: "/").map(String.init)
    }

    private static func value(at path: String, connected: Bool) -> AnySendable {
        switch Array(segments(of: path).dropFirst()) {
        case []:
            return .dictionary(["connected": .bool(connected), "serverTimeOffset": .int(0)])
        case ["connected"]:
            return .bool(connected)
        case ["serverTimeOffset"]:
            return .int(0)
        default:
            return .null
        }
    }
}

/// Single lock-protected source of truth for a `Database`'s `.info/connected`
/// state (ADR-0019 D7, D9: S15, S26).
///
/// Lock hierarchy: `BridgeLocalStreams.lock` -> `ConnectionInfoHub.lock` ->
/// `DatabaseViewCoordinator.ActiveView.lock`. `attach(to:)` and `detach()`
/// never hold `ConnectionInfoHub.lock` while calling into `PyricBridgeClient`.
internal final class ConnectionInfoHub: @unchecked Sendable {
    private let lock = NSLock()
    private var attachGeneration: UInt64 = 0
    private var attachedClient: PyricBridgeClient?
    private var bridgeObserverId: UUID?
    private var bridgeState: BridgeConnectionState = .connecting
    private var networkOnline: Bool = true
    private var _connected: Bool = false
    private var continuations: [UUID: AsyncStream<Bool>.Continuation] = [:]
    private var observers: [UUID: @Sendable (Bool) -> Void] = [:]

    init(bridgeClient: PyricBridgeClient, networkOnline: Bool) {
        self.networkOnline = networkOnline
        attach(to: bridgeClient)
    }

    var isConnected: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _connected
    }

    func attach(to client: PyricBridgeClient) {
        let (shouldAttach, gen, previous): (Bool, UInt64, (PyricBridgeClient, UUID)?) = {
            lock.lock()
            defer { lock.unlock() }
            guard attachedClient !== client else { return (false, attachGeneration, nil) }
            attachGeneration &+= 1
            let currentGen = attachGeneration
            let old = attachedClient.flatMap { oldClient in
                bridgeObserverId.map { (oldClient, $0) }
            }
            attachedClient = nil
            bridgeObserverId = nil
            return (true, currentGen, old)
        }()
        guard shouldAttach else { return }
        if let (oldClient, oldId) = previous {
            oldClient.removeConnectionStateObserver(oldId)
        }

        // `addConnectionStateObserver` invokes the closure synchronously with the
        // current bridge state under `BridgeLocalStreams.lock`.
        let newId = client.addConnectionStateObserver { [weak self] state in
            self?.updateBridgeState(state, generation: gen)
        }
        let superseded: Bool = {
            lock.lock()
            defer { lock.unlock() }
            guard attachGeneration == gen else { return true }
            attachedClient = client
            bridgeObserverId = newId
            return false
        }()
        if superseded {
            client.removeConnectionStateObserver(newId)
        }
    }

    func detach() {
        let previous: (PyricBridgeClient, UUID)? = {
            lock.lock()
            defer { lock.unlock() }
            attachGeneration &+= 1
            let old = attachedClient.flatMap { oldClient in
                bridgeObserverId.map { (oldClient, $0) }
            }
            attachedClient = nil
            bridgeObserverId = nil
            return old
        }()
        if let (oldClient, oldId) = previous {
            oldClient.removeConnectionStateObserver(oldId)
        }
    }

    private func updateBridgeState(_ next: BridgeConnectionState, generation: UInt64) {
        lock.lock()
        guard attachGeneration == generation else {
            lock.unlock()
            return
        }
        bridgeState = next
        propagateIfChangedLocked()
        lock.unlock()
    }

    func updateNetworkOnline(_ online: Bool) {
        lock.lock()
        networkOnline = online
        propagateIfChangedLocked()
        lock.unlock()
    }

    func valuesStream() -> AsyncStream<Bool> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            continuations[id] = continuation
            continuation.yield(_connected)
            lock.unlock()

            continuation.onTermination = { [weak self] _ in
                self?.removeContinuation(id)
            }
        }
    }

    /// Registers a synchronous observer and immediately delivers the current
    /// `connected` value under the lock.
    func addObserver(_ observer: @escaping @Sendable (Bool) -> Void) -> UUID {
        let id = UUID()
        lock.lock()
        observers[id] = observer
        observer(_connected)
        lock.unlock()
        return id
    }

    func removeObserver(_ id: UUID) {
        lock.lock()
        observers.removeValue(forKey: id)
        lock.unlock()
    }

    private func removeContinuation(_ id: UUID) {
        lock.lock()
        continuations.removeValue(forKey: id)
        lock.unlock()
    }

    private func propagateIfChangedLocked() {
        let nextConnected = ConnectionInfo.isConnected(bridgeState, online: networkOnline)
        guard nextConnected != _connected else { return }
        _connected = nextConnected
        for continuation in continuations.values {
            continuation.yield(nextConnected)
        }
        for observer in observers.values {
            observer(nextConnected)
        }
    }
}
