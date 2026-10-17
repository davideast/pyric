import Foundation

/// An operation that has not been handed to a socket. It waits for the next attach.
struct HeldOp: Sendable {
    let id: String
    /// Its place in the order operations were admitted.
    let sequence: Int
    /// When the app issued it. The hold deadline runs from here.
    let issuedAt: ContinuousClock.Instant
    let method: String
    let payload: [String: AnySendable]
    let timeout: TimeInterval
    let continuation: CheckedContinuation<AnySendable, Error>
    let deadlineTask: Task<Void, Never>
}

/// Held operations in admission order (ADR-0019 decision 7).
///
/// An operation issued while not attached joins the end. One admitted
/// earlier whose frame never left the device, because the transport refused
/// it or it was still queued at a drop, returns to its own place, ahead of
/// every operation held after it (ADR-0019, amended 2026-10-17).
struct HeldOperationQueue {
    private var ops: [HeldOp] = []

    var isEmpty: Bool { ops.isEmpty }

    mutating func insert(_ op: HeldOp) {
        let index = ops.firstIndex { $0.sequence > op.sequence } ?? ops.endIndex
        ops.insert(op, at: index)
    }

    mutating func popFirst() -> HeldOp? {
        guard !ops.isEmpty else { return nil }
        return ops.removeFirst()
    }

    mutating func remove(id: String) -> HeldOp? {
        guard let index = ops.firstIndex(where: { $0.id == id }) else { return nil }
        return ops.remove(at: index)
    }

    mutating func removeAll() -> [HeldOp] {
        let all = ops
        ops.removeAll()
        return all
    }
}
