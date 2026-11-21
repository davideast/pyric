package dev.pyric.ai

import com.google.firebase.FirebaseApp
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.FileDataPart
import com.google.firebase.ai.type.FunctionResponsePart
import com.google.firebase.ai.type.InlineDataPart
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.asFileDataOrNull
import com.google.firebase.ai.type.asInlineDataPartOrNull
import com.google.firebase.ai.type.asTextOrNull
import com.google.firebase.ai.type.content
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.Base64

class InlineDataAndMultimodalRoundTripTest {

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
    fun inlineDataPartDefensivelyCopiesBytesOnBothConstructionAndGetterRead() {
        val source = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val part = InlineDataPart(source, "image/png", "radar.png")

        // Mutating caller's input buffer after construction must not affect InlineDataPart
        source[0] = 0x00
        assertEquals(0x89.toByte(), part.inlineData[0])

        // Mutating the array returned by inlineData getter must not corrupt stored bytes
        val readOnce = part.inlineData
        readOnce[0] = 0x7F
        readOnce[7] = 0x55
        assertArrayEquals(
            byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A),
            part.inlineData
        )

        val sameCopy = InlineDataPart(
            byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A),
            "image/png",
            "radar.png"
        )
        val diffDisplay = InlineDataPart(
            byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A),
            "image/png",
            "other.png"
        )
        assertEquals(part, sameCopy)
        assertEquals(part.hashCode(), sameCopy.hashCode())
        assertNotEquals(part, diffDisplay)
        assertEquals(part, part.asInlineDataPartOrNull())
        assertNull(part.asTextOrNull())
        assertNull(part.asFileDataOrNull())
    }

    @Test
    fun roundTripsEmptyPaddingBoundaryFullByteSpectrumAndMultiKiBBinaryPayloads(): Unit =
        runBlocking {
            val harness = newHarness()
            val payloads = listOf(
                "empty.bin" to ByteArray(0),
                "one-byte.bin" to byteArrayOf(0xFB.toByte()),
                "two-byte.bin" to byteArrayOf(0xFF.toByte(), 0xEE.toByte()),
                "three-byte.bin" to byteArrayOf(0x00, 0x7F, 0x80.toByte()),
                "spectrum-256.bin" to ByteArray(256) { it.toByte() },
                "frame-4099.png" to ByteArray(4099) { idx -> ((idx * 37 + 13) and 0xFF).toByte() }
            )

            harness.onOp { recorded ->
                @Suppress("UNCHECKED_CAST")
                val req = recorded.op["request"] as Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val contents = req["contents"] as List<Map<String, Any?>>
                @Suppress("UNCHECKED_CAST")
                val reqParts = contents.single()["parts"] as List<Map<String, Any?>>

                // Echo every inbound inlineData part back as a model response part
                val echoedParts = reqParts.map { wirePart ->
                    @Suppress("UNCHECKED_CAST")
                    val inlineMap = wirePart["inlineData"] as Map<String, Any?>
                    val b64 = inlineMap["data"] as String
                    // Outbound encoder must emit canonical RFC 4648 Base64 without line breaks
                    assertTrue(!b64.contains('\n') && !b64.contains('\r'))
                    mapOf(
                        "inlineData" to mapOf(
                            "mimeType" to inlineMap["mimeType"],
                            "data" to b64,
                            "displayName" to inlineMap["displayName"]
                        )
                    )
                }
                ScriptedBridgeReply.Success(
                    mapOf(
                        "candidates" to listOf(
                            mapOf(
                                "index" to 0,
                                "finishReason" to "STOP",
                                "content" to mapOf("role" to "model", "parts" to echoedParts)
                            )
                        )
                    )
                )
            }

            val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
            val model = ai.generativeModel("gemini-2.5-flash")

            val prompt = content("user") {
                for ((name, bytes) in payloads) {
                    part(InlineDataPart(bytes, "application/octet-stream", name))
                }
            }
            val response = model.generateContent(prompt)

            assertNull(response.text)
            assertEquals(payloads.size, response.inlineDataParts.size)
            for (i in payloads.indices) {
                val (expectedName, expectedBytes) = payloads[i]
                val decoded = response.inlineDataParts[i]
                assertEquals(expectedName, decoded.displayName)
                assertEquals("application/octet-stream", decoded.mimeType)
                assertArrayEquals(expectedBytes, decoded.inlineData)
            }
        }

    @Test
    fun decodesMimeLineWrappedUrlSafeAndUnpaddedBase64AndRejectsCorruptedPayloads(): Unit =
        runBlocking {
            val harness = newHarness()
            // Bytes [0xFB, 0xEF, 0xBE, 0xFF, 0xFA] produce '+' and '/' in standard Base64 ("++--//o=")
            val trickyBytes = byteArrayOf(
                0xFB.toByte(),
                0xEF.toByte(),
                0xBE.toByte(),
                0xFF.toByte(),
                0xFA.toByte()
            )
            val stdB64 = Base64.getEncoder().encodeToString(trickyBytes)
            assertTrue(stdB64.contains('+') || stdB64.contains('/'))
            val mimeWrapped = stdB64.chunked(3).joinToString("\r\n ")
            val urlSafeUnpadded = Base64.getUrlEncoder().withoutPadding().encodeToString(trickyBytes)

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
                                            "mimeType" to "image/webp",
                                            "data" to mimeWrapped,
                                            "displayName" to "wrapped.webp"
                                        )
                                    ),
                                    mapOf(
                                        "inlineData" to mapOf(
                                            "mimeType" to "audio/wav",
                                            "data" to urlSafeUnpadded,
                                            "displayName" to "urlsafe.wav"
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            )

            val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
            val model = ai.generativeModel("gemini-2.5-flash")
            val okResponse = model.generateContent("decode variants")
            assertEquals(2, okResponse.inlineDataParts.size)
            assertArrayEquals(trickyBytes, okResponse.inlineDataParts[0].inlineData)
            assertArrayEquals(trickyBytes, okResponse.inlineDataParts[1].inlineData)

            // Corrupted Base64 character ('$') and 1-char remainder ("A") must throw SerializationException
            for (badB64 in listOf("not\$valid\$base64==", "A")) {
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
                                                "data" to badB64
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
                assertThrows<SerializationException> {
                    runBlocking { model.generateContent("corrupted base64") }
                }
            }

            // Non-string inlineData.data must also throw SerializationException
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
                                            "data" to listOf(1, 2, 3)
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            )
            assertThrows<SerializationException> {
                runBlocking { model.generateContent("non-string inlineData.data") }
            }
        }

    @Test
    fun contentBuilderBlobAndInlineDataProduceIdenticalWireFramesAndNestedFunctionResponseParts(): Unit =
        runBlocking {
            val harness = newHarness()
            val sampleAudio = byteArrayOf(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00)
            val chartBytes = byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37)

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
                                        "functionResponse" to mapOf(
                                            "name" to "renderReport",
                                            "id" to "call-pdf-1",
                                            "response" to mapOf("pages" to 2),
                                            "parts" to listOf(
                                                mapOf(
                                                    "inlineData" to mapOf(
                                                        "mimeType" to "application/pdf",
                                                        "data" to Base64.getEncoder().encodeToString(chartBytes),
                                                        "displayName" to "report.pdf"
                                                    )
                                                )
                                            )
                                        )
                                    ),
                                    mapOf("text" to "Multimodal report ready.")
                                )
                            )
                        )
                    )
                )
            )

            val ai = FirebaseAI.getInstance(FirebaseApp.getInstance(), harness.client)
            val model = ai.generativeModel("gemini-2.5-flash")

            val turnViaBlob = content("user") {
                blob("audio/wav", sampleAudio)
                fileData("gs://demo-bucket/clips/intro.mp4", "video/mp4")
            }
            val turnViaInline = Content.Builder()
                .setRole("user")
                .inlineData(sampleAudio, "audio/wav")
                .fileData("gs://demo-bucket/clips/intro.mp4", "video/mp4")
                .build()
            assertEquals(turnViaBlob.parts, turnViaInline.parts)
            assertEquals(
                FileDataPart("gs://demo-bucket/clips/intro.mp4", "video/mp4"),
                turnViaBlob.parts[1].asFileDataOrNull()
            )

            val fnReplyTurn = content("user") {
                part(
                    FunctionResponsePart(
                        name = "renderReport",
                        response = mapOf("pages" to 2),
                        id = "call-pdf-1",
                        parts = listOf(InlineDataPart(chartBytes, "application/pdf", "report.pdf"))
                    )
                )
            }

            val response = model.generateContent(turnViaBlob, fnReplyTurn)
            assertEquals("Multimodal report ready.", response.text)

            val decodedFnRes = response.candidates.single().content.parts[0] as FunctionResponsePart
            assertEquals("renderReport", decodedFnRes.name)
            assertEquals("call-pdf-1", decodedFnRes.id)
            val nestedInline = decodedFnRes.parts.single() as InlineDataPart
            assertEquals("application/pdf", nestedInline.mimeType)
            assertEquals("report.pdf", nestedInline.displayName)
            assertArrayEquals(chartBytes, nestedInline.inlineData)

            val op = harness.recordedOps.single()
            @Suppress("UNCHECKED_CAST")
            val sentContents = (op.op["request"] as Map<String, Any?>)["contents"] as List<Map<String, Any?>>
            @Suppress("UNCHECKED_CAST")
            val secondTurnParts = sentContents[1]["parts"] as List<Map<String, Any?>>
            @Suppress("UNCHECKED_CAST")
            val sentFnRes = secondTurnParts.single()["functionResponse"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val sentNested = (sentFnRes["parts"] as List<Map<String, Any?>>).single()["inlineData"] as Map<String, Any?>
            assertEquals(Base64.getEncoder().encodeToString(chartBytes), sentNested["data"])
            assertEquals("report.pdf", sentNested["displayName"])
        }
}
