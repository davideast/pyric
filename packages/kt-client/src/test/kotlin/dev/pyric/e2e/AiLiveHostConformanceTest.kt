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
import com.google.firebase.ai.type.FunctionResponsePart
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.HarmBlockThreshold
import com.google.firebase.ai.type.HarmCategory
import com.google.firebase.ai.type.InvalidAPIKeyException
import com.google.firebase.ai.type.PromptBlockedException
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.ResponseStoppedException
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.ai.type.ServerException
import com.google.firebase.ai.type.ThinkingLevel
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
}
