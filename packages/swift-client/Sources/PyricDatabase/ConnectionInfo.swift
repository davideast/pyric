import Foundation
import PyricFirestore

/// Serves `/.info` from the client, as every production SDK keeps it
/// (ADR-0019, amendment of 2026-10-16). A read or listener on these paths
/// never reaches the host and is never replayed on re-attach.
///
/// `connected` is true while the bridge client is `attached` and the database
/// is online. It is derived from the existing `attached` state: an operation
/// issued when it turns true is held behind the restore and the held queue.
enum ConnectionInfo {

    /// Whether the first segment of `path` is `.info`, the test `isInfoPath`
    /// in `packages/pyric/src/database/writable-path.ts` applies.
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

    /// The current value of `connected` for `database`.
    static func currentlyConnected(_ database: Database) async -> Bool {
        let state = await database.bridgeClient.connectionState
        return isConnected(state, online: database.isNetworkOnline)
    }

    /// The `connected` values of `database`: the current one first, then each change.
    static func connectedValues(of database: Database) -> AsyncStream<Bool> {
        AsyncStream { continuation in
            let tracker = ConnectedTracker(continuation: continuation)
            let states = Task {
                for await state in database.bridgeClient.connectionStates {
                    tracker.update(state: state)
                }
            }
            let flags = Task {
                for await online in database.networkOnlineStream {
                    tracker.update(online: online)
                }
            }
            continuation.onTermination = { _ in
                states.cancel()
                flags.cancel()
            }
        }
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

/// Combines the connection state and the network flag, and yields `connected`
/// once both are known and then only when it changes.
private final class ConnectedTracker: @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: AsyncStream<Bool>.Continuation
    private var state: BridgeConnectionState?
    private var online: Bool?
    private var last: Bool?

    init(continuation: AsyncStream<Bool>.Continuation) {
        self.continuation = continuation
    }

    func update(state next: BridgeConnectionState) {
        lock.lock()
        defer { lock.unlock() }
        state = next
        yieldIfChanged()
    }

    func update(online next: Bool) {
        lock.lock()
        defer { lock.unlock() }
        online = next
        yieldIfChanged()
    }

    /// Call with the lock held, so two updates never yield out of order.
    private func yieldIfChanged() {
        guard let state, let online else { return }
        let connected = ConnectionInfo.isConnected(state, online: online)
        guard connected != last else { return }
        last = connected
        continuation.yield(connected)
    }
}
