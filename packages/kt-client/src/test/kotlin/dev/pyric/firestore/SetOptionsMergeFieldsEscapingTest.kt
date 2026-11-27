package dev.pyric.firestore

import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.SetOptions
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class SetOptionsMergeFieldsEscapingTest {
    @Test
    fun backtickEscapesLiteralDotsBackticksAndBackslashesInMergeFieldPaths() {
        val options = SetOptions.mergeFieldPaths(
            listOf(
                FieldPath.of("meta", "v1.0"),
                FieldPath.of("plain"),
                FieldPath.of("a`b\\c")
            )
        )
        val wire = options.toWireOptions()
        assertEquals(
            mapOf("mergeFields" to listOf("meta.`v1.0`", "plain", "`a\\`b\\\\c`")),
            wire
        )
    }

    @Test
    fun preservesSimpleDotSeparatedMergeFieldsUnquoted() {
        val options = SetOptions.mergeFields("profile.name", "age")
        assertEquals(
            mapOf("mergeFields" to listOf("profile.name", "age")),
            options.toWireOptions()
        )
    }
}
