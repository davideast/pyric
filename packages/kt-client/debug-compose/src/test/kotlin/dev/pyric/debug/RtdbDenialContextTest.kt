package dev.pyric.debug

import dev.pyric.codecs.JsonCodec
import dev.pyric.debug.model.RulesDenialContext
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Parses the envelope a denied sandbox RTDB write sends over the bridge,
 * captured by `packages/cli/scripts/capture-rtdb-denial-envelope.ts`.
 */
class RtdbDenialContextTest {

    private fun capturedEnvelope(): Map<String, Any?> {
        val json = javaClass.classLoader.getResource("rtdb-denial-envelope.json")!!.readText()
        return JsonCodec.decodeMap(json)
    }

    @Test
    fun parsesEngineAndRtdbRuleFieldsFromCapturedEnvelope() {
        val envelope = capturedEnvelope()
        assertEquals("PERMISSION_DENIED", envelope["code"])
        @Suppress("UNCHECKED_CAST")
        val context = RulesDenialContext.fromMap(envelope["denialContext"] as Map<String, Any?>)

        assertEquals("rtdb", context.engine)
        assertTrue(context.isRtdb)
        assertEquals("/rooms/\$roomId", context.matchedPath)
        assertEquals("auth.uid == \$roomId || auth.token.role == 'editor'", context.matchedRule)
        assertEquals(mapOf("\$roomId" to "bob"), context.pathVariableBindings)
        assertTrue(context.reason!!.contains("evaluated to false"))
        assertNull(context.errorCode)

        assertNotNull(context.rule)
        assertEquals("database.rules.json", context.rule!!.file)
        assertEquals("database.rules.json /rooms/\$roomId", context.rule!!.formattedCitation)
        assertEquals(context.matchedRule, context.rule!!.expression)

        assertEquals("set", context.request?.method)
        assertEquals("/rooms/bob/title", context.request?.path)
        assertEquals(mapOf("text" to "Renamed", "by" to "alice"), context.request?.proposedValue)
        assertEquals(mapOf("text" to "Renamed", "by" to "alice"), context.request?.resourceData)
        assertEquals("alice", context.auth?.uid)
        assertEquals("tenant-a", context.auth?.tenant)
        assertEquals(1, context.reasons.size)
    }

    @Test
    fun keepsACamelCaseMethodAsSent() {
        val context = RulesDenialContext.fromMap(mapOf(
            "engine" to "rtdb",
            "request" to mapOf("method" to "setPriority", "path" to "/rooms/bob", "data" to 1)
        ))
        assertEquals("setPriority", context.request?.method)
        assertEquals(1, (context.request?.proposedValue as Number).toInt())
    }

    @Test
    fun aContextWithoutAnEngineIsAFirestoreDenial() {
        val context = RulesDenialContext.fromMap(mapOf("reasons" to listOf("denied")))
        assertEquals("firestore", context.engine)
        assertFalse(context.isRtdb)
        assertNull(context.matchedPath)
        assertNull(context.rule)
    }
}
