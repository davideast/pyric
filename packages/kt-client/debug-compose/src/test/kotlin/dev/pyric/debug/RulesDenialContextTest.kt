package dev.pyric.debug

import dev.pyric.debug.model.FieldDiffKind
import dev.pyric.debug.model.RuleCitation
import dev.pyric.debug.model.RulesDenialContext
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RulesDenialContextTest {

    @Test
    fun testParseFullDenialPayload() {
        val payload = mapOf<String, Any?>(
            "rule" to mapOf(
                "file" to "firestore.rules",
                "line" to 14,
                "col" to 5,
                "citation" to "firestore.rules:14:5",
                "expression" to "request.auth != null && request.auth.uid == userId"
            ),
            "auth" to mapOf(
                "uid" to "guest-user",
                "token" to mapOf("email" to "guest@example.com", "role" to "viewer"),
                "tenant" to "corp-tenant"
            ),
            "reasons" to listOf(
                "false for 'write' @ L14",
                "Evaluated request.auth.uid ('guest-user') == userId ('alice') -> false"
            ),
            "failedFields" to listOf("ownerId"),
            "request" to mapOf(
                "method" to "update",
                "path" to "/databases/(default)/documents/users/alice",
                "resourceData" to mapOf(
                    "displayName" to "Hacked",
                    "ownerId" to "guest-user"
                )
            ),
            "resource" to mapOf(
                "exists" to true,
                "data" to mapOf(
                    "displayName" to "Alice",
                    "ownerId" to "alice",
                    "legacyField" to 123
                )
            ),
            "query" to null
        )

        val context = RulesDenialContext.fromMap(payload)

        // Rule verification
        assertNotNull(context.rule)
        assertEquals("firestore.rules", context.rule?.file)
        assertEquals(14, context.rule?.line)
        assertEquals(5, context.rule?.column)
        assertEquals("firestore.rules:14:5", context.rule?.formattedCitation)
        assertEquals("request.auth != null && request.auth.uid == userId", context.rule?.expression)

        // Auth verification
        assertNotNull(context.auth)
        assertEquals("guest-user", context.auth?.uid)
        assertEquals("corp-tenant", context.auth?.tenant)
        assertEquals("viewer", context.auth?.role)
        assertEquals("guest@example.com", context.auth?.token?.get("email"))

        // Reasons & Failed fields
        assertEquals(2, context.reasons.size)
        assertTrue(context.reasons[0].contains("false for 'write'"))
        assertEquals(listOf("ownerId"), context.failedFields)

        // Request & Resource
        assertEquals("update", context.request?.method)
        assertEquals("/databases/(default)/documents/users/alice", context.request?.path)
        assertTrue(context.resource?.exists == true)

        // Data Diff
        val diffs = context.computeDataDiff()
        assertEquals(3, diffs.size)

        val displayDiff = diffs.find { it.path == "displayName" }
        assertNotNull(displayDiff)
        assertEquals(FieldDiffKind.MODIFIED, displayDiff?.kind)
        assertEquals("Alice", displayDiff?.oldValue)
        assertEquals("Hacked", displayDiff?.newValue)

        val legacyDiff = diffs.find { it.path == "legacyField" }
        assertNotNull(legacyDiff)
        assertEquals(FieldDiffKind.REMOVED, legacyDiff?.kind)
        assertEquals(123, legacyDiff?.oldValue)
        assertNull(legacyDiff?.newValue)

        val ownerDiff = diffs.find { it.path == "ownerId" }
        assertNotNull(ownerDiff)
        assertEquals(FieldDiffKind.MODIFIED, ownerDiff?.kind)
        assertEquals("alice", ownerDiff?.oldValue)
        assertEquals("guest-user", ownerDiff?.newValue)
    }

    @Test
    fun testParseCitationFromString() {
        val citation = RuleCitation.parse("security.rules:42:10")
        assertNotNull(citation)
        assertEquals("security.rules", citation?.file)
        assertEquals(42, citation?.line)
        assertEquals(10, citation?.column)
        assertEquals("security.rules:42:10", citation?.formattedCitation)
    }

    @Test
    fun testParseEmptyPayloadGracefully() {
        val context = RulesDenialContext.fromMap(emptyMap())
        assertNull(context.rule)
        assertNull(context.auth)
        assertTrue(context.reasons.isEmpty())
        assertTrue(context.failedFields.isEmpty())
        assertNull(context.request)
        assertNull(context.resource)
        assertNull(context.query)
        assertTrue(context.computeDataDiff().isEmpty())
    }

    @Test
    fun testQueryDenialParsing() {
        val payload = mapOf(
            "query" to mapOf(
                "where" to listOf(mapOf("field" to "status", "op" to "==", "value" to "active")),
                "limit" to 50L,
                "orderBy" to "createdAt"
            ),
            "resource" to mapOf(
                "exists" to false
            )
        )

        val context = RulesDenialContext.fromMap(payload)
        assertNotNull(context.query)
        assertEquals(1, context.query?.where?.size)
        assertEquals(50L, context.query?.limit)
        assertEquals("createdAt", context.query?.orderBy)
        assertFalse(context.resource?.exists == true)
    }

    @Test
    fun testDataDiffAddedField() {
        val payload = mapOf(
            "request" to mapOf(
                "method" to "create",
                "resourceData" to mapOf("title" to "New Task", "completed" to false)
            ),
            "resource" to mapOf(
                "exists" to false,
                "data" to emptyMap<String, Any?>()
            )
        )

        val context = RulesDenialContext.fromMap(payload)
        val diffs = context.computeDataDiff()
        assertEquals(2, diffs.size)
        assertTrue(diffs.all { it.kind == FieldDiffKind.ADDED })
    }
}
