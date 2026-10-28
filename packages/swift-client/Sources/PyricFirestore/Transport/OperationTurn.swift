import Foundation

/// A place in the order a bridge client admits operations, taken where the app
/// makes the call: synchronously in a completion-block form, before any task
/// starts, and in an async form before its first suspension.
///
/// Every turn handed out must be presented to `PyricBridgeClient.op(turn:…)`,
/// `pass(turn:)` or `disconnect(turn:)`, or the turns after it wait forever.
package struct OperationTurn: Sendable {
    let number: Int
}

/// Hands out turns in call order, from any thread.
final class OperationTurnCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var issued = 0

    func take() -> OperationTurn {
        lock.lock()
        defer { lock.unlock() }
        let turn = OperationTurn(number: issued)
        issued += 1
        return turn
    }
}
