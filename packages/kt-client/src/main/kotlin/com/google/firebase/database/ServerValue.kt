package com.google.firebase.database

import java.util.Collections

object ServerValue {
    @JvmField
    val TIMESTAMP: Map<String, String> = Collections.unmodifiableMap(
        mapOf(".sv" to "timestamp")
    )

    @JvmStatic
    fun increment(delta: Long): Map<String, Any> = Collections.unmodifiableMap(
        mapOf(".sv" to Collections.unmodifiableMap(mapOf("increment" to delta)))
    )

    @JvmStatic
    fun increment(delta: Double): Map<String, Any> = Collections.unmodifiableMap(
        mapOf(".sv" to Collections.unmodifiableMap(mapOf("increment" to delta)))
    )
}
