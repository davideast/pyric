import Foundation

private struct TransactionCallbackResult: @unchecked Sendable {
    let value: Any?
}

extension Firestore {

    public func runTransaction(
        _ updateBlock: @Sendable @escaping (Transaction) async throws -> Any?
    ) async throws -> Any? {
        try await runTransaction(options: TransactionOptions(), updateBlock)
    }

    public func runTransaction(
        options: TransactionOptions,
        _ updateBlock: @Sendable @escaping (Transaction) async throws -> Any?
    ) async throws -> Any? {
        markUsed()
        let copiedOptions = (options.copy(with: nil) as? TransactionOptions) ?? options
        return try await runTransaction(turn: takeTurn(), options: copiedOptions, updateBlock)
    }

    private func runTransaction(
        turn: OperationTurn,
        options: TransactionOptions,
        _ updateBlock: @Sendable @escaping (Transaction) async throws -> Any?
    ) async throws -> Any? {
        await bridgeClient.pass(turn: turn)
        try lifecycle.ensureActiveAndMarkStarted()
        let maxAttempts = options.maxAttempts
        guard maxAttempts >= 1 else {
            throw PyricBridgeError.invalidArgument(
                "TransactionOptions.maxAttempts must be at least 1, got \(maxAttempts)."
            )
        }
        guard lifecycle.isNetworkEnabled else {
            throw PyricBridgeError.unavailable("Transactions cannot be executed while the client is offline.")
        }
        var attempts = 0

        while attempts < maxAttempts {
            attempts += 1
            let attemptTxnId = UUID().uuidString
            let txn = Transaction(firestore: self, txnId: attemptTxnId)
            do {
                let result = try await updateBlock(txn)
                let writeId = lifecycle.beginOnlineWrite()
                do {
                    try await bridgeClient.txnCommit(
                        reads: txn.stagedReads,
                        writes: txn.stagedWrites,
                        actAs: effectiveAuthLens,
                        txnId: attemptTxnId
                    )
                    lifecycle.finishOnlineWrite(
                        writeId,
                        committedMutations: txn.stagedWrites.map { $0.toOfflineMutation() }
                    )
                } catch {
                    lifecycle.finishOnlineWrite(writeId, committedMutations: nil)
                    throw error
                }
                return result
            } catch let error as PyricBridgeError {
                if error.code == .aborted || error.code == .failedPrecondition {
                    if attempts >= maxAttempts {
                        throw error
                    }
                    let delayMs = min(1000, 50 * (1 << attempts)) + Int.random(in: 10...50)
                    try await Task.sleep(nanoseconds: UInt64(delayMs * 1_000_000))
                    continue
                }
                throw error
            } catch {
                throw error
            }
        }
        throw PyricBridgeError(code: .aborted, message: "Transaction failed after \(maxAttempts) attempts.")
    }

    public func runTransaction(
        _ updateBlock: @escaping @Sendable (Transaction, NSErrorPointer) -> Any?,
        completion: @escaping @Sendable (Any?, Error?) -> Void
    ) {
        runTransaction(options: nil, block: updateBlock, completion: completion)
    }

    public func runTransaction(
        options: TransactionOptions?,
        block updateBlock: @escaping @Sendable (Transaction, NSErrorPointer) -> Any?,
        completion: @escaping @Sendable (Any?, Error?) -> Void
    ) {
        markUsed()
        let rawOptions = options ?? TransactionOptions()
        let opts = (rawOptions.copy(with: nil) as? TransactionOptions) ?? rawOptions
        let turn = takeTurn()
        Task {
            do {
                let result = try await self.runTransaction(turn: turn, options: opts) { txn in
                    try await UpdateBlockThread.run {
                        var err: NSError?
                        #if canImport(ObjectiveC)
                        let res = updateBlock(txn, &err)
                        #else
                        let res = withUnsafeMutablePointer(to: &err) { ptr in
                            updateBlock(txn, ptr)
                        }
                        #endif
                        if let err {
                            throw err
                        }
                        return res
                    }
                }
                let boxedResult = TransactionCallbackResult(value: result)
                self.settings.dispatchCallback {
                    completion(boxedResult.value, nil)
                }
            } catch {
                self.settings.dispatchCallback {
                    completion(nil, error)
                }
            }
        }
    }
}
