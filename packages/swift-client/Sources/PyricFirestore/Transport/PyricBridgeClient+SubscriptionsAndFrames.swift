import Foundation

extension PyricBridgeClient {

    // -- Streaming Subscriptions --

    /// Establishes a real-time subscription for a document or query target.
    public nonisolated func subscribe(
        target: AnySendable,
        actAs: AnySendable? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) -> PyricSubscriptionStream {
        PyricSubscriptionStream(
            client: self,
            target: target,
            actAs: actAs,
            includeMetadataChanges: includeMetadataChanges,
            listenSource: listenSource
        )
    }

    public nonisolated func subscribe(
        target: TargetDescriptor,
        actAs: AuthLens? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) -> PyricSubscriptionStream {
        subscribe(
            target: target.toAnySendable(),
            actAs: actAs?.toAnySendable(),
            includeMetadataChanges: includeMetadataChanges,
            listenSource: listenSource
        )
    }

    public nonisolated func subscribe(
        target: [String: Any],
        actAs: AnySendable? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) -> PyricSubscriptionStream {
        subscribe(
            target: AnySendable.from(target),
            actAs: actAs,
            includeMetadataChanges: includeMetadataChanges,
            listenSource: listenSource
        )
    }

    /// Explicitly unregisters an active subscription and dispatches a worker-unsub frame.
    public func unsubscribe(subId: String) async {
        await unregisterSubscription(subId: subId)
    }

    /// Synchronously reserves a subscription id, creation sequence, and admission
    /// turn before returning, then schedules actor admission in turn order.
    nonisolated func openSubscription(
        target: AnySendable,
        actAs: AnySendable?,
        includeMetadataChanges: Bool,
        listenSource: String?,
        continuation: AsyncThrowingStream<BridgeSubscriptionEvent, Error>.Continuation
    ) -> (subId: String, task: Task<Void, Never>)? {
        if localStreams.isDisposed {
            continuation.finish(
                throwing: PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
            )
            return nil
        }
        let turn = turnCounter.take()
        let subId = pendingSubs.reserve(
            target: target,
            actAs: actAs,
            includeMetadataChanges: includeMetadataChanges,
            listenSource: listenSource,
            continuation: continuation
        )
        let task: Task<Void, Never> = Task { [weak self] in
            await self?.admitSubscription(id: subId, turn: turn)
        }
        return (subId: subId, task: task)
    }

    nonisolated func cancelPendingSubscription(subId: String) -> Bool {
        pendingSubs.cancelIfPending(id: subId)
    }

    func drainPendingSubscriptions() {
        for (subId, sub) in pendingSubs.drainAllSorted() {
            if activeSubs[subId] == nil {
                activeSubs[subId] = sub
            }
        }
    }

    func admitSubscription(id subId: String, turn: OperationTurn) async {
        await waitForTurn(turn)
        if isDisposed {
            if let pending = pendingSubs.take(id: subId) {
                pending.continuation.finish(
                    throwing: PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
                )
            }
            releaseTurn(turn)
            return
        }
        if let pending = pendingSubs.take(id: subId) {
            activeSubs[subId] = pending
        }
        guard let sub = activeSubs[subId] else {
            releaseTurn(turn)
            return
        }

        if isConnected && !restoringSubscriptions && !drainingHeldOps && !socketRefusing {
            if sub.sentInGeneration != connectionGeneration {
                writeSubAfterLastOp(id: subId, generation: connectionGeneration)
            }
            releaseTurn(turn)
            return
        }
        if isConnected && !restoringSubscriptions && drainingHeldOps && !socketRefusing {
            if sub.sentInGeneration != connectionGeneration {
                opCounter += 1
                deferredSubsDuringDrain.append((sequence: opCounter, subId: subId))
            }
            releaseTurn(turn)
            return
        }
        if isConnected && restoringSubscriptions {
            releaseTurn(turn)
            return
        }
        if hasEverAttached && canReopen {
            if connectionState == .closed {
                activeSubs.removeValue(forKey: subId)
                sub.continuation.finish(throwing: PyricBridgeError.unavailable(connectionLostMessage))
            }
            releaseTurn(turn)
            return
        }
        if retryInitialConnection {
            releaseTurn(turn)
            startAttemptIfIdle()
            return
        }
        releaseTurn(turn)
        do {
            try await connect()
        } catch {
            if let removed = activeSubs.removeValue(forKey: subId) {
                removed.continuation.finish(throwing: error)
            }
        }
    }

    private func writeSubAfterLastOp(id: String, generation: Int) {
        let previous = lastOpWrite
        lastOpWrite = Task {
            await previous?.value
            await self.sendSubFrame(id: id, generation: generation)
        }
    }

    func sendSubFrame(id subId: String, generation: Int) async {
        guard isCurrent(generation), isConnected, !restoringSubscriptions, !socketRefusing else {
            return
        }
        guard var sub = activeSubs[subId], sub.sentInGeneration != generation else {
            return
        }
        sub.sentInGeneration = generation
        activeSubs[subId] = sub
        do {
            try await sendRaw(WorkerSubFrame(subId: subId, sub: sub.payload))
        } catch is WebSocketSendRefusedError where canReopen {
            if activeSubs[subId]?.sentInGeneration == generation {
                activeSubs[subId]?.sentInGeneration = nil
            }
            if isCurrent(generation) {
                socketRefusing = true
                holdQueuedOperations()
            }
        } catch {
            if activeSubs[subId]?.sentInGeneration == generation,
               let removed = activeSubs.removeValue(forKey: subId) {
                removed.continuation.finish(throwing: error)
            }
        }
    }

    func unregisterSubscription(subId: String) async {
        if pendingSubs.cancelIfPending(id: subId) {
            return
        }
        deferredSubsDuringDrain.removeAll { $0.subId == subId }
        guard let removed = activeSubs.removeValue(forKey: subId) else { return }
        if removed.sentInGeneration == connectionGeneration && isConnected && !isDisposed {
            try? await sendRaw(WorkerUnsubFrame(subId: subId))
        }
    }

    // -- Incoming Message Processing & Event Loop --

    func receiveLoop(generation: Int, transport: any WebSocketTransport) async {
        while !Task.isCancelled && isCurrent(generation) {
            do {
                let rawText = try await transport.receive()
                guard isCurrent(generation) else { break }
                lastFrameAt = clock.now()
                receivedFrameCount += 1
                handleMessage(rawText, generation: generation)
            } catch {
                handleConnectionLoss(
                    generation: generation,
                    error: PyricBridgeError.unavailable("WebSocket connection error: \(error)"),
                    closeCode: (error as? WebSocketCloseError)?.closeCode
                )
                break
            }
        }
    }

    private func handleMessage(_ raw: String, generation: Int) {
        guard let data = raw.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = json["type"]?.stringValue else {
            return
        }

        switch type {
        case "attach-ack":
            handleAttachAck(json, generation: generation)
        case "worker-res":
            handleWorkerRes(json)
        case "worker-snap":
            handleWorkerSnap(json)
        case "worker-event":
            handleWorkerEvent(json)
        case "ping":
            handlePing(json)
        case "pong":
            break
        default:
            break
        }
    }

    private func handleWorkerEvent(_ msg: AnySendable) {
        guard let event = msg["event"]?.stringValue, event == "remote-lens" else { return }
        let lensData = msg["lens"] ?? msg["payload"]?["lens"] ?? msg["payload"]
        guard let lensData, let mode = lensData["mode"]?.stringValue else { return }

        let lens: AuthLens
        switch mode {
        case "admin":
            lens = .admin
        case "anon":
            lens = .anon
        case "app-session":
            lens = .appSession
        case "as":
            let uid = lensData["uid"]?.stringValue ?? ""
            let tenant = lensData["tenant"]?.stringValue
            let token = lensData["token"]?.dictionaryValue
            lens = .asUser(uid: uid, tenant: tenant, token: token)
        default:
            return
        }

        localStreams.yieldRemoteLens(lens)
    }

    private func handleAttachAck(_ msg: AnySendable, generation: Int) {
        guard handshakeContinuation != nil else { return }
        let peerConnected = msg["peerConnected"]?.boolValue ?? false
        guard peerConnected else {
            handleConnectionLoss(
                generation: generation,
                error: PyricBridgeError.unavailable(
                    "No browser tab is connected to the sandbox; open pyric sandbox in a browser and retry."
                ),
                closeCode: nil
            )
            return
        }
        if let ackSessionId = msg["clientSessionId"]?.stringValue ?? msg["sessionId"]?.stringValue {
            clientSessionId = ackSessionId
        }
        let ackHostId = msg["hostInstanceId"]?.stringValue
        let changedHost = hasEverAttached && hostInstanceId != nil && ackHostId != nil && ackHostId != hostInstanceId
        if let ackHostId { hostInstanceId = ackHostId }
        if changedHost { needsAuthRestore = true }
        resumeHandshake(returning: .success(needsAuthRestore))
    }

    private func handleWorkerRes(_ msg: AnySendable) {
        guard let id = msg["id"]?.stringValue,
              let pending = pendingOps.removeValue(forKey: id) else {
            return
        }
        pending.timeoutTask.cancel()

        let ok = msg["ok"]?.boolValue ?? false
        if ok {
            let result = msg["value"] ?? msg["res"] ?? .null
            pending.continuation.resume(returning: result)
        } else {
            let errorObj = msg["error"] ?? msg["err"]
            let code = errorObj?["code"]?.stringValue ?? "unknown"
            let message = errorObj?["message"]?.stringValue ?? "unknown sandbox error"
            let denialContext = errorObj?["denialContext"]
            let envelope = errorObj?["envelope"]

            let error = PyricBridgeError.fromCode(
                code: code,
                message: message,
                denialContext: denialContext,
                envelope: envelope
            )
            if denialContext != nil || error.code == .permissionDenied {
                localStreams.yieldDenial(error)
            }
            pending.continuation.resume(throwing: error)
        }
    }

    private func handleWorkerSnap(_ msg: AnySendable) {
        guard let subId = msg["subId"]?.stringValue,
              var sub = activeSubs[subId],
              let value = msg["value"] ?? msg["res"] else {
            return
        }

        let errObj = value["__error"] ?? msg["error"] ?? msg["err"]
        if let errObj {
            activeSubs.removeValue(forKey: subId)
            if isConnected && !isDisposed {
                Task { [weak self] in
                    try? await self?.sendRaw(WorkerUnsubFrame(subId: subId))
                }
            }
            let code = errObj["code"]?.stringValue ?? "permission-denied"
            let message = errObj["message"]?.stringValue ?? "Subscription error"
            let denialContext = errObj["denialContext"]

            let error = PyricBridgeError.fromCode(
                code: code,
                message: message,
                denialContext: denialContext
            )
            if denialContext != nil || error.code == .permissionDenied {
                localStreams.yieldDenial(error)
            }
            sub.continuation.finish(throwing: error)
            return
        }

        if sub.awaitsRestoredValue {
            sub.awaitsRestoredValue = false
            let unchanged = sub.lastValue == value
            if unchanged && !sub.includeMetadataChanges {
                activeSubs[subId] = sub
                return
            }
        }
        sub.lastValue = value
        activeSubs[subId] = sub
        sub.continuation.yield(.value(value))
    }

    private func handlePing(_ msg: AnySendable) {
        guard let id = msg["id"]?.stringValue else { return }
        Task { [weak self] in
            try? await self?.sendRaw(PongFrame(id: id))
        }
    }

    func failSubscriptions(code: FirestoreErrorCode, message: String) {
        let subs = activeSubs
        activeSubs.removeAll()
        for (_, sub) in subs {
            sub.continuation.finish(throwing: PyricBridgeError(code: code, message: message))
        }
    }

    func sendRaw<T: Encodable>(_ message: T) async throws {
        guard let transport, !isDisposed else {
            throw PyricBridgeError.unavailable("Cannot send message: WebSocket is closed.")
        }
        let data = try JSONEncoder().encode(message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw PyricBridgeError.internalError("Failed to encode frame to UTF-8")
        }
        try await transport.send(text)
    }

    // -- Heartbeat --

    func startHeartbeat(generation: Int) {
        heartbeatTask?.cancel()
        let activeClock = clock
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = await self?.heartbeatTick(generation: generation) else { return }
                try? await activeClock.sleep(seconds: delay)
            }
        }
    }

    func stopHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    private func heartbeatTick(generation: Int) async -> TimeInterval? {
        guard isCurrent(generation), isConnected else { return nil }
        if seconds(since: lastFrameAt) >= livenessTimeout {
            dropSilentConnection(generation: generation)
            return nil
        }
        pingCounter += 1
        try? await sendRaw(PingFrame(id: "hb-\(pingCounter)"))
        let untilTimeout = livenessTimeout - seconds(since: lastFrameAt)
        return max(0, min(heartbeatInterval, untilTimeout))
    }

    private func dropSilentConnection(generation: Int) {
        let silentTransport = transport
        handleConnectionLoss(
            generation: generation,
            error: PyricBridgeError.unavailable(silentHostMessage),
            closeCode: nil
        )
        if !canReopen, let silentTransport {
            Task { await silentTransport.close(closeCode: 1000, reason: "No frame received") }
        }
    }

    func ensureConnected() throws {
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if !isConnected {
            throw PyricBridgeError.unavailable("PyricBridgeClient is not connected. Call connect() first.")
        }
    }
}
