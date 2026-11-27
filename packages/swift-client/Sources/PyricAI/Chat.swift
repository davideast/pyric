import Foundation

/// Thread-safe FIFO turn serializer ensuring multi-turn `Chat` messages execute sequentially.
private actor ChatTurnSerializer {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isRunning = false

    func acquire() async {
        if !isRunning {
            isRunning = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func release() {
        if !waiters.isEmpty {
            let next = waiters.removeFirst()
            next.resume()
        } else {
            isRunning = false
        }
    }
}

/// Thread-safe multi-turn conversation history store and chunk aggregator.
private final class ChatHistoryStore: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ModelContent]

    init(initial: [ModelContent]) {
        self.items = initial
    }

    var history: [ModelContent] {
        get {
            lock.lock()
            defer { lock.unlock() }
            return items
        }
        set {
            lock.lock()
            items = newValue
            lock.unlock()
        }
    }

    func appendTurn(userTurns: [ModelContent], modelTurn: ModelContent) {
        lock.lock()
        items.append(contentsOf: userTurns)
        items.append(modelTurn)
        lock.unlock()
    }

    static func aggregateChunks(_ chunks: [ModelContent]) -> ModelContent {
        var parts: [InternalPart] = []
        var combinedText = ""
        var combinedThoughts = ""

        func flush() {
            if !combinedThoughts.isEmpty {
                parts.append(InternalPart(.text(combinedThoughts), isThought: true, thoughtSignature: nil))
                combinedThoughts = ""
            }
            if !combinedText.isEmpty {
                parts.append(InternalPart(.text(combinedText), isThought: nil, thoughtSignature: nil))
                combinedText = ""
            }
        }

        for part in chunks.flatMap({ $0.internalParts }) {
            if case .text(let text) = part.data,
               part.thoughtSignature == nil,
               part.speechMetadata == nil {
                if text.isEmpty {
                    continue
                }
                if part.isThought == true {
                    if !combinedText.isEmpty {
                        flush()
                    }
                    combinedThoughts += text
                } else {
                    if !combinedThoughts.isEmpty {
                        flush()
                    }
                    combinedText += text
                }
            } else {
                flush()
                parts.append(part)
            }
        }
        flush()
        return ModelContent(role: "model", internalParts: parts)
    }
}

/// Multi-turn conversation session preserving successful user/model turns in `history`
/// and leaving `history` untouched when a turn fails or is blocked,
/// mirroring `FirebaseAILogic.Chat` (`13.2.0`).
public final class Chat: Sendable {
    public let model: GenerativeModel
    private let store: ChatHistoryStore
    private let serializer = ChatTurnSerializer()

    package init(model: GenerativeModel, history: [ModelContent]) {
        self.model = model
        self.store = ChatHistoryStore(initial: history)
    }

    /// Conversation turns successfully sent to and received from the model so far.
    public var history: [ModelContent] {
        get { store.history }
        set { store.history = newValue }
    }

    /// Sends a single chat turn from `PartsRepresentable` inputs and atomically updates `history` on success.
    public func sendMessage(_ parts: any PartsRepresentable...) async throws -> GenerateContentResponse {
        try await sendMessage([ModelContent(parts: parts.flatMap { $0.partsValue })])
    }

    /// Sends a chat turn from `[ModelContent]` values and atomically updates `history` on success.
    public func sendMessage(_ content: [ModelContent]) async throws -> GenerateContentResponse {
        await serializer.acquire()
        do {
            let normalizedUserTurns = content.map(Self.ensureRole)
            let fullConversation = store.history + normalizedUserTurns
            let response = try await model.performGenerateContent(
                fullConversation,
                generationConfig: model.generationConfig
            )
            guard let replyContent = response.candidates.first?.content,
                  !replyContent.internalParts.isEmpty else {
                await serializer.release()
                throw GenerateContentError.internalError(underlying: EmptyContentError())
            }
            let modelTurn = ModelContent(role: "model", internalParts: replyContent.internalParts)
            store.appendTurn(userTurns: normalizedUserTurns, modelTurn: modelTurn)
            await serializer.release()
            return response
        } catch {
            await serializer.release()
            throw error
        }
    }

    /// Streams a chat turn from `PartsRepresentable` inputs and updates `history` only after clean stream completion.
    public func sendMessageStream(
        _ parts: any PartsRepresentable...
    ) throws -> AsyncThrowingStream<GenerateContentResponse, any Error> {
        try sendMessageStream([ModelContent(parts: parts.flatMap { $0.partsValue })])
    }

    /// Streams a chat turn from `[ModelContent]` values and updates `history` only after clean stream completion.
    public func sendMessageStream(
        _ content: [ModelContent]
    ) throws -> AsyncThrowingStream<GenerateContentResponse, any Error> {
        let normalizedUserTurns = content.map(Self.ensureRole)
        let targetModel = model
        let historyStore = store
        let turnSerializer = serializer

        return AsyncThrowingStream { continuation in
            let releaseGate = OnceTurnReleaseGate(serializer: turnSerializer)
            let task = Task {
                await turnSerializer.acquire()
                releaseGate.markAcquired()

                do {
                    let fullConversation = historyStore.history + normalizedUserTurns
                    let innerStream = try targetModel.performGenerateContentStream(
                        fullConversation,
                        generationConfig: targetModel.generationConfig
                    )
                    var collectedChunks: [ModelContent] = []
                    for try await chunk in innerStream {
                        try Task.checkCancellation()
                        if let candidateContent = chunk.candidates.first?.content {
                            collectedChunks.append(candidateContent)
                        }
                        continuation.yield(chunk)
                    }

                    try Task.checkCancellation()
                    let aggregated = ChatHistoryStore.aggregateChunks(collectedChunks)
                    guard !aggregated.internalParts.isEmpty else {
                        await releaseGate.releaseOnce()
                        continuation.finish(
                            throwing: GenerateContentError.internalError(underlying: EmptyContentError())
                        )
                        return
                    }
                    historyStore.appendTurn(userTurns: normalizedUserTurns, modelTurn: aggregated)
                    await releaseGate.releaseOnce()
                    continuation.finish()
                } catch {
                    await releaseGate.releaseOnce()
                    continuation.finish(throwing: GenerateContentError.wrap(error))
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
                Task {
                    await releaseGate.releaseOnce()
                }
            }
        }
    }

    private static func ensureRole(_ item: ModelContent) -> ModelContent {
        if item.role != nil {
            return item
        }
        return ModelContent(role: "user", internalParts: item.internalParts)
    }
}

private final class OnceTurnReleaseGate: @unchecked Sendable {
    private let lock = NSLock()
    private let serializer: ChatTurnSerializer
    private var acquired = false
    private var released = false

    init(serializer: ChatTurnSerializer) {
        self.serializer = serializer
    }

    func markAcquired() {
        lock.lock()
        acquired = true
        let shouldReleaseImmediately = released
        lock.unlock()
        if shouldReleaseImmediately {
            Task { await serializer.release() }
        }
    }

    func releaseOnce() async {
        let shouldReleaseNow: Bool = {
            lock.lock()
            defer { lock.unlock() }
            if released {
                return false
            }
            released = true
            return acquired
        }()
        if shouldReleaseNow {
            await serializer.release()
        }
    }
}
