package com.google.firebase.functions

import com.google.firebase.FirebaseException
import dev.pyric.codecs.JsonCodec

class FirebaseFunctionsException : FirebaseException {
    val code: Code
    val details: Any?

    constructor(message: String, code: Code, details: Any?) : super(message) {
        this.code = code
        this.details = details
    }

    constructor(
        message: String,
        code: Code,
        details: Any?,
        cause: Throwable?
    ) : super(message, cause) {
        this.code = code
        this.details = details
    }

    enum class Code(internal val statusValue: Int) {
        OK(0),
        CANCELLED(1),
        UNKNOWN(2),
        INVALID_ARGUMENT(3),
        DEADLINE_EXCEEDED(4),
        NOT_FOUND(5),
        ALREADY_EXISTS(6),
        PERMISSION_DENIED(7),
        RESOURCE_EXHAUSTED(8),
        FAILED_PRECONDITION(9),
        ABORTED(10),
        OUT_OF_RANGE(11),
        UNIMPLEMENTED(12),
        INTERNAL(13),
        UNAVAILABLE(14),
        DATA_LOSS(15),
        UNAUTHENTICATED(16);

        companion object {
            private val BY_VALUE: Map<Int, Code> = entries.associateBy { it.statusValue }

            @JvmStatic
            fun fromValue(value: Int): Code = BY_VALUE[value] ?: UNKNOWN

            @JvmStatic
            fun fromHttpStatus(status: Int): Code {
                if (status in 200..299) {
                    return OK
                }
                return when (status) {
                    400 -> INVALID_ARGUMENT
                    401 -> UNAUTHENTICATED
                    403 -> PERMISSION_DENIED
                    404 -> NOT_FOUND
                    409 -> ABORTED
                    429 -> RESOURCE_EXHAUSTED
                    499 -> CANCELLED
                    500 -> INTERNAL
                    501 -> UNIMPLEMENTED
                    503 -> UNAVAILABLE
                    504 -> DEADLINE_EXCEEDED
                    else -> UNKNOWN
                }
            }
        }
    }

    companion object {
        internal fun fromResponse(
            defaultCode: Code,
            body: String?,
            serializer: FunctionsSerializer
        ): FirebaseFunctionsException? {
            val parsedBody = if (!body.isNullOrBlank()) {
                runCatching { JsonCodec.decode(body) as? Map<*, *> }.getOrNull()
            } else {
                null
            }
            return fromParsedErrorEnvelope(defaultCode, parsedBody, serializer)
        }

        internal fun fromParsedErrorEnvelope(
            defaultCode: Code,
            parsedBody: Map<*, *>?,
            serializer: FunctionsSerializer
        ): FirebaseFunctionsException? {
            var resolvedCode = defaultCode
            var description = resolvedCode.name
            var decodedDetails: Any? = null

            val errorObj = parsedBody?.get("error") as? Map<*, *>
            if (errorObj != null) {
                var statusValid = true
                val statusRaw = errorObj["status"]
                if (statusRaw is String) {
                    val mapped = runCatching { Code.valueOf(statusRaw) }.getOrNull()
                    if (mapped == null) {
                        resolvedCode = Code.INTERNAL
                        description = Code.INTERNAL.name
                        statusValid = false
                    } else {
                        resolvedCode = mapped
                        description = resolvedCode.name
                    }
                }
                if (statusValid) {
                    val msgRaw = errorObj["message"]
                    if (msgRaw is String && msgRaw.isNotEmpty()) {
                        description = msgRaw
                    }
                    val detailsRaw = errorObj["details"]
                    if (detailsRaw != null) {
                        decodedDetails = runCatching { serializer.decode(detailsRaw) }.getOrNull()
                    }
                }
            }

            if (resolvedCode == Code.OK) {
                return null
            }
            return FirebaseFunctionsException(description, resolvedCode, decodedDetails)
        }
    }
}
