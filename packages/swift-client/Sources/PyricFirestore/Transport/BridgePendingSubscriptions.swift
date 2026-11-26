import Foundation

/// Synchronous pre-registration and cancellation table for subscriptions opened
/// before their admission or unregister task reaches the `PyricBridgeClient`
/// actor (ADR-0019 D5, D7, D10: S9, S16, S17, S18, S28).
///
/// - `finishAttach` drains subscriptions registered synchronously right before
///   a reconnect completes, preserving exact creation order.
/// - Cancelling a subscription before admission removes it immediately so no
///   ghost `worker-sub` is sent.
/// - Cancelling an already-admitted subscription records its id synchronously in
///   `cancelledIds` so an immediate re-attach never restores a cancelled listener
///   before `unregisterSubscription` reaches the actor (S28).
final class BridgePendingSubscriptions: @unchecked Sendable {
    private let lock = NSLock()
    private var nextSequence = 0
    private var pending: [String: ActiveSub] = [:]
    private var cancelledIds: Set<String> = []

    func reserve(
        target: AnySendable,
        actAs: AnySendable?,
        includeMetadataChanges: Bool,
        listenSource: String?,
        continuation: AsyncThrowingStream<BridgeSubscriptionEvent, Error>.Continuation? = nil,
        onEvent: (@Sendable (BridgeSubscriptionEvent) -> Void)? = nil,
        onFinish: (@Sendable (Error?) -> Void)? = nil
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
            onEvent: onEvent,
            onFinish: onFinish,
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

    /// Removes `id` synchronously if still pending; otherwise records `id` in
    /// `cancelledIds` so an immediate re-attach skips restoring it (D10, S28).
    /// Returns `true` when removed before actor admission (no `worker-unsub` needed).
    func cancel(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if pending.removeValue(forKey: id) != nil {
            return true
        }
        cancelledIds.insert(id)
        return false
    }

    func isCancelled(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelledIds.contains(id)
    }

    func clearCancelled(id: String) {
        lock.lock()
        cancelledIds.remove(id)
        lock.unlock()
    }

    func failAll(error: PyricBridgeError) {
        lock.lock()
        let snapshot = pending
        pending.removeAll()
        cancelledIds.removeAll()
        lock.unlock()
        for (_, sub) in snapshot.sorted(by: { $0.value.sequence < $1.value.sequence }) {
            sub.finish(throwing: error)
        }
    }
}
