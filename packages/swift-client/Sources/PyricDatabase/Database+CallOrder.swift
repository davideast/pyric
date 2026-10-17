import Foundation
import PyricFirestore

// Every Realtime Database call that sends takes its turn where the app makes
// the call: a completion-block form synchronously, before it starts its task,
// and an async form as its first step, before its first suspension.

extension Database {
    /// Takes the next place in the order operations reach the bridge.
    func takeTurn() -> OperationTurn {
        bridgeClient.takeTurn()
    }

    /// Sends an operation in the place `turn` holds and awaits its result.
    func send(turn: OperationTurn, method: String, params: [String: AnySendable]) async throws {
        _ = try await bridgeClient.op(turn: turn, method: method, params: params, actAs: currentAuthLens())
    }

    /// Sends a write started from synchronous code in the order the app called
    /// it, then reports the result. The turn is taken here, before the task
    /// starts, so writes issued back to back reach the bridge in call order
    /// while their replies are still awaited concurrently.
    func sendInCallOrder(
        method: String,
        params: [String: AnySendable],
        completion: @escaping @Sendable (Error?) -> Void
    ) {
        let client = bridgeClient
        let turn = client.takeTurn()
        let actAs = currentAuthLens()
        Task {
            do {
                _ = try await client.op(turn: turn, method: method, params: params, actAs: actAs)
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }
}
