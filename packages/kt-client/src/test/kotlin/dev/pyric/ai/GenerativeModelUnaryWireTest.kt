package dev.pyric.ai

import com.google.firebase.FirebaseApp
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.ContentModality
import com.google.firebase.ai.type.FinishReason
import com.google.firebase.ai.type.FunctionCallPart
import com.google.firebase.ai.type.FunctionResponsePart
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.HarmBlockMethod
import com.google.firebase.ai.type.HarmBlockThreshold
import com.google.firebase.ai.type.HarmCategory
import com.google.firebase.ai.type.HarmProbability
import com.google.firebase.ai.type.HarmSeverity
import com.google.firebase.ai.type.InvalidStateException
import com.google.firebase.ai.type.ModalityTokenCount
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.ai.type.ThinkingLevel
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import com.google.firebase.ai.type.thinkingConfig
import com.google.firebase.appcheck.FirebaseAppCheck
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.Base64

class GenerativeModelUnaryWireTest {

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
    fun generateContentEncodesFullWireRequestAndDecodesRichResponsePartsAndMetadata(): Unit = runBlocking {
        val harness = newHarness()
        val outImageBytes = byteArrayOf(1, 2, 3, 4, 5)
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
                                    "text" to "Let me reason step by step.",
                                    "thought" to true
                                ),
                                mapOf(
                                    "text" to "Tokyo is 21C and sunny.",
                                    "thoughtSignature" to "sig-text-1"
                                ),
                                mapOf(
                                    "inlineData" to mapOf(
                                        "mimeType" to "image/png",
                                        "data" to Base64.getEncoder().encodeToString(outImageBytes),
                                        "displayName" to "chart.png"
                                    )
                                ),
                                mapOf(
                                    "functionCall" to mapOf(
                                        "name" to "renderChart",
                                        "args" to mapOf("city" to "Tokyo", "tempC" to 21),
                                        "id" to "fc-99"
                                    ),
                                    "thoughtSignature" to "sig-fc-99"
                                )
                            )
                        ),
                        "safetyRatings" to listOf(
                            mapOf(
                                "category" to "HARM_CATEGORY_HARASSMENT",
                                "probability" to "NEGLIGIBLE",
                                "probabilityScore" to 0.02,
                                "blocked" to false,
                                "severity" to "HARM_SEVERITY_LOW",
                                "severityScore" to 0.1
                            )
                        ),
                        "citationMetadata" to mapOf(
                            "citations" to listOf(
                                mapOf(
                                    "title" to "JMA Forecast",
                                    "startIndex" to 0,
                                    "endIndex" to 23,
                                    "uri" to "https://example.com/jma",
                                    "license" to "CC-BY-4.0",
                                    "publicationDate" to mapOf("year" to 2026, "month" to 11, "day" to 21)
                                )
                            )
                        )
                    )
                ),
                "usageMetadata" to mapOf(
                    "promptTokenCount" to 18,
                    "candidatesTokenCount" to 12,
                    "totalTokenCount" to 37,
                    "thoughtsTokenCount" to 7,
                    "promptTokensDetails" to listOf(
                        mapOf("modality" to "TEXT", "tokenCount" to 14),
                        mapOf("modality" to "IMAGE", "tokenCount" to 4)
                    )
                ),
                "modelVersion" to "gemini-2.5-flash",
                "responseId" to "sbx-42"
            )
        )

        val ai = FirebaseAI.getInstance(
            app = FirebaseApp.getInstance(),
            bridgeClient = harness.client,
            backend = GenerativeBackend.vertexAI("us-central1")
        )
        val model = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            generationConfig = generationConfig {
                temperature = 0.25f
                maxOutputTokens = 256
                stopSequences = listOf("###")
                responseMimeType = "text/plain"
                thinkingConfig = thinkingConfig {
                    thinkingLevel = ThinkingLevel.MEDIUM
                    includeThoughts = true
                }
            },
            safetySettings = listOf(
                SafetySetting(
                    HarmCategory.HARASSMENT,
                    HarmBlockThreshold.MEDIUM_AND_ABOVE,
                    HarmBlockMethod.PROBABILITY
                )
            ),
            systemInstruction = content { text("Answer concisely with metric units.") }
        )

        val inBytes = byteArrayOf(9, 8, 7)
        val turn1 = content("user") {
            text("Weather for Tokyo?")
            inlineData(inBytes, "image/jpeg")
            fileData("gs://weather-bucket/map.png", "image/png")
        }
        val turn2 = content("model") {
            part(
                FunctionCallPart.createWithThinking(
                    name = "fetchWeather",
                    args = mapOf("city" to "Tokyo"),
                    id = "fc-1",
                    isThought = false,
                    thoughtSignature = "sig-prior"
                )
            )
        }
        val turn3 = content("user") {
            part(FunctionResponsePart("fetchWeather", mapOf("tempC" to 21), id = "fc-1"))
        }

        val response = model.generateContent(turn1, turn2, turn3)

        assertEquals("Tokyo is 21C and sunny.", response.text)
        assertEquals("Let me reason step by step.", response.thoughtSummary)
        assertEquals("gemini-2.5-flash", response.modelVersion)
        assertEquals("sbx-42", response.responseId)

        assertEquals(1, response.inlineDataParts.size)
        assertArrayEquals(outImageBytes, response.inlineDataParts[0].inlineData)
        assertEquals("chart.png", response.inlineDataParts[0].displayName)

        assertEquals(1, response.functionCalls.size)
        val fnCall = response.functionCalls[0]
        assertEquals("renderChart", fnCall.name)
        assertEquals("fc-99", fnCall.id)
        assertEquals("sig-fc-99", fnCall.thoughtSignature)
        assertEquals("Tokyo", fnCall.args["city"])
        assertEquals(21, fnCall.args["tempC"])

        val candidate = response.candidates.single()
        assertEquals(FinishReason.STOP, candidate.finishReason)
        assertEquals(1, candidate.safetyRatings.size)
        assertEquals(HarmCategory.HARASSMENT, candidate.safetyRatings[0].category)
        assertEquals(HarmProbability.NEGLIGIBLE, candidate.safetyRatings[0].probability)
        assertEquals(HarmSeverity.LOW, candidate.safetyRatings[0].severity)
        assertEquals("JMA Forecast", candidate.citationMetadata?.citations?.single()?.title)

        val usage = response.usageMetadata!!
        assertEquals(18, usage.promptTokenCount)
        assertEquals(12, usage.candidatesTokenCount)
        assertEquals(37, usage.totalTokenCount)
        assertEquals(7, usage.thoughtsTokenCount)
        assertEquals(
            listOf(
                ModalityTokenCount(ContentModality.TEXT, 14),
                ModalityTokenCount(ContentModality.IMAGE, 4)
            ),
            usage.promptTokensDetails
        )

        val sent = harness.recordedOps.single()
        assertEquals("ai.generateContent", sent.method)
        assertEquals("publishers/google/models/gemini-2.5-flash", sent.op["model"])
        assertFalse(sent.op.containsKey("appCheck"))

        @Suppress("UNCHECKED_CAST")
        val req = sent.op["request"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val sys = req["systemInstruction"] as Map<String, Any?>
        assertEquals("system", sys["role"])
        @Suppress("UNCHECKED_CAST")
        val contents = req["contents"] as List<Map<String, Any?>>
        assertEquals(3, contents.size)
        @Suppress("UNCHECKED_CAST")
        val modelParts = contents[1]["parts"] as List<Map<String, Any?>>
        assertEquals("sig-prior", modelParts[0]["thoughtSignature"])
    }

    @Test
    fun googleAiBackendRejectsSafetySettingWithHarmBlockMethodLocally(): Unit = runBlocking {
        val harness = newHarness()
        val ai = FirebaseAI.getInstance(
            app = FirebaseApp.getInstance(),
            bridgeClient = harness.client,
            backend = GenerativeBackend.googleAI()
        )
        val model = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            safetySettings = listOf(
                SafetySetting(
                    HarmCategory.HATE_SPEECH,
                    HarmBlockThreshold.LOW_AND_ABOVE,
                    HarmBlockMethod.SEVERITY
                )
            )
        )

        val err = assertThrows<InvalidStateException> {
            runBlocking { model.generateContent("hello") }
        }
        assertTrue(err.message!!.contains("HarmBlockMethod"))
        assertTrue(harness.recordedOps.isEmpty())
    }

    @Test
    fun countTokensEncodesContentsAndSystemInstructionAndSupportsDestructuring(): Unit = runBlocking {
        val harness = newHarness()
        harness.enqueueSuccess(
            mapOf(
                "totalTokens" to 11,
                "promptTokensDetails" to listOf(
                    mapOf("modality" to "TEXT", "tokenCount" to 11)
                )
            )
        )

        val ai = FirebaseAI.getInstance(
            app = FirebaseApp.getInstance(),
            bridgeClient = harness.client,
            backend = GenerativeBackend.googleAI()
        )
        val model = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            systemInstruction = content { text("Count carefully.") }
        )

        val countResponse = model.countTokens("One two three four")
        val (total, details) = countResponse
        assertEquals(11, total)
        assertEquals(1, details.size)
        val (modality, count) = details[0]
        assertEquals(ContentModality.TEXT, modality)
        assertEquals(11, count)

        val sent = harness.recordedOps.single()
        assertEquals("ai.countTokens", sent.method)
        assertEquals("models/gemini-2.5-flash", sent.op["model"])
        @Suppress("UNCHECKED_CAST")
        val req = sent.op["request"] as Map<String, Any?>
        assertTrue(req.containsKey("systemInstruction"))
    }
}
