import Foundation
import Testing
import PyricAI
import PyricAppCheck
import PyricFirestore

private final class CountingAppCheckProvider: NSObject, AppCheckProvider, @unchecked Sendable {
    private let lock = NSLock()
    private var standardCount = 0
    private var limitedCount = 0

    func getToken(completion handler: @escaping (AppCheckToken?, Error?) -> Void) {
        let next: Int = {
            lock.lock()
            defer { lock.unlock() }
            standardCount += 1
            return standardCount
        }()
        let token = AppCheckToken(
            token: "unit-std-jwt-\(next)",
            expirationDate: Date().addingTimeInterval(3600)
        )
        handler(token, nil)
    }

    func getLimitedUseToken(completion handler: @escaping (AppCheckToken?, Error?) -> Void) {
        let next: Int = {
            lock.lock()
            defer { lock.unlock() }
            limitedCount += 1
            return limitedCount
        }()
        let token = AppCheckToken(
            token: "unit-limited-jwt-\(next)",
            expirationDate: Date().addingTimeInterval(300)
        )
        handler(token, nil)
    }
}

private final class CountingAppCheckFactory: NSObject, AppCheckProviderFactory, @unchecked Sendable {
    let provider = CountingAppCheckProvider()

    func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
        _ = app
        return provider
    }
}

@Suite("PyricAI Streaming, Chat, and App Check Suite", .serialized)
struct PyricAIStreamChatAndAppCheckTests {

    private func makeTextChunk(_ text: String, finishReason: String? = nil, isThought: Bool? = nil) -> JSONObject {
        var partObj: JSONObject = ["text": .string(text)]
        if let isThought {
            partObj["thought"] = .bool(isThought)
        }
        var candidate: JSONObject = [
            "content": .object([
                "role": .string("model"),
                "parts": .array([.object(partObj)]),
            ]),
        ]
        if let finishReason {
            candidate["finishReason"] = .string(finishReason)
        }
        return ["candidates": .array([.object(candidate)])]
    }

    @Test("generateContentStream yields ordered chunks via worker-sub and sends worker-unsub on early consumer break")
    func streamGenerateContentAndEarlyUnsubscribe() async throws {
        let channel = MockAiBridgeChannel()
        let app = FirebaseApp(
            name: "stream-app",
            options: FirebaseOptions(projectID: "demo-stream", apiKey: "k", googleAppID: "1:1:ios:stream")
        )
        let ai = FirebaseAI.firebaseAI(app: app, transport: channel)
        let model = ai.generativeModel(modelName: "gemini-2.5-flash")

        channel.enqueueReply(.streamChunks(
            chunks: [
                makeTextChunk("plan", isThought: true),
                makeTextChunk("Alpha "),
                makeTextChunk("Beta", finishReason: "STOP"),
            ],
            finishAfterChunks: true
        ))

        var texts: [String] = []
        var thoughts: [String] = []
        let stream1 = try model.generateContentStream("Stream test")
        for try await chunk in stream1 {
            if let t = chunk.text { texts.append(t) }
            if let th = chunk.thoughtSummary { thoughts.append(th) }
        }
        #expect(texts == ["Alpha ", "Beta"])
        #expect(thoughts == ["plan"])

        let subs = channel.recordedSubs()
        #expect(subs.count == 1)
        #expect(subs[0].sub["target"]?["service"]?.stringValue == "ai")
        #expect(subs[0].sub["target"]?["op"]?.stringValue == "streamGenerateContent")
        #expect(subs[0].sub["model"]?.stringValue == "models/gemini-2.5-flash")

        // Open-ended stream cancelled early by breaking out of the consumer loop -> sends worker-unsub
        channel.enqueueReply(.streamChunks(
            chunks: [makeTextChunk("First chunk")],
            finishAfterChunks: false
        ))
        var receivedFirst: String?
        do {
            for try await chunk in try model.generateContentStream("Cancel mid-stream") {
                receivedFirst = chunk.text
                break
            }
        }
        #expect(receivedFirst == "First chunk")
        let cancelledSubId = await channel.waitForNextUnsub()
        #expect(cancelledSubId == channel.recordedSubs()[1].subId)

        await ai.disconnect()
    }

    @Test("Chat updates history atomically on sendMessage and sendMessageStream and skips failed or blocked turns")
    func chatAtomicHistoryUpdates() async throws {
        let channel = MockAiBridgeChannel()
        let app = FirebaseApp(
            name: "chat-app",
            options: FirebaseOptions(projectID: "demo-chat", apiKey: "k", googleAppID: "1:1:ios:chat")
        )
        let ai = FirebaseAI.firebaseAI(app: app, transport: channel)
        let model = ai.generativeModel(modelName: "gemini-2.5-flash")
        let chat = model.startChat(history: [
            ModelContent(role: "user", parts: "Seed user"),
            ModelContent(role: "model", parts: "Seed model"),
        ])
        #expect(chat.history.count == 2)

        // 1. Successful unary turn appends user + model turns (4 total)
        channel.enqueueReply(.unarySuccess(makeTextChunk("Unary reply", finishReason: "STOP")))
        let reply1 = try await chat.sendMessage("Turn 1")
        #expect(reply1.text == "Unary reply")
        #expect(chat.history.count == 4)

        // 2. Safety-blocked candidate throws responseStoppedEarly and leaves history at 4!
        channel.enqueueReply(.unarySuccess([
            "candidates": .array([
                .object([
                    "content": .object(["role": .string("model"), "parts": .array([])]),
                    "finishReason": .string("SAFETY"),
                ]),
            ]),
        ]))
        do {
            _ = try await chat.sendMessage("Blocked turn")
            Issue.record("Expected responseStoppedEarly")
        } catch is GenerateContentError {
            // expected
        }
        #expect(chat.history.count == 4)

        // 3. Backend error on stream leaves history at 4!
        channel.enqueueReply(.streamError(
            code: "ai/RESOURCE_EXHAUSTED",
            message: "Quota exceeded",
            aiEnvelope: [
                "error": .object([
                    "code": .number(429),
                    "message": .string("Quota exceeded"),
                    "status": .string("RESOURCE_EXHAUSTED"),
                ]),
            ],
            partialChunks: [makeTextChunk("Partial before failure")]
        ))
        do {
            let failingStream = try chat.sendMessageStream("Failing stream turn")
            var partialCount = 0
            for try await _ in failingStream {
                partialCount += 1
            }
            #expect(partialCount == 1)
            Issue.record("Expected stream error")
        } catch let GenerateContentError.internalError(underlying) {
            let backend = try #require(underlying as? BackendError)
            #expect(backend.httpResponseCode == 429)
            #expect(backend.status == .resourceExhausted)
        }
        #expect(chat.history.count == 4)

        // 4. Successful streaming turn aggregates thought + text chunks into one model turn (6 total)
        channel.enqueueReply(.streamChunks(
            chunks: [
                makeTextChunk("step-1 ", isThought: true),
                makeTextChunk("step-2", isThought: true),
                makeTextChunk("Stream "),
                makeTextChunk("complete!", finishReason: "STOP"),
            ],
            finishAfterChunks: true
        ))
        let okStream = try chat.sendMessageStream("Streaming turn")
        var streamedText = ""
        for try await chunk in okStream {
            streamedText += chunk.text ?? ""
        }
        #expect(streamedText == "Stream complete!")
        #expect(chat.history.count == 6)
        let aggregatedModelTurn = chat.history[5]
        #expect(aggregatedModelTurn.role == "model")
        #expect(aggregatedModelTurn.parts.count == 2)
        let thoughtPart = try #require(aggregatedModelTurn.parts[0] as? TextPart)
        #expect(thoughtPart.isThought == true)
        #expect(thoughtPart.text == "step-1 step-2")
        let answerPart = try #require(aggregatedModelTurn.parts[1] as? TextPart)
        #expect(answerPart.isThought == false)
        #expect(answerPart.text == "Stream complete!")

        await ai.disconnect()
    }

    @Test("AppCheck attaches cached standard and fresh limited-use tokens via opWithAppCheck onto unary and stream calls")
    func appCheckTokenAttachmentOnUnaryAndStream() async throws {
        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            let previousFactory = AppCheck.providerFactory
            defer {
                AppCheck.setAppCheckProviderFactory(previousFactory)
                FirebaseAI.reset()
            }

            let factory = CountingAppCheckFactory()
            AppCheck.setAppCheckProviderFactory(factory)
            let appName = "ai-appcheck-unit-\(UUID().uuidString)"
            FirebaseApp.configure(
                name: appName,
                options: FirebaseOptions(
                    projectID: "demo-ai-appcheck",
                    apiKey: "demo-key",
                    googleAppID: "1:999999:ios:aiappcheck"
                )
            )
            let app = try #require(FirebaseApp.app(name: appName))
            _ = try #require(AppCheck.appCheck(app: app))
            AppCheck.setAppCheckProviderFactory(previousFactory)

            // Standard cached App Check token attached to generateContent, countTokens, and generateContentStream
            let stdChannel = MockAiBridgeChannel()
            let stdAI = FirebaseAI.firebaseAI(
                app: app,
                useLimitedUseAppCheckTokens: false,
                transport: stdChannel
            )
            let stdModel = stdAI.generativeModel(modelName: "gemini-2.5-flash")

            stdChannel.enqueueReply(.unarySuccess(makeTextChunk("ok-1", finishReason: "STOP")))
            _ = try await stdModel.generateContent("First call")

            stdChannel.enqueueReply(.unarySuccess([
                "totalTokens": .number(7),
                "promptTokensDetails": .array([
                    .object(["modality": .string("TEXT"), "tokenCount": .number(7)]),
                ]),
            ]))
            let counted = try await stdModel.countTokens("Count me")
            #expect(counted.totalTokens == 7)
            #expect(counted.promptTokensDetails.first?.tokenCount == 7)

            stdChannel.enqueueReply(.streamChunks(
                chunks: [makeTextChunk("stream-ok", finishReason: "STOP")],
                finishAfterChunks: true
            ))
            for try await _ in try stdModel.generateContentStream("Stream with AppCheck") {}

            let stdOps = stdChannel.recordedOps()
            #expect(stdOps.count == 2)
            #expect(stdOps[0]["appCheck"]?["token"]?.stringValue == "unit-std-jwt-1")
            #expect(stdOps[0]["appCheckToken"]?.stringValue == "unit-std-jwt-1")
            #expect(stdOps[1]["appCheck"]?["token"]?.stringValue == "unit-std-jwt-1")
            let stdSubs = stdChannel.recordedSubs()
            #expect(stdSubs.count == 1)
            #expect(stdSubs[0].sub["appCheck"]?["token"]?.stringValue == "unit-std-jwt-1")
            #expect(stdSubs[0].sub["appCheckToken"]?.stringValue == "unit-std-jwt-1")

            // Limited-use App Check tokens mint a fresh token per request
            let limitedChannel = MockAiBridgeChannel()
            let limitedAI = FirebaseAI.firebaseAI(
                app: app,
                useLimitedUseAppCheckTokens: true,
                transport: limitedChannel
            )
            let limitedModel = limitedAI.generativeModel(modelName: "gemini-2.5-flash")

            limitedChannel.enqueueReply(.unarySuccess(makeTextChunk("lim-1", finishReason: "STOP")))
            _ = try await limitedModel.generateContent("Limited 1")
            limitedChannel.enqueueReply(.unarySuccess(makeTextChunk("lim-2", finishReason: "STOP")))
            _ = try await limitedModel.generateContent("Limited 2")

            let limOps = limitedChannel.recordedOps()
            #expect(limOps.count == 2)
            #expect(limOps[0]["appCheck"]?["token"]?.stringValue == "unit-limited-jwt-1")
            #expect(limOps[1]["appCheck"]?["token"]?.stringValue == "unit-limited-jwt-2")

            await stdAI.disconnect()
            await limitedAI.disconnect()
            await app.delete()
        }
    }
}
