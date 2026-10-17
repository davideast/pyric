import Foundation

extension Firestore {
    /// Sends a write started from a completion-block form in the order the app
    /// called it, then reports the result on the settings queue. The turn is
    /// taken here, before the task starts, so writes issued back to back reach
    /// the bridge in call order while their replies are still awaited
    /// concurrently. Call it only once the write can no longer fail
    /// synchronously, so every turn taken is presented.
    func sendInCallOrder(
        method: String,
        params: [String: AnySendable],
        completion: (@Sendable (Error?) -> Void)?
    ) {
        let client = bridgeClient
        let turn = client.takeTurn()
        let actAs = effectiveAuthLens
        Task {
            do {
                _ = try await client.op(turn: turn, method: method, params: params, actAs: actAs)
                self.settings.dispatchQueue.async { completion?(nil) }
            } catch {
                self.settings.dispatchQueue.async { completion?(error) }
            }
        }
    }

    /// Runs a network toggle from a completion-block form once every write
    /// issued before it has been sent or held, then reports the result on the
    /// settings queue. The turn is taken here, before the task starts.
    func toggleNetworkInCallOrder(
        completion: (@Sendable (Error?) -> Void)?,
        _ toggle: @escaping @Sendable (PyricBridgeClient) async throws -> Void
    ) {
        let client = bridgeClient
        let turn = client.takeTurn()
        Task {
            await client.pass(turn: turn)
            do {
                try await toggle(client)
                self.settings.dispatchQueue.async { completion?(nil) }
            } catch {
                self.settings.dispatchQueue.async { completion?(error) }
            }
        }
    }
}
