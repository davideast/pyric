import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricAppCheck
import PyricFirestore

// MARK: - In-Memory opWithAppCheck Probe

/// Zero-socket in-memory channel extracting the App Check token `PyricBridgeClient.opWithAppCheck`
/// attaches for a `FirebaseApp` without mutating `AppCheck` singleton state when uninitialized.
private final class InMemoryAppCheckProbeChannel: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inboundQueue: [String] = []
    private var waiters: [CheckedContinuation<String, any Error>] = []
    private var closed = false
    private var capturedToken: String?

    func send(_ string: String) async throws {
        guard let data = string.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = frame["type"]?.stringValue else {
            return
        }
        if type == "attach" {
            enqueue("{\"type\":\"attach-ack\",\"protocol\":1,\"peerConnected\":true,\"clientSessionId\":\"ai-probe\"}")
        } else if type == "worker-op" {
            let id = frame["id"]?.stringValue ?? "rop-1"
            let token = frame["op"]?["appCheckToken"]?.stringValue
            recordCapturedToken(token)
            enqueue("{\"type\":\"worker-res\",\"id\":\"\(id)\",\"ok\":true,\"value\":null}")
        } else if type == "ping", let id = frame["id"]?.stringValue {
            enqueue("{\"type\":\"pong\",\"id\":\"\(id)\"}")
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if closed {
                lock.unlock()
                continuation.resume(throwing: CancellationError())
                return
            }
            if !inboundQueue.isEmpty {
                let next = inboundQueue.removeFirst()
                lock.unlock()
                continuation.resume(returning: next)
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func close(closeCode: Int, reason: String?) async {
        _ = closeCode
        _ = reason
        let pending: [CheckedContinuation<String, any Error>] = {
            lock.lock()
            defer { lock.unlock() }
            closed = true
            let current = waiters
            waiters.removeAll()
            return current
        }()
        for waiter in pending {
            waiter.resume(throwing: CancellationError())
        }
    }

    func takeCapturedToken() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return capturedToken
    }

    private func recordCapturedToken(_ token: String?) {
        lock.lock()
        capturedToken = token
        lock.unlock()
    }

    private func enqueue(_ raw: String) {
        let waiter: CheckedContinuation<String, any Error>? = {
            lock.lock()
            defer { lock.unlock() }
            if !waiters.isEmpty {
                return waiters.removeFirst()
            }
            inboundQueue.append(raw)
            return nil
        }()
        waiter?.resume(returning: raw)
    }
}

package enum AiAppCheckResolver {
    package struct ResolvedClaim: Sendable {
        let claimObject: AnySendable?
        let attachedToken: String?
    }

    package static func resolve(
        app: FirebaseApp,
        useLimitedUseTokens: Bool,
        enforceAppCheck: Bool
    ) async throws -> ResolvedClaim {
        let probeChannel = InMemoryAppCheckProbeChannel()
        let probeClient = PyricBridgeClient(channel: probeChannel)
        _ = try? await probeClient.opWithAppCheck(app: app, method: "ai.probe", params: [:])
        let standardToken = probeChannel.takeCapturedToken()
        await probeClient.disconnect()

        if let standardToken {
            if useLimitedUseTokens {
                guard let appCheckInstance = AppCheck.appCheck(app: app) else {
                    return ResolvedClaim(
                        claimObject: .dictionary(["token": .string(standardToken)]),
                        attachedToken: standardToken
                    )
                }
                let limited = try await appCheckInstance.limitedUseToken()
                return ResolvedClaim(
                    claimObject: .dictionary(["token": .string(limited.token)]),
                    attachedToken: limited.token
                )
            }
            return ResolvedClaim(
                claimObject: .dictionary(["token": .string(standardToken)]),
                attachedToken: standardToken
            )
        }

        if enforceAppCheck {
            return ResolvedClaim(
                claimObject: .dictionary(["token": .null]),
                attachedToken: nil
            )
        }
        return ResolvedClaim(claimObject: nil, attachedToken: nil)
    }
}

// MARK: - Dedicated AI WebSocket Session

/// Actor managing unary `worker-op` (`ai.generateContent`, `ai.countTokens`) and finite streaming
/// `worker-sub` (`target: { service: "ai", op: "streamGenerateContent" }`) frames over the Pyric bridge.
package actor AiBridgeSession {
    private struct PendingUnary {
        let continuation: CheckedContinuation<AnySendable, any Error>
        let timeoutTask: Task<Void, Never>
    }

    private let fixedTransport: (any WebSocketTransport)?
    private var activeEndpoint: URL?
    private var activeHeaders: [String: String] = [:]
    private var transport: (any WebSocketTransport)?
    private var receiveTask: Task<Void, Never>?
    private var attachContinuation: CheckedContinuation<Void, any Error>?
    private var isAttached = false
    private var isDisposed = false
    private var connectionGeneration = 0
    private var clientSessionId: String?
    private var opCounter = 0
    private var subCounter = 0

    private var pendingOps: [String: PendingUnary] = [:]
    private var activeStreams: [String: AsyncThrowingStream<AnySendable, any Error>.Continuation] = [:]

    package init(fixedTransport: (any WebSocketTransport)? = nil) {
        self.fixedTransport = fixedTransport
    }

    package func unaryOp(
        endpoint: URL,
        headers: [String: String],
        method: String,
        model: String,
        request: AnySendable,
        engine: PyricAIEngineConfig?,
        appCheck: AiAppCheckResolver.ResolvedClaim,
        timeout: TimeInterval
    ) async throws -> AnySendable {
        try await ensureAttached(endpoint: endpoint, headers: headers)
        opCounter += 1
        let id = "ai-op-\(opCounter)"
        var payload: [String: AnySendable] = [
            "method": .string(method),
            "model": .string(model),
            "request": request,
        ]
        if let engine {
            payload["engine"] = engine.toAnySendable()
        }
        if let claim = appCheck.claimObject {
            payload["appCheck"] = claim
        }
        if let token = appCheck.attachedToken {
            payload["appCheckToken"] = .string(token)
        }

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
                    await self.failDispatchedOp(id: id, error: error)
                }
            }
        }
    }

    package func openStream(
        endpoint: URL,
        headers: [String: String],
        model: String,
        request: AnySendable,
        engine: PyricAIEngineConfig?,
        appCheck: AiAppCheckResolver.ResolvedClaim,
        continuation: AsyncThrowingStream<AnySendable, any Error>.Continuation
    ) async throws -> String {
        try await ensureAttached(endpoint: endpoint, headers: headers)
        subCounter += 1
        let subId = "ai-sub-\(subCounter)"
        var subPayload: [String: AnySendable] = [
            "target": .dictionary([
                "service": .string("ai"),
                "op": .string("streamGenerateContent"),
            ]),
            "model": .string(model),
            "request": request,
        ]
        if let engine {
            subPayload["engine"] = engine.toAnySendable()
        }
        if let claim = appCheck.claimObject {
            subPayload["appCheck"] = claim
        }
        if let token = appCheck.attachedToken {
            subPayload["appCheckToken"] = .string(token)
        }

        activeStreams[subId] = continuation
        do {
            try await sendEncoded(WorkerSubFrame(subId: subId, sub: subPayload))
            return subId
        } catch {
            activeStreams.removeValue(forKey: subId)
            throw error
        }
    }

    package func cancelStream(subId: String) async {
        guard activeStreams.removeValue(forKey: subId) != nil else { return }
        if isAttached && !isDisposed {
            try? await sendEncoded(WorkerUnsubFrame(subId: subId))
        }
    }

    package func disconnect() async {
        isDisposed = true
        let closing = tearDownCurrentSocket(
            error: BackendError(
                httpResponseCode: 503,
                message: "AI bridge session disconnected.",
                status: .unavailable
            )
        )
        await closing?.close(closeCode: 1000, reason: "AI client disconnect")
    }

    // MARK: - Connection & Frame Loop

    private func ensureAttached(endpoint: URL, headers: [String: String]) async throws {
        if isDisposed {
            throw BackendError(
                httpResponseCode: 503,
                message: "AI bridge session has been disposed.",
                status: .unavailable
            )
        }
        if fixedTransport == nil,
           isAttached,
           (activeEndpoint != endpoint || activeHeaders != headers) {
            let stale = tearDownCurrentSocket(
                error: BackendError(
                    httpResponseCode: 503,
                    message: "AI bridge endpoint reconfigured.",
                    status: .unavailable
                )
            )
            await stale?.close(closeCode: 1000, reason: "Endpoint reconfigured")
        }
        if isAttached, transport != nil {
            return
        }

        connectionGeneration += 1
        let generation = connectionGeneration
        let opened: any WebSocketTransport
        if let fixedTransport {
            opened = fixedTransport
        } else {
            let urlRequest = PyricBridgeClient.makeWebSocketRequest(url: endpoint, headers: headers)
            opened = URLSessionWebSocketTransport(request: urlRequest)
        }
        self.transport = opened
        self.activeEndpoint = endpoint
        self.activeHeaders = headers
        self.isAttached = false

        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(generation: generation, transport: opened)
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            self.attachContinuation = continuation
            let frame = AttachFrame(
                clientSessionId: self.clientSessionId,
                clientInfo: ClientInfo(platform: "swift", deviceLabel: "pyric-ai")
            )
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.sendEncoded(frame)
                } catch {
                    await self.handleSocketLoss(
                        generation: generation,
                        error: BackendError(
                            httpResponseCode: 503,
                            message: "Failed to attach to Pyric AI bridge: \(error)",
                            status: .unavailable
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
                    error: BackendError(
                        httpResponseCode: 503,
                        message: "WebSocket connection closed: \(error)",
                        status: .unavailable
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
            let peerConnected = json["peerConnected"]?.boolValue ?? false
            guard peerConnected else {
                let err = BackendError(
                    httpResponseCode: 503,
                    message: "No sandbox peer connected to Pyric bridge.",
                    status: .unavailable
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
                pending.continuation.resume(throwing: Self.decodeWireError(errObj))
            }

        case "worker-snap":
            guard let subId = json["subId"]?.stringValue,
                  let streamCont = activeStreams[subId],
                  let value = json["value"] ?? json["res"] else {
                return
            }
            if let errObj = value["__error"] ?? json["error"] ?? json["err"] {
                activeStreams.removeValue(forKey: subId)
                streamCont.finish(throwing: Self.decodeWireError(errObj))
                return
            }
            if value["done"]?.boolValue == true {
                activeStreams.removeValue(forKey: subId)
                streamCont.finish()
                return
            }
            if let chunk = value["chunk"] {
                streamCont.yield(chunk)
            }

        default:
            break
        }
    }

    package static func decodeWireError(_ errorObj: AnySendable) -> BackendError {
        if let aiEnvelope = errorObj["aiEnvelope"],
           let data = try? JSONEncoder().encode(aiEnvelope),
           let decoded = try? JSONDecoder().decode(BackendError.self, from: data) {
            return decoded
        }
        let rawCode = errorObj["code"]?.stringValue
        let status = RPCStatus.fromWireStatus(rawCode)
        let message = errorObj["message"]?.stringValue ?? "Unknown AI sandbox error."
        return BackendError(
            httpResponseCode: status.defaultHTTPStatusCode,
            message: message,
            status: status
        )
    }

    private func sendEncoded<T: Encodable>(_ frame: T) async throws {
        guard let transport, !isDisposed else {
            throw BackendError(
                httpResponseCode: 503,
                message: "AI bridge WebSocket is not connected.",
                status: .unavailable
            )
        }
        let data = try JSONEncoder().encode(frame)
        guard let text = String(data: data, encoding: .utf8) else {
            throw BackendError(
                httpResponseCode: 500,
                message: "Failed to UTF-8 encode AI bridge frame.",
                status: .internalError
            )
        }
        try await transport.send(text)
    }

    private func failTimedOutOp(id: String, method: String, timeout: TimeInterval) {
        guard let pending = pendingOps.removeValue(forKey: id) else { return }
        pending.continuation.resume(
            throwing: BackendError(
                httpResponseCode: 504,
                message: "AI operation \(method) timed out after \(Int(timeout * 1000))ms.",
                status: .deadlineExceeded
            )
        )
    }

    private func failDispatchedOp(id: String, error: any Error) {
        guard let pending = pendingOps.removeValue(forKey: id) else { return }
        pending.timeoutTask.cancel()
        pending.continuation.resume(throwing: error)
    }

    private func handleSocketLoss(generation: Int, error: any Error) {
        guard generation == connectionGeneration else { return }
        let closing = tearDownCurrentSocket(error: error)
        if fixedTransport == nil, let closing {
            Task { await closing.close(closeCode: 1000, reason: "Socket lost") }
        }
    }

    private func tearDownCurrentSocket(error: any Error) -> (any WebSocketTransport)? {
        connectionGeneration += 1
        isAttached = false
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

        let streams = activeStreams
        activeStreams.removeAll()
        for (_, cont) in streams {
            cont.finish(throwing: error)
        }

        let closing = transport
        if fixedTransport == nil {
            transport = nil
        }
        return closing
    }
}
