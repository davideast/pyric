package dev.pyric.ai

import com.google.firebase.FirebaseApp
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.FunctionCallPart
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.TextPart
import com.google.firebase.ai.type.asTextOrNull
import com.google.firebase.appcheck.FirebaseAppCheck
import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.BridgeTransportFactory
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

class ConcurrentStreamCancellationTest {

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
    fun twelveConcurrentStreamsMixFullCompletionTakeOneAndMidFlightJobCancelCleanly(): Unit = runBlocking {
        val harness = newHarness()
        val subIdByPrompt = ConcurrentHashMap<String, String>()
        val midFlightFirstChunkSeen = ConcurrentHashMap<String, CompletableDeferred<Unit>>()

        for (idx in 8..11) {
            midFlightFirstChunkSeen["stream-$idx"] = CompletableDeferred()
        }

        val streamServer = MockAiStreamServer { transport, subId, subPayload ->
            @Suppress("UNCHECKED_CAST")
            val req = subPayload["request"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val contents = req["contents"] as List<Map<String, Any?>>
            @Suppress("UNCHECKED_CAST")
            val parts = contents.last()["parts"] as List<Map<String, Any?>>
            val promptText = parts.single()["text"] as String
            subIdByPrompt[promptText] = subId

            when {
                promptText in listOf("stream-0", "stream-1", "stream-2", "stream-3") -> {
                    for (c in 0..3) {
                        val reason = if (c == 3) "STOP" else null
                        MockAiStreamServer.sendTextChunk(transport, subId, "$promptText#$c|", finishReason = reason)
                    }
                    MockAiStreamServer.sendDone(transport, subId)
                }
                promptText in listOf("stream-4", "stream-5", "stream-6", "stream-7") -> {
                    MockAiStreamServer.sendTextChunk(transport, subId, "$promptText#0", finishReason = null)
                    MockAiStreamServer.sendTextChunk(transport, subId, "$promptText#1", finishReason = null)
                }
                else -> {
                    MockAiStreamServer.sendTextChunk(transport, subId, "$promptText#0", finishReason = null)
                }
            }
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = streamServer.factory
        val model = ai.generativeModel("gemini-2.5-flash")

        withContext(Dispatchers.Default) {
            coroutineScope {
                val fullJobs = (0..3).map { idx ->
                    async {
                        val key = "stream-$idx"
                        val text = model.generateContentStream(key)
                            .toList()
                            .joinToString("") { it.text.orEmpty() }
                        assertEquals("$key#0|$key#1|$key#2|$key#3|", text)
                    }
                }
                val takeOneJobs = (4..7).map { idx ->
                    async {
                        val key = "stream-$idx"
                        val first = model.generateContentStream(key).take(1).toList()
                        assertEquals("$key#0", first.single().text)
                    }
                }
                val midCancelJobs = (8..11).map { idx ->
                    async {
                        val key = "stream-$idx"
                        val seen = midFlightFirstChunkSeen.getValue(key)
                        val collector = launch {
                            model.generateContentStream(key).collect { chunk ->
                                if (chunk.text == "$key#0") {
                                    seen.complete(Unit)
                                }
                            }
                        }
                        seen.await()
                        collector.cancelAndJoin()
                    }
                }
                (fullJobs + takeOneJobs + midCancelJobs).awaitAll()
            }
        }

        assertEquals(12, streamServer.recordedSubs.size)
        assertEquals(12, streamServer.transports.size)
        assertTrue(streamServer.transports.all { it.closedCode == 1000 })

        val allSubIds = (0..11).map { subIdByPrompt.getValue("stream-$it") }.toSet()
        val expectedCancelledSubIds = (4..11).map { subIdByPrompt.getValue("stream-$it") }.toSet()

        // Mirrors packages/cli/src/serve/worker/client/ai.ts: awaitClose sends worker-unsub on
        // teardown for every opened subscription (benign idempotent no-op after done, active
        // cancellation on early .take(1) / cancelAndJoin()).
        assertEquals(12, allSubIds.size)
        assertTrue(streamServer.recordedUnsubs.toSet().containsAll(expectedCancelledSubIds))
        assertEquals(allSubIds, streamServer.recordedUnsubs.toSet())
    }

    @Test
    fun cancellingStreamBeforeAttachAckClosesSocketWithoutOrphanedSubOrUnsub(): Unit = runBlocking {
        val harness = newHarness()
        val attachReceived = CompletableDeferred<TrackedStreamTransport>()
        val recordedFrames = CopyOnWriteArrayList<Map<String, Any?>>()

        val holdAttachFactory = BridgeTransportFactory { _, _, _ ->
            val tracked = TrackedStreamTransport()
            tracked.inner.onServerReceive { raw ->
                val frame = JsonCodec.decodeMap(raw)
                recordedFrames.add(frame)
                if (frame["type"] == BridgeProtocol.TYPE_ATTACH) {
                    attachReceived.complete(tracked)
                }
            }
            tracked
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = holdAttachFactory
        val model = ai.generativeModel("gemini-2.5-flash")

        val job = launch(Dispatchers.Default) {
            model.generateContentStream("pre-ack-cancel").collect {}
        }
        val tracked = attachReceived.await()
        job.cancelAndJoin()

        // Late attach-ack arriving after cancellation must NOT trigger worker-sub or worker-unsub.
        tracked.inner.sendToClient(
            JsonCodec.encodeToString(
                mapOf(
                    "type" to BridgeProtocol.TYPE_ATTACH_ACK,
                    "protocol" to 1,
                    "peerConnected" to true
                )
            )
        )

        assertEquals(1000, tracked.closedCode)
        val frameTypes = recordedFrames.map { it["type"] }
        assertEquals(listOf(BridgeProtocol.TYPE_ATTACH), frameTypes)
    }

    @Test
    fun chatSendMessageAndStreamRejectEmptyCandidateEnvelopesWithSerializationException(): Unit = runBlocking {
        val harness = newHarness()
        val unblockedEmptyEnvelope = mapOf(
            "promptFeedback" to mapOf(
                "safetyRatings" to listOf(
                    mapOf("category" to "HARM_CATEGORY_HARASSMENT", "probability" to "NEGLIGIBLE")
                )
            )
        )
        harness.enqueueSuccess(unblockedEmptyEnvelope)
        harness.enqueueSuccess(
            mapOf(
                "candidates" to listOf(
                    mapOf(
                        "index" to 0,
                        "finishReason" to "STOP",
                        "content" to mapOf("role" to "model", "parts" to listOf(mapOf("text" to "recovered")))
                    )
                )
            )
        )

        val streamServer = MockAiStreamServer { transport, subId, _ ->
            MockAiStreamServer.sendChunk(transport, subId, unblockedEmptyEnvelope)
            MockAiStreamServer.sendDone(transport, subId)
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = streamServer.factory
        val chat = ai.generativeModel("gemini-2.5-flash").startChat()

        assertThrows<SerializationException> {
            runBlocking { chat.sendMessage("empty candidates unary") }
        }
        assertTrue(chat.history.isEmpty())

        assertThrows<SerializationException> {
            runBlocking { chat.sendMessageStream("empty candidates stream").toList() }
        }
        assertTrue(chat.history.isEmpty())

        // Semaphore was released cleanly after both failures.
        val ok = chat.sendMessage("normal turn")
        assertEquals("recovered", ok.text)
        assertEquals(2, chat.history.size)
    }

    @Test
    fun chatStreamSkipsTrailingEmptyTextDeltaAfterFunctionCallAndCoalescesThoughtDeltas(): Unit = runBlocking {
        val harness = newHarness()
        var scenario = "FN_THEN_EMPTY_STOP"

        val streamServer = MockAiStreamServer { transport, subId, _ ->
            when (scenario) {
                "FN_THEN_EMPTY_STOP" -> {
                    MockAiStreamServer.sendChunk(
                        transport,
                        subId,
                        mapOf(
                            "candidates" to listOf(
                                mapOf(
                                    "index" to 0,
                                    "content" to mapOf(
                                        "role" to "model",
                                        "parts" to listOf(
                                            mapOf(
                                                "functionCall" to mapOf(
                                                    "name" to "runQuery",
                                                    "args" to mapOf("sql" to "SELECT 1"),
                                                    "id" to "fc-7"
                                                ),
                                                "thoughtSignature" to "sig-fc-7"
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                    MockAiStreamServer.sendTextChunk(transport, subId, "", finishReason = "STOP")
                    MockAiStreamServer.sendDone(transport, subId)
                }
                "THOUGHT_AND_ANSWER_DELTAS" -> {
                    for (t in listOf("Step 1: analyze. ", "Step 2: conclude.")) {
                        MockAiStreamServer.sendChunk(
                            transport,
                            subId,
                            mapOf(
                                "candidates" to listOf(
                                    mapOf(
                                        "index" to 0,
                                        "content" to mapOf(
                                            "role" to "model",
                                            "parts" to listOf(mapOf("text" to t, "thought" to true))
                                        )
                                    )
                                )
                            )
                        )
                    }
                    MockAiStreamServer.sendTextChunk(transport, subId, "Answer is ", finishReason = null)
                    MockAiStreamServer.sendChunk(
                        transport,
                        subId,
                        mapOf(
                            "candidates" to listOf(
                                mapOf(
                                    "index" to 0,
                                    "finishReason" to "STOP",
                                    "content" to mapOf(
                                        "role" to "model",
                                        "parts" to listOf(
                                            mapOf("text" to "42.", "thoughtSignature" to "sig-ans-42")
                                        )
                                    )
                                )
                            )
                        )
                    )
                    MockAiStreamServer.sendDone(transport, subId)
                }
            }
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = streamServer.factory
        val model = ai.generativeModel("gemini-2.5-flash")

        val fnChat = model.startChat()
        fnChat.sendMessageStream("run sql").toList()
        val fnParts = fnChat.history.last().parts
        assertEquals(1, fnParts.size)
        val recordedCall = fnParts.single() as FunctionCallPart
        assertEquals("runQuery", recordedCall.name)
        assertEquals("sig-fc-7", recordedCall.thoughtSignature)

        scenario = "THOUGHT_AND_ANSWER_DELTAS"
        val thoughtChat = model.startChat()
        val chunks = thoughtChat.sendMessageStream("reason then answer").toList()
        // Thought chunks have response.text == null; answer chunks expose only non-thought text.
        assertNull(chunks[0].text)
        assertNull(chunks[1].text)
        assertEquals("Answer is 42.", chunks.drop(2).joinToString("") { it.text.orEmpty() })

        val recordedParts = thoughtChat.history.last().parts
        assertEquals(2, recordedParts.size)
        val thoughtPart = recordedParts[0] as TextPart
        assertTrue(thoughtPart.isThought)
        assertEquals("Step 1: analyze. Step 2: conclude.", thoughtPart.text)
        assertNull(thoughtPart.thoughtSignature)

        val answerPart = recordedParts[1] as TextPart
        assertFalse(answerPart.isThought)
        assertEquals("Answer is 42.", answerPart.text)
        assertEquals("sig-ans-42", answerPart.thoughtSignature)
    }

    @Test
    fun parallelChatInstancesStreamCancelAndRecoverWithoutCrossSessionInterference(): Unit = runBlocking {
        val harness = newHarness()
        harness.onOp { op ->
            @Suppress("UNCHECKED_CAST")
            val req = op.op["request"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val contents = req["contents"] as List<Map<String, Any?>>
            @Suppress("UNCHECKED_CAST")
            val parts = contents.last()["parts"] as List<Map<String, Any?>>
            val prompt = parts.single()["text"] as String
            ScriptedBridgeReply.Success(
                mapOf(
                    "candidates" to listOf(
                        mapOf(
                            "index" to 0,
                            "finishReason" to "STOP",
                            "content" to mapOf(
                                "role" to "model",
                                "parts" to listOf(mapOf("text" to "reply:$prompt"))
                            )
                        )
                    )
                )
            )
        }

        val streamServer = MockAiStreamServer { transport, subId, subPayload ->
            @Suppress("UNCHECKED_CAST")
            val req = subPayload["request"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val contents = req["contents"] as List<Map<String, Any?>>
            @Suppress("UNCHECKED_CAST")
            val parts = contents.last()["parts"] as List<Map<String, Any?>>
            val prompt = parts.single()["text"] as String
            MockAiStreamServer.sendTextChunk(transport, subId, "$prompt-part1", finishReason = null)
            MockAiStreamServer.sendTextChunk(transport, subId, "-part2", finishReason = "STOP")
            MockAiStreamServer.sendDone(transport, subId)
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = streamServer.factory
        val model = ai.generativeModel("gemini-2.5-flash")

        withContext(Dispatchers.Default) {
            coroutineScope {
                (0..5).map { idx ->
                    async {
                        val chat = model.startChat()
                        val partial = chat.sendMessageStream("chat$idx-cancel").take(1).toList()
                        assertEquals("chat$idx-cancel-part1", partial.single().text)
                        assertTrue(chat.history.isEmpty())

                        chat.sendMessageStream("chat$idx-full").toList()
                        assertEquals(2, chat.history.size)
                        assertEquals("chat$idx-full-part1-part2", chat.history[1].parts.single().asTextOrNull())

                        val unary = chat.sendMessage("chat$idx-unary")
                        assertEquals("reply:chat$idx-unary", unary.text)
                        assertEquals(4, chat.history.size)
                    }
                }.awaitAll()
            }
        }
    }
}
