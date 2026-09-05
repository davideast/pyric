import Foundation

/// Internal container for an in-flight worker operation.
private struct PendingOp: Sendable {
    let continuation: CheckedContinuation<AnySendable, Error>
    let timeoutTask: Task<Void, Never>
}


/// Pure-Swift WebSocket transport connecting to the Pyric local sandbox bridge.
public actor PyricBridgeClient {
    public let endpoint: URL
    public let headers: [String: String]
    public let defaultOpTimeout: TimeInterval

    private var transport: (any WebSocketTransport)?
    private let transportFactory: (@Sendable (URLRequest) async throws -> any WebSocketTransport)?

    public private(set) var isConnected: Bool = false
    public private(set) var isDisposed: Bool = false

    private var opCounter: Int = 0
    private var subCounter: Int = 0

    private var connectTask: Task<Void, Error>?
    private var receiveTask: Task<Void, Never>?
    private var handshakeContinuation: CheckedContinuation<Void, Error>?

    private let denialLock = NSLock()
    nonisolated(unsafe) private var _onDenial: (@Sendable (PyricBridgeError) -> Void)?

    /// Instance-scoped callback invoked whenever a Security Rules denial is intercepted.
    public nonisolated var onDenial: (@Sendable (PyricBridgeError) -> Void)? {
        get {
            denialLock.lock()
            defer { denialLock.unlock() }
            return _onDenial
        }
        set {
            denialLock.lock()
            defer { denialLock.unlock() }
            _onDenial = newValue
        }
    }
    private var remoteLensContinuations: [UUID: AsyncStream<AuthLens>.Continuation] = [:]
    private var denialContinuations: [UUID: AsyncStream<PyricBridgeError>.Continuation] = [:]

    private var pendingOps: [String: PendingOp] = [:]
    private var activeSubs: [String: AsyncThrowingStream<AnySendable, Error>.Continuation] = [:]

    public init(
        endpoint: URL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
        headers: [String: String] = ["Host": "127.0.0.1:5174"],
        defaultOpTimeout: TimeInterval = 35.0,
        transportFactory: (@Sendable (URLRequest) async throws -> any WebSocketTransport)? = nil
    ) {
        self.endpoint = endpoint
        self.headers = headers
        self.defaultOpTimeout = defaultOpTimeout
        self.transportFactory = transportFactory
    }

    public init(
        channel: any WebSocketTransport,
        endpoint: URL = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
        headers: [String: String] = ["Host": "127.0.0.1:5174"],
        defaultOpTimeout: TimeInterval = 35.0
    ) {
        self.endpoint = endpoint
        self.headers = headers
        self.defaultOpTimeout = defaultOpTimeout
        self.transport = channel
        self.transportFactory = nil
    }

    /// Constructs a URLRequest populating the Host header for DNS-rebinding protection.
    public static func makeWebSocketRequest(url: URL, headers: [String: String] = [:]) -> URLRequest {
        var request = URLRequest(url: url)
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if request.value(forHTTPHeaderField: "Host") == nil {
            let hostStr = (url.port != nil) ? "\(url.host ?? "127.0.0.1"):\(url.port!)" : (url.host ?? "127.0.0.1:5174")
            request.setValue(hostStr, forHTTPHeaderField: "Host")
        }
        return request
    }

    // ─── Connection Lifecycle ────────────────────────────────────────────────

    /// Establishes the WebSocket connection and completes the attach / attach-ack handshake.
    public func connect() async throws {
        if isConnected { return }
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if let existing = connectTask {
            return try await existing.value
        }

        let task = Task { [weak self] in
            guard let self else { throw PyricBridgeError.unavailable("Client was deallocated.") }
            try await self.performConnect()
        }
        self.connectTask = task
        do {
            try await task.value
            self.connectTask = nil
        } catch {
            self.connectTask = nil
            throw error
        }
    }

    private func resumeHandshake(returning result: Result<Void, Error>) {
        guard let continuation = handshakeContinuation else { return }
        handshakeContinuation = nil
        switch result {
        case .success:
            continuation.resume()
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }

    private func performConnect() async throws {
        let request = Self.makeWebSocketRequest(url: endpoint, headers: headers)

        if let channel = self.transport {
            self.transport = channel
        } else if let factory = transportFactory {
            self.transport = try await factory(request)
        } else {
            self.transport = URLSessionWebSocketTransport(request: request)
        }

        // Start receive loop
        self.receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }

        // Handshake: send attach and await attach-ack
        do {
            try await withCheckedThrowingContinuation { continuation in
                self.handshakeContinuation = continuation
                Task {
                    do {
                        let attachFrame = AttachFrame()
                        try await self.sendRaw(attachFrame)
                    } catch {
                        self.resumeHandshake(
                            returning: .failure(PyricBridgeError.unavailable("Failed to send attach frame: \(error)"))
                        )
                    }
                }
            }
        } catch {
            self.receiveTask?.cancel()
            self.receiveTask = nil
            self.resumeHandshake(returning: .failure(error))
            throw error
        }

        self.isConnected = true
    }

    // ─── One-Shot RPC Operations ─────────────────────────────────────────────

    /// Dispatches a one-shot worker operation and awaits the correlated result.
    public func op(
        method: String,
        params: [String: AnySendable] = [:],
        actAs: AuthLens? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> AnySendable {
        if !isConnected && !isDisposed {
            try await connect()
        }
        try ensureConnected()

        opCounter += 1
        let id = "rop-\(opCounter)"
        let opTimeout = timeout ?? defaultOpTimeout

        var opPayload = params
        opPayload["method"] = .string(method)
        if let actAs {
            opPayload["actAs"] = actAs.toAnySendable()
        }

        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(opTimeout * 1_000_000_000))
                if !Task.isCancelled {
                    await self?.handleOpTimeout(id: id, timeout: opTimeout, method: method)
                }
            }

            self.pendingOps[id] = PendingOp(continuation: continuation, timeoutTask: timeoutTask)

            Task {
                do {
                    let frame = WorkerOpFrame(id: id, op: opPayload)
                    try await self.sendRaw(frame)
                } catch {
                    timeoutTask.cancel()
                    self.pendingOps.removeValue(forKey: id)
                    continuation.resume(
                        throwing: PyricBridgeError.unavailable("Failed to dispatch op to bridge: \(error)")
                    )
                }
            }
        }
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

    /// Exposes pushed remote lens changes from desktop Pyric Studio.
    public nonisolated var remoteLensStream: AsyncStream<AuthLens> {
        AsyncStream { continuation in
            let id = UUID()
            Task { [weak self] in
                await self?.registerRemoteLensContinuation(id: id, continuation: continuation)
            }
            continuation.onTermination = { [weak self] _ in
                Task { [weak self] in
                    await self?.unregisterRemoteLensContinuation(id: id)
                }
            }
        }
    }

    private func registerRemoteLensContinuation(id: UUID, continuation: AsyncStream<AuthLens>.Continuation) {
        remoteLensContinuations[id] = continuation
    }

    private func unregisterRemoteLensContinuation(id: UUID) {
        remoteLensContinuations.removeValue(forKey: id)
    }

    /// Exposes Security Rules denial errors intercepted from bridge responses and snapshots.
    public nonisolated var denialStream: AsyncStream<PyricBridgeError> {
        AsyncStream { continuation in
            let id = UUID()
            Task { [weak self] in
                await self?.registerDenialContinuation(id: id, continuation: continuation)
            }
            continuation.onTermination = { [weak self] _ in
                Task { [weak self] in
                    await self?.unregisterDenialContinuation(id: id)
                }
            }
        }
    }

    private func registerDenialContinuation(id: UUID, continuation: AsyncStream<PyricBridgeError>.Continuation) {
        denialContinuations[id] = continuation
    }

    private func unregisterDenialContinuation(id: UUID) {
        denialContinuations.removeValue(forKey: id)
    }

    // ─── Streaming Subscriptions ─────────────────────────────────────────────

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
        subscribe(target: target.toAnySendable(), actAs: actAs?.toAnySendable(), includeMetadataChanges: includeMetadataChanges, listenSource: listenSource)
    }

    public nonisolated func subscribe(
        target: [String: Any],
        actAs: AnySendable? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) -> PyricSubscriptionStream {
        subscribe(target: AnySendable.from(target), actAs: actAs, includeMetadataChanges: includeMetadataChanges, listenSource: listenSource)
    }

    /// Explicitly unregisters an active subscription and dispatches a worker-unsub frame.
    public func unsubscribe(subId: String) async {
        await unregisterSubscription(subId: subId)
    }

    func registerSubscription(
        target: AnySendable,
        actAs: AnySendable?,
        includeMetadataChanges: Bool,
        listenSource: String?,
        continuation: AsyncThrowingStream<AnySendable, Error>.Continuation
    ) async throws -> String {
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if !isConnected {
            try await connect()
        }

        subCounter += 1
        let subId = "rsub-\(subCounter)"
        activeSubs[subId] = continuation

        var subPayload: [String: AnySendable] = [
            "target": target
        ]
        if let actAs {
            subPayload["actAs"] = actAs
        }
        if includeMetadataChanges {
            subPayload["includeMetadataChanges"] = .bool(true)
        }
        if let listenSource, listenSource != "defaultSource" {
            subPayload["listenSource"] = .string(listenSource)
        }

        let frame = WorkerSubFrame(subId: subId, sub: subPayload)
        try await sendRaw(frame)
        return subId
    }

    func unregisterSubscription(subId: String) async {
        guard activeSubs.removeValue(forKey: subId) != nil else { return }
        if isConnected && !isDisposed {
            try? await sendRaw(WorkerUnsubFrame(subId: subId))
        }
    }

    // ─── Incoming Message Processing & Event Loop ───────────────────────────

    private func receiveLoop() async {
        while !Task.isCancelled && !isDisposed {
            guard let transport else { break }
            do {
                let rawText = try await transport.receive()
                handleMessage(rawText)
            } catch {
                if !isDisposed {
                    handleChannelError(error)
                }
                break
            }
        }
    }

    private func handleMessage(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = json["type"]?.stringValue else {
            return
        }

        switch type {
        case "attach-ack":
            handleAttachAck(json)
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

        for cont in remoteLensContinuations.values {
            cont.yield(lens)
        }
    }

    private func handleAttachAck(_ msg: AnySendable) {
        let peerConnected = msg["peerConnected"]?.boolValue ?? false
        if peerConnected {
            resumeHandshake(returning: .success(()))
        } else {
            resumeHandshake(
                returning: .failure(
                    PyricBridgeError.unavailable(
                        "No browser tab is connected to the sandbox — open pyric sandbox in a browser and retry."
                    )
                )
            )
        }
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
            if denialContext != nil {
                for cont in denialContinuations.values {
                    cont.yield(error)
                }
                onDenial?(error)
            }
            pending.continuation.resume(throwing: error)
        }
    }

    private func handleWorkerSnap(_ msg: AnySendable) {
        guard let subId = msg["subId"]?.stringValue,
              let continuation = activeSubs[subId],
              let value = msg["value"] ?? msg["res"] else {
            return
        }

        // Terminal snapshot error check
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
            if denialContext != nil {
                for cont in denialContinuations.values {
                    cont.yield(error)
                }
                onDenial?(error)
            }
            continuation.finish(throwing: error)
            return
        }

        continuation.yield(value)
    }

    private func handlePing(_ msg: AnySendable) {
        guard let id = msg["id"]?.stringValue else { return }
        Task { [weak self] in
            try? await self?.sendRaw(PongFrame(id: id))
        }
    }

    private func handleChannelError(_ error: Error) {
        resumeHandshake(returning: .failure(PyricBridgeError.unavailable("WebSocket connection error: \(error)")))
        failPendingOperations(code: .unavailable, message: "WebSocket connection error: \(error)")
    }

    private func failPendingOperations(code: FirestoreErrorCode, message: String) {
        isConnected = false

        for (_, pending) in pendingOps {
            pending.timeoutTask.cancel()
            pending.continuation.resume(
                throwing: PyricBridgeError(code: code, message: message)
            )
        }
        pendingOps.removeAll()

        for (_, sub) in activeSubs {
            sub.finish(throwing: PyricBridgeError(code: code, message: message))
        }
        activeSubs.removeAll()
    }

    private func sendRaw<T: Encodable>(_ message: T) async throws {
        guard let transport, !isDisposed else {
            throw PyricBridgeError.unavailable("Cannot send message: WebSocket is closed.")
        }
        let data = try JSONEncoder().encode(message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw PyricBridgeError.internalError("Failed to encode frame to UTF-8")
        }
        try await transport.send(text)
    }

    private func ensureConnected() throws {
        if isDisposed {
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        if !isConnected {
            throw PyricBridgeError.unavailable("PyricBridgeClient is not connected. Call connect() first.")
        }
    }

    // ─── Teardown ────────────────────────────────────────────────────────────

    /// Closes the connection and cancels all outstanding operations and subscriptions.
    public func disconnect() async {
        isDisposed = true
        isConnected = false

        failPendingOperations(code: .unavailable, message: "PyricBridgeClient disconnected.")
        resumeHandshake(returning: .failure(PyricBridgeError.unavailable("PyricBridgeClient disconnected.")))

        for cont in remoteLensContinuations.values { cont.finish() }
        remoteLensContinuations.removeAll()
        for cont in denialContinuations.values { cont.finish() }
        denialContinuations.removeAll()
        onDenial = nil

        receiveTask?.cancel()
        receiveTask = nil

        await transport?.close(closeCode: 1000, reason: "Client disconnect")
        transport = nil
    }
}

