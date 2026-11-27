package dev.pyric.debug.model

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test

class RtdbDenialCitationTest {
    @Test
    fun `NO_MATCHING_RULE RTDB denial without matchedPath or matchedRule populates database rules json citation`() {
        val ctx = RulesDenialContext.fromMap(
            mapOf(
                "engine" to "rtdb",
                "reason" to "NO_MATCHING_RULE",
                "remediation" to "Add a .write rule under /secrets",
                "pathVariableBindings" to mapOf("\$roomId" to "bob"),
                "request" to mapOf(
                    "method" to "set",
                    "path" to "/secrets/scalar",
                    "data" to "secret-scalar"
                )
            )
        )
        assertNotNull(ctx.rule)
        assertEquals("database.rules.json", ctx.rule?.file)
        assertEquals("database.rules.json", ctx.rule?.formattedCitation)
        assertEquals("NO_MATCHING_RULE", ctx.reason)
        assertEquals("Add a .write rule under /secrets", ctx.remediation)
        assertEquals(mapOf("\$roomId" to "bob"), ctx.pathVariableBindings)
        assertEquals("secret-scalar", ctx.request?.proposedValue)
    }
}
