package dev.pyric.e2e

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.ContentModality
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.InlineDataPart
import com.google.firebase.ai.type.ModalityTokenCount
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import com.google.firebase.ai.type.thinkingConfig
import com.google.firebase.appcheck.FirebaseAppCheck
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class AiLiveHostHardeningConformanceTest {

    private lateinit var liveBridgeUrl: String
    private val bridges = mutableListOf<PyricBridgeClient>()

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_AI_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "Skipping AiLiveHostHardeningConformanceTest: PYRIC_LIVE_AI_BRIDGE_URL is unset"
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
    fun multimodalInlineDataRoundTripsFullByteSpectrumAgainstLiveHost(): Unit = runBlocking {
        val app = initApp("live-ai-harden-mm", "1:424242424242:android:aihardenmm")
        val bridge = newBridge()
        val model = FirebaseAI.getInstance(
            app = app,
            bridgeClient = bridge,
            backend = GenerativeBackend.googleAI()
        ).generativeModel("gemini-2.5-flash")

        val outboundSpectrum = ByteArray(256) { it.toByte() }
        val expectedInverted = ByteArray(256) { (255 - it).toByte() }

        val prompt = content("user") {
            text("SCRIPT_HARDEN_MULTIMODAL: invert 256-byte spectrum")
            part(InlineDataPart(outboundSpectrum, "image/png", "spectrum-256.png"))
        }

        val countRes = model.countTokens(prompt)
        assertTrue(countRes.totalTokens > 0)

        val response = model.generateContent(prompt)
        assertEquals("Inverted 256-byte spectrum attached.", response.text)
        assertEquals(1, response.inlineDataParts.size)
        val returnedPart = response.inlineDataParts.single()
        assertEquals("image/png", returnedPart.mimeType)
        assertEquals("inverted-256.png", returnedPart.displayName)
        assertArrayEquals(expectedInverted, returnedPart.inlineData)
    }

    @Test
    fun thoughtPartsAreFilteredFromResponseTextAndInlineDataWhileReplayingCleanlyOverLiveHost(): Unit =
        runBlocking {
            val app = initApp("live-ai-harden-thoughts", "1:424242424242:android:aihardenthoughts")
            val bridge = newBridge()
            val model = FirebaseAI.getInstance(
                app = app,
                bridgeClient = bridge,
                backend = GenerativeBackend.googleAI()
            ).generativeModel(
                modelName = "gemini-2.5-pro",
                generationConfig = generationConfig {
                    thinkingConfig = thinkingConfig {
                        thinkingBudget = 512
                        includeThoughts = true
                    }
                }
            )

            val firstTurn = content("user") { text("SCRIPT_HARDEN_THOUGHTS: derive prime factor") }
            val firstReply = model.generateContent(firstTurn)

            // response.text and response.inlineDataParts omit thought-marked parts
            assertEquals("Prime factor is 97.", firstReply.text)
            assertEquals(
                "Step 1: check divisibility. Step 2: confirm 97 is prime.",
                firstReply.thoughtSummary
            )
            assertTrue(firstReply.inlineDataParts.isEmpty())

            // Underlying candidate content preserves all thought + public parts & signatures
            val rawParts = firstReply.candidates.single().content.parts
            assertEquals(4, rawParts.size)
            assertEquals(3, rawParts.count { it.isThought })

            // Thought-only response returns null for response.text
            val silentReply = model.generateContent("SCRIPT_HARDEN_THOUGHT_ONLY")
            assertNull(silentReply.text)
            assertEquals("Internal deliberation with zero public text.", silentReply.thoughtSummary)

            // Multi-turn replay with preserved thought parts & signatures succeeds through AiBroker
            val secondReply = model.generateContent(
                firstTurn,
                firstReply.candidates.single().content,
                content("user") { text("SCRIPT_HARDEN_THOUGHTS_TURN2: verify 97 * 3") }
            )
            assertEquals("Verified product is 291.", secondReply.text)
        }

    @Test
    fun usageMetadataTokenBreakdownRoundTripsPromptCandidatesTotalAndThoughtsOverLiveHost(): Unit =
        runBlocking {
            val app = initApp("live-ai-harden-usage", "1:424242424242:android:aihardenusage")
            val bridge = newBridge()
            val model = FirebaseAI.getInstance(
                app = app,
                bridgeClient = bridge,
                backend = GenerativeBackend.vertexAI("us-central1")
            ).generativeModel("gemini-2.5-pro")

            val response = model.generateContent("SCRIPT_HARDEN_USAGE: report full token accounting")
            assertEquals("Token breakdown verified.", response.text)
            assertEquals("Deliberated across 27 reasoning tokens.", response.thoughtSummary)

            val usage = response.usageMetadata
            assertNotNull(usage)
            assertEquals(42, usage!!.promptTokenCount)
            assertEquals(19, usage.candidatesTokenCount)
            assertEquals(27, usage.thoughtsTokenCount)
            assertEquals(8, usage.cachedContentTokenCount)
            assertEquals(5, usage.toolUsePromptTokenCount)
            assertEquals(88, usage.totalTokenCount)
            assertEquals(
                listOf(
                    ModalityTokenCount(ContentModality.TEXT, 14),
                    ModalityTokenCount(ContentModality.IMAGE, 28)
                ),
                usage.promptTokensDetails
            )
            assertEquals(
                listOf(ModalityTokenCount(ContentModality.TEXT, 19)),
                usage.candidatesTokensDetails
            )
        }

    @Test
    fun streamedGenerateContentAndChatFilterThoughtEnvelopeAndPreserveUsageMetadataOverLiveHost(): Unit =
        runBlocking {
            val app = initApp("live-ai-harden-stream", "1:424242424242:android:aihardenstream")
            val bridge = newBridge()
            val model = FirebaseAI.getInstance(
                app = app,
                bridgeClient = bridge,
                backend = GenerativeBackend.googleAI()
            ).generativeModel("gemini-2.5-pro")

            val streamChunks = model.generateContentStream("SCRIPT_HARDEN_STREAM_THOUGHT").toList()
            assertEquals("Streamed public answer.", streamChunks.joinToString("") { it.text.orEmpty() })
            assertEquals(
                "Streamed hidden thought.",
                streamChunks.joinToString("") { it.thoughtSummary.orEmpty() }
            )
            assertEquals(21, streamChunks.last().usageMetadata?.thoughtsTokenCount)

            val chat = model.startChat()
            val chatChunks = chat.sendMessageStream("SCRIPT_HARDEN_CHAT_THOUGHT").toList()
            assertEquals("Chat public reply.", chatChunks.joinToString("") { it.text.orEmpty() })
            assertEquals(
                "Chat hidden reasoning.",
                chatChunks.joinToString("") { it.thoughtSummary.orEmpty() }
            )
            assertEquals(2, chat.history.size)
        }
}
