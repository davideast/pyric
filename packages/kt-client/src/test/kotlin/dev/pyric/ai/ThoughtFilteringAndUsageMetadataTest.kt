package dev.pyric.ai

import com.google.firebase.FirebaseApp
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.InferenceSource
import com.google.firebase.ai.type.ContentModality
import com.google.firebase.ai.type.CountTokensResponse
import com.google.firebase.ai.type.FunctionCallPart
import com.google.firebase.ai.type.InlineDataPart
import com.google.firebase.ai.type.ModalityTokenCount
import com.google.firebase.ai.type.TextPart
import com.google.firebase.ai.type.ThinkingLevel
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import com.google.firebase.ai.type.thinkingConfig
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.Base64

class ThoughtFilteringAndUsageMetadataTest {

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
    fun responseTextFunctionCallsAndInlineDataPartsExcludeThoughtMarkedPartsWhilePreservingRawCandidateParts(): Unit =
        runBlocking {
            val harness = newHarness()
            val scratchDiagram = byteArrayOf(0x01, 0x02, 0x03, 0x04)
            val finalBadge = byteArrayOf(0xAA.toByte(), 0xBB.toByte(), 0xCC.toByte())

            harness.enqueueSuccess(
                mapOf(
                    "modelVersion" to "gemini-2.5-pro",
                    "responseId" to "resp-thought-filter-1",
                    "candidates" to listOf(
                        mapOf(
                            "index" to 0,
                            "finishReason" to "STOP",
                            "content" to mapOf(
                                "role" to "model",
                                "parts" to listOf(
                                    mapOf(
                                        "text" to "Internal step 1. ",
                                        "thought" to true,
                                        "thoughtSignature" to "sig-thought-1"
                                    ),
                                    mapOf(
                                        "inlineData" to mapOf(
                                            "mimeType" to "image/png",
                                            "data" to Base64.getEncoder().encodeToString(scratchDiagram)
                                        ),
                                        "thought" to true,
                                        "thoughtSignature" to "sig-thought-img"
                                    ),
                                    mapOf(
                                        "functionCall" to mapOf(
                                            "name" to "hypotheticalProbe",
                                            "args" to mapOf("draft" to true),
                                            "id" to "fc-draft"
                                        ),
                                        "thought" to true,
                                        "thoughtSignature" to "sig-thought-fc"
                                    ),
                                    mapOf(
                                        "text" to "Internal step 2.",
                                        "thought" to true,
                                        "thoughtSignature" to "sig-thought-2"
                                    ),
                                    mapOf(
                                        "text" to "Verified answer: ",
                                        "thoughtSignature" to "sig-public-1"
                                    ),
                                    mapOf(
                                        "text" to "42.",
                                        "thought" to false,
                                        "thoughtSignature" to "sig-public-2"
                                    ),
                                    mapOf(
                                        "inlineData" to mapOf(
                                            "mimeType" to "image/png",
                                            "data" to Base64.getEncoder().encodeToString(finalBadge),
                                            "displayName" to "badge.png"
                                        ),
                                        "thought" to false,
                                        "thoughtSignature" to "sig-public-img"
                                    ),
                                    mapOf(
                                        "functionCall" to mapOf(
                                            "name" to "commitAnswer",
                                            "args" to mapOf("value" to 42),
                                            "id" to "fc-real"
                                        ),
                                        "thoughtSignature" to "sig-public-fc"
                                    )
                                )
                            )
                        )
                    )
                )
            )

            val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
            val model = ai.generativeModel(
                modelName = "gemini-2.5-pro",
                generationConfig = generationConfig {
                    thinkingConfig = thinkingConfig {
                        thinkingBudget = 1024
                        includeThoughts = true
                    }
                }
            )

            val response = model.generateContent("Compute 6 * 7 carefully.")

            assertEquals(InferenceSource.IN_CLOUD, response.inferenceSource)
            assertEquals("Verified answer: 42.", response.text)
            assertEquals("Internal step 1. Internal step 2.", response.thoughtSummary)

            // Convenience accessors must exclude thought-marked inlineData and functionCall parts
            assertEquals(1, response.inlineDataParts.size)
            assertEquals("badge.png", response.inlineDataParts.single().displayName)
            assertArrayEquals(finalBadge, response.inlineDataParts.single().inlineData)

            assertEquals(1, response.functionCalls.size)
            assertEquals("commitAnswer", response.functionCalls.single().name)
            assertEquals("fc-real", response.functionCalls.single().id)
            assertEquals("sig-public-fc", response.functionCalls.single().thoughtSignature)

            // Raw candidate.content.parts preserves all 8 parts + signatures for multi-turn replay
            val rawParts = response.candidates.single().content.parts
            assertEquals(8, rawParts.size)
            assertEquals(4, rawParts.count { it.isThought })
            assertEquals(4, rawParts.count { !it.isThought })
            assertTrue((rawParts[1] as InlineDataPart).isThought)
            assertTrue((rawParts[2] as FunctionCallPart).isThought)

            // Replaying candidate.content in a follow-up turn preserves thought flags and thoughtSignatures on wire
            harness.enqueueSuccess(
                mapOf(
                    "candidates" to listOf(
                        mapOf(
                            "index" to 0,
                            "finishReason" to "STOP",
                            "content" to mapOf(
                                "role" to "model",
                                "parts" to listOf(mapOf("text" to "Done."))
                            )
                        )
                    )
                )
            )
            val followUp = model.generateContent(
                content("user") { text("Compute 6 * 7 carefully.") },
                response.candidates.single().content,
                content("user") { text("Confirm.") }
            )
            assertEquals("Done.", followUp.text)

            @Suppress("UNCHECKED_CAST")
            val secondReq = harness.recordedOps[1].op["request"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val replayedModelParts = ((secondReq["contents"] as List<Map<String, Any?>>)[1]["parts"]) as List<Map<String, Any?>>
            assertEquals(true, replayedModelParts[0]["thought"])
            assertEquals("sig-thought-1", replayedModelParts[0]["thoughtSignature"])
            assertEquals("sig-public-fc", replayedModelParts[7]["thoughtSignature"])
        }

    @Test
    fun thoughtOnlyResponseReturnsNullTextAndPopulatesThoughtSummary(): Unit = runBlocking {
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
                                mapOf(
                                    "text" to "Silent chain-of-thought reasoning only.",
                                    "thought" to true,
                                    "thoughtSignature" to "sig-only-thought"
                                )
                            )
                        )
                    )
                )
            )
        )

        val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
        val model = ai.generativeModel(
            modelName = "gemini-2.5-flash",
            generationConfig = generationConfig {
                thinkingConfig = thinkingConfig {
                    thinkingLevel = ThinkingLevel.HIGH
                    includeThoughts = true
                }
            }
        )

        val response = model.generateContent("Think silently.")
        assertNull(response.text)
        assertEquals("Silent chain-of-thought reasoning only.", response.thoughtSummary)
        assertTrue(response.functionCalls.isEmpty())
        assertTrue(response.inlineDataParts.isEmpty())

        @Suppress("UNCHECKED_CAST")
        val genCfg = (harness.recordedOps.single().op["request"] as Map<String, Any?>)["generationConfig"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val sentThinking = genCfg["thinkingConfig"] as Map<String, Any?>
        assertEquals("HIGH", sentThinking["thinkingLevel"])
        assertEquals(true, sentThinking["includeThoughts"])

        // Mutual exclusion between thinkingBudget and thinkingLevel
        assertThrows<IllegalArgumentException> {
            thinkingConfig {
                thinkingBudget = 512
                thinkingLevel = ThinkingLevel.LOW
            }
        }
    }

    @Test
    fun usageMetadataAndCountTokensDecodeFullTokenBreakdownsAndDefaultMissingFieldsCleanly(): Unit =
        runBlocking {
            val harness = newHarness()
            harness.enqueueSuccess(
                mapOf(
                    "totalTokens" to 148,
                    "promptTokensDetails" to listOf(
                        mapOf("modality" to "TEXT", "tokenCount" to 20),
                        mapOf("modality" to "IMAGE", "tokenCount" to 128)
                    )
                )
            )
            harness.enqueueSuccess(
                mapOf(
                    "candidates" to listOf(
                        mapOf(
                            "index" to 0,
                            "finishReason" to "STOP",
                            "content" to mapOf(
                                "role" to "model",
                                "parts" to listOf(
                                    mapOf("text" to "Reasoning...", "thought" to true),
                                    mapOf("text" to "Summary ready.")
                                )
                            )
                        )
                    ),
                    "usageMetadata" to mapOf(
                        "promptTokenCount" to 148,
                        "candidatesTokenCount" to 32,
                        "thoughtsTokenCount" to 64,
                        "cachedContentTokenCount" to 12,
                        "toolUsePromptTokenCount" to 10,
                        "totalTokenCount" to 254,
                        "promptTokensDetails" to listOf(
                            mapOf("modality" to "TEXT", "tokenCount" to 20),
                            mapOf("modality" to "IMAGE", "tokenCount" to 128)
                        ),
                        "candidatesTokensDetails" to listOf(
                            mapOf("modality" to "TEXT", "tokenCount" to 32)
                        ),
                        "cacheTokensDetails" to listOf(
                            mapOf("modality" to "DOCUMENT", "tokenCount" to 12)
                        ),
                        "toolUsePromptTokensDetails" to listOf(
                            mapOf("modality" to "TEXT", "tokenCount" to 10)
                        )
                    )
                )
            )
            // Minimal partial usageMetadata envelope (omitted optional counters default to 0 / emptyList)
            harness.enqueueSuccess(
                mapOf(
                    "candidates" to listOf(
                        mapOf(
                            "index" to 0,
                            "finishReason" to "STOP",
                            "content" to mapOf(
                                "role" to "model",
                                "parts" to listOf(mapOf("text" to "Minimal."))
                            )
                        )
                    ),
                    "usageMetadata" to mapOf(
                        "promptTokenCount" to 5,
                        "totalTokenCount" to 7
                    )
                )
            )

            val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
            val model = ai.generativeModel("gemini-2.5-flash")

            val countRes: CountTokensResponse = model.countTokens("Describe image")
            val (total, details) = countRes
            assertEquals(148, total)
            assertEquals(
                listOf(
                    ModalityTokenCount(ContentModality.TEXT, 20),
                    ModalityTokenCount(ContentModality.IMAGE, 128)
                ),
                details
            )

            val rich = model.generateContent("Describe image")
            assertEquals("Summary ready.", rich.text)
            assertEquals("Reasoning...", rich.thoughtSummary)
            val usage = rich.usageMetadata!!
            assertEquals(148, usage.promptTokenCount)
            assertEquals(32, usage.candidatesTokenCount)
            assertEquals(64, usage.thoughtsTokenCount)
            assertEquals(12, usage.cachedContentTokenCount)
            assertEquals(10, usage.toolUsePromptTokenCount)
            assertEquals(254, usage.totalTokenCount)
            assertEquals(2, usage.promptTokensDetails.size)
            assertEquals(ContentModality.IMAGE, usage.promptTokensDetails[1].modality)
            assertEquals(128, usage.promptTokensDetails[1].tokenCount)
            assertEquals(ContentModality.TEXT, usage.candidatesTokensDetails.single().modality)
            assertEquals(ContentModality.DOCUMENT, usage.cacheTokensDetails.single().modality)
            assertEquals(ContentModality.TEXT, usage.toolUsePromptTokensDetails.single().modality)

            val minimal = model.generateContent("Minimal")
            val minUsage = minimal.usageMetadata!!
            assertEquals(5, minUsage.promptTokenCount)
            assertEquals(0, minUsage.candidatesTokenCount)
            assertEquals(0, minUsage.thoughtsTokenCount)
            assertEquals(0, minUsage.cachedContentTokenCount)
            assertEquals(0, minUsage.toolUsePromptTokenCount)
            assertEquals(7, minUsage.totalTokenCount)
            assertTrue(minUsage.promptTokensDetails.isEmpty())
            assertTrue(minUsage.candidatesTokensDetails.isEmpty())
        }

    @Test
    fun generateContentStreamAndChatSendMessageStreamFilterThoughtChunksAndExposeUsageBreakdowns(): Unit =
        runBlocking {
            val harness = newHarness()
            val streamServer = MockAiStreamServer { transport, subId, _ ->
                MockAiStreamServer.sendChunk(
                    transport,
                    subId,
                    mapOf(
                        "candidates" to listOf(
                            mapOf(
                                "index" to 0,
                                "content" to mapOf(
                                    "role" to "model",
                                    "parts" to listOf(mapOf("text" to "Drafting ", "thought" to true))
                                )
                            )
                        )
                    )
                )
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
                                            "text" to "proof.",
                                            "thought" to true,
                                            "thoughtSignature" to "sig-stream-thought"
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
                MockAiStreamServer.sendChunk(
                    transport,
                    subId,
                    mapOf(
                        "candidates" to listOf(
                            mapOf(
                                "index" to 0,
                                "content" to mapOf(
                                    "role" to "model",
                                    "parts" to listOf(mapOf("text" to "Final "))
                                )
                            )
                        )
                    )
                )
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
                                            "text" to "verdict!",
                                            "thoughtSignature" to "sig-stream-answer"
                                        )
                                    )
                                )
                            )
                        ),
                        "usageMetadata" to mapOf(
                            "promptTokenCount" to 12,
                            "candidatesTokenCount" to 6,
                            "thoughtsTokenCount" to 15,
                            "totalTokenCount" to 33
                        )
                    )
                )
                MockAiStreamServer.sendDone(transport, subId)
            }

            val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
            ai.streamTransportFactory = streamServer.factory
            val model = ai.generativeModel("gemini-2.5-pro")

            val directChunks = model.generateContentStream("Stream with thoughts").toList()
            assertEquals(4, directChunks.size)
            assertNull(directChunks[0].text)
            assertNull(directChunks[1].text)
            assertEquals("Final verdict!", directChunks.joinToString("") { it.text.orEmpty() })
            assertEquals("Drafting proof.", directChunks.joinToString("") { it.thoughtSummary.orEmpty() })
            assertEquals(15, directChunks.last().usageMetadata?.thoughtsTokenCount)
            assertEquals(33, directChunks.last().usageMetadata?.totalTokenCount)

            val chat = model.startChat()
            val chatChunks = chat.sendMessageStream("Chat stream with thoughts").toList()
            assertEquals("Final verdict!", chatChunks.joinToString("") { it.text.orEmpty() })
            assertEquals("Drafting proof.", chatChunks.joinToString("") { it.thoughtSummary.orEmpty() })

            val recordedModelParts = chat.history.last().parts
            assertEquals(
                "Final verdict!",
                recordedModelParts.filterIsInstance<TextPart>().filter { !it.isThought }.joinToString("") { it.text }
            )
            assertEquals(
                "Drafting proof.",
                recordedModelParts.filterIsInstance<TextPart>().filter { it.isThought }.joinToString("") { it.text }
            )
        }
}
