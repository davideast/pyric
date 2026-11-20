import Foundation

// Every Firestore call that sends takes its turn where the app makes the call:
// a completion-block form synchronously, before it starts its task, and an
// async form as its first step, before its first suspension. Take a turn only
// once the call can no longer fail synchronously, so every turn taken is presented.

extension Firestore {
    /// Takes the next place in the order operations reach the bridge.
    func takeTurn() -> OperationTurn {
        bridgeClient.takeTurn()
    }

    /// Sends a write in the place `turn` holds (or stages it locally while offline) and awaits its result.
    func send(
        turn: OperationTurn,
        method: String,
        params: [String: AnySendable],
        mutations: [OfflineWriteMutation] = []
    ) async throws {
        try await executeWrite(
            turn: turn,
            method: method,
            params: params,
            actAs: effectiveAuthLens,
            mutations: mutations
        )
    }

    internal func executeWrite(
        turn: OperationTurn,
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens,
        mutations: [OfflineWriteMutation]
    ) async throws {
        let client = bridgeClient
        await client.acquireTurn(turn)
        if await client.isDisposed {
            await client.finishTurn(turn)
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        do {
            try lifecycle.ensureActiveAndMarkStarted()
        } catch {
            await client.finishTurn(turn)
            throw error
        }

        if lifecycle.isNetworkEnabled {
            let writeId = lifecycle.beginOnlineWrite()
            do {
                _ = try await client.op(turn: turn, method: method, params: params, actAs: actAs)
                lifecycle.finishOnlineWrite(writeId, committedMutations: mutations)
            } catch {
                lifecycle.finishOnlineWrite(writeId, committedMutations: nil)
                throw error
            }
            return
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.lifecycle.stageOfflineWrite(
                method: method,
                params: params,
                actAs: actAs,
                mutations: mutations,
                continuation: continuation
            )
            Task {
                await client.finishTurn(turn)
            }
        }
    }

    /// Runs a call from a completion-block form in the place of a turn taken
    /// here, before the task starts, then reports its result on the settings queue.
    func runInCallOrder<T: Sendable>(
        completion: (@Sendable (T?, Error?) -> Void)?,
        _ call: @escaping @Sendable (OperationTurn) async throws -> T
    ) {
        let turn = takeTurn()
        let currentSettings = settings
        Task {
            do {
                let result = try await call(turn)
                currentSettings.dispatchCallback { completion?(result, nil) }
            } catch {
                currentSettings.dispatchCallback { completion?(nil, error) }
            }
        }
    }

    /// Sends a write started from a completion-block form in the order the app
    /// called it, then reports the result on the settings queue. Writes issued
    /// back to back reach the bridge in call order while their replies are
    /// still awaited concurrently.
    func sendInCallOrder(
        method: String,
        params: [String: AnySendable],
        mutations: [OfflineWriteMutation] = [],
        completion: (@Sendable (Error?) -> Void)?
    ) {
        // The lens is read at the call, like the turn.
        let actAs = effectiveAuthLens
        runInCallOrder(completion: reportingError(completion)) { turn in
            try await self.executeWrite(
                turn: turn,
                method: method,
                params: params,
                actAs: actAs,
                mutations: mutations
            )
            return true
        }
    }

    /// Runs a network toggle or a close from a completion-block form in the
    /// place of a turn taken here, before the task starts, then reports the
    /// result on the settings queue. `toggle` must present the turn first.
    func toggleNetworkInCallOrder(
        completion: (@Sendable (Error?) -> Void)?,
        _ toggle: @escaping @Sendable (PyricBridgeClient, OperationTurn) async throws -> Void
    ) {
        let client = bridgeClient
        runInCallOrder(completion: reportingError(completion)) { turn in
            try await toggle(client, turn)
            return true
        }
    }

    func runVoidInCallOrder(
        completion: (@Sendable (Error?) -> Void)?,
        _ call: @escaping @Sendable (OperationTurn) async throws -> Void
    ) {
        runInCallOrder(completion: reportingError(completion)) { turn in
            try await call(turn)
            return true
        }
    }

    /// A completion for a call whose result is only whether it failed.
    private func reportingError(
        _ completion: (@Sendable (Error?) -> Void)?
    ) -> (@Sendable (Bool?, Error?) -> Void)? {
        guard let completion else { return nil }
        return { _, error in completion(error) }
    }
}
