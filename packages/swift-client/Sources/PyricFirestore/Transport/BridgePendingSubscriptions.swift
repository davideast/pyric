import Foundation

/// Synchronous pre-registration table for subscriptions opened before their
/// admission task reaches the `PyricBridgeClient` actor (ADR-0019 D5, D7:
/// S9, S16, S17, S18).
///
/// Storing the reserved `ActiveSub` with its monotonic `sequence` under a lock
/// ensures:
/// - `finishAttach` drains subscriptions registered synchronously right before
///   a reconnect completes, preserving exact creation order.
/// - Cancelling a subscription before its admission task runs drops it cleanly
///   without sending a ghost `worker-sub`.
final class BridgePendingSubscriptions: @unchecked Sendable {
    private let lock = NSLock()
    private var nextSequence = 0
    private var pending: [String: ActiveSub] = [:]

    func reserve(
        target: AnySendable,
        actAs: AnySendable?,
        includeMetadataChanges: Bool,
        listenSource: String?,
        continuation: AsyncThrowingStream<BridgeSubscriptionEvent, Error>.Continuation
    ) -> String {
        var payload: [String: AnySendable] = [
            "target": target
        ]
        if let actAs {
            payload["actAs"] = actAs
        }
        if includeMetadataChanges {
            payload["includeMetadataChanges"] = .bool(true)
        }
        if let listenSource, listenSource != "defaultSource" {
            payload["listenSource"] = .string(listenSource)
        }

        lock.lock()
        nextSequence += 1
        let seq = nextSequence
        let subId = "rsub-\(seq)"
        pending[subId] = ActiveSub(
            sequence: seq,
            continuation: continuation,
            payload: payload,
            includeMetadataChanges: includeMetadataChanges
        )
        lock.unlock()
        return subId
    }

    func take(id: String) -> ActiveSub? {
        lock.lock()
        defer { lock.unlock() }
        return pending.removeValue(forKey: id)
    }

    func drainAllSorted() -> [(String, ActiveSub)] {
        lock.lock()
        let snapshot = pending
        pending.removeAll()
        lock.unlock()
        return snapshot.sorted { $0.value.sequence < $1.value.sequence }
    }

    /// Removes `id` if it has not yet been moved onto the actor. Returns `true`
    /// when cancelled before admission so the caller skips `worker-unsub`.
    func cancelIfPending(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return pending.removeValue(forKey: id) != nil
    }

    func failAll(error: PyricBridgeError) {
        let drained = drainAllSorted()
        for (_, sub) in drained {
            sub.continuation.finish(throwing: error)
        }
    }
}
