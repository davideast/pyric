import Foundation

extension PyricBridgeClient {

    // -- One-Shot RPC Operations --

    /// Dispatches a one-shot worker operation and awaits the correlated result.
    public func op(
        method: String,
        params: [String: AnySendable] = [:],
        actAs: AuthLens? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> AnySendable {
        try await op(turn: turnCounter.take(), method: method, params: params, actAs: actAs, timeout: timeout)
    }

    // -- Call Order --

    /// Takes the next place in the order operations and subscriptions are admitted.
    package nonisolated func takeTurn() -> OperationTurn {
        turnCounter.take()
    }

    /// Dispatches an operation once every turn taken before this one has been admitted.
    package func op(
        turn: OperationTurn,
        method: String,
        params: [String: AnySendable] = [:],
        actAs: AuthLens? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> AnySendable {
        await waitForTurn(turn)
        defer { releaseTurn(turn) }
        return try await admit(method: method, params: params, actAs: actAs, timeout: timeout, turn: turn)
    }

    /// Waits for a turn and releases it at once, for a call that turns out to send nothing.
    package func pass(turn: OperationTurn) async {
        await waitForTurn(turn)
        releaseTurn(turn)
    }

    package func acquireTurn(_ turn: OperationTurn) async {
        await waitForTurn(turn)
    }

    package func finishTurn(_ turn: OperationTurn) {
        releaseTurn(turn)
    }

    package func flushSocketWrites() async {
        await lastOpWrite?.value
    }

    package func startOrderedOp(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens?
    ) async -> Task<AnySendable, Error> {
        final class OnceGate: @unchecked Sendable {
            private let lock = NSLock()
            private var resumed = false
            private let continuation: CheckedContinuation<Void, Never>

            init(_ continuation: CheckedContinuation<Void, Never>) {
                self.continuation = continuation
            }

            func fire() {
                lock.lock()
                guard !resumed else {
                    lock.unlock()
                    return
                }
                resumed = true
                lock.unlock()
                continuation.resume()
            }
        }

        var startedTask: Task<AnySendable, Error>?
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let gate = OnceGate(continuation)
            startedTask = Task {
                defer { gate.fire() }
                return try await self.admit(
                    method: method,
                    params: params,
                    actAs: actAs,
                    timeout: nil,
                    turn: nil,
                    onQueued: { gate.fire() }
                )
            }
        }
        return startedTask!
    }

    /// Closes the client in the place `turn` holds.
    package func disconnect(turn: OperationTurn) async {
        await waitForTurn(turn)
        let closing = close()
        releaseTurn(turn)
        await closing?.close(closeCode: 1000, reason: "Client disconnect")
    }

    func waitForTurn(_ turn: OperationTurn) async {
        guard turn.number > nextTurn else { return }
        await withCheckedContinuation { continuation in
            turnWaiters[turn.number] = continuation
        }
    }

    func releaseTurn(_ turn: OperationTurn?) {
        guard let turn, turn.number == nextTurn else { return }
        nextTurn += 1
        turnWaiters.removeValue(forKey: nextTurn)?.resume()
    }

    private func admit(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens?,
        timeout: TimeInterval?,
        turn: OperationTurn?,
        onQueued: (@Sendable () -> Void)? = nil
    ) async throws -> AnySendable {
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        let acceptsNewOps = isConnected && !drainingHeldOps && !socketRefusing
        if acceptsNewOps {
            return try await dispatchOp(
                method: method,
                params: params,
                actAs: actAs,
                timeout: timeout,
                turn: turn,
                holdable: canReopen,
                onQueued: onQueued
            )
        }
        guard canReopen else {
            try await connect()
            try ensureConnected()
            return try await dispatchOp(
                method: method,
                params: params,
                actAs: actAs,
                timeout: timeout,
                turn: turn,
                holdable: false,
                onQueued: onQueued
            )
        }
        let closedAfterAttach = hasEverAttached && connectionState == .closed
        if closedAfterAttach {
            throw PyricBridgeError.unavailable(connectionLostMessage)
        }
        return try await hold(
            method: method,
            params: params,
            actAs: actAs,
            timeout: timeout,
            turn: turn,
            onQueued: onQueued
        )
    }

    private func nextOpId() -> (id: String, sequence: Int) {
        opCounter += 1
        return ("rop-\(opCounter)", opCounter)
    }

    private func opPayload(method: String, params: [String: AnySendable], actAs: AuthLens?) -> [String: AnySendable] {
        var payload = params
        payload["method"] = .string(method)
        if let actAs {
            payload["actAs"] = actAs.toAnySendable()
        }
        return payload
    }

    func dispatchOp(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens?,
        timeout: TimeInterval?,
        turn: OperationTurn?,
        holdable: Bool,
        onQueued: (@Sendable () -> Void)? = nil
    ) async throws -> AnySendable {
        let (id, sequence) = nextOpId()
        let issuedAt = clock.now()
        let opTimeout = timeout ?? defaultOpTimeout
        let payload = opPayload(method: method, params: params, actAs: actAs)

        return try await withCheckedThrowingContinuation { continuation in
            self.registerPendingOp(
                id: id,
                sequence: sequence,
                issuedAt: issuedAt,
                holdable: holdable,
                method: method,
                payload: payload,
                timeout: opTimeout,
                continuation: continuation
            )
            self.writeAfterLastOp(id: id)
            self.releaseTurn(turn)
            onQueued?()
        }
    }

    private func writeAfterLastOp(id: String) {
        let previous = lastOpWrite
        lastOpWrite = Task {
            await previous?.value
            await self.sendOpFrame(id: id)
        }
    }

    private func isPending(_ id: String) -> Bool {
        pendingOps[id]?.write == .queued
    }

    private func registerPendingOp(
        id: String,
        sequence: Int,
        issuedAt: TimeInterval,
        holdable: Bool,
        method: String,
        payload: [String: AnySendable],
        timeout: TimeInterval,
        continuation: CheckedContinuation<AnySendable, Error>
    ) {
        let activeClock = clock
        let deadline = activeClock.now() + timeout
        let timeoutTask = Task { [weak self] in
            try? await activeClock.sleepUntil(deadline: deadline)
            if !Task.isCancelled {
                await self?.handleOpTimeout(id: id, timeout: timeout, method: method)
            }
        }
        pendingOps[id] = PendingOp(
            continuation: continuation,
            timeoutTask: timeoutTask,
            sequence: sequence,
            issuedAt: issuedAt,
            holdable: holdable,
            method: method,
            payload: payload,
            timeout: timeout
        )
    }

    private func sendOpFrame(id: String) async {
        guard isPending(id), var op = pendingOps[id] else { return }
        let canWrite = transport != nil && !isDisposed && !socketRefusing
        guard canWrite else {
            settleWrite(id: id, .refused(WebSocketSendRefusedError()))
            return
        }
        op.write = .writing
        pendingOps[id] = op
        do {
            try await sendRaw(WorkerOpFrame(id: id, op: op.payload))
            settleWrite(id: id, .written)
        } catch let error as WebSocketSendRefusedError {
            settleWrite(id: id, .refused(error))
        } catch {
            settleWrite(id: id, .failed(error))
        }
    }

    private func settleWrite(id: String, _ outcome: WriteOutcome) {
        guard let op = pendingOps[id] else { return }
        if op.write == .writingOnLostSocket {
            settleWriteOnLostSocket(id: id, outcome)
            return
        }
        switch outcome {
        case .written:
            pendingOps[id]?.write = .written
        case .refused(let error):
            refuse(id: id, error: error)
        case .failed(let error):
            failDispatch(id: id, error: error)
        }
    }

    private func settleWriteOnLostSocket(id: String, _ outcome: WriteOutcome) {
        guard let op = pendingOps.removeValue(forKey: id) else { return }
        if case .refused = outcome {
            holdAgain(id: id, op)
            return
        }
        op.timeoutTask.cancel()
        op.continuation.resume(throwing: PyricBridgeError.unavailable(connectionLostMessage))
    }

    private func refuse(id: String, error: Error) {
        guard let op = pendingOps[id], op.holdable else {
            failDispatch(id: id, error: error)
            return
        }
        socketRefusing = true
        pendingOps[id]?.write = .queued
        holdQueuedOperations()
    }

    func holdQueuedOperations() {
        for (id, op) in pendingOps where op.holdable && op.write == .queued {
            pendingOps.removeValue(forKey: id)
            holdAgain(id: id, op)
        }
    }

    func settlePendingOperationsAtDrop() {
        holdQueuedOperations()
        for (id, op) in pendingOps {
            let writeInProgress = op.holdable && op.write == .writing
            if writeInProgress {
                pendingOps[id]?.write = .writingOnLostSocket
                continue
            }
            if op.write == .writingOnLostSocket { continue }
            pendingOps.removeValue(forKey: id)
            op.timeoutTask.cancel()
            op.continuation.resume(throwing: PyricBridgeError.unavailable(connectionLostMessage))
        }
    }

    private func holdAgain(id: String, _ op: PendingOp) {
        op.timeoutTask.cancel()
        let remaining = holdDeadline - seconds(since: op.issuedAt)
        guard remaining > 0 else {
            op.continuation.resume(throwing: PyricBridgeError.unavailable(holdExpiredMessage))
            return
        }
        heldOps.insert(HeldOp(
            id: id,
            sequence: op.sequence,
            issuedAt: op.issuedAt,
            method: op.method,
            payload: op.payload,
            timeout: op.timeout,
            continuation: op.continuation,
            deadlineTask: holdDeadlineTask(id: id, after: remaining)
        ))
    }

    private func holdDeadlineTask(id: String, after seconds: TimeInterval) -> Task<Void, Never> {
        let activeClock = clock
        let deadline = activeClock.now() + seconds
        return Task { [weak self] in
            try? await activeClock.sleepUntil(deadline: deadline)
            guard !Task.isCancelled else { return }
            await self?.holdDeadlinePassed(id: id)
        }
    }

    private func hold(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens?,
        timeout: TimeInterval?,
        turn: OperationTurn?,
        onQueued: (@Sendable () -> Void)? = nil
    ) async throws -> AnySendable {
        let (id, sequence) = nextOpId()
        let issuedAt = clock.now()
        let opTimeout = timeout ?? defaultOpTimeout
        let payload = opPayload(method: method, params: params, actAs: actAs)

        return try await withCheckedThrowingContinuation { continuation in
            self.heldOps.insert(HeldOp(
                id: id,
                sequence: sequence,
                issuedAt: issuedAt,
                method: method,
                payload: payload,
                timeout: opTimeout,
                continuation: continuation,
                deadlineTask: self.holdDeadlineTask(id: id, after: self.holdDeadline)
            ))
            self.releaseTurn(turn)
            onQueued?()
            self.startAttemptIfIdle()
        }
    }

    func startAttemptIfIdle() {
        let attemptPending = attemptTask != nil || reconnectTask != nil
        guard !attemptPending, !isConnected else { return }
        startAttempt()
    }

    private func holdDeadlinePassed(id: String) {
        guard let held = heldOps.remove(id: id) else { return }
        held.continuation.resume(throwing: PyricBridgeError.unavailable(holdExpiredMessage))
    }

    func sendHeldOperations(generation: Int) async {
        await lastOpWrite?.value
        while isCurrent(generation), isConnected, !socketRefusing {
            let nextOpSeq = heldOps.firstSequence
            let nextSubSeq = deferredSubsDuringDrain.first?.sequence
            if let subSeq = nextSubSeq, nextOpSeq == nil || subSeq < nextOpSeq! {
                let deferred = deferredSubsDuringDrain.removeFirst()
                await sendSubFrame(id: deferred.subId, generation: generation)
                continue
            }
            guard let held = heldOps.popFirst() else { break }
            held.deadlineTask.cancel()
            registerPendingOp(
                id: held.id,
                sequence: held.sequence,
                issuedAt: held.issuedAt,
                holdable: true,
                method: held.method,
                payload: held.payload,
                timeout: held.timeout,
                continuation: held.continuation
            )
            await sendOpFrame(id: held.id)
        }
        if isCurrent(generation) {
            drainingHeldOps = false
        }
    }

    func failHeldOperations(code: FirestoreErrorCode, message: String) {
        for op in heldOps.removeAll() {
            op.deadlineTask.cancel()
            op.continuation.resume(throwing: PyricBridgeError(code: code, message: message))
        }
    }

    func failPendingOperations(code: FirestoreErrorCode, message: String) {
        let pending = pendingOps
        pendingOps.removeAll()
        for (_, op) in pending {
            op.timeoutTask.cancel()
            op.continuation.resume(throwing: PyricBridgeError(code: code, message: message))
        }
    }

    private func failDispatch(id: String, error: Error) {
        guard let pending = pendingOps.removeValue(forKey: id) else { return }
        pending.timeoutTask.cancel()
        pending.continuation.resume(
            throwing: PyricBridgeError.unavailable("Failed to dispatch op to bridge: \(error)")
        )
    }

    private func handleOpTimeout(id: String, timeout: TimeInterval, method: String) {
        guard let pending = pendingOps.removeValue(forKey: id) else { return }
        pending.continuation.resume(
            throwing: PyricBridgeError.deadlineExceeded(
                "Remote sandbox op timed out after \(Int(timeout * 1000))ms (op: \(method)). Is pyric sandbox still running?"
            )
        )
    }

    /// Lists all sandbox users via the auth.listUsers RPC.
    public func authListUsers() async throws -> [AnySendable] {
        let res = try await op(method: "auth.listUsers", params: [:])
        return res.arrayValue ?? []
    }
}
