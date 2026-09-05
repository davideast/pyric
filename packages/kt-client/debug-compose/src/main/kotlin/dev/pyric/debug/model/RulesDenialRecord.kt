package dev.pyric.debug.model

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

data class RulesDenialRecord(
    val id: String = UUID.randomUUID().toString(),
    val timestampMs: Long = System.currentTimeMillis(),
    val exception: Exception,
    val context: RulesDenialContext,
    val isViewed: Boolean = false
) {
    val formattedTime: String
        get() {
            return try {
                val instant = Instant.ofEpochMilli(timestampMs)
                DateTimeFormatter.ofPattern("HH:mm:ss")
                    .withZone(ZoneId.systemDefault())
                    .format(instant)
            } catch (_: Throwable) {
                "$timestampMs"
            }
        }
}
