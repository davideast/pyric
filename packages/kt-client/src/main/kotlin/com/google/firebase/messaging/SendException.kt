package com.google.firebase.messaging

import java.util.Locale

class SendException : Exception {
    val errorCode: Int

    constructor(message: String?) : super(message) {
        this.errorCode = parseErrorCode(message)
    }

    internal constructor(message: String?, errorCode: Int, cause: Throwable? = null) : super(message, cause) {
        this.errorCode = errorCode
    }

    companion object {
        const val ERROR_UNKNOWN: Int = 0
        const val ERROR_INVALID_PARAMETERS: Int = 1
        const val ERROR_SIZE: Int = 2
        const val ERROR_TTL_EXCEEDED: Int = 3
        const val ERROR_TOO_MANY_MESSAGES: Int = 4

        internal fun parseErrorCode(reason: String?): Int {
            if (reason == null) {
                return ERROR_UNKNOWN
            }
            val normalized = reason.lowercase(Locale.US)
            return when (normalized) {
                "invalid_parameters", "missing_to" -> ERROR_INVALID_PARAMETERS
                "messagetoobig" -> ERROR_SIZE
                "service_not_available", "ttl_exceeded" -> ERROR_TTL_EXCEEDED
                "toomanymessages" -> ERROR_TOO_MANY_MESSAGES
                else -> classifyMessageText(normalized)
            }
        }

        private fun classifyMessageText(lower: String): Int {
            return when {
                lower.contains("too large") || lower.contains("maximum is 4k") -> ERROR_SIZE
                lower.contains("ttl") -> ERROR_TTL_EXCEEDED
                lower.contains("quota") ||
                    lower.contains("resource_exhausted") ||
                    lower.contains("too many messages") -> ERROR_TOO_MANY_MESSAGES
                lower.contains("invalid") ||
                    lower.contains("not set") ||
                    lower.contains("unregistered") ||
                    lower.contains("not found") ||
                    lower.contains("malformed") -> ERROR_INVALID_PARAMETERS
                else -> ERROR_UNKNOWN
            }
        }

        internal fun fromBridgeFailure(error: Throwable): SendException {
            if (error is SendException) {
                return error
            }
            val msg = error.message
            return SendException(msg, parseErrorCode(msg), error)
        }
    }
}
