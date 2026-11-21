package dev.pyric.ai

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.BlockReason
import com.google.firebase.ai.type.FinishReason
import com.google.firebase.ai.type.FunctionCallingConfig
import com.google.firebase.ai.type.FunctionDeclaration
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.HarmBlockMethod
import com.google.firebase.ai.type.HarmBlockThreshold
import com.google.firebase.ai.type.HarmCategory
import com.google.firebase.ai.type.InvalidAPIKeyException
import com.google.firebase.ai.type.InvalidStateException
import com.google.firebase.ai.type.PromptBlockedException
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.RequestOptions
import com.google.firebase.ai.type.RequestTimeoutException
import com.google.firebase.ai.type.ResponseStoppedException
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.ai.type.Schema
import com.google.firebase.ai.type.Tool
import com.google.firebase.ai.type.ToolConfig
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.BridgeTransportFactory
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

internal class TrackedStreamTransport(
    val inner: InMemoryBridgeTransport = InMemoryBridgeTransport()
) : dev.pyric.bridge.BridgeTransport by inner {
    var closedCode: Int? = null
    override fun close(code: Int, reason: String?): Boolean {
        closedCode = code
        return inner.close(code, reason)
    }
}

internal class MockAiStreamServer(
    private val onSub: (transport: InMemoryBridgeTransport, subId: String, subPayload: Map<String, Any?>) -> Unit
) {
    val recordedSubs = CopyOnWriteArrayList<Pair<String, Map<String, Any?>>>()
    val recordedUnsubs = CopyOnWriteArrayList<String>()
    val transports = CopyOnWriteArrayList<TrackedStreamTransport>()

    val factory = BridgeTransportFactory { _, _, _ ->
        val tracked = TrackedStreamTransport()
        val transport = tracked.inner
        transports.add(tracked)
        transport.onServerReceive { rawJson ->
            val msg = JsonCodec.decodeMap(rawJson)
            when (msg["type"] as? String) {
                BridgeProtocol.TYPE_ATTACH -> {
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to BridgeProtocol.TYPE_ATTACH_ACK,
                                "protocol" to 1,
                                "clientSessionId" to "stream-session",
                                "peerConnected" to true,
                                "hostInstanceId" to "stream-host"
                            )
                        )
                    )
                }
                BridgeProtocol.TYPE_WORKER_SUB -> {
                    val subId = msg["subId"] as? String ?: return@onServerReceive
                    @Suppress("UNCHECKED_CAST")
                    val subPayload = (msg["sub"] as? Map<String, Any?>).orEmpty()
                    recordedSubs.add(subId to subPayload)
                    onSub(transport, subId, subPayload)
                }
                BridgeProtocol.TYPE_WORKER_UNSUB -> {
                    val subId = msg["subId"] as? String ?: return@onServerReceive
                    recordedUnsubs.add(subId)
                }
            }
        }
        tracked
    }

    companion object {
        fun sendChunk(
            transport: InMemoryBridgeTransport,
            subId: String,
            chunk: Map<String, Any?>
        ) {
            transport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf(
                        "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                        "subId" to subId,
                        "value" to mapOf("chunk" to chunk)
                    )
                )
            )
        }

        fun sendTextChunk(
            transport: InMemoryBridgeTransport,
            subId: String,
            text: String,
            finishReason: String? = "STOP"
        ) {
            val candidate = LinkedHashMap<String, Any?>()
            candidate["index"] = 0
            if (finishReason != null) candidate["finishReason"] = finishReason
            candidate["content"] = mapOf(
                "role" to "model",
                "parts" to listOf(mapOf("text" to text))
            )
            sendChunk(transport, subId, mapOf("candidates" to listOf(candidate)))
        }

        fun sendDone(transport: InMemoryBridgeTransport, subId: String) {
            transport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf(
                        "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                        "subId" to subId,
                        "value" to mapOf("done" to true)
                    )
                )
            )
        }

        fun sendError(
            transport: InMemoryBridgeTransport,
            subId: String,
            code: String,
            message: String,
            aiEnvelope: Map<String, Any?>? = null
        ) {
            val errObj = LinkedHashMap<String, Any?>()
            errObj["code"] = code
            errObj["message"] = message
            if (aiEnvelope != null) errObj["aiEnvelope"] = aiEnvelope
            transport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf(
                        "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                        "subId" to subId,
                        "value" to mapOf("__error" to errObj)
                    )
                )
            )
        }
    }
}

class GenerativeModelStreamingAndToolsTest {

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
    fun generateContentStreamIsColdAndEncodesToolsToolConfigAndResponseSchema(): Unit = runBlocking {
        val harness = newHarness()
        val streamServer = MockAiStreamServer { transport, subId, _ ->
            MockAiStreamServer.sendTextChunk(transport, subId, "{\"city\":", finishReason = null)
            MockAiStreamServer.sendTextChunk(transport, subId, "\"Osaka\",", finishReason = null)
            MockAiStreamServer.sendTextChunk(transport, subId, "\"tempC\":22}", finishReason = "STOP")
            MockAiStreamServer.sendDone(transport, subId)
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = streamServer.factory

        val weatherSchema = Schema.obj(
            properties = mapOf(
                "city" to Schema.string(description = "City name"),
                "tempC" to Schema.integer(description = "Temperature in Celsius")
            ),
            optionalProperties = listOf("tempC"),
            propertyOrdering = listOf("city", "tempC")
        )
        val weatherDecl = FunctionDeclaration(
            name = "lookupWeather",
            description = "Fetches current weather for a city",
            parameters = mapOf("city" to Schema.string()),
            optionalParameters = emptyList()
        )
        val model = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            generationConfig = generationConfig {
                responseMimeType = "application/json"
                responseSchema = weatherSchema
            },
            tools = listOf(Tool.functionDeclarations(listOf(weatherDecl))),
            toolConfig = ToolConfig(FunctionCallingConfig.any(listOf("lookupWeather"))),
            systemInstruction = content { text("Return valid JSON.") }
        )

        // Creating the Flow is cold: zero sockets or worker-sub frames until collected.
        val flow = model.generateContentStream("Weather in Osaka?")
        assertTrue(streamServer.recordedSubs.isEmpty())

        val firstRun = flow.toList()
        assertEquals(3, firstRun.size)
        assertEquals("{\"city\":\"Osaka\",\"tempC\":22}", firstRun.joinToString("") { it.text.orEmpty() })

        // Collecting the same cold Flow again opens an independent subscription with a fresh subId.
        val secondRun = flow.toList()
        assertEquals(3, secondRun.size)
        assertEquals(2, streamServer.recordedSubs.size)
        assertNotEquals(streamServer.recordedSubs[0].first, streamServer.recordedSubs[1].first)

        val (_, subPayload) = streamServer.recordedSubs[0]
        assertEquals(mapOf("service" to "ai", "op" to "streamGenerateContent"), subPayload["target"])
        assertEquals("models/gemini-2.5-flash", subPayload["model"])

        @Suppress("UNCHECKED_CAST")
        val req = subPayload["request"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val genCfg = req["generationConfig"] as Map<String, Any?>
        assertEquals("application/json", genCfg["responseMimeType"])
        assertEquals(weatherSchema.toWireMap(), genCfg["responseSchema"])

        @Suppress("UNCHECKED_CAST")
        val toolsWire = req["tools"] as List<Map<String, Any?>>
        assertEquals(1, toolsWire.size)
        assertEquals(
            mapOf(
                "functionCallingConfig" to mapOf(
                    "mode" to "ANY",
                    "allowedFunctionNames" to listOf("lookupWeather")
                )
            ),
            req["toolConfig"]
        )
    }

    @Test
    fun generateContentStreamTakeOneAndScopeCancelSendWorkerUnsubImmediately(): Unit = runBlocking {
        val harness = newHarness()
        val subStarted = CompletableDeferred<String>()
        val streamServer = MockAiStreamServer { transport, subId, _ ->
            if (!subStarted.isCompleted) {
                subStarted.complete(subId)
            }
            MockAiStreamServer.sendTextChunk(transport, subId, "chunk-1", finishReason = null)
            MockAiStreamServer.sendTextChunk(transport, subId, "chunk-2", finishReason = null)
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = streamServer.factory
        val model = ai.generativeModel("gemini-2.5-flash")

        val taken = model.generateContentStream(
            content("user") { text("part 1") },
            content("user") { text("part 2") }
        ).take(1).toList()

        assertEquals(1, taken.size)
        assertEquals("chunk-1", taken[0].text)
        val firstSubId = streamServer.recordedSubs[0].first
        assertEquals(listOf(firstSubId), streamServer.recordedUnsubs)
        assertEquals(1000, streamServer.transports[0].closedCode)

        // Scope cancellation while waiting for additional chunks also sends worker-unsub cleanly.
        val holdSubStarted = CompletableDeferred<String>()
        val holdServer = MockAiStreamServer { _, subId, _ ->
            holdSubStarted.complete(subId)
        }
        ai.streamTransportFactory = holdServer.factory

        val job = async {
            model.generateContentStream("hold forever").toList()
        }
        val activeSubId = holdSubStarted.await()
        job.cancel(CancellationException("user navigated away"))
        assertThrows<CancellationException> { runBlocking { job.await() } }
        assertEquals(listOf(activeSubId), holdServer.recordedUnsubs)
        assertEquals(1000, holdServer.transports[0].closedCode)
    }

    @Test
    fun generateContentStreamMapsErrorsBlocksTimeoutAndAttachesLimitedUseAppCheck(): Unit = runBlocking {
        val harness = newHarness()
        val mintSeq = AtomicInteger(0)
        harness.onOp { op ->
            when (op.method) {
                "appCheck.getLimitedUseToken" -> ScriptedBridgeReply.Success(
                    mapOf(
                        "token" to "stream-lim-jwt-${mintSeq.incrementAndGet()}",
                        "expireTimeMillis" to (System.currentTimeMillis() + 300_000L)
                    )
                )
                else -> ScriptedBridgeReply.Failure("unknown", "Unexpected ${op.method}")
            }
        }

        val app = FirebaseApp.initializeApp(
            "stream-appcheck-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-stream-ai")
                .setApiKey("sandbox-key")
                .setApplicationId("1:111122223333:android:streamai")
                .build()
        )
        FirebaseAppCheck.getInstance(app, harness.client)
            .installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())

        val limitedAi = FirebaseAI.getInstance(
            app = app,
            bridgeClient = harness.client,
            backend = GenerativeBackend.googleAI(),
            useLimitedUseAppCheckTokens = true
        )

        var mode = "OK"
        val streamServer = MockAiStreamServer { transport, subId, _ ->
            when (mode) {
                "OK" -> {
                    MockAiStreamServer.sendTextChunk(transport, subId, "ok")
                    MockAiStreamServer.sendDone(transport, subId)
                }
                "QUOTA" -> MockAiStreamServer.sendError(
                    transport,
                    subId,
                    "ai/RESOURCE_EXHAUSTED",
                    "Quota exceeded",
                    mapOf("error" to mapOf("code" to 429, "status" to "RESOURCE_EXHAUSTED", "message" to "Quota exceeded for model"))
                )
                "API_KEY" -> MockAiStreamServer.sendError(
                    transport,
                    subId,
                    "ai/INVALID_ARGUMENT",
                    "Bad key",
                    mapOf("error" to mapOf("code" to 400, "status" to "INVALID_ARGUMENT", "message" to "API key not valid."))
                )
                "SAFETY" -> MockAiStreamServer.sendChunk(
                    transport,
                    subId,
                    mapOf(
                        "candidates" to listOf(
                            mapOf(
                                "index" to 0,
                                "finishReason" to "SAFETY",
                                "content" to mapOf("role" to "model", "parts" to emptyList<Any>())
                            )
                        )
                    )
                )
                "PROMPT_BLOCK" -> MockAiStreamServer.sendChunk(
                    transport,
                    subId,
                    mapOf("promptFeedback" to mapOf("blockReason" to "SAFETY"))
                )
                "HOLD" -> Unit
            }
        }
        limitedAi.streamTransportFactory = streamServer.factory
        val model = limitedAi.generativeModel(
            modelName = "gemini-2.5-flash",
            requestOptions = RequestOptions(timeoutInMillis = 45L)
        )

        assertEquals("ok", model.generateContentStream("call 1").toList().single().text)
        assertEquals("ok", model.generateContentStream("call 2").toList().single().text)
        assertEquals(mapOf("token" to "stream-lim-jwt-1"), streamServer.recordedSubs[0].second["appCheck"])
        assertEquals(mapOf("token" to "stream-lim-jwt-2"), streamServer.recordedSubs[1].second["appCheck"])

        mode = "QUOTA"
        assertThrows<QuotaExceededException> { runBlocking { model.generateContentStream("q").toList() } }

        mode = "API_KEY"
        assertThrows<InvalidAPIKeyException> { runBlocking { model.generateContentStream("k").toList() } }

        mode = "SAFETY"
        val stopped = assertThrows<ResponseStoppedException> {
            runBlocking { model.generateContentStream("s").toList() }
        }
        assertEquals(FinishReason.SAFETY, stopped.response.candidates.single().finishReason)

        mode = "PROMPT_BLOCK"
        val blocked = assertThrows<PromptBlockedException> {
            runBlocking { model.generateContentStream("p").toList() }
        }
        assertEquals(BlockReason.SAFETY, blocked.response?.promptFeedback?.blockReason)

        mode = "HOLD"
        assertThrows<RequestTimeoutException> {
            runBlocking { model.generateContentStream("slow").toList() }
        }

        // Local HarmBlockMethod validation on GoogleAI fails before opening any stream socket.
        val subsBeforeInvalid = streamServer.recordedSubs.size
        val invalidSafetyModel = limitedAi.generativeModel(
            modelName = "gemini-2.5-flash",
            safetySettings = listOf(
                SafetySetting(
                    HarmCategory.HATE_SPEECH,
                    HarmBlockThreshold.LOW_AND_ABOVE,
                    HarmBlockMethod.SEVERITY
                )
            )
        )
        assertThrows<InvalidStateException> {
            runBlocking { invalidSafetyModel.generateContentStream("bad safety").toList() }
        }
        assertEquals(subsBeforeInvalid, streamServer.recordedSubs.size)
    }

    @Test
    fun unaryGenerateContentAndCountTokensEncodeToolsToolConfigAndAnyOfSchema(): Unit = runBlocking {
        val harness = newHarness()
        harness.enqueueSuccess(
            mapOf(
                "candidates" to listOf(
                    mapOf(
                        "index" to 0,
                        "finishReason" to "STOP",
                        "content" to mapOf(
                            "role" to "model",
                            "parts" to listOf(mapOf("text" to "{\"result\":\"sunny\"}"))
                        )
                    )
                )
            )
        )
        harness.enqueueSuccess(mapOf("totalTokens" to 19))

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        val unionSchema = Schema.obj(
            mapOf(
                "result" to Schema.anyOf(
                    listOf(
                        Schema.enumeration(listOf("sunny", "rainy")),
                        Schema.integer(nullable = true)
                    )
                )
            )
        )
        val tool = Tool.functionDeclarations(
            listOf(
                FunctionDeclaration(
                    name = "pingService",
                    description = "Pings health endpoint",
                    parameters = mapOf("host" to Schema.string())
                )
            )
        )
        val model = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            generationConfig = generationConfig {
                responseMimeType = "application/json"
                responseSchema = unionSchema
            },
            tools = listOf(tool),
            toolConfig = ToolConfig(FunctionCallingConfig.none())
        )

        val gen = model.generateContent("check union")
        assertEquals("{\"result\":\"sunny\"}", gen.text)
        val tok = model.countTokens("check union")
        assertEquals(19, tok.totalTokens)

        assertEquals(2, harness.recordedOps.size)
        @Suppress("UNCHECKED_CAST")
        val genReq = harness.recordedOps[0].op["request"] as Map<String, Any?>
        assertEquals(listOf(tool.toWireMap()), genReq["tools"])
        assertEquals(mapOf("functionCallingConfig" to mapOf("mode" to "NONE")), genReq["toolConfig"])

        @Suppress("UNCHECKED_CAST")
        val countReq = harness.recordedOps[1].op["request"] as Map<String, Any?>
        assertEquals(listOf(tool.toWireMap()), countReq["tools"])
        assertTrue(countReq.containsKey("generationConfig"))
    }
}
