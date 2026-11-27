import Foundation
import PyricFirestore

/// Multimodal generative model (such as Gemini) capable of unary content generation,
/// streaming content generation, token counting, and multi-turn `Chat` sessions,
/// mirroring `FirebaseAILogic.GenerativeModel` (`13.2.0`).
public final class GenerativeModel: Sendable {
    public typealias Tool = PyricAI.Tool

    public let modelName: String
    package let modelResourceName: String
    package let firebaseAI: FirebaseAI
    public let generationConfig: GenerationConfig?
    public let safetySettings: [SafetySetting]?
    public let tools: [Tool]?
    public let toolConfig: ToolConfig?
    public let systemInstruction: ModelContent?
    public let requestOptions: RequestOptions

    package init(
        modelName: String,
        modelResourceName: String,
        firebaseAI: FirebaseAI,
        generationConfig: GenerationConfig?,
        safetySettings: [SafetySetting]?,
        tools: [Tool]?,
        toolConfig: ToolConfig?,
        systemInstruction: ModelContent?,
        requestOptions: RequestOptions
    ) {
        self.modelName = modelName
        self.modelResourceName = modelResourceName
        self.firebaseAI = firebaseAI
        self.generationConfig = generationConfig
        self.safetySettings = safetySettings
        self.tools = tools
        self.toolConfig = toolConfig
        self.systemInstruction = systemInstruction.map {
            ModelContent(role: nil, internalParts: $0.internalParts)
        }
        self.requestOptions = requestOptions
    }

    // MARK: - Public API

    /// Generates a response from one or more `PartsRepresentable` inputs (`String`, `TextPart`, `InlineDataPart`, etc.).
    public func generateContent(_ parts: any PartsRepresentable...) async throws -> GenerateContentResponse {
        try await generateContent([ModelContent(parts: parts.flatMap { $0.partsValue })])
    }

    /// Generates a response from an array of multi-turn `ModelContent` values.
    public func generateContent(_ content: [ModelContent]) async throws -> GenerateContentResponse {
        try await performGenerateContent(content, generationConfig: generationConfig)
    }

    /// Streams incremental `GenerateContentResponse` chunks from `PartsRepresentable` prompt inputs.
    public func generateContentStream(
        _ parts: any PartsRepresentable...
    ) throws -> AsyncThrowingStream<GenerateContentResponse, any Error> {
        try generateContentStream([ModelContent(parts: parts.flatMap { $0.partsValue })])
    }

    /// Streams incremental `GenerateContentResponse` chunks from an array of `ModelContent` values.
    public func generateContentStream(
        _ content: [ModelContent]
    ) throws -> AsyncThrowingStream<GenerateContentResponse, any Error> {
        try performGenerateContentStream(content, generationConfig: generationConfig)
    }

    /// Counts prompt tokens for one or more `PartsRepresentable` inputs.
    public func countTokens(_ parts: any PartsRepresentable...) async throws -> CountTokensResponse {
        try await countTokens([ModelContent(parts: parts.flatMap { $0.partsValue })])
    }

    /// Counts prompt tokens for an array of `ModelContent` values.
    public func countTokens(_ content: [ModelContent]) async throws -> CountTokensResponse {
        let requestWire = try encodeRequestPayload(
            contents: content,
            generationConfig: generationConfig,
            includeSafetyAndToolConfig: false
        )
        let appCheck = try await AiAppCheckResolver.resolve(
            app: firebaseAI.app,
            useLimitedUseTokens: firebaseAI.useLimitedUseAppCheckTokens,
            enforceAppCheck: firebaseAI.enforceAppCheck
        )
        let rawResponse = try await dispatchUnary(
            method: "ai.countTokens",
            request: requestWire,
            appCheck: appCheck
        )
        let data = try JSONEncoder().encode(rawResponse)
        return try JSONDecoder().decode(CountTokensResponse.self, from: data)
    }

    /// Starts a stateful multi-turn `Chat` session seeded with `history`.
    public func startChat(history: [ModelContent] = []) -> Chat {
        Chat(model: self, history: history)
    }

    // MARK: - Package Execution Helpers

    package func performGenerateContent(
        _ content: [ModelContent],
        generationConfig: GenerationConfig?
    ) async throws -> GenerateContentResponse {
        let response: GenerateContentResponse
        do {
            let requestWire = try encodeRequestPayload(
                contents: content,
                generationConfig: generationConfig,
                includeSafetyAndToolConfig: true
            )
            let appCheck = try await AiAppCheckResolver.resolve(
                app: firebaseAI.app,
                useLimitedUseTokens: firebaseAI.useLimitedUseAppCheckTokens,
                enforceAppCheck: firebaseAI.enforceAppCheck
            )
            let rawResponse = try await dispatchUnary(
                method: "ai.generateContent",
                request: requestWire,
                appCheck: appCheck
            )
            response = try Self.decodeGenerateContentResponse(rawResponse)
        } catch {
            throw GenerateContentError.wrap(error)
        }

        try Self.validateResponse(response)
        if response.candidates.allSatisfy({ $0.isEmpty }) {
            throw GenerateContentError.internalError(underlying: EmptyContentError())
        }
        return response
    }

    package func performGenerateContentStream(
        _ content: [ModelContent],
        generationConfig: GenerationConfig?
    ) throws -> AsyncThrowingStream<GenerateContentResponse, any Error> {
        let requestWire = try encodeRequestPayload(
            contents: content,
            generationConfig: generationConfig,
            includeSafetyAndToolConfig: true
        )
        let ai = firebaseAI
        let modelRes = modelResourceName
        let rawTimeout = requestOptions.timeout
        let clampedTimeout = rawTimeout.isFinite ? min(max(0.1, rawTimeout), 86_400.0) : 86_400.0
        let timeoutNanos = UInt64((clampedTimeout * 1_000_000_000.0).rounded())

        return AsyncThrowingStream { continuation in
            let (rawStream, rawContinuation) = AsyncThrowingStream<AnySendable, any Error>.makeStream()
            let stateBox = StreamRegistrationBox(session: ai.session)
            final class HandleSlot: @unchecked Sendable {
                private let lock = NSLock()
                private var cancelFn: (@Sendable () -> Void)?
                private var cancelled = false
                func store(_ fn: @escaping @Sendable () -> Void) {
                    lock.lock()
                    if cancelled {
                        lock.unlock()
                        fn()
                        return
                    }
                    cancelFn = fn
                    lock.unlock()
                }
                func cancel() {
                    lock.lock()
                    cancelled = true
                    let fn = cancelFn
                    cancelFn = nil
                    lock.unlock()
                    fn?()
                }
            }
            let injectedHandleSlot = HandleSlot()

            let timeoutTask = Task {
                try? await Task.sleep(nanoseconds: timeoutNanos)
                guard !Task.isCancelled else { return }
                let timeoutErr = BackendError(
                    httpResponseCode: 504,
                    message: "AI stream timed out after \(Int(clampedTimeout * 1000))ms.",
                    status: .deadlineExceeded
                )
                rawContinuation.finish(throwing: timeoutErr)
                injectedHandleSlot.cancel()
                await stateBox.cancelIfRegistered()
            }

            let pumpTask = Task {
                defer { timeoutTask.cancel() }
                do {
                    let appCheck = try await AiAppCheckResolver.resolve(
                        app: ai.app,
                        useLimitedUseTokens: ai.useLimitedUseAppCheckTokens,
                        enforceAppCheck: ai.enforceAppCheck
                    )
                    if let explicitBridge = ai.explicitBridgeClient,
                       explicitBridge.hasInjectedChannel {
                        var subTarget: [String: AnySendable] = [
                            "service": .string("ai"),
                            "op": .string("streamGenerateContent"),
                            "model": .string(modelRes),
                            "request": requestWire,
                        ]
                        if let engine = ai.engineConfig {
                            subTarget["engine"] = engine.toAnySendable()
                        }
                        if let claim = appCheck.claimObject {
                            subTarget["appCheck"] = claim
                        }
                        if let token = appCheck.attachedToken {
                            subTarget["appCheckToken"] = .string(token)
                        }
                        let handle = explicitBridge.openOrderedSubscription(
                            target: .dictionary(subTarget),
                            dispatchOnDeliveryQueue: false,
                            onEvent: { event in
                                guard case .value(let frame) = event else { return }
                                if let errObj = frame["__error"] {
                                    rawContinuation.finish(throwing: AiBridgeSession.decodeWireError(errObj))
                                    return
                                }
                                if frame["done"]?.boolValue == true {
                                    rawContinuation.finish()
                                    return
                                }
                                rawContinuation.yield(frame["chunk"] ?? frame)
                            },
                            onFinish: { error in
                                if let error {
                                    rawContinuation.finish(throwing: error)
                                } else {
                                    rawContinuation.finish(
                                        throwing: BackendError(
                                            httpResponseCode: 503,
                                            message: "AI stream closed before terminal done frame.",
                                            status: .unavailable
                                        )
                                    )
                                }
                            }
                        )
                        injectedHandleSlot.store { handle.cancel() }
                    } else {
                        let bridge = ai.activeBridgeClient()
                        let endpoint = await bridge.endpoint
                        let headers = await bridge.headers

                        let subId = try await ai.session.openStream(
                            endpoint: endpoint,
                            headers: headers,
                            model: modelRes,
                            request: requestWire,
                            engine: ai.engineConfig,
                            appCheck: appCheck,
                            continuation: rawContinuation
                        )
                        if stateBox.recordOrNeedsCancel(subId: subId) {
                            await ai.session.cancelStream(subId: subId)
                            return
                        }
                    }

                    var didYieldCandidate = false
                    for try await rawChunk in rawStream {
                        let chunk = try Self.decodeGenerateContentResponse(rawChunk)
                        try Self.validateResponse(chunk)
                        if !chunk.candidates.allSatisfy({ $0.isEmpty }) {
                            didYieldCandidate = true
                            continuation.yield(chunk)
                        }
                    }

                    injectedHandleSlot.cancel()
                    if didYieldCandidate {
                        continuation.finish()
                    } else {
                        continuation.finish(
                            throwing: GenerateContentError.internalError(underlying: EmptyContentError())
                        )
                    }
                } catch is CancellationError {
                    injectedHandleSlot.cancel()
                    await stateBox.cancelIfRegistered()
                    continuation.finish(throwing: CancellationError())
                } catch {
                    injectedHandleSlot.cancel()
                    await stateBox.cancelIfRegistered()
                    continuation.finish(throwing: GenerateContentError.wrap(error))
                }
            }

            continuation.onTermination = { @Sendable _ in
                timeoutTask.cancel()
                pumpTask.cancel()
                injectedHandleSlot.cancel()
                Task {
                    await stateBox.cancelIfRegistered()
                }
            }
        }
    }

    // MARK: - Wire Encoding & Validation

    private struct WireGenerateRequest: Encodable {
        let contents: [ModelContent]
        let generationConfig: GenerationConfig?
        let safetySettings: [SafetySetting]?
        let tools: [Tool]?
        let toolConfig: ToolConfig?
        let systemInstruction: ModelContent?
    }

    private func encodeRequestPayload(
        contents: [ModelContent],
        generationConfig: GenerationConfig?,
        includeSafetyAndToolConfig: Bool
    ) throws -> AnySendable {
        let wire = WireGenerateRequest(
            contents: contents,
            generationConfig: generationConfig,
            safetySettings: includeSafetyAndToolConfig ? safetySettings : nil,
            tools: tools,
            toolConfig: includeSafetyAndToolConfig ? toolConfig : nil,
            systemInstruction: systemInstruction
        )
        let data = try JSONEncoder().encode(wire)
        return try JSONDecoder().decode(AnySendable.self, from: data)
    }

    private func dispatchUnary(
        method: String,
        request: AnySendable,
        appCheck: AiAppCheckResolver.ResolvedClaim
    ) async throws -> AnySendable {
        if let explicitBridge = firebaseAI.explicitBridgeClient,
           explicitBridge.hasInjectedChannel {
            var params: [String: AnySendable] = [
                "model": .string(modelResourceName),
                "request": request,
            ]
            if let engine = firebaseAI.engineConfig {
                params["engine"] = engine.toAnySendable()
            }
            if let claim = appCheck.claimObject {
                params["appCheck"] = claim
            }
            if let token = appCheck.attachedToken {
                params["appCheckToken"] = .string(token)
            }
            do {
                return try await explicitBridge.opWithAppCheck(
                    app: firebaseAI.app,
                    method: method,
                    params: params,
                    timeout: requestOptions.timeout
                )
            } catch let bridgeErr as PyricBridgeError {
                let status = RPCStatus.fromWireStatus(bridgeErr.rawCode)
                throw BackendError(
                    httpResponseCode: status.defaultHTTPStatusCode,
                    message: bridgeErr.message,
                    status: status
                )
            }
        }

        let bridge = firebaseAI.activeBridgeClient()
        let endpoint = await bridge.endpoint
        let headers = await bridge.headers
        return try await firebaseAI.session.unaryOp(
            endpoint: endpoint,
            headers: headers,
            method: method,
            model: modelResourceName,
            request: request,
            engine: firebaseAI.engineConfig,
            appCheck: appCheck,
            timeout: requestOptions.timeout
        )
    }

    private static func decodeGenerateContentResponse(_ raw: AnySendable) throws -> GenerateContentResponse {
        let data = try JSONEncoder().encode(raw)
        return try JSONDecoder().decode(GenerateContentResponse.self, from: data)
    }

    private static func validateResponse(_ response: GenerateContentResponse) throws {
        if response.promptFeedback?.blockReason != nil {
            throw GenerateContentError.promptBlocked(response: response)
        }
        if let reason = response.candidates.first?.finishReason, reason != .stop {
            throw GenerateContentError.responseStoppedEarly(reason: reason, response: response)
        }
    }
}

private final class StreamRegistrationBox: @unchecked Sendable {
    private let lock = NSLock()
    private let session: AiBridgeSession
    private var subId: String?
    private var cancelled = false

    init(session: AiBridgeSession) {
        self.session = session
    }

    func recordOrNeedsCancel(subId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if cancelled {
            return true
        }
        self.subId = subId
        return false
    }

    func cancelIfRegistered() async {
        let toCancel: String? = {
            lock.lock()
            defer { lock.unlock() }
            cancelled = true
            let current = subId
            subId = nil
            return current
        }()
        if let toCancel {
            await session.cancelStream(subId: toCancel)
        }
    }
}
