package com.google.firebase.appcheck

abstract class AppCheckToken {
    abstract val token: String
    abstract val expireTimeMillis: Long
}

internal class DefaultAppCheckToken(
    override val token: String,
    override val expireTimeMillis: Long
) : AppCheckToken() {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AppCheckToken) return false
        return token == other.token && expireTimeMillis == other.expireTimeMillis
    }

    override fun hashCode(): Int {
        var result = token.hashCode()
        result = 31 * result + expireTimeMillis.hashCode()
        return result
    }

    override fun toString(): String =
        "DefaultAppCheckToken(expireTimeMillis=$expireTimeMillis)"
}
