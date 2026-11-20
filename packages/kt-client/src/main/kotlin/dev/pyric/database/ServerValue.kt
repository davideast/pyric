package dev.pyric.database

object ServerValue {
    @JvmField
    val TIMESTAMP: Map<String, String> = com.google.firebase.database.ServerValue.TIMESTAMP

    @JvmStatic
    fun increment(delta: Long): Map<String, Any> =
        com.google.firebase.database.ServerValue.increment(delta)

    @JvmStatic
    fun increment(delta: Double): Map<String, Any> =
        com.google.firebase.database.ServerValue.increment(delta)
}
