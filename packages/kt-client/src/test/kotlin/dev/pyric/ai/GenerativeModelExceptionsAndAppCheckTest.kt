package dev.pyric.ai

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.FirebaseOptions
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.APINotConfiguredException
import com.google.firebase.ai.type.BlockReason
import com.google.firebase.ai.type.FinishReason
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.InvalidAPIKeyException
import com.google.firebase.ai.type.PromptBlockedException
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.RequestOptions
import com.google.firebase.ai.type.RequestTimeoutException
import com.google.firebase.ai.type.ResponseStoppedException
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.ServerException
import com.google.firebase.ai.type.ServiceDisabledException
import com.google.firebase.ai.type.UnsupportedUserLocationException
import com.google.firebase.appcheck.AppCheckProvider
import com.google.firebase.appcheck.AppCheckProviderFactory
import com.google.firebase.appcheck.AppCheckToken
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.atomic.AtomicInteger

private class FakeAppCheckToken(
    override val token: String,
    override val expireTimeMillis: Long
) : AppCheckToken()

class GenerativeModelExceptionsAndAppCheckTest {

    private val harnesses = mutableListOf<AiMockBridgeHarness>()

    @AfterEach
    fun tearDown() {
        for (h in harnesses) {
            h.close()
        }
        harnesses.clear()
        FirebaseAI.reset()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun newHarness(): AiMockBridgeHarness =
        AiMockBridgeHarness().also { harnesses.add(it) }

    @Test
    fun blockedPromptStoppedFinishReasonsAndMalformedEnvelopesThrowTypedExceptions(): Unit = runBlocking {
        val harness = newHarness()
        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        val model = ai.generativeModel("gemini-2.5-flash")

        harness.enqueueSuccess(
            mapOf(
                "promptFeedback" to mapOf(
                    "blockReason" to "PROHIBITED_CONTENT",
                    "blockReasonMessage" to "Blocked by policy"
                )
            )
        )
        val promptBlocked = assertThrows<PromptBlockedException> {
            runBlocking { model.generateContent("forbidden prompt") }
        }
        assertEquals(BlockReason.PROHIBITED_CONTENT, promptBlocked.response?.promptFeedback?.blockReason)
        assertEquals("Blocked by policy", promptBlocked.response?.promptFeedback?.blockReasonMessage)

        harness.enqueueSuccess(
            mapOf(
                "promptFeedback" to mapOf(
                    "safetyRatings" to listOf(
                        mapOf("category" to "HARM_CATEGORY_HATE_SPEECH", "probability" to "LOW")
                    )
                )
            )
        )
        val unblockedEmpty = model.generateContent("edge case")
        assertNull(unblockedEmpty.text)
        assertTrue(unblockedEmpty.candidates.isEmpty())

        harness.enqueueSuccess(
            mapOf(
                "candidates" to listOf(
                    mapOf(
                        "index" to 0,
                        "finishReason" to "SAFETY",
                        "finishMessage" to "Candidate withheld by safety filter",
                        "content" to mapOf("role" to "model", "parts" to emptyList<Any>())
                    )
                )
            )
        )
        val stoppedSafety = assertThrows<ResponseStoppedException> {
            runBlocking { model.generateContent("unsafe output") }
        }
        assertEquals(FinishReason.SAFETY, stoppedSafety.response.candidates[0].finishReason)
        assertEquals(
            "Candidate withheld by safety filter",
            stoppedSafety.response.candidates[0].finishMessage
        )

        harness.enqueueSuccess(
            mapOf(
                "candidates" to listOf(
                    mapOf(
                        "index" to 0,
                        "finishReason" to "MAX_TOKENS",
                        "content" to mapOf(
                            "role" to "model",
                            "parts" to listOf(mapOf("text" to "Partial answer cut"))
                        )
                    )
                )
            )
        )
        val stoppedTokens = assertThrows<ResponseStoppedException> {
            runBlocking { model.generateContent("long essay") }
        }
        assertEquals(FinishReason.MAX_TOKENS, stoppedTokens.response.candidates[0].finishReason)
        assertEquals("Partial answer cut", stoppedTokens.response.text)

        harness.enqueueSuccess(emptyMap<String, Any?>())
        assertThrows<SerializationException> {
            runBlocking { model.generateContent("empty envelope") }
        }

        harness.enqueueSuccess(
            mapOf(
                "candidates" to listOf(
                    mapOf(
                        "index" to 0,
                        "finishReason" to "STOP",
                        "content" to mapOf(
                            "role" to "model",
                            "parts" to listOf(
                                mapOf(
                                    "inlineData" to mapOf(
                                        "mimeType" to "image/png",
                                        "data" to "%%%not-valid-base64%%%"
                                    )
                                )
                            )
                        )
                    )
                )
            )
        )
        assertThrows<SerializationException> {
            runBlocking { model.generateContent("corrupt image") }
        }
    }

    @Test
    fun wireErrorsTimeoutAndCancellationMapToExactFirebaseAiExceptionHierarchy(): Unit = runBlocking {
        val harness = newHarness()
        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        val model = ai.generativeModel("gemini-2.5-flash")

        harness.enqueueFailure("ai/INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.")
        assertThrows<InvalidAPIKeyException> { runBlocking { model.generateContent("ping") } }

        harness.enqueueFailure("ai/RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota).")
        assertThrows<QuotaExceededException> { runBlocking { model.generateContent("ping") } }

        harness.enqueueFailure("ai/FAILED_PRECONDITION", "User location is not supported for the API use.")
        assertThrows<UnsupportedUserLocationException> { runBlocking { model.generateContent("ping") } }

        harness.enqueueFailure("ai/NOT_FOUND", "genai config not found for project")
        assertThrows<APINotConfiguredException> { runBlocking { model.generateContent("ping") } }

        harness.enqueueFailure("ai/PERMISSION_DENIED", "SERVICE_DISABLED: firebasevertexai.googleapis.com")
        assertThrows<ServiceDisabledException> { runBlocking { model.generateContent("ping") } }

        harness.enqueueFailure("ai/NOT_FOUND", "models/gemini-1.0-pro is not found")
        assertThrows<ServerException> { runBlocking { model.generateContent("ping") } }

        val shortTimeoutModel = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            requestOptions = RequestOptions(timeoutInMillis = 45L)
        )
        harness.enqueueHold()
        assertThrows<RequestTimeoutException> {
            runBlocking { shortTimeoutModel.generateContent("slow prompt") }
        }

        harness.enqueueHold()
        val deferred = async { model.generateContent("cancelled prompt") }
        delay(20L)
        deferred.cancel(CancellationException("caller cancelled"))
        assertThrows<CancellationException> { runBlocking { deferred.await() } }
    }

    @Test
    fun attachesStandardLimitedUseAndPlaceholderAppCheckClaimsAutomatically(): Unit = runBlocking {
        val harness = newHarness()
        val mintedSeq = AtomicInteger(0)

        harness.onOp { op ->
            when (op.method) {
                "appCheck.getToken" -> {
                    val n = mintedSeq.incrementAndGet()
                    ScriptedBridgeReply.Success(
                        mapOf(
                            "token" to "std-jwt-$n",
                            "expireTimeMillis" to (System.currentTimeMillis() + 3_600_000L)
                        )
                    )
                }
                "appCheck.getLimitedUseToken" -> {
                    val n = mintedSeq.incrementAndGet()
                    ScriptedBridgeReply.Success(
                        mapOf(
                            "token" to "lim-jwt-$n",
                            "expireTimeMillis" to (System.currentTimeMillis() + 300_000L)
                        )
                    )
                }
                "ai.generateContent" -> ScriptedBridgeReply.Success(
                    mapOf(
                        "candidates" to listOf(
                            mapOf(
                                "index" to 0,
                                "finishReason" to "STOP",
                                "content" to mapOf(
                                    "role" to "model",
                                    "parts" to listOf(mapOf("text" to "ok"))
                                )
                            )
                        )
                    )
                )
                "ai.countTokens" -> ScriptedBridgeReply.Success(mapOf("totalTokens" to 3))
                else -> ScriptedBridgeReply.Failure("unknown", "Unexpected ${op.method}")
            }
        }

        val app = FirebaseApp.initializeApp(
            "ai-appcheck-unit",
            FirebaseOptions.Builder()
                .setProjectId("demo-ai-unit")
                .setApiKey("sandbox-key")
                .setApplicationId("1:123456789000:android:aiunit")
                .build()
        )
        val appCheck = FirebaseAppCheck.getInstance(app, harness.client)
        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())

        val standardAi = FirebaseAI.getInstance(
            app = app,
            bridgeClient = harness.client,
            backend = GenerativeBackend.googleAI(),
            useLimitedUseAppCheckTokens = false
        )
        val standardModel = standardAi.generativeModel("gemini-2.5-flash")
        assertEquals("ok", standardModel.generateContent("hi").text)
        assertEquals(3, standardModel.countTokens("hi").totalTokens)

        val aiOpsStandard = harness.recordedOps.filter { it.method.startsWith("ai.") }
        assertEquals(2, aiOpsStandard.size)
        assertEquals(mapOf("token" to "std-jwt-1"), aiOpsStandard[0].op["appCheck"])
        assertEquals(mapOf("token" to "std-jwt-1"), aiOpsStandard[1].op["appCheck"])

        harness.recordedOps.clear()
        val limitedAi = FirebaseAI.getInstance(
            app = app,
            bridgeClient = harness.client,
            backend = GenerativeBackend.googleAI(),
            useLimitedUseAppCheckTokens = true
        )
        val limitedModel = limitedAi.generativeModel("gemini-2.5-flash")
        assertEquals("ok", limitedModel.generateContent("one").text)
        assertEquals("ok", limitedModel.generateContent("two").text)

        val limitedMintOps = harness.recordedOps.filter { it.method == "appCheck.getLimitedUseToken" }
        assertEquals(2, limitedMintOps.size)
        val aiOpsLimited = harness.recordedOps.filter { it.method == "ai.generateContent" }
        assertEquals(mapOf("token" to "lim-jwt-2"), aiOpsLimited[0].op["appCheck"])
        assertEquals(mapOf("token" to "lim-jwt-3"), aiOpsLimited[1].op["appCheck"])

        harness.recordedOps.clear()
        appCheck.installAppCheckProviderFactory(
            AppCheckProviderFactory {
                AppCheckProvider { Tasks.forException(FirebaseException("attestation offline")) }
            }
        )
        assertEquals("ok", standardModel.generateContent("with-broken-provider").text)
        val placeholderOp = harness.recordedOps.single { it.method == "ai.generateContent" }
        assertEquals(
            mapOf("token" to FirebaseAppCheck.APP_CHECK_PLACEHOLDER_TOKEN),
            placeholderOp.op["appCheck"]
        )

        harness.recordedOps.clear()
        appCheck.installAppCheckProviderFactory(
            AppCheckProviderFactory {
                AppCheckProvider {
                    Tasks.forResult(
                        FakeAppCheckToken("custom-signed-jwt", System.currentTimeMillis() + 60_000L)
                    )
                }
            }
        )
        assertEquals("ok", standardModel.generateContent("custom-token").text)
        val customOp = harness.recordedOps.single { it.method == "ai.generateContent" }
        assertEquals(mapOf("token" to "custom-signed-jwt"), customOp.op["appCheck"])
    }
}
