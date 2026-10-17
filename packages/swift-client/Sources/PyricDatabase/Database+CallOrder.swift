import Foundation
import PyricFirestore

extension Database {
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
