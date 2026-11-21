package dev.pyric.e2e

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.TextPart
import com.google.firebase.appcheck.FirebaseAppCheck
import dev.pyric.bridge.PyricBridgeClient
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
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class AiLiveHostConcurrencyConformanceTest {

    private lateinit var liveBridgeUrl: String
    private val bridges = mutableListOf<PyricBridgeClient>()

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_AI_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "Skipping AiLiveHostConcurrencyConformanceTest: PYRIC_LIVE_AI_BRIDGE_URL is unset"
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
    fun concurrentLiveOkHttpStreamsDeliverWorkerUnsubWithoutDisturbingSiblingStreams(): Unit = runBlocking {
        val app = initApp("live-ai-conc-streams", "1:424242424242:android:aiconcstreams")
        val bridge = newBridge()
        val model = FirebaseAI.getInstance(app, bridge).generativeModel("gemini-2.5-flash")

        withContext(Dispatchers.Default) {
            coroutineScope {
                val fullJobs = (1..3).map { idx ->
                    async {
                        val marker = "SCRIPT_CONC_FULL_$idx"
                        val text = model.generateContentStream("$marker: run full stream")
                            .toList()
                            .joinToString("") { it.text.orEmpty() }
                        assertEquals("full-$idx-a|full-$idx-b|full-$idx-c", text)
                    }
                }

                val takeOneJobs = (1..2).map { idx ->
                    async {
                        val marker = "SCRIPT_CONC_TAKE_$idx"
                        val taken = model.generateContentStream("$marker: cancel after 1")
                            .take(1)
                            .toList()
                        assertEquals("take-$idx-first", taken.single().text)
                    }
                }

                val cancelScopeJob = async {
                    val seenFirst = CompletableDeferred<String>()
                    val collector = launch {
                        model.generateContentStream("SCRIPT_CONC_JOB_CANCEL: cancel mid flight")
                            .collect { chunk ->
                                if (!seenFirst.isCompleted) {
                                    seenFirst.complete(chunk.text.orEmpty())
                                }
                            }
                    }
                    assertEquals("job-cancel-first", seenFirst.await())
                    collector.cancelAndJoin()
                }

                (fullJobs + takeOneJobs + listOf(cancelScopeJob)).awaitAll()
            }
        }
    }

    @Test
    fun chatThoughtPartSeparationAndEmptyCandidateGuardAgainstLiveHost(): Unit = runBlocking {
        val app = initApp("live-ai-conc-chat", "1:424242424242:android:aiconcchat")
        val bridge = newBridge()
        val chat = FirebaseAI.getInstance(app, bridge)
            .generativeModel("gemini-2.5-flash")
            .startChat()

        // Unblocked empty-candidate response throws SerializationException and leaves Chat.history clean
        assertThrows<SerializationException> {
            runBlocking { chat.sendMessage("SCRIPT_CONC_EMPTY_CANDIDATES: unblocked empty") }
        }
        assertTrue(chat.history.isEmpty())

        // Streaming response with internal thought part + signed answer part keeps thought excluded from .text
        val chunks = chat.sendMessageStream("SCRIPT_CONC_CHAT_THOUGHT: reason then answer").toList()
        val combinedPublicText = chunks.joinToString("") { it.text.orEmpty() }
        assertEquals("Verified public answer.", combinedPublicText)

        assertEquals(2, chat.history.size)
        val modelParts = chat.history.last().parts
        assertEquals(2, modelParts.size)
        val thoughtPart = modelParts[0] as TextPart
        assertTrue(thoughtPart.isThought)
        assertEquals("Internal chain of thought.", thoughtPart.text)

        val answerPart = modelParts[1] as TextPart
        assertFalse(answerPart.isThought)
        assertEquals("Verified public answer.", answerPart.text)
        assertNotNull(answerPart.thoughtSignature)
    }
}
