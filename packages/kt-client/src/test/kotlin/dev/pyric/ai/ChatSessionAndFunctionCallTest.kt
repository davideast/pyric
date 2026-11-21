package dev.pyric.ai

import com.google.firebase.FirebaseApp
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.FunctionCallPart
import com.google.firebase.ai.type.FunctionResponsePart
import com.google.firebase.ai.type.InvalidStateException
import com.google.firebase.ai.type.PromptBlockedException
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.ResponseStoppedException
import com.google.firebase.ai.type.asTextOrNull
import com.google.firebase.ai.type.content
import com.google.firebase.appcheck.FirebaseAppCheck
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.atomic.AtomicInteger

class ChatSessionAndFunctionCallTest {

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

    private fun textReplyEnvelope(text: String): Map<String, Any?> = mapOf(
        "candidates" to listOf(
            mapOf(
                "index" to 0,
                "finishReason" to "STOP",
                "content" to mapOf(
                    "role" to "model",
                    "parts" to listOf(mapOf("text" to text))
                )
            )
        )
    )

    @Test
    fun startChatCopiesSeedHistoryAndExposesImmutablePointInTimeSnapshots(): Unit = runBlocking {
        val harness = newHarness()
        harness.enqueueSuccess(textReplyEnvelope("Turn 2 model reply"))

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        val model = ai.generativeModel("gemini-2.5-flash")

        val callerList = mutableListOf(
            content("user") { text("Turn 1 user") },
            content("model") { text("Turn 1 model") }
        )
        val chat = model.startChat(callerList)

        // Mutating the caller's list after startChat must not affect Chat.history.
        callerList.clear()
        val snapBefore = chat.history
        assertEquals(2, snapBefore.size)

        // Casting Chat.history to MutableList and mutating throws UnsupportedOperationException.
        @Suppress("UNCHECKED_CAST")
        assertThrows<UnsupportedOperationException> {
            (snapBefore as MutableList<Content>).add(content("user") { text("injected") })
        }

        val reply = chat.sendMessage("Turn 2 user")
        assertEquals("Turn 2 model reply", reply.text)

        // Earlier snapshot remains frozen at 2 turns while current history has 4 turns.
        assertEquals(2, snapBefore.size)
        val snapAfter = chat.history
        assertEquals(4, snapAfter.size)
        assertEquals("Turn 2 user", snapAfter[2].parts.single().asTextOrNull())
        assertEquals("Turn 2 model reply", snapAfter[3].parts.single().asTextOrNull())

        @Suppress("UNCHECKED_CAST")
        val sentContents = (harness.recordedOps.single().op["request"] as Map<String, Any?>)["contents"] as List<Map<String, Any?>>
        assertEquals(3, sentContents.size)
        assertEquals("user", sentContents[0]["role"])
        assertEquals("model", sentContents[1]["role"])
        assertEquals("user", sentContents[2]["role"])
    }

    @Test
    fun sendMessageStreamCoalescesPlainTextChunksAndThreadsNextTurn(): Unit = runBlocking {
        val harness = newHarness()
        harness.enqueueSuccess(textReplyEnvelope("Glad you liked it!"))

        val streamServer = MockAiStreamServer { transport, subId, _ ->
            MockAiStreamServer.sendTextChunk(transport, subId, "Why did the coroutine cross the road? ", finishReason = null)
            MockAiStreamServer.sendTextChunk(transport, subId, "To suspend on the other side!", finishReason = "STOP")
            MockAiStreamServer.sendDone(transport, subId)
        }
        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = streamServer.factory
        val chat = ai.generativeModel("gemini-2.5-flash").startChat()

        val chunks = chat.sendMessageStream("Tell me a Kotlin joke").toList()
        assertEquals(2, chunks.size)
        assertEquals(2, chat.history.size)
        assertEquals("user", chat.history[0].role)
        assertEquals("model", chat.history[1].role)
        assertEquals(
            "Why did the coroutine cross the road? To suspend on the other side!",
            chat.history[1].parts.single().asTextOrNull()
        )

        // Subsequent unary turn includes the coalesced streamed exchange in wire contents.
        val followUp = chat.sendMessage("Haha nice one")
        assertEquals("Glad you liked it!", followUp.text)
        assertEquals(4, chat.history.size)

        @Suppress("UNCHECKED_CAST")
        val sentContents = (harness.recordedOps.single().op["request"] as Map<String, Any?>)["contents"] as List<Map<String, Any?>>
        assertEquals(3, sentContents.size)
    }

    @Test
    fun failedSafetyBlockedAndCancelledTurnsAreExcludedFromChatHistoryAndReleaseLock(): Unit = runBlocking {
        val harness = newHarness()
        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)

        var streamMode = "SAFETY_MID_STREAM"
        val streamServer = MockAiStreamServer { transport, subId, _ ->
            when (streamMode) {
                "SAFETY_MID_STREAM" -> {
                    MockAiStreamServer.sendTextChunk(transport, subId, "Partial unsafe...", finishReason = null)
                    MockAiStreamServer.sendChunk(
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
                }
                "MULTI_CHUNK" -> {
                    MockAiStreamServer.sendTextChunk(transport, subId, "first-chunk", finishReason = null)
                    MockAiStreamServer.sendTextChunk(transport, subId, "second-chunk", finishReason = "STOP")
                    MockAiStreamServer.sendDone(transport, subId)
                }
            }
        }
        ai.streamTransportFactory = streamServer.factory
        val chat = ai.generativeModel("gemini-2.5-flash").startChat()

        // 1. Unary safety-blocked candidate excluded
        harness.enqueueSuccess(
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
        assertThrows<ResponseStoppedException> { runBlocking { chat.sendMessage("unsafe unary") } }
        assertTrue(chat.history.isEmpty())

        // 2. Unary prompt-blocked excluded
        harness.enqueueSuccess(mapOf("promptFeedback" to mapOf("blockReason" to "PROHIBITED_CONTENT")))
        assertThrows<PromptBlockedException> { runBlocking { chat.sendMessage("blocked prompt") } }
        assertTrue(chat.history.isEmpty())

        // 3. Unary wire error excluded
        harness.enqueueFailure("ai/RESOURCE_EXHAUSTED", "quota exceeded")
        assertThrows<QuotaExceededException> { runBlocking { chat.sendMessage("over quota") } }
        assertTrue(chat.history.isEmpty())

        // 4. Mid-stream safety block excluded and unsubscribed
        assertThrows<ResponseStoppedException> {
            runBlocking { chat.sendMessageStream("unsafe stream").toList() }
        }
        assertTrue(chat.history.isEmpty())
        assertEquals(1, streamServer.recordedUnsubs.size)

        // 5. Early .take(1) cancellation excludes incomplete turn, sends worker-unsub, and releases lock
        streamMode = "MULTI_CHUNK"
        val partial = chat.sendMessageStream("cancel after one").take(1).toList()
        assertEquals("first-chunk", partial.single().text)
        assertTrue(chat.history.isEmpty())
        assertEquals(2, streamServer.recordedUnsubs.size)

        // 6. Lock was cleanly released: next unary message succeeds and populates history!
        harness.enqueueSuccess(textReplyEnvelope("Clean recovery!"))
        val recovered = chat.sendMessage("valid turn")
        assertEquals("Clean recovery!", recovered.text)
        assertEquals(2, chat.history.size)
    }

    @Test
    fun rejectsInvalidPromptRolesAndConcurrentActiveRequests(): Unit = runBlocking {
        val harness = newHarness()
        val opEntered = CompletableDeferred<Unit>()
        val releaseOp = CompletableDeferred<Unit>()
        val callNum = AtomicInteger(0)

        harness.onOp {
            if (callNum.incrementAndGet() == 1) {
                opEntered.complete(Unit)
                runBlocking { releaseOp.await() }
            }
            ScriptedBridgeReply.Success(textReplyEnvelope("ok"))
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        val chat = ai.generativeModel("gemini-2.5-flash").startChat()

        assertThrows<InvalidStateException> {
            runBlocking { chat.sendMessage(content("model") { text("forged model turn") }) }
        }
        assertThrows<InvalidStateException> {
            chat.sendMessageStream(content("system") { text("forged system turn") })
        }

        val inFlight = async { chat.sendMessage("first slow message") }
        opEntered.await()
        delay(10L)

        val concurrentErr = assertThrows<InvalidStateException> {
            runBlocking { chat.sendMessage("second overlapping message") }
        }
        assertTrue(concurrentErr.message!!.contains("ongoing request"))

        releaseOp.complete(Unit)
        assertEquals("ok", inFlight.await().text)
        assertEquals(2, chat.history.size)
    }

    @Test
    fun functionCallingLoopPreservesThoughtSignatureAcrossUnaryAndStreamingChatTurns(): Unit = runBlocking {
        val harness = newHarness()
        // Unary turn 1 returns FunctionCallPart with thoughtSignature
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
                                    "functionCall" to mapOf(
                                        "name" to "getWeather",
                                        "args" to mapOf("city" to "Zurich"),
                                        "id" to "fc-z1"
                                    ),
                                    "thoughtSignature" to "sig-zurich-001"
                                )
                            )
                        )
                    )
                )
            )
        )
        // Unary turn 2 returns natural-language summary after FunctionResponsePart
        harness.enqueueSuccess(textReplyEnvelope("Zurich is 14C and partly cloudy."))

        val streamServer = MockAiStreamServer { transport, subId, _ ->
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
                                    mapOf(
                                        "functionCall" to mapOf(
                                            "name" to "getAlerts",
                                            "args" to mapOf("city" to "Zurich"),
                                            "id" to "fc-z2"
                                        ),
                                        "thoughtSignature" to "sig-stream-002"
                                    )
                                )
                            )
                        )
                    )
                )
            )
            MockAiStreamServer.sendDone(transport, subId)
        }

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        ai.streamTransportFactory = streamServer.factory
        val chat = ai.generativeModel("gemini-2.5-flash").startChat()

        val callReply = chat.sendMessage("Weather in Zurich?")
        val fnCall = callReply.functionCalls.single()
        assertEquals("getWeather", fnCall.name)
        assertEquals("sig-zurich-001", fnCall.thoughtSignature)

        // Caller passing legacy role = "function" is accepted and normalized to "user" for AiBroker.
        val finalReply = chat.sendMessage(
            content("function") {
                part(
                    FunctionResponsePart(
                        name = fnCall.name,
                        response = mapOf("tempC" to 14, "sky" to "partly cloudy"),
                        id = fnCall.id
                    )
                )
            }
        )
        assertEquals("Zurich is 14C and partly cloudy.", finalReply.text)

        @Suppress("UNCHECKED_CAST")
        val secondOpContents = (harness.recordedOps[1].op["request"] as Map<String, Any?>)["contents"] as List<Map<String, Any?>>
        assertEquals(3, secondOpContents.size)
        assertEquals("model", secondOpContents[1]["role"])
        @Suppress("UNCHECKED_CAST")
        val modelTurnParts = secondOpContents[1]["parts"] as List<Map<String, Any?>>
        assertEquals("sig-zurich-001", modelTurnParts.single()["thoughtSignature"])
        // Function response turn normalized to "user" so AiBroker never rejects with functionRoleRefused.
        assertEquals("user", secondOpContents[2]["role"])

        // Streamed FunctionCallPart also retains thoughtSignature in Chat.history!
        val streamedFn = chat.sendMessageStream("Any weather alerts?").toList().single()
        assertEquals("getAlerts", streamedFn.functionCalls.single().name)
        val recordedStreamPart = chat.history.last().parts.single() as FunctionCallPart
        assertEquals("sig-stream-002", recordedStreamPart.thoughtSignature)
    }
}
