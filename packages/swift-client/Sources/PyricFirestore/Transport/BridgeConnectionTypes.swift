import Foundation

/// How far a pending operation's frame has got toward the socket.
enum OpWrite: Sendable {
    /// Waiting in the send chain. The frame has not been handed to a socket.
    case queued
    case writing
    /// Still being written when its socket dropped. The write's result decides.
    case writingOnLostSocket
    case written
}

/// Internal container for a dispatched worker operation.
struct PendingOp: Sendable {
    let continuation: CheckedContinuation<AnySendable, Error>
    let timeoutTask: Task<Void, Never>
    /// Its place in the order operations were admitted.
    let sequence: Int
    let issuedAt: TimeInterval
    /// False for Auth restore traffic and on a client that cannot reopen its
    /// channel: those fail as before instead of being held.
    let holdable: Bool
    let method: String
    let payload: [String: AnySendable]
    let timeout: TimeInterval
    var write: OpWrite = .queued
}

/// The result of one attempt to write an operation frame.
enum WriteOutcome {
    case written
    /// The transport did not take the frame, so it never left the device.
    case refused(Error)
    /// The frame may have reached the host.
    case failed(Error)
}

/// A live subscription and what it needs to be restored after a drop.
struct ActiveSub: Sendable {
    let sequence: Int
    let continuation: AsyncThrowingStream<BridgeSubscriptionEvent, Error>.Continuation
    let payload: [String: AnySendable]
    let includeMetadataChanges: Bool
    var lastValue: AnySendable?
    var awaitsRestoredValue = false
    var sentInGeneration: Int?
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

/// Thrown by a transport's `receive()` when the peer closed the socket with a code.
public struct WebSocketCloseError: Error, Sendable {
    public let closeCode: Int
    public let reason: String?

    public init(closeCode: Int, reason: String? = nil) {
        self.closeCode = closeCode
        self.reason = reason
    }
}
