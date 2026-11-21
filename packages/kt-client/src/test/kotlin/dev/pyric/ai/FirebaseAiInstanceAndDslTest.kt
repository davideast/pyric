package dev.pyric.ai

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.BlockThreshold
import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.FileDataPart
import com.google.firebase.ai.type.FunctionCallPart
import com.google.firebase.ai.type.FunctionResponsePart
import com.google.firebase.ai.type.GenerationConfig
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.HarmBlockMethod
import com.google.firebase.ai.type.HarmBlockThreshold
import com.google.firebase.ai.type.HarmCategory
import com.google.firebase.ai.type.InlineDataPart
import com.google.firebase.ai.type.InvalidLocationException
import com.google.firebase.ai.type.InvalidStateException
import com.google.firebase.ai.type.RequestOptions
import com.google.firebase.ai.type.ResponseModality
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.ai.type.TextPart
import com.google.firebase.ai.type.ThinkingConfig
import com.google.firebase.ai.type.ThinkingLevel
import com.google.firebase.ai.type.asFileDataOrNull
import com.google.firebase.ai.type.asInlineDataPartOrNull
import com.google.firebase.ai.type.asTextOrNull
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import com.google.firebase.ai.type.thinkingConfig
import com.google.firebase.appcheck.FirebaseAppCheck
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class FirebaseAiInstanceAndDslTest {

    @AfterEach
    fun tearDown() {
        FirebaseAI.reset()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun firebaseAiCachesPerAppBackendAndLimitedUseFlagAndResetInvalidates() {
        val defaultAi = Firebase.ai
        assertSame(defaultAi, FirebaseAI.instance)
        assertSame(defaultAi, FirebaseAI.getInstance())
        assertSame(defaultAi, Firebase.ai(backend = GenerativeBackend.googleAI()))
        assertEquals(GenerativeBackend.googleAI(), defaultAi.backend)

        val vertexCentral = Firebase.ai(backend = GenerativeBackend.vertexAI("us-central1"))
        val vertexEurope = Firebase.ai(backend = GenerativeBackend.vertexAI("europe-west1"))
        val agentGlobal = Firebase.ai(backend = GenerativeBackend.agentPlatform())
        assertSame(vertexCentral, FirebaseAI.getInstance(GenerativeBackend.vertexAI()))
        assertNotSame(defaultAi, vertexCentral)
        assertNotSame(vertexCentral, vertexEurope)
        assertNotSame(vertexCentral, agentGlobal)

        val limitedUse = Firebase.ai(
            backend = GenerativeBackend.googleAI(),
            useLimitedUseAppCheckTokens = true
        )
        assertNotSame(defaultAi, limitedUse)
        assertTrue(limitedUse.useLimitedUseAppCheckTokens)

        val secondaryApp = FirebaseApp.initializeApp(
            "secondary-ai-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-secondary-ai")
                .setApiKey("secondary-key")
                .setApplicationId("1:999999999999:android:secondaryai")
                .build()
        )
        val secondaryAi = Firebase.ai(secondaryApp, GenerativeBackend.googleAI())
        assertNotSame(defaultAi, secondaryAi)
        assertSame(secondaryAi, FirebaseAI.getInstance(secondaryApp))

        FirebaseAI.reset()
        val afterReset = Firebase.ai
        assertNotSame(defaultAi, afterReset)
    }

    @Test
    fun generativeBackendValidatesLocationsAndNormalizesModelResourceNames() {
        assertEquals(GenerativeBackend.googleAI(), GenerativeBackend.googleAI())
        assertEquals(
            GenerativeBackend.vertexAI("us-central1"),
            GenerativeBackend.vertexAI()
        )
        assertEquals(
            GenerativeBackend.agentPlatform("global"),
            GenerativeBackend.agentPlatform()
        )
        assertNotEquals(GenerativeBackend.googleAI(), GenerativeBackend.vertexAI())

        assertThrows<InvalidLocationException> { GenerativeBackend.vertexAI("") }
        assertThrows<InvalidLocationException> { GenerativeBackend.vertexAI("   ") }
        assertThrows<InvalidLocationException> { GenerativeBackend.vertexAI("us/central1") }
        assertThrows<InvalidLocationException> { GenerativeBackend.agentPlatform("projects/foo") }

        val googleAi = FirebaseAI.getInstance(GenerativeBackend.googleAI())
        assertEquals(
            "models/gemini-2.5-flash",
            googleAi.generativeModel("gemini-2.5-flash").normalizedModelName
        )
        assertEquals(
            "models/gemini-2.5-flash",
            googleAi.generativeModel("models/gemini-2.5-flash").normalizedModelName
        )

        val vertexAi = FirebaseAI.getInstance(GenerativeBackend.vertexAI("us-east1"))
        assertEquals(
            "publishers/google/models/gemini-2.5-pro",
            vertexAi.generativeModel("gemini-2.5-pro").normalizedModelName
        )
        assertEquals(
            "publishers/google/models/gemini-2.5-pro",
            vertexAi.generativeModel("models/gemini-2.5-pro").normalizedModelName
        )
        assertEquals(
            "publishers/acme/models/custom-1",
            vertexAi.generativeModel("publishers/acme/models/custom-1").normalizedModelName
        )

        assertThrows<InvalidStateException> {
            googleAi.generativeModel("   ")
        }
    }

    @Test
    fun contentDslAndPartHierarchyBuildImmutableSnapshotsWithDefensiveByteCopies() {
        val rawPng = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)
        val rawWav = byteArrayOf(0x52, 0x49, 0x46, 0x46)
        val rawPdf = byteArrayOf(0x25, 0x50, 0x44, 0x46)

        val turn = content(role = "user") {
            text("Describe these attachments")
            inlineData(rawPng, "image/png")
            blob("audio/wav", rawWav)
            blob(rawPdf, "application/pdf")
            fileData("gs://demo-bucket/clips/intro.mp4", "video/mp4")
            part(FunctionCallPart("lookupWeather", mapOf("city" to "Tokyo"), id = "call-1"))
            part(FunctionResponsePart("lookupWeather", mapOf("tempC" to 21), id = "call-1"))
        }

        // Mutating caller byte arrays after construction must not mutate InlineDataPart payloads.
        rawPng[0] = 0x00
        assertEquals("user", turn.role)
        assertEquals(7, turn.parts.size)

        val p0 = turn.parts[0]
        assertEquals("Describe these attachments", p0.asTextOrNull())
        assertNull(p0.asInlineDataPartOrNull())
        assertNull(p0.asFileDataOrNull())

        val p1 = turn.parts[1].asInlineDataPartOrNull()!!
        assertArrayEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47), p1.inlineData)
        assertEquals("image/png", p1.mimeType)
        assertEquals(
            InlineDataPart(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47), "image/png"),
            p1
        )

        val p2 = turn.parts[2].asInlineDataPartOrNull()!!
        assertEquals("audio/wav", p2.mimeType)
        assertArrayEquals(rawWav, p2.inlineData)

        val p3 = turn.parts[3].asInlineDataPartOrNull()!!
        assertEquals("application/pdf", p3.mimeType)
        assertArrayEquals(rawPdf, p3.inlineData)

        val p4 = turn.parts[4].asFileDataOrNull()!!
        assertEquals(FileDataPart("gs://demo-bucket/clips/intro.mp4", "video/mp4"), p4)

        val thoughtPart = TextPart.createWithThinking("internal chain", true, "sig-abc")
        assertTrue(thoughtPart.isThought)
        assertEquals("sig-abc", thoughtPart.thoughtSignature)

        val copied = turn.copy(role = "model")
        assertEquals("model", copied.role)
        assertEquals(turn.parts, copied.parts)
    }

    @Test
    fun generationConfigThinkingConfigSafetySettingAndRequestOptionsValidateAndRoundTripBuilder() {
        val schemaMap = mapOf(
            "type" to "OBJECT",
            "properties" to mapOf("answer" to mapOf("type" to "STRING"))
        )
        val config = generationConfig {
            temperature = 0.4f
            topP = 0.9f
            topK = 32
            candidateCount = 1
            maxOutputTokens = 512
            presencePenalty = 0.1f
            frequencyPenalty = 0.2f
            stopSequences = listOf("END", "STOP_HERE")
            responseMimeType = "application/json"
            responseSchema = schemaMap
            responseModalities = listOf(ResponseModality.TEXT)
            thinkingConfig = thinkingConfig {
                thinkingBudget = 256
                includeThoughts = true
            }
        }

        assertEquals(0.4f, config.temperature)
        assertEquals(0.9f, config.topP)
        assertEquals(32, config.topK)
        assertEquals(1, config.candidateCount)
        assertEquals(512, config.maxOutputTokens)
        assertEquals(listOf("END", "STOP_HERE"), config.stopSequences)
        assertEquals("application/json", config.responseMimeType)
        assertEquals(schemaMap, config.responseSchema)
        assertEquals(256, config.thinkingConfig?.thinkingBudget)
        assertEquals(true, config.thinkingConfig?.includeThoughts)

        val rebuilt = config.toBuilder().setMaxOutputTokens(1024).build()
        assertEquals(1024, rebuilt.maxOutputTokens)
        assertEquals(0.4f, rebuilt.temperature)
        assertNotEquals(config, rebuilt)

        val levelThinking = ThinkingConfig.builder()
            .setThinkingLevel(ThinkingLevel.HIGH)
            .setIncludeThoughts(false)
            .build()
        assertEquals(ThinkingLevel.HIGH, levelThinking.thinkingLevel)

        // Setting both thinkingBudget and thinkingLevel is rejected per upstream ThinkingConfig.
        assertThrows<IllegalArgumentException> {
            thinkingConfig {
                thinkingBudget = 128
                thinkingLevel = ThinkingLevel.LOW
            }
        }

        val safetyA = SafetySetting(HarmCategory.HATE_SPEECH, BlockThreshold.LOW_AND_ABOVE)
        val safetyB = SafetySetting(
            HarmCategory.DANGEROUS_CONTENT,
            HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmBlockMethod.SEVERITY
        )
        assertEquals(HarmBlockThreshold.LOW_AND_ABOVE, safetyA.threshold)
        assertEquals(HarmBlockMethod.SEVERITY, safetyB.method)

        assertThrows<IllegalArgumentException> { RequestOptions(timeoutInMillis = 0L) }
        assertThrows<IllegalArgumentException> { RequestOptions(autoFunctionCallingTurnLimit = -1) }
        assertEquals(180_000L, GenerationConfig.builder().let { RequestOptions().timeoutInMillis })
    }
}
