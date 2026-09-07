package dev.pyric.database

object ServerValue {
    @JvmField
    val TIMESTAMP: Map<String, String> = mapOf(
        ".sv" to "timestamp",
        "__rtdbSentinel" to "serverTimestamp"
    )

    @JvmStatic
    fun increment(delta: Long): Map<String, Any> = mapOf(
        ".sv" to mapOf("increment" to delta)
    )

    @JvmStatic
    fun increment(delta: Double): Map<String, Any> = mapOf(
        ".sv" to mapOf("increment" to delta)
    )
}
