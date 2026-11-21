package com.google.firebase.functions

import java.util.concurrent.TimeUnit

class HttpsCallableOptions internal constructor(
    val limitedUseAppCheckTokens: Boolean
) {
    class Builder {
        private var limitedUseField: Boolean = false

        var limitedUseAppCheckTokens: Boolean
            get() = limitedUseField
            @JvmSynthetic set(value) {
                limitedUseField = value
            }

        fun setLimitedUseAppCheckTokens(limitedUse: Boolean): Builder {
            limitedUseField = limitedUse
            return this
        }

        fun build(): HttpsCallableOptions = HttpsCallableOptions(limitedUseField)
    }
}

internal class HttpsCallOptions(
    @Volatile var timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS,
    val limitedUseAppCheckTokens: Boolean = false
) {
    fun setTimeout(timeout: Long, units: TimeUnit) {
        val converted = units.toMillis(timeout)
        require(converted > 0L) { "Timeout must be positive." }
        timeoutMillis = converted
    }

    fun getTimeout(): Long = timeoutMillis

    fun copyWithTimeout(timeout: Long, units: TimeUnit): HttpsCallOptions {
        val copy = HttpsCallOptions(
            timeoutMillis = timeoutMillis,
            limitedUseAppCheckTokens = limitedUseAppCheckTokens
        )
        copy.setTimeout(timeout, units)
        return copy
    }

    companion object {
        const val DEFAULT_TIMEOUT_MILLIS: Long = 70_000L
    }
}
