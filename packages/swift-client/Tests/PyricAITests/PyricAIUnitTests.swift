import Foundation
import Testing
import PyricAI
import PyricFirestore

@Suite("PyricAI Unit Suite", .serialized)
struct PyricAIUnitTests {

    @Test("FirebaseAI instance caching, reset, and GoogleAI/VertexAI model normalization")
    func instanceCachingAndModelNormalization() async throws {
        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            FirebaseAI.reset()
            defer {
                FirebaseAI.reset()
            }

            let opts = FirebaseOptions(
                projectID: "demo-ai-unit",
                apiKey: "demo-key",
                googleAppID: "1:123456789:ios:aiunit"
            )
            let secondaryName = "secondary-ai-\(UUID().uuidString)"
            FirebaseApp.configure(options: opts)
            FirebaseApp.configure(name: secondaryName, options: opts)

            let defaultAI1 = FirebaseAI.firebaseAI()
            let defaultAI2 = FirebaseAI.firebaseAI(backend: .googleAI())
            #expect(defaultAI1 === defaultAI2)

            let limitedAI = FirebaseAI.firebaseAI(useLimitedUseAppCheckTokens: true)
            #expect(limitedAI !== defaultAI1)
            #expect(limitedAI.useLimitedUseAppCheckTokens == true)

            let vertexAI1 = FirebaseAI.firebaseAI(backend: .vertexAI(location: "europe-west1"))
            let vertexAI2 = FirebaseAI.firebaseAI(backend: .vertexAI(location: "europe-west1"))
            #expect(vertexAI1 === vertexAI2)
            #expect(vertexAI1 !== defaultAI1)
            #expect(vertexAI1.backend.location == "europe-west1")

            let agentPlatformAI = FirebaseAI.firebaseAI(backend: .agentPlatform())
            #expect(agentPlatformAI.backend.location == "global")

            let secondaryApp = try #require(FirebaseApp.app(name: secondaryName))
            let secondaryAI = FirebaseAI.firebaseAI(app: secondaryApp)
            #expect(secondaryAI !== defaultAI1)

            FirebaseAI.reset()
            let postResetAI = FirebaseAI.firebaseAI()
            #expect(postResetAI !== defaultAI1)

            await secondaryApp.delete()
        }
    }

    @Test("GoogleAI and VertexAI normalize bare and prefixed model names without double-prefixing")
    func wireModelNameNormalization() async throws {
        let app = FirebaseApp(
            name: "norm-app",
            options: FirebaseOptions(projectID: "demo-norm", apiKey: "k", googleAppID: "1:1:ios:norm")
        )
        let googleChannel = MockAiBridgeChannel()
        let googleAI = FirebaseAI.firebaseAI(app: app, backend: .googleAI(), transport: googleChannel)

        _ = try await googleAI.generativeModel(modelName: "gemini-2.5-flash").generateContent("hi")
        _ = try await googleAI.generativeModel(modelName: "models/gemini-2.5-flash").generateContent("hi")

        let googleOps = googleChannel.recordedOps()
        #expect(googleOps.count == 2)
        #expect(googleOps[0]["model"]?.stringValue == "models/gemini-2.5-flash")
        #expect(googleOps[1]["model"]?.stringValue == "models/gemini-2.5-flash")

        let vertexChannel = MockAiBridgeChannel()
        let vertexAI = FirebaseAI.firebaseAI(
            app: app,
            backend: .vertexAI(location: "us-central1"),
            transport: vertexChannel
        )
        _ = try await vertexAI.generativeModel(modelName: "gemini-2.5-pro").generateContent("hi")
        _ = try await vertexAI.generativeModel(modelName: "models/gemini-2.5-pro").generateContent("hi")

        let vertexOps = vertexChannel.recordedOps()
        #expect(vertexOps.count == 2)
        #expect(vertexOps[0]["model"]?.stringValue == "publishers/google/models/gemini-2.5-pro")
        #expect(vertexOps[1]["model"]?.stringValue == "publishers/google/models/gemini-2.5-pro")

        await googleAI.disconnect()
        await vertexAI.disconnect()
    }

    @Test("Schema DSL builds OpenAPI and JSON Schema structures across all types")
    func schemaDslEncoding() throws {
        let addressSchema = Schema.object(
            properties: [
                "city": .string(description: "City name", format: .custom("city-name")),
                "zip": .integer(nullable: true, format: .int32, minimum: 10000, maximum: 99999),
            ],
            optionalProperties: ["zip"],
            propertyOrdering: ["city", "zip"]
        )
        let rootSchema = Schema.object(
            properties: [
                "title": .string(title: "Title"),
                "direction": .enumeration(values: ["north", "south"], nullable: true),
                "score": .float(minimum: 0.0, maximum: 1.0),
                "precise": .double(minimum: -10.5, maximum: 10.5),
                "active": .boolean(),
                "tags": .array(items: .string(), minItems: 1, maxItems: 5),
                "address": addressSchema,
                "flexibleId": .anyOf(schemas: [.integer(format: .int64), .string()]),
            ],
            optionalProperties: ["precise"]
        )

        #expect(rootSchema.type == "OBJECT")
        #expect(rootSchema.requiredProperties?.contains("title") == true)
        #expect(rootSchema.requiredProperties?.contains("precise") == false)
        #expect(Schema.anyOf(schemas: [.string()]).type == "UNSPECIFIED")

        let encoded = try JSONEncoder().encode(rootSchema)
        let wire = try JSONDecoder().decode(JSONObject.self, from: encoded)
        #expect(wire["type"] == .string("OBJECT"))
        #expect(wire["properties"]?["direction"]?["enum"] == .array([.string("north"), .string("south")]))
        #expect(wire["properties"]?["tags"]?["minItems"] == .number(1))
        #expect(wire["properties"]?["tags"]?["maxItems"] == .number(5))
        #expect(wire["properties"]?["address"]?["propertyOrdering"] == .array([.string("city"), .string("zip")]))

        let jsonSchema = rootSchema.toJSONSchema()
        #expect(jsonSchema["type"] == .string("object"))
        #expect(jsonSchema["additionalProperties"] == .bool(false))
        #expect(
            jsonSchema["properties"]?["direction"]?["type"]
                == .array([.string("string"), .string("null")])
        )
        #expect(
            jsonSchema["properties"]?["direction"]?["enum"]
                == .array([.string("north"), .string("south"), .null])
        )
    }

    @Test("ModelContent and all Part types round-trip with Gemini JSON wire fidelity")
    func modelContentAndPartWireRoundTrip() throws {
        let rawBytes = Data([0x89, 0x50, 0x4E, 0x47])
        let turn = ModelContent(
            role: "model",
            parts: [
                TextPart("thinking step", isThought: true, thoughtSignature: "sig-thought"),
                TextPart("final answer", speechMetadata: SpeechMetadata(speaker: "Alice", prompt: "cheerful")),
                InlineDataPart(data: rawBytes, mimeType: "image/png"),
                FileDataPart(uri: "gs://demo-bucket/clip.mp4", mimeType: "video/mp4"),
                FunctionCallPart(
                    name: "lookupWeather",
                    args: ["city": .string("Tokyo"), "metric": .bool(true)],
                    id: "call-1",
                    thoughtSignature: "sig-fn-1"
                ),
                FunctionResponsePart(
                    name: "lookupWeather",
                    response: ["tempC": .number(21)],
                    functionId: "call-1"
                ),
                ExecutableCodePart(language: .python, code: "print(6 * 7)"),
                CodeExecutionResultPart(outcome: .ok, output: "42\n"),
            ]
        )

        let data = try JSONEncoder().encode(turn)
        let wire = try JSONDecoder().decode(JSONObject.self, from: data)
        #expect(wire["role"] == .string("model"))
        let wireParts = try #require(wire["parts"]?.arrayValue)
        #expect(wireParts.count == 8)
        #expect(wireParts[0]["thought"] == .bool(true))
        #expect(wireParts[0]["thoughtSignature"] == .string("sig-thought"))
        #expect(wireParts[2]["inlineData"]?["data"] == .string(rawBytes.base64EncodedString()))
        #expect(wireParts[3]["fileData"]?["fileUri"] == .string("gs://demo-bucket/clip.mp4"))
        #expect(wireParts[4]["functionCall"]?["name"] == .string("lookupWeather"))
        #expect(wireParts[4]["thoughtSignature"] == .string("sig-fn-1"))
        #expect(wireParts[5]["functionResponse"]?["id"] == .string("call-1"))

        let decoded = try JSONDecoder().decode(ModelContent.self, from: data)
        #expect(decoded == turn)
        let decodedFnCall = try #require(decoded.parts[4] as? FunctionCallPart)
        #expect(decodedFnCall.name == "lookupWeather")
        #expect(decodedFnCall.functionId == "call-1")
        #expect(decodedFnCall.thoughtSignature == "sig-fn-1")
        #expect(decodedFnCall.args["metric"] == .bool(true))
    }

    @Test("GenerationConfig, Tool, ToolConfig, SafetySetting, and systemInstruction serialize cleanly")
    func requestConfigurationSerialization() async throws {
        let channel = MockAiBridgeChannel()
        let app = FirebaseApp(
            name: "cfg-app",
            options: FirebaseOptions(projectID: "demo-cfg", apiKey: "k", googleAppID: "1:1:ios:cfg")
        )
        let ai = FirebaseAI.firebaseAI(
            app: app,
            engine: .scripted(script: [["text": .string("configured")]]),
            transport: channel
        )

        let weatherDecl = FunctionDeclaration(
            name: "getWeather",
            description: "Fetches current weather",
            parameters: [
                "city": .string(description: "City"),
                "units": .enumeration(values: ["C", "F"]),
            ],
            optionalParameters: ["units"]
        )
        let genConfig = GenerationConfig(
            temperature: 0.25,
            topP: 0.9,
            topK: 20,
            maxOutputTokens: 256,
            stopSequences: ["END"],
            responseMIMEType: "application/json",
            responseSchema: .object(properties: ["answer": .string()]),
            responseModalities: [.text],
            thinkingConfig: ThinkingConfig(thinkingBudget: 128, includeThoughts: true),
            imageConfig: ImageConfig(aspectRatio: .landscape16x9, imageSize: .size1K)
        )
        let model = ai.generativeModel(
            modelName: "gemini-2.5-flash",
            generationConfig: genConfig,
            safetySettings: [
                SafetySetting(
                    harmCategory: .harassment,
                    threshold: .blockMediumAndAbove,
                    method: .severity
                ),
            ],
            tools: [
                GenerativeModel.Tool.functionDeclarations([weatherDecl]),
                Tool.googleSearch(),
                Tool.codeExecution(),
            ],
            toolConfig: ToolConfig(
                functionCallingConfig: .any(allowedFunctionNames: ["getWeather"]),
                retrievalConfig: RetrievalConfig(
                    location: RetrievalLocation(latitude: 35.6762, longitude: 139.6503),
                    languageCode: "en-US"
                )
            ),
            systemInstruction: ModelContent(parts: "Always answer concisely.")
        )

        _ = try await model.generateContent("Hello", [TextPart("world")] as [any PartsRepresentable])
        let op = try #require(channel.recordedOps().first)
        #expect(op["method"]?.stringValue == "ai.generateContent")
        #expect(op["engine"]?["kind"]?.stringValue == "scripted")

        let req = try #require(op["request"]?.dictionaryValue)
        #expect(req["systemInstruction"]?["role"] == nil)
        #expect(req["systemInstruction"]?["parts"]?[0]?["text"]?.stringValue == "Always answer concisely.")
        #expect(req["generationConfig"]?["responseMimeType"]?.stringValue == "application/json")
        #expect(req["generationConfig"]?["thinkingConfig"]?["thinkingBudget"]?.intValue == 128)
        #expect(req["generationConfig"]?["thinkingConfig"]?["includeThoughts"]?.boolValue == true)
        #expect(req["safetySettings"]?[0]?["category"]?.stringValue == "HARM_CATEGORY_HARASSMENT")
        #expect(req["safetySettings"]?[0]?["threshold"]?.stringValue == "BLOCK_MEDIUM_AND_ABOVE")
        #expect(req["safetySettings"]?[0]?["method"]?.stringValue == "SEVERITY")
        #expect(req["toolConfig"]?["functionCallingConfig"]?["mode"]?.stringValue == "ANY")
        #expect(req["toolConfig"]?["retrievalConfig"]?["latLng"]?["latitude"]?.doubleValue == 35.6762)

        // Verify FunctionCallingConfig.none() encodes "NONE" (not nil!)
        let noneEncoded = try JSONEncoder().encode(FunctionCallingConfig.none())
        let noneObj = try JSONDecoder().decode(JSONObject.self, from: noneEncoded)
        #expect(noneObj["mode"] == .string("NONE"))

        await ai.disconnect()
    }

    @Test("GenerateContentResponse skips thought parts in text, exposes thoughtSummary/functionCalls/inlineDataParts, and maps errors")
    func responseHelpersAndErrorCases() async throws {
        let channel = MockAiBridgeChannel()
        let app = FirebaseApp(
            name: "resp-app",
            options: FirebaseOptions(projectID: "demo-resp", apiKey: "k", googleAppID: "1:1:ios:resp")
        )
        let ai = FirebaseAI.firebaseAI(app: app, transport: channel)
        let model = ai.generativeModel(modelName: "gemini-2.5-flash")

        let pngBase64 = Data([1, 2, 3, 4]).base64EncodedString()
        channel.enqueueReply(.unarySuccess([
            "responseId": .string("resp-101"),
            "modelVersion": .string("gemini-2.5-flash-001"),
            "candidates": .array([
                .object([
                    "content": .object([
                        "role": .string("model"),
                        "parts": .array([
                            .object(["text": .string("internal reasoning"), "thought": .bool(true)]),
                            .object(["text": .string("Hello ")]),
                            .object(["text": .string("Swift!")]),
                            .object([
                                "functionCall": .object([
                                    "name": .string("computeSum"),
                                    "args": .object(["a": .number(2), "b": .number(3)]),
                                    "id": .string("fn-99"),
                                ]),
                                "thoughtSignature": .string("sig-99"),
                            ]),
                            .object([
                                "inlineData": .object([
                                    "mimeType": .string("image/png"),
                                    "data": .string(pngBase64),
                                ]),
                            ]),
                        ]),
                    ]),
                    "finishReason": .string("STOP"),
                    "citationMetadata": .object([
                        "citationSources": .array([
                            .object([
                                "startIndex": .number(0),
                                "endIndex": .number(5),
                                "uri": .string("https://example.com/doc"),
                                "publicationDate": .object(["year": .number(2026), "month": .number(5), "day": .number(1)]),
                            ]),
                        ]),
                    ]),
                    "groundingMetadata": .object([
                        "webSearchQueries": .array([.string("swift concurrency")]),
                        "groundingChunks": .array([
                            .object(["web": .object(["uri": .string("https://swift.org"), "title": .string("Swift")])]),
                        ]),
                    ]),
                ]),
            ]),
            "usageMetadata": .object([
                "promptTokenCount": .number(12),
                "candidatesTokenCount": .number(8),
                "thoughtsTokenCount": .number(5),
                "totalTokenCount": .number(25),
                "promptTokensDetails": .array([
                    .object(["modality": .string("TEXT"), "tokenCount": .number(12)]),
                ]),
            ]),
        ]))

        let res = try await model.generateContent("Test multimodal")
        #expect(res.text == "Hello Swift!")
        #expect(res.thoughtSummary == "internal reasoning")
        #expect(res.modelVersion == "gemini-2.5-flash-001")
        #expect(res.responseID == "resp-101")
        #expect(res.functionCalls.count == 1)
        #expect(res.functionCalls[0].name == "computeSum")
        #expect(res.functionCalls[0].functionId == "fn-99")
        #expect(res.functionCalls[0].thoughtSignature == "sig-99")
        #expect(res.inlineDataParts.count == 1)
        #expect(res.inlineDataParts[0].data == Data([1, 2, 3, 4]))
        #expect(res.usageMetadata?.totalTokenCount == 25)
        #expect(res.usageMetadata?.thoughtsTokenCount == 5)
        #expect(res.usageMetadata?.promptTokensDetails.first?.modality == .text)
        #expect(res.candidates.first?.citationMetadata?.citations.first?.publicationDate?.year == 2026)
        #expect(res.candidates.first?.groundingMetadata?.webSearchQueries == ["swift concurrency"])

        // Prompt blocked -> GenerateContentError.promptBlocked
        channel.enqueueReply(.unarySuccess([
            "promptFeedback": .object([
                "blockReason": .string("SAFETY"),
                "blockReasonMessage": .string("Unsafe prompt"),
            ]),
        ]))
        do {
            _ = try await model.generateContent("Blocked prompt")
            Issue.record("Expected promptBlocked error")
        } catch let GenerateContentError.promptBlocked(blockedRes) {
            #expect(blockedRes.promptFeedback?.blockReason == .safety)
        }

        // Candidate safety finishReason -> GenerateContentError.responseStoppedEarly
        channel.enqueueReply(.unarySuccess([
            "candidates": .array([
                .object([
                    "content": .object(["role": .string("model"), "parts": .array([])]),
                    "finishReason": .string("SAFETY"),
                    "finishMessage": .string("Filtered"),
                ]),
            ]),
        ]))
        do {
            _ = try await model.generateContent("Stopped early")
            Issue.record("Expected responseStoppedEarly error")
        } catch let GenerateContentError.responseStoppedEarly(reason, _) {
            #expect(reason == .safety)
        }

        // Backend aiEnvelope error -> GenerateContentError.internalError(BackendError)
        channel.enqueueReply(.unaryError(
            code: "ai/UNAUTHENTICATED",
            message: "Firebase App Check token is invalid.",
            aiEnvelope: [
                "error": .object([
                    "code": .number(401),
                    "message": .string("Firebase App Check token is invalid."),
                    "status": .string("UNAUTHENTICATED"),
                ]),
            ]
        ))
        do {
            _ = try await model.generateContent("Unauthorized")
            Issue.record("Expected BackendError")
        } catch let GenerateContentError.internalError(underlying) {
            let backendErr = try #require(underlying as? BackendError)
            #expect(backendErr.httpResponseCode == 401)
            #expect(backendErr.status == .unauthenticated)
            #expect(backendErr.message == "Firebase App Check token is invalid.")
        }

        await ai.disconnect()
    }
}
