package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.BlockReason
import com.google.firebase.ai.type.ContentModality
import com.google.firebase.ai.type.FinishReason
import com.google.firebase.ai.type.FunctionCallingConfig
import com.google.firebase.ai.type.FunctionDeclaration
import com.google.firebase.ai.type.FunctionResponsePart
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.HarmBlockThreshold
import com.google.firebase.ai.type.HarmCategory
import com.google.firebase.ai.type.InvalidAPIKeyException
import com.google.firebase.ai.type.PromptBlockedException
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.ResponseStoppedException
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.ai.type.Schema
import com.google.firebase.ai.type.ServerException
import com.google.firebase.ai.type.TextPart
import com.google.firebase.ai.type.ThinkingLevel
import com.google.firebase.ai.type.Tool
import com.google.firebase.ai.type.ToolConfig
import com.google.firebase.ai.type.asTextOrNull
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import com.google.firebase.ai.type.thinkingConfig
import com.google.firebase.appcheck.AppCheckProvider
import com.google.firebase.appcheck.AppCheckProviderFactory
import com.google.firebase.appcheck.AppCheckToken
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

private class ForgedAppCheckToken(
    override val token: String,
    override val expireTimeMillis: Long
) : AppCheckToken()

class AiLiveHostConformanceTest {

    private lateinit var liveBridgeUrl: String
    private val bridges = mutableListOf<PyricBridgeClient>()

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_AI_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "Skipping AiLiveHostConformanceTest: PYRIC_LIVE_AI_BRIDGE_URL is unset"
        )
        liveBridgeUrl = envUrl!!.trim()
        FirebaseAI.reset()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        for (bridge in bridges) {
            runCatching { bridge.terminate() }
        }
        bridges.clear()
        FirebaseAI.reset()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun newBridge(): PyricBridgeClient {
        val client = PyricBridgeClient(url = liveBridgeUrl)
        bridges.add(client)
        return client
    }

    private fun initApp(name: String, appId: String): FirebaseApp =
        FirebaseApp.initializeApp(
            name,
            FirebaseOptions.Builder()
                .setProjectId("demo-kotlin-ai")
                .setApiKey("sandbox-api-key")
                .setApplicationId(appId)
                .build()
        )

    @Test
    fun unaryGenerateContentAndCountTokensRoundTripAcrossGoogleAiAndVertexAiBackends(): Unit = runBlocking {
        val app = initApp("live-ai-unary", "1:424242424242:android:aiunaryapp")
        val bridge = newBridge()

        val googleAi = FirebaseAI.getInstance(
            app = app,
            bridgeClient = bridge,
            backend = GenerativeBackend.googleAI()
        )
        val model = googleAi.generativeModel(
            modelName = "gemini-2.5-flash",
            generationConfig = generationConfig {
                temperature = 0.3f
                maxOutputTokens = 256
                stopSequences = listOf("STOP_SEQ")
                thinkingConfig = thinkingConfig {
                    thinkingLevel = ThinkingLevel.LOW
                    includeThoughts = false
                }
            },
            safetySettings = listOf(
                SafetySetting(HarmCategory.HARASSMENT, HarmBlockThreshold.MEDIUM_AND_ABOVE)
            ),
            systemInstruction = content { text("You are the Pyric Kotlin AI test oracle.") }
        )

        val textResponse = model.generateContent("SCRIPT_GREET: Hello from Android Kotlin")
        assertEquals("Kotlin AI Logic unary greeting verified!", textResponse.text)
        assertEquals("gemini-2.5-flash", textResponse.modelVersion)
        assertNotNull(textResponse.responseId)
        assertEquals(FinishReason.STOP, textResponse.candidates.single().finishReason)
        assertTrue((textResponse.usageMetadata?.totalTokenCount ?: 0) > 0)

        // Multimodal + function-call round-trip preserving broker-minted thoughtSignature
        val vertexModel = FirebaseAI.getInstance(
            app = app,
            bridgeClient = bridge,
            backend = GenerativeBackend.vertexAI("us-central1")
        ).generativeModel("gemini-2.5-pro")

        val fnPrompt = content("user") {
            text("SCRIPT_FNCALL: Check weather in Kyoto")
            inlineData(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47), "image/png")
            fileData("gs://demo-kotlin-ai.appspot.com/maps/kyoto.png", "image/png")
        }
        val fnResponse = vertexModel.generateContent(fnPrompt)
        assertEquals(1, fnResponse.functionCalls.size)
        val callPart = fnResponse.functionCalls.single()
        assertEquals("lookupWeather", callPart.name)
        assertEquals("Kyoto", callPart.args["city"])
        assertNotNull(callPart.thoughtSignature)

        // Replay signed model turn + function response turn through broker validation
        val followUp = vertexModel.generateContent(
            fnPrompt,
            fnResponse.candidates.single().content,
            content("user") {
                part(
                    FunctionResponsePart(
                        name = callPart.name,
                        response = mapOf("tempC" to 19, "condition" to "clear"),
                        id = callPart.id
                    )
                )
            },
            content("user") { text("SCRIPT_FNRESULT: Summarize forecast") }
        )
        assertEquals("Kyoto is 19C and clear.", followUp.text)

        // Deterministic countTokens scales with input length
        val shortTokens = model.countTokens("short")
        val longTokens = model.countTokens("short ".repeat(25))
        assertTrue(shortTokens.totalTokens >= 1)
        assertTrue(longTokens.totalTokens > shortTokens.totalTokens)
        assertEquals(ContentModality.TEXT, shortTokens.promptTokensDetails.first().modality)
    }

    @Test
    fun blockedFinishReasonsBlockedPromptsAndBrokerWireErrorsThrowTypedExceptions(): Unit = runBlocking {
        val app = initApp("live-ai-blocks", "1:424242424242:android:aiblocksapp")
        val bridge = newBridge()
        val model = FirebaseAI.getInstance(app, bridge).generativeModel("gemini-2.5-flash")

        val safetyStopped = assertThrows<ResponseStoppedException> {
            runBlocking { model.generateContent("SCRIPT_BLOCK_SAFETY: trigger candidate block") }
        }
        assertEquals(FinishReason.SAFETY, safetyStopped.response.candidates.single().finishReason)
        assertEquals(
            "Candidate withheld by safety filter.",
            safetyStopped.response.candidates.single().finishMessage
        )

        val promptBlocked = assertThrows<PromptBlockedException> {
            runBlocking { model.generateContent("SCRIPT_BLOCK_PROMPT: trigger prompt block") }
        }
        assertEquals(
            BlockReason.PROHIBITED_CONTENT,
            promptBlocked.response?.promptFeedback?.blockReason
        )

        assertThrows<QuotaExceededException> {
            runBlocking { model.generateContent("SCRIPT_ERR_QUOTA: trigger 429") }
        }

        assertThrows<InvalidAPIKeyException> {
            runBlocking { model.generateContent("SCRIPT_ERR_APIKEY: trigger invalid key") }
        }

        // Broker-enforced role validation ('system' inside contents is rejected with 400 INVALID_ARGUMENT)
        val badRoleErr = assertThrows<ServerException> {
            runBlocking {
                model.generateContent(content(role = "system") { text("disallowed content role") })
            }
        }
        assertTrue(badRoleErr.message!!.contains("Role 'system' is not supported"))
    }

    @Test
    fun verifiesStandardLimitedUseAndRejectedAppCheckClaimsAgainstLiveAiBroker(): Unit = runBlocking {
        val standardApp = initApp(
            "live-ai-appcheck-standard",
            "1:424242424242:android:aistandardcheck"
        )
        val bridge = newBridge()

        val standardCheck = FirebaseAppCheck.getInstance(standardApp, bridge)
        standardCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())

        // Standard Firebase.ai(app) resolves the shared bridge and attaches cached debug JWT
        val standardModel = Firebase.ai(standardApp).generativeModel("gemini-2.5-flash")
        val gatedReply = standardModel.generateContent("SCRIPT_APPCHECK_STD: hello gated broker")
        assertEquals("Standard App Check claim admitted!", gatedReply.text)
        val gatedCount = standardModel.countTokens("count under standard App Check")
        assertTrue(gatedCount.totalTokens > 0)

        // Limited-use App Check mode mints distinct single-use JWTs on each AI request
        val limitedApp = initApp(
            "live-ai-appcheck-limited",
            "1:424242424242:android:ailimitedcheck"
        )
        val limitedCheck = FirebaseAppCheck.getInstance(limitedApp, bridge)
        limitedCheck.installAppCheckProviderFactory(
            PlayIntegrityAppCheckProviderFactory.getInstance()
        )
        val limitedModel = Firebase.ai(
            app = limitedApp,
            backend = GenerativeBackend.googleAI(),
            useLimitedUseAppCheckTokens = true
        ).generativeModel("gemini-2.5-flash")

        val limReply1 = limitedModel.generateContent("SCRIPT_APPCHECK_LIM_1: first limited call")
        val limReply2 = limitedModel.generateContent("SCRIPT_APPCHECK_LIM_2: second limited call")
        assertEquals("Limited-use App Check call 1 admitted!", limReply1.text)
        assertEquals("Limited-use App Check call 2 admitted!", limReply2.text)

        // Forged / unsigned App Check token is refused by AiBroker's enforced 401 gate
        val forgedApp = initApp(
            "live-ai-appcheck-forged",
            "1:424242424242:android:aiforgedcheck"
        )
        val forgedCheck = FirebaseAppCheck.getInstance(forgedApp, bridge)
        forgedCheck.installAppCheckProviderFactory(
            AppCheckProviderFactory {
                AppCheckProvider {
                    Tasks.forResult(
                        ForgedAppCheckToken(
                            token = "forged.unsigned.jwt",
                            expireTimeMillis = System.currentTimeMillis() + 300_000L
                        )
                    )
                }
            }
        )
        val forgedModel = Firebase.ai(forgedApp).generativeModel("gemini-2.5-flash")
        val refused = assertThrows<ServerException> {
            runBlocking { forgedModel.generateContent("should be refused before engine") }
        }
        assertNotEquals("", refused.message)
        assertTrue(refused.message!!.contains("Firebase App Check token is invalid."))
    }

    @Test
    fun streamingGenerateContentStreamMultiChunkTakeOneCancelAndAppCheckOverLiveOkHttp(): Unit = runBlocking {
        val app = initApp("live-ai-streaming", "1:424242424242:android:aistandardcheck")
        val bridge = newBridge()
        FirebaseAppCheck.getInstance(app, bridge)
            .installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())

        val model = FirebaseAI.getInstance(app, bridge).generativeModel("gemini-2.5-flash")

        val multiChunks = model.generateContentStream(
            "SCRIPT_STREAM_MULTI: stream three ordered chunks"
        ).toList()
        assertEquals(3, multiChunks.size)
        assertEquals("Kotlin Flow stream!", multiChunks.joinToString("") { it.text.orEmpty() })
        assertEquals(FinishReason.STOP, multiChunks.last().candidates.single().finishReason)
        assertTrue((multiChunks.last().usageMetadata?.totalTokenCount ?: 0) > 0)

        // Early .take(1) cancellation over real OkHttp WebSocket triggers worker-unsub on HostedRuntime
        val cancelledSlice = model.generateContentStream(
            "SCRIPT_STREAM_CANCEL: cancel immediately after first chunk"
        ).take(1).toList()
        assertEquals(1, cancelledSlice.size)
        assertEquals("first-cancel-chunk", cancelledSlice.single().text)

        // Stream wire error maps to exact FirebaseAIException subtype
        val unauthenticatedApp = initApp(
            "live-ai-streaming-err",
            "1:424242424242:android:aistreamerr"
        )
        val plainStreamModel = FirebaseAI.getInstance(unauthenticatedApp, bridge)
            .generativeModel("gemini-2.5-flash")
        assertThrows<QuotaExceededException> {
            runBlocking {
                plainStreamModel.generateContentStream("SCRIPT_STREAM_ERR: trigger stream 429").toList()
            }
        }
    }

    @Test
    fun multiTurnChatSendMessageStreamSafetyExclusionAndFunctionCallingLoop(): Unit = runBlocking {
        val app = initApp("live-ai-chat", "1:424242424242:android:aichatapp")
        val bridge = newBridge()
        val ai = FirebaseAI.getInstance(app, bridge)
        val model = ai.generativeModel("gemini-2.5-flash")

        val chat = model.startChat(
            listOf(
                content("user") { text("Seed: project code is 731.") },
                content("model") { text("Acknowledged project code 731.") }
            )
        )
        val initialSnapshot = chat.history
        assertEquals(2, initialSnapshot.size)

        val turn1 = chat.sendMessage("SCRIPT_CHAT_TURN_1: Hi, I am Ada.")
        assertEquals("Nice to meet you, Ada! Your favorite language is Kotlin.", turn1.text)
        assertEquals(2, initialSnapshot.size)
        assertEquals(4, chat.history.size)

        // Safety-blocked turn must not pollute chat.history
        assertThrows<ResponseStoppedException> {
            runBlocking { chat.sendMessage("SCRIPT_CHAT_BLOCKED: unsafe chat request") }
        }
        assertEquals(4, chat.history.size)

        // Streaming turn coalesces chunks into chat.history on clean completion
        val streamReply = chat.sendMessageStream("SCRIPT_CHAT_TURN_2: What is my name?").toList()
        assertEquals(2, streamReply.size)
        assertEquals("Your name is Ada and you love Kotlin!", streamReply.joinToString("") { it.text.orEmpty() })
        assertEquals(6, chat.history.size)
        val mergedStreamPart = chat.history.last().parts.single() as TextPart
        assertEquals("Your name is Ada and you love Kotlin!", mergedStreamPart.text)
        assertNotNull(mergedStreamPart.thoughtSignature)

        // Early .take(1) on sendMessageStream unsubscribes and excludes incomplete turn from history
        val partialChatChunk = chat.sendMessageStream("SCRIPT_CHAT_STREAM_CANCEL: stop early")
            .take(1)
            .toList()
        assertEquals("partial-chat-chunk-1", partialChatChunk.single().text)
        assertEquals(6, chat.history.size)

        // End-to-end Chat function-calling loop (thoughtSignature preserved + user/function role accepted)
        val weatherTool = Tool.functionDeclarations(
            listOf(
                FunctionDeclaration(
                    name = "lookupWeather",
                    description = "Returns current weather for a city",
                    parameters = mapOf("city" to Schema.string(description = "City name"))
                )
            )
        )
        val toolChat = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            tools = listOf(weatherTool),
            toolConfig = ToolConfig(FunctionCallingConfig.auto())
        ).startChat()

        val fnCallTurn = toolChat.sendMessage("SCRIPT_CHAT_FN: Weather in Reykjavik?")
        val fnCall = fnCallTurn.functionCalls.single()
        assertEquals("lookupWeather", fnCall.name)
        assertEquals("Reykjavik", fnCall.args["city"])
        assertNotNull(fnCall.thoughtSignature)

        val fnSummaryTurn = toolChat.sendMessage(
            content("function") {
                part(
                    FunctionResponsePart(
                        name = fnCall.name,
                        response = mapOf("tempC" to 4, "wind" to "brisk"),
                        id = fnCall.id
                    )
                )
            }
        )
        assertEquals("Reykjavik is 4C and brisk!", fnSummaryTurn.text)
        assertEquals(4, toolChat.history.size)
    }

    @Test
    fun structuredJsonResponseSchemaAndForcedToolConfigAnySynthesizeLiveBrokerShapes(): Unit = runBlocking {
        val app = initApp("live-ai-schema-tools", "1:424242424242:android:aischemaapp")
        val bridge = newBridge()
        val ai = FirebaseAI.getInstance(app, bridge)

        // Unscripted prompt with ToolConfig(Mode.ANY) exercises AiBroker/ScriptedEngine schema synthesis
        val flightDecl = FunctionDeclaration(
            name = "bookFlight",
            description = "Books a flight itinerary",
            parameters = mapOf(
                "origin" to Schema.enumeration(listOf("SFO", "NRT")),
                "passengers" to Schema.integer()
            )
        )
        val forcedToolModel = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            tools = listOf(Tool.functionDeclarations(listOf(flightDecl))),
            toolConfig = ToolConfig(FunctionCallingConfig.any(listOf("bookFlight")))
        )
        val forcedRes = forcedToolModel.generateContent("UNSCRIPTED_FORCED_TOOL: book trip")
        val forcedCall = forcedRes.functionCalls.single()
        assertEquals("bookFlight", forcedCall.name)
        assertEquals("SFO", forcedCall.args["origin"])
        assertEquals(1, (forcedCall.args["passengers"] as Number).toInt())
        assertNotNull(forcedCall.thoughtSignature)

        // Unscripted prompt with responseMimeType = application/json + responseSchema synthesizes matching JSON
        val reportSchema = Schema.obj(
            properties = mapOf(
                "status" to Schema.enumeration(listOf("READY", "PENDING")),
                "count" to Schema.integer(),
                "ok" to Schema.boolean(),
                "tags" to Schema.array(Schema.string())
            ),
            propertyOrdering = listOf("status", "count", "ok", "tags")
        )
        val jsonModel = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            generationConfig = generationConfig {
                responseMimeType = "application/json"
                responseSchema = reportSchema
            }
        )
        val unaryJson = JsonCodec.decodeMap(jsonModel.generateContent("UNSCRIPTED_SCHEMA_JSON: unary").text!!)
        assertEquals("READY", unaryJson["status"])
        assertEquals(1, (unaryJson["count"] as Number).toInt())
        assertEquals(true, unaryJson["ok"])
        assertEquals(listOf("pyric"), unaryJson["tags"])

        val streamedJsonRaw = jsonModel.generateContentStream("UNSCRIPTED_SCHEMA_JSON_STREAM: stream")
            .toList()
            .joinToString("") { it.text.orEmpty() }
        val streamedJson = JsonCodec.decodeMap(streamedJsonRaw)
        assertEquals("READY", streamedJson["status"])
        assertEquals(true, streamedJson["ok"])
    }
}
