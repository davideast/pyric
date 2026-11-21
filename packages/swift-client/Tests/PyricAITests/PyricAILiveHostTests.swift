import Foundation
import Testing
import PyricAI
import PyricAppCheck
import PyricFirestore

@Suite("PyricAI Live-Host Conformance Suite", .serialized)
struct PyricAILiveHostTests {
    private static let projectId = "demo-swift-ai"
    private static let iosAppId = "1:424242424242:ios:swiftaiclient"

    @Test("Executes unary, structured JSON, function calling, streaming, Chat, countTokens, and App Check over live AiBroker")
    func fullLiveHostAiLogicWorkflow() async throws {
        guard let rawBridgeUrl = ProcessInfo.processInfo.environment["PYRIC_LIVE_AI_BRIDGE_URL"],
              !rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let parsedUrl = try #require(URL(string: rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines)))
        let host = try #require(parsedUrl.host)
        let port = try #require(parsedUrl.port)

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            let previousFactory = AppCheck.providerFactory
            FirebaseAI.reset()
            defer {
                AppCheck.setAppCheckProviderFactory(previousFactory)
                FirebaseAI.reset()
            }

            let options = FirebaseOptions(
                projectID: Self.projectId,
                apiKey: "sandbox-ai-key",
                googleAppID: Self.iosAppId
            )
            let unauthName = "live-swift-ai-unauth-\(UUID().uuidString)"
            FirebaseApp.configure(name: unauthName, options: options)
            let unauthApp = try #require(FirebaseApp.app(name: unauthName))
            unauthApp.useEmulator(withHost: host, port: port)

            // 1. Enforced App Check without an initialized provider is refused with HTTP 401 UNAUTHENTICATED
            let enforcedUninitAI = FirebaseAI.firebaseAI(
                app: unauthApp,
                backend: .googleAI(),
                enforceAppCheck: true
            )
            let uninitModel = enforcedUninitAI.generativeModel(modelName: "gemini-2.5-flash")
            do {
                _ = try await uninitModel.generateContent("Should fail App Check gate")
                Issue.record("Expected 401 UNAUTHENTICATED App Check refusal")
            } catch let GenerateContentError.internalError(underlying) {
                let backendErr = try #require(underlying as? BackendError)
                #expect(backendErr.httpResponseCode == 401)
                #expect(backendErr.status == .unauthenticated)
                #expect(backendErr.message == "Firebase App Check token is invalid.")
            }
            await enforcedUninitAI.disconnect()
            await unauthApp.delete()

            // 2. Initialize real sandbox AppCheckDebugProviderFactory on primary app
            AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
            let primaryName = "live-swift-ai-primary-\(UUID().uuidString)"
            FirebaseApp.configure(name: primaryName, options: options)
            let app = try #require(FirebaseApp.app(name: primaryName))
            app.useEmulator(withHost: host, port: port)
            let appCheck = try #require(AppCheck.appCheck(app: app))
            AppCheck.setAppCheckProviderFactory(previousFactory)
            let mintedStd = try await appCheck.token(forcingRefresh: false)
            #expect(!mintedStd.token.isEmpty)

            let ai = FirebaseAI.firebaseAI(app: app, backend: .googleAI())

            // 3. Unary generateContent with scripted thought + answer parts
            let unaryModel = ai.generativeModel(
                modelName: "gemini-2.5-flash",
                generationConfig: GenerationConfig(
                    temperature: 0.2,
                    maxOutputTokens: 200,
                    thinkingConfig: ThinkingConfig(thinkingBudget: 64, includeThoughts: true)
                ),
                safetySettings: [
                    SafetySetting(harmCategory: .hateSpeech, threshold: .blockOnlyHigh),
                ],
                systemInstruction: ModelContent(parts: "Respond concisely.")
            )
            let thoughtRes = try await unaryModel.generateContent("LIVE_THOUGHT_PROMPT")
            #expect(thoughtRes.text == "Verified live Swift answer")
            #expect(thoughtRes.thoughtSummary == "Reasoning on live host")
            #expect((thoughtRes.usageMetadata?.totalTokenCount ?? 0) > 0)

            // 4. Structured JSON output via Schema DSL (zero-config schema synthesis on AiBroker)
            let jsonSchema = Schema.object(
                properties: [
                    "framework": .string(),
                    "status": .enumeration(values: ["ready", "pending"]),
                    "count": .integer(),
                    "verified": .boolean(),
                ]
            )
            let jsonModel = ai.generativeModel(
                modelName: "gemini-2.5-flash",
                generationConfig: GenerationConfig(
                    responseMIMEType: "application/json",
                    responseSchema: jsonSchema
                )
            )
            let jsonRes = try await jsonModel.generateContent("Generate structured JSON")
            let rawJsonText = try #require(jsonRes.text)
            let parsedJson = try JSONDecoder().decode(
                JSONObject.self,
                from: Data(rawJsonText.utf8)
            )
            #expect(parsedJson["status"] == .string("ready"))
            #expect(parsedJson["count"] == .number(1))
            #expect(parsedJson["verified"] == .bool(true))

            // 5. Multi-turn function calling in Chat (preserving AiBroker thoughtSignature!)
            let lookupTool = Tool.functionDeclarations([
                FunctionDeclaration(
                    name: "getForecast",
                    description: "Returns weather forecast for a city",
                    parameters: ["city": .string()]
                ),
            ])
            let fnModel = ai.generativeModel(
                modelName: "gemini-2.5-flash",
                tools: [lookupTool],
                toolConfig: ToolConfig(functionCallingConfig: .auto())
            )
            let fnChat = fnModel.startChat()
            let fnTurn1 = try await fnChat.sendMessage("LIVE_FNCALL_PROMPT")
            #expect(fnTurn1.functionCalls.count == 1)
            let callPart = fnTurn1.functionCalls[0]
            #expect(callPart.name == "getForecast")
            #expect(callPart.args["city"] == .string("Kyoto"))
            #expect(callPart.thoughtSignature != nil)
            #expect(fnChat.history.count == 2)

            let fnTurn2 = try await fnChat.sendMessage(
                FunctionResponsePart(
                    name: callPart.name,
                    response: ["forecast": .string("Sunny 23C")],
                    functionId: callPart.functionId
                )
            )
            #expect(fnTurn2.text == "Kyoto is Sunny 23C today.")
            #expect(fnChat.history.count == 4)

            // 6. Streaming generateContentStream + multi-turn Chat sendMessageStream + blocked turn preservation
            let streamChat = unaryModel.startChat()
            let streamTurn = try streamChat.sendMessageStream("LIVE_STREAM_CHUNKS")
            var collectedPieces: [String] = []
            for try await chunk in streamTurn {
                if let piece = chunk.text {
                    collectedPieces.append(piece)
                }
            }
            #expect(collectedPieces == ["Swift ", "streaming ", "works!"])
            #expect(streamChat.history.count == 2)

            // Blocked safety turn on live AiBroker leaves streamChat.history at 2!
            do {
                _ = try await streamChat.sendMessage("LIVE_SAFETY_BLOCK")
                Issue.record("Expected safety responseStoppedEarly")
            } catch let GenerateContentError.responseStoppedEarly(reason, _) {
                #expect(reason == .safety)
            }
            #expect(streamChat.history.count == 2)

            // 7. countTokens on VertexAI backend + limited-use App Check token AI handle
            let vertexLimitedAI = FirebaseAI.firebaseAI(
                app: app,
                backend: .vertexAI(location: "us-central1"),
                useLimitedUseAppCheckTokens: true
            )
            let vertexModel = vertexLimitedAI.generativeModel(modelName: "gemini-2.5-flash")
            let countRes = try await vertexModel.countTokens("Count these tokens over live WebSocket")
            #expect(countRes.totalTokens > 0)
            #expect(countRes.promptTokensDetails.first?.modality == .text)

            let limitedGenRes = try await vertexModel.generateContent("LIVE_LIMITED_TOKEN_PROMPT")
            #expect(limitedGenRes.text == "Limited-use token accepted")

            await ai.disconnect()
            await vertexLimitedAI.disconnect()
            await app.delete()
        }
    }
}
