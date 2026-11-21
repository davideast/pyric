package dev.pyric.ai

import com.google.firebase.FirebaseApp
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.BlockReason
import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.ContentModality
import com.google.firebase.ai.type.FinishReason
import com.google.firebase.ai.type.GenerationConfig
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.HarmBlockMethod
import com.google.firebase.ai.type.HarmBlockThreshold
import com.google.firebase.ai.type.HarmCategory
import com.google.firebase.ai.type.HarmProbability
import com.google.firebase.ai.type.HarmSeverity
import com.google.firebase.ai.type.Part
import com.google.firebase.ai.type.RequestOptions
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.TextPart
import com.google.firebase.ai.type.ThinkingConfig
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.lang.reflect.Modifier
import java.util.Calendar

class FirebaseAiJavaAbiAndCodecEdgeTest {

    private val harnesses = mutableListOf<AiMockBridgeHarness>()

    @AfterEach
    fun tearDown() {
        for (h in harnesses) {
            h.close()
        }
        harnesses.clear()
        FirebaseAI.reset()
        FirebaseApp.clearInstancesForTest()
    }

    private fun newHarness(): AiMockBridgeHarness =
        AiMockBridgeHarness().also { harnesses.add(it) }

    @Test
    fun exposesExpectedJvmStaticFactoriesJvmOverloadsAndBuilderMethodsForJavaCallers() {
        val aiClass = FirebaseAI::class.java
        val staticAiMethods = listOf(
            "getInstance" to emptyArray<Class<*>>(),
            "getInstance" to arrayOf<Class<*>>(FirebaseApp::class.java),
            "getInstance" to arrayOf<Class<*>>(GenerativeBackend::class.java),
            "getInstance" to arrayOf<Class<*>>(FirebaseApp::class.java, GenerativeBackend::class.java),
            "getInstance" to arrayOf<Class<*>>(
                FirebaseApp::class.java,
                GenerativeBackend::class.java,
                Boolean::class.javaPrimitiveType!!
            ),
            "reset" to emptyArray<Class<*>>()
        )
        for ((name, params) in staticAiMethods) {
            val m = aiClass.getMethod(name, *params)
            assertTrue(Modifier.isStatic(m.modifiers), "Expected FirebaseAI.$name to be static")
        }

        // @JvmOverloads on generativeModel exposes 1-arg through 5-arg overloads
        assertNotNullMethod(aiClass, "generativeModel", String::class.java)
        assertNotNullMethod(
            aiClass,
            "generativeModel",
            String::class.java,
            GenerationConfig::class.java,
            List::class.java,
            Content::class.java,
            RequestOptions::class.java
        )

        val backendClass = GenerativeBackend::class.java
        assertTrue(Modifier.isStatic(backendClass.getMethod("googleAI").modifiers))
        assertTrue(Modifier.isStatic(backendClass.getMethod("vertexAI").modifiers))
        assertTrue(Modifier.isStatic(backendClass.getMethod("vertexAI", String::class.java).modifiers))
        assertTrue(Modifier.isStatic(backendClass.getMethod("agentPlatform").modifiers))
        assertTrue(Modifier.isStatic(backendClass.getMethod("agentPlatform", String::class.java).modifiers))

        // Content.Builder @JvmName("addText" / "addInlineData" / "addFileData" / "addPart")
        val contentBuilderClass = Content.Builder::class.java
        assertNotNullMethod(contentBuilderClass, "addText", String::class.java)
        assertNotNullMethod(
            contentBuilderClass,
            "addInlineData",
            ByteArray::class.java,
            String::class.java
        )
        assertNotNullMethod(contentBuilderClass, "addFileData", String::class.java, String::class.java)
        assertNotNullMethod(contentBuilderClass, "addPart", Part::class.java)

        assertTrue(Modifier.isStatic(GenerationConfig::class.java.getMethod("builder").modifiers))
        assertTrue(Modifier.isStatic(ThinkingConfig::class.java.getMethod("builder").modifiers))
        assertTrue(
            Modifier.isStatic(
                TextPart::class.java.getMethod(
                    "createWithThinking",
                    String::class.java,
                    Boolean::class.javaPrimitiveType!!,
                    String::class.java
                ).modifiers
            )
        )

        // @JvmField enum-like constants on companion classes
        assertTrue(Modifier.isStatic(HarmCategory::class.java.getField("HARASSMENT").modifiers))
        assertTrue(Modifier.isStatic(HarmBlockThreshold::class.java.getField("LOW_AND_ABOVE").modifiers))
        assertTrue(Modifier.isStatic(HarmBlockMethod::class.java.getField("PROBABILITY").modifiers))
        assertTrue(Modifier.isStatic(FinishReason::class.java.getField("STOP").modifiers))
        assertTrue(Modifier.isStatic(BlockReason::class.java.getField("SAFETY").modifiers))
        SafetySetting::class.java.getConstructor(
            HarmCategory::class.java,
            HarmBlockThreshold::class.java
        )
        SafetySetting::class.java.getConstructor(
            HarmCategory::class.java,
            HarmBlockThreshold::class.java,
            HarmBlockMethod::class.java
        )
    }

    private fun assertNotNullMethod(cls: Class<*>, name: String, vararg params: Class<*>) {
        val m = cls.getMethod(name, *params)
        assertEquals(name, m.name)
    }

    @Test
    fun forwardCompatibleWireDecodingHandlesUnknownEnumsUnknownPartsCitationSourcesAndFullUsage(): Unit =
        runBlocking {
            val harness = newHarness()
            harness.enqueueSuccess(
                mapOf(
                    "candidates" to listOf(
                        mapOf(
                            "index" to 0,
                            "finishReason" to "STOP",
                            "content" to mapOf(
                                "role" to "model",
                                "parts" to listOf(
                                    mapOf("futureExperimentalPart" to mapOf("foo" to "bar")),
                                    mapOf("text" to "Hello "),
                                    mapOf("text" to "world!")
                                )
                            ),
                            "safetyRatings" to listOf(
                                mapOf(
                                    "category" to "HARM_CATEGORY_FUTURE_NEW",
                                    "probability" to "FUTURE_PROBABILITY",
                                    "severity" to "HARM_SEVERITY_FUTURE"
                                ),
                                mapOf("incompleteWithoutProbability" to "HARM_CATEGORY_HATE_SPEECH")
                            ),
                            "citationMetadata" to mapOf(
                                "citationSources" to listOf(
                                    mapOf(
                                        "startIndex" to 0,
                                        "endIndex" to 12,
                                        "uri" to "https://example.org/doc",
                                        "publicationDate" to mapOf("year" to 2025, "month" to 0, "day" to 0)
                                    )
                                )
                            )
                        ),
                        mapOf(
                            "index" to 1,
                            "finishReason" to "STOP",
                            "content" to mapOf(
                                "role" to "model",
                                "parts" to listOf(mapOf("text" to "Second candidate"))
                            )
                        )
                    ),
                    "usageMetadata" to mapOf(
                        "promptTokenCount" to 20,
                        "candidatesTokenCount" to 10,
                        "totalTokenCount" to 45,
                        "cachedContentTokenCount" to 5,
                        "thoughtsTokenCount" to 6,
                        "toolUsePromptTokenCount" to 4,
                        "promptTokensDetails" to listOf(
                            mapOf("modality" to "FUTURE_MODALITY", "tokenCount" to 20)
                        ),
                        "candidatesTokensDetails" to listOf(
                            mapOf("modality" to "AUDIO", "tokenCount" to 10)
                        ),
                        "cacheTokensDetails" to listOf(
                            mapOf("modality" to "DOCUMENT", "tokenCount" to 5)
                        ),
                        "toolUsePromptTokensDetails" to listOf(
                            mapOf("modality" to "VIDEO", "tokenCount" to 4)
                        )
                    )
                )
            )

            val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
            val model = ai.generativeModel("gemini-2.5-flash")
            val response = model.generateContent("test forward compatibility")

            // Unknown part skipped cleanly; adjacent text parts concatenated in order
            assertEquals("Hello world!", response.text)
            assertNull(response.thoughtSummary)
            assertEquals(2, response.candidates.size)
            assertEquals(1, response.candidates[1].index)

            val rating = response.candidates[0].safetyRatings.single()
            assertEquals(HarmCategory.UNKNOWN, rating.category)
            assertEquals(HarmProbability.UNKNOWN, rating.probability)
            assertEquals(HarmSeverity.UNKNOWN, rating.severity)

            val citation = response.candidates[0].citationMetadata!!.citations.single()
            assertEquals("https://example.org/doc", citation.uri)
            assertEquals(2025, citation.publicationDate!!.get(Calendar.YEAR))
            assertEquals(Calendar.JANUARY, citation.publicationDate!!.get(Calendar.MONTH))
            assertEquals(1, citation.publicationDate!!.get(Calendar.DAY_OF_MONTH))

            val usage = response.usageMetadata!!
            assertEquals(5, usage.cachedContentTokenCount)
            assertEquals(6, usage.thoughtsTokenCount)
            assertEquals(4, usage.toolUsePromptTokenCount)
            assertEquals(ContentModality.UNSPECIFIED, usage.promptTokensDetails.single().modality)
            assertEquals(ContentModality.AUDIO, usage.candidatesTokensDetails.single().modality)
            assertEquals(ContentModality.DOCUMENT, usage.cacheTokensDetails.single().modality)
            assertEquals(ContentModality.VIDEO, usage.toolUsePromptTokensDetails.single().modality)
        }

    @Test
    fun customUnsupportedPartImplementationThrowsSerializationException(): Unit = runBlocking {
        val harness = newHarness()
        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        val model = ai.generativeModel("gemini-2.5-flash")

        val foreignPart = object : Part {
            override val isThought: Boolean = false
        }

        assertThrows<SerializationException> {
            runBlocking {
                model.generateContent(Content(role = "user", parts = listOf(foreignPart)))
            }
        }
    }
}
