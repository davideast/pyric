package com.google.firebase.ai.type

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class AiSchemaPhase2RegressionTest {
    @Test
    fun `P2-K15 Schema preserves 64-bit Long bounds and rejects non-finite Double bounds`() {
        val exactMin = 9007199254740993L
        val exactMax = 9007199254740995L
        val schema = Schema.long(minimum = exactMin, maximum = exactMax)
        val wire = schema.toWireMap()
        assertEquals(exactMin, wire["minimum"])
        assertEquals(exactMax, wire["maximum"])

        assertThrows(IllegalArgumentException::class.java) {
            Schema.double(minimum = Double.NaN)
        }
        assertThrows(IllegalArgumentException::class.java) {
            Schema.double(maximum = Double.POSITIVE_INFINITY)
        }
        assertThrows(IllegalArgumentException::class.java) {
            Schema.float(minimum = Double.NEGATIVE_INFINITY)
        }
    }
}
