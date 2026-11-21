import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricFirestore

/// Dedicated WebSocket bridge actor for one `Messaging` instance, multiplexing
/// `messaging.*` unary operations and `messaging.foreground` / `messaging.background`
/// delivery subscriptions with per-app `recipientId` and client visibility isolation.
package actor MessagingBridgeSession {
    private struct PendingUnary {
        let continuation: CheckedContinuation<AnySendable, any Error>
        let timeoutTask: Task<Void, Never>
    }

    private let fixedTransport: (any WebSocketTransport)?
    private let wireRecipientID: String?
    private let observerState: @Sendable () -> (wantsForeground: Bool, wantsBackground: Bool)
    private let onDelivery: @Sendable (RemoteMessagingMessage) -> Void
    private let onSubscriptionError: @Sendable (MessagingError) -> Void

    private var activeEndpoint: URL?
    private var activeHeaders: [String: String] = [:]
    private var transport: (any WebSocketTransport)?
    private var receiveTask: Task<Void, Never>?
    private var attachTask: Task<Void, any Error>?
    private var attachContinuation: CheckedContinuation<Void, any Error>?
    private var isAttached = false
    private var isDisconnecting = false
    private var isDisposed = false
    private var connectionGeneration = 0
    private var clientSessionId: String?
    private var opCounter = 0
    private var subCounter = 0

    private var foregroundSubID: String?
    private var backgroundSubID: String?
    private var pendingOps: [String: PendingUnary] = [:]

    package init(
        fixedTransport: (any WebSocketTransport)?,
        wireRecipientID: String?,
        observerState: @escaping @Sendable () -> (wantsForeground: Bool, wantsBackground: Bool),
        onDelivery: @escaping @Sendable (RemoteMessagingMessage) -> Void,
        onSubscriptionError: @escaping @Sendable (MessagingError) -> Void
    ) {
        self.fixedTransport = fixedTransport
        self.wireRecipientID = wireRecipientID
        self.observerState = observerState
        self.onDelivery = onDelivery
        self.onSubscriptionError = onSubscriptionError
    }

    package func unaryOp(
        endpoint: URL,
        headers: [String: String],
        method: String,
        params: [String: AnySendable],
        timeout: TimeInterval = 30.0
    ) async throws -> AnySendable {
        try await ensureAttached(endpoint: endpoint, headers: headers)
        try await flushSubscriptionIntent()

        opCounter += 1
        let id = "msg-op-\(opCounter)"
        var payload = params
        payload["method"] = .string(method)

        let opFrame = WorkerOpFrame(id: id, op: payload)
        let effectiveTimeout = max(0.1, timeout)
        let nanos = UInt64((effectiveTimeout * 1_000_000_000.0).rounded())

        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: nanos)
                if !Task.isCancelled {
                    await self?.failTimedOutOp(id: id, method: method, timeout: effectiveTimeout)
                }
            }
            self.pendingOps[id] = PendingUnary(continuation: continuation, timeoutTask: timeoutTask)
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.sendEncoded(opFrame)
                } catch {
                    await self.failDispatchedOp(id: id, error: MessagingError.from(error))
                }
            }
        }
    }

    package func syncSubscriptions(endpoint: URL, headers: [String: String]) async throws {
        if isDisposed || isDisconnecting { return }
        let intent = observerState()
        if !intent.wantsForeground && !intent.wantsBackground && !isAttached {
            return
        }
        try await ensureAttached(endpoint: endpoint, headers: headers)
        try await flushSubscriptionIntent()
    }

    package func reconfigureEndpoint(endpoint: URL, headers: [String: String]) async {
        guard !isDisposed, fixedTransport == nil else { return }
        if isAttached, (activeEndpoint != endpoint || activeHeaders != headers) {
            let stale = tearDownCurrentSocket(
                error: MessagingError(code: .network, message: "Messaging bridge endpoint reconfigured.")
            )
            await stale?.close(closeCode: 1000, reason: "Endpoint reconfigured")
        }
        activeEndpoint = endpoint
        activeHeaders = headers
        let intent = observerState()
        if intent.wantsForeground || intent.wantsBackground {
            try? await ensureAttached(endpoint: endpoint, headers: headers)
            try? await flushSubscriptionIntent()
        }
    }

    package func disconnect() async {
        if isDisposed || isDisconnecting { return }
        isDisconnecting = true
        if isAttached {
            let fg = foregroundSubID
            let bg = backgroundSubID
            foregroundSubID = nil
            backgroundSubID = nil
            if let fg {
                try? await sendEncoded(WorkerUnsubFrame(subId: fg))
            }
            if let bg {
                try? await sendEncoded(WorkerUnsubFrame(subId: bg))
            }
        }
        isDisposed = true
        let closing = tearDownCurrentSocket(
            error: MessagingError(code: .network, message: "Messaging bridge session disconnected.")
        )
        await closing?.close(closeCode: 1000, reason: "Messaging client disconnect")
    }

    // MARK: - Subscription & Socket Plumbing

    private func flushSubscriptionIntent() async throws {
        guard isAttached && !isDisposed else { return }
        let intent = observerState()

        if intent.wantsForeground && foregroundSubID == nil {
            subCounter += 1
            let subId = "msg-fg-\(subCounter)"
            foregroundSubID = subId
            do {
                try await sendEncoded(
                    WorkerSubFrame(subId: subId, sub: buildSubPayload(target: "messaging.foreground"))
                )
            } catch {
                foregroundSubID = nil
                throw MessagingError.from(error)
            }
        } else if !intent.wantsForeground, let activeFg = foregroundSubID {
            foregroundSubID = nil
            try? await sendEncoded(WorkerUnsubFrame(subId: activeFg))
        }

        if intent.wantsBackground && backgroundSubID == nil {
            subCounter += 1
            let subId = "msg-bg-\(subCounter)"
            backgroundSubID = subId
            do {
                try await sendEncoded(
                    WorkerSubFrame(subId: subId, sub: buildSubPayload(target: "messaging.background"))
                )
            } catch {
                backgroundSubID = nil
                throw MessagingError.from(error)
            }
        } else if !intent.wantsBackground, let activeBg = backgroundSubID {
            backgroundSubID = nil
            try? await sendEncoded(WorkerUnsubFrame(subId: activeBg))
        }
    }

    private func buildSubPayload(target: String) -> [String: AnySendable] {
        var payload: [String: AnySendable] = ["target": .string(target)]
        if let wireRecipientID {
            payload["recipientId"] = .string(wireRecipientID)
        }
        return payload
    }

    private func ensureAttached(endpoint: URL, headers: [String: String]) async throws {
        if isDisposed {
            throw MessagingError(code: .network, message: "Messaging bridge session has been disposed.")
        }
        if fixedTransport == nil,
           (isAttached || attachTask != nil),
           (activeEndpoint != endpoint || activeHeaders != headers) {
            let stale = tearDownCurrentSocket(
                error: MessagingError(code: .network, message: "Messaging bridge endpoint reconfigured.")
            )
            await stale?.close(closeCode: 1000, reason: "Endpoint reconfigured")
        }
        if isAttached, transport != nil {
            return
        }
        if let existingAttach = attachTask {
            try await existingAttach.value
            return
        }

        connectionGeneration += 1
        let generation = connectionGeneration
        let opened: any WebSocketTransport
        if let fixedTransport {
            opened = fixedTransport
        } else {
            let request = PyricBridgeClient.makeWebSocketRequest(url: endpoint, headers: headers)
            opened = URLSessionWebSocketTransport(request: request)
        }
        self.transport = opened
        self.activeEndpoint = endpoint
        self.activeHeaders = headers
        self.isAttached = false

        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(generation: generation, transport: opened)
        }

        let createdAttach = Task<Void, any Error> { [weak self] in
            guard let self else {
                throw MessagingError(code: .network, message: "Messaging bridge session deallocated.")
            }
            try await self.awaitAttachHandshake(generation: generation)
        }
        self.attachTask = createdAttach
        do {
            try await createdAttach.value
        } catch {
            if self.connectionGeneration == generation {
                self.attachTask = nil
            }
            throw error
        }
    }

    private func awaitAttachHandshake(generation: Int) async throws {
        if isAttached && generation == connectionGeneration {
            return
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            guard generation == self.connectionGeneration && !self.isDisposed else {
                continuation.resume(
                    throwing: MessagingError(code: .network, message: "Messaging bridge session closed during attach.")
                )
                return
            }
            if self.isAttached {
                continuation.resume()
                return
            }
            self.attachContinuation = continuation
            let frame = AttachFrame(
                clientSessionId: self.clientSessionId,
                clientInfo: ClientInfo(platform: "swift", deviceLabel: "pyric-messaging")
            )
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.sendEncoded(frame)
                } catch {
                    await self.handleSocketLoss(
                        generation: generation,
                        error: MessagingError(
                            code: .network,
                            message: "Failed to attach to Pyric Messaging bridge: \(error)"
                        )
                    )
                }
            }
        }
    }

    private func receiveLoop(generation: Int, transport: any WebSocketTransport) async {
        while !Task.isCancelled && generation == connectionGeneration && !isDisposed {
            do {
                let rawText = try await transport.receive()
                guard generation == connectionGeneration && !isDisposed else { break }
                handleInboundText(rawText, generation: generation)
            } catch {
                handleSocketLoss(
                    generation: generation,
                    error: MessagingError(
                        code: .network,
                        message: "Messaging WebSocket connection closed: \(error)"
                    )
                )
                break
            }
        }
    }

    private func handleInboundText(_ raw: String, generation: Int) {
        guard let data = raw.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = json["type"]?.stringValue else {
            return
        }

        switch type {
        case "attach-ack":
            guard let attachCont = attachContinuation else { return }
            attachContinuation = nil
            attachTask = nil
            let peerConnected = json["peerConnected"]?.boolValue ?? false
            guard peerConnected else {
                let err = MessagingError(
                    code: .network,
                    message: "No sandbox peer connected to Pyric Messaging bridge."
                )
                attachCont.resume(throwing: err)
                handleSocketLoss(generation: generation, error: err)
                return
            }
            if let sid = json["clientSessionId"]?.stringValue ?? json["sessionId"]?.stringValue {
                clientSessionId = sid
            }
            isAttached = true
            attachCont.resume()

        case "ping":
            if let id = json["id"]?.stringValue {
                Task { [weak self] in
                    try? await self?.sendEncoded(PongFrame(id: id))
                }
            }

        case "worker-res":
            guard let id = json["id"]?.stringValue,
                  let pending = pendingOps.removeValue(forKey: id) else {
                return
            }
            pending.timeoutTask.cancel()
            if json["ok"]?.boolValue == true {
                let val = json["value"] ?? json["res"] ?? .null
                pending.continuation.resume(returning: val)
            } else {
                let errObj = json["error"] ?? json["err"] ?? .null
                pending.continuation.resume(throwing: MessagingError.fromWireError(errObj))
            }

        case "worker-snap":
            guard let subId = json["subId"]?.stringValue,
                  let value = json["value"] ?? json["res"] else {
                return
            }
            let route: MessagingDeliveryRoute
            if subId == foregroundSubID {
                route = .foreground
            } else if subId == backgroundSubID {
                route = .background
            } else {
                return
            }
            if let errObj = value["__error"] ?? json["error"] ?? json["err"] {
                onSubscriptionError(MessagingError.fromWireError(errObj))
                return
            }
            if let decoded = RemoteMessagingMessage.fromDeliveredPayload(
                value,
                route: route,
                subscriptionID: subId
            ) {
                onDelivery(decoded)
            }

        default:
            break
        }
    }

    private func sendEncoded<T: Encodable>(_ frame: T) async throws {
        guard let transport, !isDisposed else {
            throw MessagingError(code: .network, message: "Messaging bridge WebSocket is not connected.")
        }
        let data = try JSONEncoder().encode(frame)
        guard let text = String(data: data, encoding: .utf8) else {
            throw MessagingError(code: .unknown, message: "Failed to UTF-8 encode Messaging bridge frame.")
        }
        try await transport.send(text)
    }

    private func failTimedOutOp(id: String, method: String, timeout: TimeInterval) {
        guard let pending = pendingOps.removeValue(forKey: id) else { return }
        pending.continuation.resume(
            throwing: MessagingError(
                code: .timeout,
                message: "Messaging operation \(method) timed out after \(Int(timeout * 1000))ms."
            )
        )
    }

    private func failDispatchedOp(id: String, error: MessagingError) {
        guard let pending = pendingOps.removeValue(forKey: id) else { return }
        pending.timeoutTask.cancel()
        pending.continuation.resume(throwing: error)
    }

    private func handleSocketLoss(generation: Int, error: MessagingError) {
        guard generation == connectionGeneration else { return }
        let closing = tearDownCurrentSocket(error: error)
        if fixedTransport == nil, let closing {
            Task { await closing.close(closeCode: 1000, reason: "Socket lost") }
        }
    }

    private func tearDownCurrentSocket(error: MessagingError) -> (any WebSocketTransport)? {
        connectionGeneration += 1
        isAttached = false
        foregroundSubID = nil
        backgroundSubID = nil
        attachTask = nil
        receiveTask?.cancel()
        receiveTask = nil

        if let attachCont = attachContinuation {
            attachContinuation = nil
            attachCont.resume(throwing: error)
        }

        let ops = pendingOps
        pendingOps.removeAll()
        for (_, op) in ops {
            op.timeoutTask.cancel()
            op.continuation.resume(throwing: error)
        }

        let closing = transport
        if fixedTransport == nil {
            transport = nil
        }
        return closing
    }
}
