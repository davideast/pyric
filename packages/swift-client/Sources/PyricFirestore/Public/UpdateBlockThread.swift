import Foundation

/// Runs a completion-form transaction's update block on a thread of its own.
///
/// The block may call `Transaction.getDocument(_:error:)`, which blocks its thread
/// until the read's reply arrives. That reply is received on URLSession's queues
/// (GCD worker threads) and processed by the bridge client's actor and tasks on the
/// Swift concurrency cooperative pool. A block run on either kind of thread could,
/// with enough transactions at once, hold every thread the reply needs, and then no
/// transaction settles. A thread started for the block holds none of them.
enum UpdateBlockThread {
    static func run(_ body: @escaping @Sendable () throws -> Any?) async throws -> Any? {
        let outcome = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<BlockOutcome, Error>) in
            let thread = Thread {
                do {
                    continuation.resume(returning: BlockOutcome(value: try body()))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
            thread.name = "dev.pyric.firestore.transaction-update-block"
            thread.start()
        }
        return outcome.value
    }
}

/// The update block's return value, handed from its thread back to the transaction task.
/// The block owns the value and returns it once, so nothing else touches it.
private struct BlockOutcome: @unchecked Sendable {
    let value: Any?
}
